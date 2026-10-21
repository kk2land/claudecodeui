import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import TOML from '@iarna/toml';

import { CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';
import type { AnyRecord, ProviderModelsDefinition } from '@/shared/index.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/index.js';

/** GPT Web's provider composition and tests use the bridge's authenticated, profile-specific model catalog. */
export class GptwebModelsProvider extends CodexProviderModels {
  private cache: { key: string; expires: number; models: ProviderModelsDefinition } | null = null;
  private requests = new Map<string, Promise<ProviderModelsDefinition>>();

  constructor(
    home?: string,
    private readonly fetchModels: typeof fetch = fetch,
  ) { super('gptweb', home); }

  /** Providers' model service uses this predicate to enforce Web-only routing for every selection. */
  isModelIdSupported(model: string): boolean {
    return model.startsWith('chatgpt-web/') && model.length > 'chatgpt-web/'.length;
  }

  override async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const home = this.home;
    let config: AnyRecord;
    try {
      const parsed = TOML.parse(await readFile(path.join(home, 'config.toml'), 'utf8'));
      const root = readObjectRecord(parsed) ?? {};
      const profile = readOptionalString(root.profile);
      config = { ...root, ...(profile ? readObjectRecord(readObjectRecord(root.profiles)?.[profile]) : {}) };
    } catch {
      throw new AppError('Configure config.toml in CODEX_GPTWEB_HOME before connecting GPT Web.', {
        code: 'GPTWEB_CONFIG_UNAVAILABLE', statusCode: 503,
      });
    }
    const provider = readOptionalString(config.model_provider) ?? 'openai';
    const upstream = readObjectRecord(readObjectRecord(config.model_providers)?.[provider]) ?? {};
    const baseUrl = readOptionalString(provider === 'openai' ? config.openai_base_url : upstream.base_url);
    if (!baseUrl) throw new AppError('GPT Web model routing is not configured.', { code: 'GPTWEB_ROUTE_UNAVAILABLE', statusCode: 503 });
    let url: URL;
    try {
      url = new URL(`${baseUrl.replace(/\/+$/, '')}/models`);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    } catch {
      throw new AppError('GPT Web model routing must use an HTTP or HTTPS URL.', { code: 'GPTWEB_ROUTE_INVALID', statusCode: 503 });
    }
    const headers = new Headers({ accept: 'application/json' });
    for (const [key, value] of Object.entries(readObjectRecord(upstream.http_headers) ?? {})) {
      if (typeof value === 'string') headers.set(key, value);
    }
    for (const [key, name] of Object.entries(readObjectRecord(upstream.env_http_headers) ?? {})) {
      if (typeof name === 'string' && process.env[name]) headers.set(key, process.env[name]!);
    }
    const envKey = readOptionalString(upstream.env_key);
    let token = envKey ? process.env[envKey] : undefined;
    if (!token && !headers.has('authorization')) {
      try {
        const auth = readObjectRecord(JSON.parse(await readFile(path.join(this.home, 'auth.json'), 'utf8'))) ?? {};
        const tokens = readObjectRecord(auth.tokens);
        token = readOptionalString(tokens?.access_token) ?? readOptionalString(auth.OPENAI_API_KEY);
        const accountId = readOptionalString(tokens?.account_id);
        if (accountId) headers.set('chatgpt-account-id', accountId);
      } catch { /* A custom route may use only explicit headers. The server reports authentication failure. */ }
    }
    if (token) headers.set('authorization', `Bearer ${token}`);
    const key = createHash('sha256').update(JSON.stringify([url.href, [...headers], config.model])).digest('hex');
    if (this.cache?.key === key && this.cache.expires > Date.now()) return this.cache.models;
    const existing = this.requests.get(key);
    if (existing) return existing;
    const request = this.loadModels(url, headers, readOptionalString(config.model)).then(models => {
      this.cache = { key, expires: Date.now() + 60_000, models };
      return models;
    }).finally(() => { this.requests.delete(key); });
    this.requests.set(key, request);
    return request;
  }

  override async getCurrentActiveModel() {
    return { model: (await this.getSupportedModels()).DEFAULT };
  }

  private async loadModels(url: URL, headers: Headers, configuredModel?: string): Promise<ProviderModelsDefinition> {
    // The bridge forwards this version to the native model catalog before adding Web entries.
    const version = (createRequire(import.meta.url)('@openai/codex/package.json') as { version: string }).version;
    url.searchParams.set('client_version', version);
    headers.set('user-agent', `codex_cli_rs/${version}`);
    let response: Response;
    try {
      response = await this.fetchModels(url, { headers, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    } catch {
      throw new AppError('Cannot reach the GPT Web model service.', { code: 'GPTWEB_MODELS_UNAVAILABLE', statusCode: 503 });
    }
    if (!response.ok) throw new AppError(`GPT Web model service returned HTTP ${response.status}.`, {
      code: 'GPTWEB_MODELS_REJECTED', statusCode: response.status === 401 || response.status === 403 ? response.status : 502,
    });
    let catalog: AnyRecord | null;
    try { catalog = readObjectRecord(await response.json()); }
    catch { throw new AppError('GPT Web returned an invalid model catalog.', { code: 'GPTWEB_MODELS_INVALID', statusCode: 502 }); }
    if (!Array.isArray(catalog?.models)) throw new AppError('GPT Web returned no model catalog.', { code: 'GPTWEB_MODELS_INVALID', statusCode: 502 });
    const seen = new Set<string>();
    const options: ProviderModelsDefinition['OPTIONS'] = [];
    for (const raw of catalog.models) {
      const model = readObjectRecord(raw);
      const id = readOptionalString(model?.slug);
      if (!id || !this.isModelIdSupported(id) || model?.visibility !== 'list' || seen.has(id)) continue;
      seen.add(id);
      const levels = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.flatMap((level: unknown) => {
          const record = readObjectRecord(level);
          const value = readOptionalString(record?.effort);
          return value ? [{ value }] : [];
        }) : [];
      const defaultEffort = readOptionalString(model.default_reasoning_level);
      options.push({
        value: id,
        label: readOptionalString(model.display_name) ?? id,
        description: readOptionalString(model.description),
        ...(Array.isArray(model.input_modalities) ? { inputModalities: model.input_modalities.filter(
          (value: unknown): value is 'text' | 'image' => value === 'text' || value === 'image',
        ) } : {}),
        ...(levels.length ? { effort: {
          ...(defaultEffort && levels.some(level => level.value === defaultEffort) ? { default: defaultEffort } : {}),
          values: levels,
        } } : {}),
      });
    }
    if (!options.length) throw new AppError('GPT Web has no available Web models. Check its launcher configuration.', {
      code: 'GPTWEB_MODELS_EMPTY', statusCode: 503,
    });
    return { OPTIONS: options, DEFAULT: options.some(model => model.value === configuredModel) ? configuredModel! : options[0].value };
  }
}
