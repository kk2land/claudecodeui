import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import TOML from '@iarna/toml';

import { AppError, readObjectRecord, readOptionalString } from '@/shared/index.js';

type ProviderConfig = {
  name?: string;
  base_url?: string;
  env_key?: string;
  experimental_bearer_token?: string;
  requires_openai_auth?: boolean;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  query_params?: Record<string, string>;
  auth?: { command: string; args?: string[]; cwd?: string; timeout_ms?: number };
};

/** Public directory metadata excludes endpoint credentials. */
type CodexModelProviders = {
  defaultProvider: string;
  hasCustomProviders: boolean;
  providers: Array<{ id: string; name: string }>;
};

/** Parsed service model ids and the expiration of their one-minute HTTP cache. */
type CodexModelCatalog = { modelProvider: string; models: string[]; expiresAt: number };

/** Providers routes and the native runtime share configured services and their minute-long model cache. */
export class CodexModelProviderService {
  private readonly cache = new Map<string, { signature: string; catalog: CodexModelCatalog }>();
  private readonly environment: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly fetchModels: typeof fetch;
  private readonly now: () => number;

  constructor(options: { home?: string; environment?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number } = {}) {
    this.environment = options.environment ?? process.env;
    this.home = options.home ?? path.resolve(this.environment.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'));
    this.fetchModels = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async readConfig() {
    let raw = '';
    try { raw = await readFile(path.join(this.home, 'config.toml'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let config: Record<string, unknown>;
    try { config = TOML.parse(raw) as Record<string, unknown>; }
    catch { throw new AppError('Could not parse Codex config.toml.', { code: 'CODEX_CONFIG_INVALID', statusCode: 400 }); }
    const custom = readObjectRecord(config.model_providers) ?? {};
    const providers = new Map<string, ProviderConfig>([['openai', {
      name: 'OpenAI', requires_openai_auth: true,
      base_url: readOptionalString(config.openai_base_url) || this.environment.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    }]]);
    for (const [id, value] of Object.entries(custom)) {
      if (id === 'openai') continue; // Codex reserves the built-in provider id.
      const provider = readObjectRecord(value);
      if (!provider) throw new AppError(`Invalid Codex model provider: ${id}.`, { code: 'CODEX_CONFIG_INVALID', statusCode: 400 });
      providers.set(id, provider as ProviderConfig);
    }
    return { providers, defaultProvider: readOptionalString(config.model_provider) || 'openai' };
  }

  /** Only labels and ids leave this service; opening the picker never starts app-server. */
  async list(): Promise<CodexModelProviders> {
    const { providers, defaultProvider } = await this.readConfig();
    return {
      defaultProvider,
      hasCustomProviders: providers.size > 1,
      providers: [...providers].map(([id, config]) => ({ id, name: config.name || id })),
    };
  }

  /** Reads an OpenAI-compatible /models endpoint using the selected service's own authentication. */
  async models(modelProvider: string): Promise<CodexModelCatalog> {
    const { providers } = await this.readConfig();
    const config = providers.get(modelProvider);
    if (!config) throw new AppError('This model provider is no longer configured in Codex.', {
      code: 'CODEX_MODEL_PROVIDER_NOT_FOUND', statusCode: 404,
    });
    if (!config.base_url) throw new AppError('This model provider has no base_url for its models endpoint.', {
      code: 'CODEX_MODEL_CATALOG_UNAVAILABLE', statusCode: 400,
    });
    let url: URL;
    try { url = new URL(config.base_url); }
    catch { throw new AppError('The model provider has an invalid base_url.', { code: 'CODEX_CONFIG_INVALID', statusCode: 400 }); }
    let nativeOpenAICatalog = false;
    if (!['http:', 'https:'].includes(url.protocol)) throw new AppError('The model provider needs an HTTP or HTTPS base_url.', {
      code: 'CODEX_CONFIG_INVALID', statusCode: 400,
    });
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
    for (const [key, value] of Object.entries(config.query_params ?? {})) url.searchParams.set(key, value);

    const headers = new Headers();
    const setHeader = (name: string, value: string) => {
      try { headers.set(name, value); }
      catch {
        // Headers errors can quote their value, which may be a credential.
        throw new AppError('The model provider has an invalid HTTP header.', { code: 'CODEX_CONFIG_INVALID', statusCode: 400 });
      }
    };
    // TOML tables carry parser symbols; only configured string keys are HTTP headers.
    for (const [key, value] of Object.entries(config.http_headers ?? {})) setHeader(key, value);
    for (const [key, variable] of Object.entries(config.env_http_headers ?? {})) {
      const value = this.environment[variable];
      if (!value) throw new AppError(`The model provider requires environment variable ${variable}.`, {
        code: 'CODEX_MODEL_PROVIDER_AUTH_REQUIRED', statusCode: 400,
      });
      setHeader(key, value);
    }
    let token = config.experimental_bearer_token;
    if (config.auth) {
      try {
        const result = await promisify(execFile)(config.auth.command, config.auth.args ?? [], {
          env: this.environment, cwd: config.auth.cwd, timeout: config.auth.timeout_ms ?? 5000, maxBuffer: 64 * 1024,
        });
        token = result.stdout.trim();
      } catch {
        throw new AppError('The model provider authentication command failed.', {
          code: 'CODEX_MODEL_PROVIDER_AUTH_REQUIRED', statusCode: 400,
        });
      }
      if (!token) throw new AppError('The model provider authentication command returned no token.', {
        code: 'CODEX_MODEL_PROVIDER_AUTH_REQUIRED', statusCode: 400,
      });
    } else if (config.env_key && !config.requires_openai_auth) {
      token = this.environment[config.env_key];
      if (!token) throw new AppError(`The model provider requires environment variable ${config.env_key}.`, {
        code: 'CODEX_MODEL_PROVIDER_AUTH_REQUIRED', statusCode: 400,
      });
    } else if (config.requires_openai_auth) {
      // As in Codex, requires_openai_auth takes precedence over env_key.
      // The saved login mode wins over unrelated API keys in the environment.
      let raw = '{}';
      try { raw = await readFile(path.join(this.home, 'auth.json'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let auth: { auth_mode?: string; OPENAI_API_KEY?: string; tokens?: { access_token?: string; account_id?: string } };
      try { auth = JSON.parse(raw) as typeof auth; }
      catch { throw new AppError('Could not read Codex authentication.', { code: 'CODEX_MODEL_PROVIDER_AUTH_REQUIRED', statusCode: 400 }); }
      if (!['apikey', 'api_key'].includes(auth.auth_mode ?? '') && auth.tokens?.access_token) {
        token = auth.tokens.access_token;
        if (auth.tokens.account_id) setHeader('ChatGPT-Account-Id', auth.tokens.account_id);
        // The built-in ChatGPT service exposes Codex's native catalog. A
        // configured proxy explicitly opting into OpenAI auth keeps /models.
        if (modelProvider === 'openai' && url.origin === 'https://api.openai.com' && url.pathname === '/v1/models') {
          url = new URL('https://chatgpt.com/backend-api/codex/models');
          const version = (createRequire(import.meta.url)('@openai/codex/package.json') as { version: string }).version;
          url.searchParams.set('client_version', version);
          nativeOpenAICatalog = true;
        }
      } else token = auth.OPENAI_API_KEY || this.environment.OPENAI_API_KEY;
      if (!token) throw new AppError('No file-backed Codex login or OpenAI API key is available to read this service’s models.', {
        code: 'CODEX_MODEL_PROVIDER_AUTH_REQUIRED', statusCode: 400,
      });
    }
    if (token && !headers.has('Authorization')) setHeader('Authorization', `Bearer ${token}`);
    const signature = createHash('sha256').update(JSON.stringify([url.toString(), [...headers]])).digest('hex');
    const cached = this.cache.get(modelProvider);
    if (cached?.signature === signature && cached.catalog.expiresAt > this.now()) return cached.catalog;
    let response: Response;
    try { response = await this.fetchModels(url, { headers, signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
    catch { throw new AppError('Could not reach this model provider’s models endpoint.', { code: 'CODEX_MODEL_CATALOG_FAILED', statusCode: 502 }); }
    if (!response.ok) throw new AppError(`The model provider’s models endpoint returned HTTP ${response.status}.`, {
      code: 'CODEX_MODEL_CATALOG_FAILED', statusCode: 502,
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new AppError('The models endpoint did not return JSON.', { code: 'CODEX_MODEL_CATALOG_INVALID', statusCode: 502 }); }
    const data = readObjectRecord(body)?.[nativeOpenAICatalog ? 'models' : 'data'];
    const idField = nativeOpenAICatalog ? 'slug' : 'id';
    if (!Array.isArray(data) || data.some((entry) => !readOptionalString(readObjectRecord(entry)?.[idField]))) {
      throw new AppError('The models endpoint must return an OpenAI-compatible data array with model ids.', {
        code: 'CODEX_MODEL_CATALOG_INVALID', statusCode: 502,
      });
    }
    const models = [...new Set(data.filter((entry) => !nativeOpenAICatalog || !entry.visibility || entry.visibility === 'list')
      .map((entry: Record<string, string>) => entry[idField].trim()))];
    const catalog = { modelProvider, models, expiresAt: this.now() + 60_000 };
    this.cache.set(modelProvider, { signature, catalog });
    return catalog;
  }
}

/** Codex routes and runtime controls share one cache without sharing session selections. */
export const codexModelProviderService = new CodexModelProviderService();
