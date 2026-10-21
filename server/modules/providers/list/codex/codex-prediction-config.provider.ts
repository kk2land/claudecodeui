import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CodexPredictionConfigResult, CodexPredictionConfiguration } from '@/shared/index.js';
import { readObjectRecord, readOptionalString } from '@/shared/index.js';

/**
 * The only endpoint this adapter reads prediction configuration from.
 *
 * It mirrors the desktop client's `/wham/predictions/config` path, which is
 * served by the ChatGPT backend API. Authentication is attached only because
 * the URL is the verified official origin; nothing here accepts a caller
 * supplied host.
 */
const PREDICTION_CONFIG_URL = 'https://chatgpt.com/backend-api/wham/predictions/config';
const OFFICIAL_ORIGIN = 'https://chatgpt.com';
const SUCCESS_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

/** OAuth material read from Codex's auth store; never logged or persisted. */
type PredictionCredentials = {
  accessToken: string;
  accountId: string | null;
  userId: string | null;
  /** Whether the JWT `exp` has already elapsed; the loader refreshes first. */
  expired: boolean;
  /** Account/token identity used to isolate cached configuration. */
  identity: string;
};

type CachedConfiguration = {
  identity: string;
  expiresAt: number;
  config: CodexPredictionConfiguration;
};

/**
 * Used by CodexAppServerRuntime to load the desktop's signed-in configuration.
 *
 * The loader owns only HTTP, credential reading and validation. It deliberately
 * does not sample, fork, or start turns, and it never refreshes tokens itself:
 * an expired access token or a 401 response asks the injected
 * `refreshCredentials` callback to let app-server's managed `account/read`
 * refresh the store, then re-reads `auth.json`.
 */
export class CodexPredictionConfigProvider {
  private cached: CachedConfiguration | null = null;

  /**
   * @param options.readAuth Reads current OAuth credentials. Injectable so tests
   *   can simulate credential files without writing real secrets.
   * @param options.fetch HTTP implementation; production uses global fetch.
   * @param options.now Clock used for the success-only TTL.
   * @param options.timeoutMs Budget covering headers and body for one request.
   * @param options.ttlMs How long a successfully parsed configuration is reused
   *   for the same account/token identity.
   */
  constructor(private readonly options: {
    readAuth?: () => Promise<PredictionCredentials | null>;
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    ttlMs?: number;
  } = {}) {}

  /**
   * Loads configuration for the current credentials.
   *
   * `refreshCredentials` is called at most once per load, only for an expired
   * access token or an official 401. Failures are never cached, so a later turn
   * retries instead of inheriting a transient outage. Cancellation is honoured
   * across every await, including the credential read and body read.
   */
  async load(input: {
    signal: AbortSignal;
    refreshCredentials: () => Promise<void>;
  }): Promise<CodexPredictionConfigResult> {
    const readAuth = this.options.readAuth ?? readCodexPredictionCredentials;
    const now = this.options.now ?? Date.now;
    input.signal.throwIfAborted();
    let credentials = await readAuth();
    input.signal.throwIfAborted();
    if (!credentials) return { status: 'unavailable', reason: 'ineligible' };
    let refreshed = false;

    // An expired access token asks app-server to rotate it before any request.
    // The loader never writes the token itself; it only re-reads the file.
    if (credentials.expired) {
      const preRefreshIdentity = credentials.identity;
      refreshed = true;
      await input.refreshCredentials();
      input.signal.throwIfAborted();
      credentials = await readAuth();
      input.signal.throwIfAborted();
      if (!credentials || credentials.expired || credentials.identity === preRefreshIdentity) {
        return { status: 'unavailable', reason: 'ineligible' };
      }
    }

    if (this.cached && this.cached.identity === credentials.identity && this.cached.expiresAt > now()) {
      input.signal.throwIfAborted();
      return { status: 'ready', config: this.cached.config };
    }

    // A single fetch + parse, fully bounded as one unit. The timeout and the
    // caller abort cover the headers AND the body in the same scope.
    let result = await this.fetchAndParse(credentials, input.signal);
    input.signal.throwIfAborted();

    if (result.status === 401) {
      if (refreshed) return { status: 'unavailable', reason: 'ineligible' };
      // app-server owns token refresh; re-read the file afterwards. If the
      // identity did not change, the refresh did not help, so stop rather than
      // loop on the same stale account.
      const preRefreshIdentity = credentials.identity;
      await input.refreshCredentials();
      input.signal.throwIfAborted();
      credentials = await readAuth();
      input.signal.throwIfAborted();
      if (!credentials || credentials.expired || credentials.identity === preRefreshIdentity) {
        return { status: 'unavailable', reason: 'ineligible' };
      }
      if (this.cached && this.cached.identity === credentials.identity && this.cached.expiresAt > now()) {
        return { status: 'ready', config: this.cached.config };
      }
      result = await this.fetchAndParse(credentials, input.signal);
      input.signal.throwIfAborted();
    }
    if (result.status !== 200 || result.payload === null) {
      return { status: 'unavailable', reason: 'config_unavailable' };
    }
    const config = parsePredictionConfiguration(result.payload);
    if (!config) return { status: 'unavailable', reason: 'config_unavailable' };
    // Authentication may have changed while the response body was in flight.
    // Neither return nor cache a configuration for the previous identity.
    const currentCredentials = await readAuth();
    input.signal.throwIfAborted();
    if (!currentCredentials || currentCredentials.identity !== credentials.identity) {
      this.cached = null;
      return { status: 'unavailable', reason: 'ineligible' };
    }
    this.cached = {
      identity: credentials.identity,
      expiresAt: now() + Math.max(0, this.options.ttlMs ?? SUCCESS_TTL_MS),
      config,
    };
    return { status: 'ready', config };
  }

  /**
   * Performs one authenticated GET and reads the JSON body entirely within one
   * timeout scope.
   *
   * The AbortController stays armed until the body is fully read, and both the
   * fetch and `response.json()` are raced against it so a never-resolving body
   * cannot outlive the budget.
   */
  private async fetchAndParse(credentials: PredictionCredentials, signal: AbortSignal): Promise<{ status: number; payload: unknown }> {
    const url = new URL(PREDICTION_CONFIG_URL);
    if (url.origin !== OFFICIAL_ORIGIN) throw new Error('Prediction configuration is not an official endpoint.');
    if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    const controller = new AbortController();
    const timeoutMs = Math.max(1, this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.cancellable<Response>(
        (this.options.fetch ?? fetch)(url.toString(), {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${credentials.accessToken}`,
            ...(credentials.accountId ? { 'ChatGPT-Account-ID': credentials.accountId } : {}),
          },
        }),
        controller.signal,
      );
      let payload: unknown = null;
      try {
        payload = await this.cancellable<unknown>(response.json(), controller.signal);
      } catch {
        // Body may be non-JSON (e.g. a 401/error page). Keep the status so the
        // caller can still distinguish a 401 refresh from a generic failure.
        if (controller.signal.aborted) throw controller.signal.reason;
        payload = null;
      }
      return { status: response.status, payload };
    } catch (error) {
      // Any network, HTTP or JSON failure is a non-sensitive configuration
      // failure; the original message may carry host details and never leaves.
      if (controller.signal.aborted) {
        // A caller-directed abort must propagate so the runtime can drop it;
        // a timeout abort is reported as an unavailable configuration.
        if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
        return { status: 0, payload: null };
      }
      void error;
      return { status: 0, payload: null };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  /**
   * Races `promise` against an abort so a hung body (a fake Response whose
   * stream never ends) still settles. A late rejection/fulfilment is observed
   * so no unhandled rejection escapes, and the race listener is detached.
   */
  private cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (reason) => { signal.removeEventListener('abort', onAbort); reject(reason); },
      );
    });
  }
}

/**
 * Validates the remote schema before any value can influence a fork.
 *
 * Unknown extra fields are ignored, matching the desktop parser; a missing
 * required field or an out-of-range sample rate rejects the whole configuration
 * rather than silently enabling predictions with defaults.
 */
function parsePredictionConfiguration(payload: unknown): CodexPredictionConfiguration | null {
  const record = readObjectRecord(payload);
  if (!record) return null;
  if (typeof record.is_enabled !== 'boolean') return null;
  const prompt = readOptionalString(record.prompt);
  const promptVersion = readOptionalString(record.prompt_version);
  if (!prompt || !promptVersion) return null;
  const unsupportedModels = parseStringArray(record.unsupported_models);
  if (unsupportedModels === null) return null;
  const sampleRate = parseRate(record.sample_rate);
  const liveSampleRate = parseRate(record.live_sample_rate);
  if (sampleRate === null || liveSampleRate === null) return null;
  if (typeof record.prediction_reasoning_effort !== 'string') return null;
  return {
    isEnabled: record.is_enabled,
    unsupportedModels,
    sampleRate: sampleRate ?? 1,
    ...(liveSampleRate !== undefined ? { liveSampleRate } : {}),
    prompt,
    promptVersion,
    predictionReasoningEffort: record.prediction_reasoning_effort.trim() || null,
  };
}

/** Returns undefined when absent, null when present but invalid. */
function parseRate(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/** Returns null when the field is present but not an array of strings. */
function parseStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null;
  return [...value];
}

/**
 * Reads the OAuth credentials Codex itself uses, honoring CODEX_HOME.
 *
 * An explicit `auth_mode: "apikey"` store can never reach the ChatGPT backend,
 * even if stale OAuth tokens linger in the file. The selected workspace's
 * `tokens.account_id` takes precedence over the JWT default account, so a
 * workspace switch cannot reuse another account's cached configuration.
 */
async function readCodexPredictionCredentials(): Promise<PredictionCredentials | null> {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  let content: string;
  try {
    content = await readFile(path.join(home, 'auth.json'), 'utf8');
  } catch {
    return null;
  }
  let auth: unknown;
  try {
    auth = JSON.parse(content);
  } catch {
    return null;
  }
  const record = readObjectRecord(auth);
  // An explicit api-key mode (any spelling) is not OAuth and can never reach
  // the ChatGPT backend, even with residual OAuth tokens in the same file.
  if (readOptionalString(record?.auth_mode) === 'apikey' || readOptionalString(record?.auth_mode) === 'api_key') return null;
  const tokens = readObjectRecord(record?.tokens) ?? {};
  const accessToken = readOptionalString(tokens.access_token);
  if (!accessToken) return null;
  const claims = readObjectRecord(readJwtPayload(accessToken));
  const authClaims = readObjectRecord(claims?.['https://api.openai.com/auth']);
  // The workspace's explicit account id wins; fall back to JWT auth claims only
  // when the store does not name one.
  const accountId = readOptionalString(tokens.account_id)
    ?? readOptionalString(authClaims?.chatgpt_account_id)
    ?? readOptionalString(claims?.chatgpt_account_id)
    ?? null;
  const userId = readOptionalString(authClaims?.chatgpt_user_id)
    ?? readOptionalString(authClaims?.user_id)
    ?? readOptionalString(claims?.sub)
    ?? null;
  const exp = readOptionalNumber(claims?.exp);
  const expired = typeof exp === 'number' && exp * 1000 <= Date.now();
  const fingerprint = createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
  return {
    accessToken,
    accountId,
    userId,
    expired,
    identity: `${userId ?? 'unknown'}:${accountId ?? 'no-account'}:${fingerprint}`,
  };
}

/** Reads an optional finite number; returns undefined otherwise. */
function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Decodes a JWT payload without verifying it; the backend remains the authority. */
function readJwtPayload(token: string): unknown {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
