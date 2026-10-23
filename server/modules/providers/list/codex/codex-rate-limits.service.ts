import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import type { AnyRecord, CodexRateLimitSnapshot, CodexRateLimitWindow, CodexRateLimitsState, CodexRpcClient } from '@/shared/index.js';
import { AppError, isCodexRateLimitsEnabled } from '@/shared/index.js';

/** Codex reports its weekly quota as seven days of minutes. */
const WEEKLY_WINDOW_DURATION_MINS = 10_080;
/** Codex reports its short rolling quota as five hours of minutes. */
const FIVE_HOUR_WINDOW_DURATION_MINS = 300;

/**
 * One `codex_rate_limits_updated` frame the service hands to a registered
 * broadcaster. `snapshot` is null when the cached quota must be cleared because
 * the signed-in account changed.
 */
type CodexRateLimitsEvent = {
  kind: 'codex_rate_limits_updated';
  enabled: true;
  snapshot: CodexRateLimitSnapshot | null;
};

type ReadWindows = {
  weekly: CodexRateLimitWindow | null;
  fiveHour: CodexRateLimitWindow | null;
};

type ParsedWindows = ReadWindows & {
  /**
   * True when a window matching weekly or five-hour duration carried numbers
   * this service cannot trust. Distinct from a legitimately absent window,
   * which is only `null`.
   */
  malformed: boolean;
};

/** Codex returns Unix seconds for `resetsAt`; the wire contract keeps that unit. */
function readResetsAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Keeps a couple of decimals so a fractional remaining percentage is not rounded to a lie. */
function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Remaining quota is the inverse of `usedPercent`, clamped and never invented when the field is invalid. */
function readRemainingPercent(window: AnyRecord): number | null {
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  return roundPercent(Math.min(100, Math.max(0, 100 - usedPercent)));
}

/**
 * True once a window's reset instant has passed. The window's reported value is
 * kept as-is: an expired window is never treated as a full quota, only as stale.
 */
export function isCodexWindowExpired(window: CodexRateLimitWindow | null, nowMs: number): boolean {
  return window?.resetsAt !== null && window?.resetsAt !== undefined && window.resetsAt * 1000 <= nowMs;
}

/** Returns the snapshot with `stale` raised when either window is past its reset time. */
function withExpiry(snapshot: CodexRateLimitSnapshot, nowMs: number): CodexRateLimitSnapshot {
  if (snapshot.stale || (!isCodexWindowExpired(snapshot.weekly, nowMs) && !isCodexWindowExpired(snapshot.fiveHour, nowMs))) {
    return snapshot;
  }
  return { ...snapshot, stale: true };
}

/**
 * Picks the quota bucket that belongs to the Codex account.
 *
 * The documented payload prefers `rateLimitsByLimitId.codex`. A bare
 * `rateLimits` bucket is only Codex's when it names no other limit id: an
 * explicit `limitId` such as a review or image bucket must never overwrite the
 * account's quota cache.
 */
function resolveCodexBucket(payload: AnyRecord | null | undefined): AnyRecord | null {
  if (!payload || typeof payload !== 'object') return null;
  const byLimitId = payload.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === 'object') {
    const entries = Object.entries(byLimitId as AnyRecord);
    const named = entries.find(([key, value]) => key === 'codex' && value && typeof value === 'object');
    const namedByField = entries.find(([, value]) => value && typeof value === 'object' && (value as AnyRecord).limitId === 'codex');
    const bucket = named?.[1] ?? namedByField?.[1];
    if (bucket && typeof bucket === 'object') return bucket as AnyRecord;
  }
  const single = payload.rateLimits;
  if (single && typeof single === 'object') {
    const limitId = (single as AnyRecord).limitId;
    if (limitId === undefined || limitId === null || limitId === 'codex') return single as AnyRecord;
  }
  return null;
}

/**
 * Splits one Codex bucket into weekly and five-hour windows by duration rather
 * than by the primary/secondary field names, which Codex may swap.
 *
 * A bucket with no matching window is legitimate (the account simply reports
 * neither quota) and yields empty windows. Only a window whose duration is one
 * of ours but whose numbers are unusable is reported as malformed.
 */
function parseWindows(bucket: AnyRecord): ParsedWindows {
  const windows: ParsedWindows = { weekly: null, fiveHour: null, malformed: false };
  for (const [key, value] of Object.entries(bucket)) {
    if (key === 'limitId') continue;
    // A null bucket slot is an absent window, not a malformed one.
    if (!value || typeof value !== 'object') continue;
    const entry = value as AnyRecord;
    const durationMins = entry.windowDurationMins;
    if (typeof durationMins !== 'number' || !Number.isFinite(durationMins)) continue;
    const target = durationMins === WEEKLY_WINDOW_DURATION_MINS
      ? 'weekly'
      : durationMins === FIVE_HOUR_WINDOW_DURATION_MINS ? 'fiveHour' : null;
    // Another legitimate duration belongs to a window this card does not show.
    if (!target) continue;
    const remainingPercent = readRemainingPercent(entry);
    if (remainingPercent === null) {
      windows.malformed = true;
      continue;
    }
    if (!windows[target]) {
      windows[target] = { remainingPercent, resetsAt: readResetsAt(entry.resetsAt) };
    }
  }
  return windows;
}


type RateLimitsState = {
  snapshot: CodexRateLimitSnapshot | null;
  /**
   * Bumped by every accepted notification, exit and account change. A read
   * captures it before its RPC and discards its own result when it changed, so
   * a late reply can never overwrite newer state.
   */
  version: number;
  /** Bumped by `account/updated`; a read from a previous account is discarded even if no notification arrived. */
  accountGeneration: number;
};

/**
 * Caches the signed-in Codex account's quota for the settings account card.
 *
 * The service subscribes to the shared app-server transport when this module is
 * evaluated, so quota notifications are captured during ordinary chat use
 * without opening the settings page and without starting a process. It never
 * polls and never keeps the app-server alive: the read RPC is sent only by an
 * explicit refresh, and the cache lives in memory only.
 *
 * Consumers: the providers routes (GET cache and POST refresh) and the
 * `server/index.ts` startup wiring that broadcasts `codex_rate_limits_updated`
 * through the existing authenticated chat websocket.
 */
export class CodexRateLimitsService {
  private state: RateLimitsState = { snapshot: null, version: 0, accountGeneration: 0 };
  private refreshing: Promise<CodexRateLimitSnapshot | null> | null = null;
  private readonly listeners = new Set<(event: CodexRateLimitsEvent) => void>();

  constructor(
    private readonly client: CodexRpcClient = codexAppServerTransport,
    private readonly now: () => number = Date.now,
    private readonly enabled: () => boolean = isCodexRateLimitsEnabled,
  ) {
    // Registered eagerly at module load: the transport delivers quota updates
    // only while a listener exists, and normal app-server chat must populate the
    // cache. Registering does not spawn or keep a child process alive.
    client.onNotification((frame) => this.onNotification(frame));
    client.onExit(() => this.onExit());
  }

  /** Returns the cached state without any RPC, so a settings mount never starts a process. */
  getState(): CodexRateLimitsState {
    // A disabled deployment reports no quota at all: nothing can be cached while
    // the flag is off, and the payload must not imply otherwise.
    if (!this.enabled()) return { enabled: false, snapshot: null };
    // Expiry is evaluated against the request time, not only when the snapshot
    // was stored, so a page that loads after a reset sees it as stale.
    const snapshot = this.state.snapshot ? withExpiry({ ...this.state.snapshot }, this.now()) : null;
    return { enabled: true, snapshot };
  }

  /** Registers a bearer-safe broadcaster; the websocket module owns the actual socket fan-out. */
  subscribe(listener: (event: CodexRateLimitsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Asks the app-server for the current quota and updates the cache.
   *
   * Concurrent refreshes share one in-flight RPC. A failure keeps the previous
   * windows (marked stale) and throws a clear error; a read that raced a newer
   * notification, an exit or an account change is dropped rather than applied.
   */
  async refresh(): Promise<CodexRateLimitSnapshot | null> {
    if (!this.enabled()) {
      throw new AppError('Codex rate limits are disabled.', {
        code: 'CODEX_RATE_LIMITS_DISABLED', statusCode: 403,
      });
    }
    if (!this.refreshing) {
      this.refreshing = this.read().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async read(): Promise<CodexRateLimitSnapshot | null> {
    const startedVersion = this.state.version;
    const startedGeneration = this.state.accountGeneration;
    try {
      const result = await this.client.request<AnyRecord>('account/rateLimits/read');
      const bucket = resolveCodexBucket(result);
      // A response that changed accounts or lost to a newer notification must
      // never repaint the cache; the newest state already owns it.
      if (startedGeneration !== this.state.accountGeneration || startedVersion !== this.state.version) {
        return this.state.snapshot;
      }
      if (!bucket) {
        throw new AppError('Codex returned no account rate limit bucket.', {
          code: 'CODEX_RATE_LIMITS_UNAVAILABLE', statusCode: 502,
        });
      }
      const windows = parseWindows(bucket);
      // A window of our duration whose numbers cannot be read is a protocol
      // answer this service must not turn into a fabricated quota.
      if (windows.malformed) {
        throw new AppError('Codex returned unusable rate limit numbers.', {
          code: 'CODEX_RATE_LIMITS_INVALID', statusCode: 502,
        });
      }
      // No matching window is legitimate: an empty snapshot lets the card show
      // that the weekly quota is unavailable rather than inventing one.
      const snapshot: CodexRateLimitSnapshot = withExpiry(
        { weekly: windows.weekly, fiveHour: windows.fiveHour, updatedAt: this.now(), stale: false },
        this.now(),
      );
      this.state = { ...this.state, snapshot, version: startedVersion + 1 };
      this.broadcast(snapshot);
      return snapshot;
    } catch (error) {
      // Stale only applies to a cache that is still the one this read started
      // against; a newer notification or account owns the state now and keeps it
      // fresh. The failure is still reported to the caller either way.
      if (startedGeneration === this.state.accountGeneration && startedVersion === this.state.version) {
        this.markStale();
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(`Codex rate limit refresh failed: ${message}`, {
        code: 'CODEX_RATE_LIMITS_REFRESH_FAILED', statusCode: 502, details: { cause: message },
      });
    }
  }

  private onNotification(frame: { method?: string; params?: AnyRecord }): void {
    if (!this.enabled() || !frame.method) return;
    if (frame.method === 'account/updated') {
      // A different sign-in must not inherit the previous account's quota.
      this.state = { snapshot: null, version: this.state.version + 1, accountGeneration: this.state.accountGeneration + 1 };
      this.broadcast(null);
      return;
    }
    if (frame.method !== 'account/rateLimits/updated') return;
    const bucket = resolveCodexBucket(frame.params);
    // Notifications for other buckets are ignored and never replace the cache.
    if (!bucket) return;
    const windows = parseWindows(bucket);
    // A malformed notification must never replace a good cache. An empty but
    // well-formed bucket is a real answer (quota absent), so it is accepted.
    if (windows.malformed) return;
    const snapshot: CodexRateLimitSnapshot = withExpiry(
      { weekly: windows.weekly, fiveHour: windows.fiveHour, updatedAt: this.now(), stale: false },
      this.now(),
    );
    this.state = { ...this.state, snapshot, version: this.state.version + 1 };
    this.broadcast(snapshot);
  }

  private onExit(): void {
    // Even without a cached snapshot, an in-flight read belongs to the dead
    // process and must not become a fresh value afterwards, so always bump the
    // version and keep the last windows only to flag them stale.
    const snapshot = this.state.snapshot && !this.state.snapshot.stale
      ? { ...this.state.snapshot, stale: true }
      : this.state.snapshot;
    this.state = { snapshot, version: this.state.version + 1, accountGeneration: this.state.accountGeneration };
    if (snapshot) this.broadcast(snapshot);
  }

  /** Keeps the last known windows and flags them stale instead of resetting to a full quota. */
  private markStale(): void {
    const snapshot = this.state.snapshot;
    if (!snapshot || snapshot.stale) return;
    this.state = { ...this.state, snapshot: { ...snapshot, stale: true }, version: this.state.version + 1 };
    this.broadcast(this.state.snapshot);
  }

  private broadcast(snapshot: CodexRateLimitSnapshot | null): void {
    if (!this.enabled()) return;
    for (const listener of this.listeners) {
      try {
        listener({ kind: 'codex_rate_limits_updated', enabled: true, snapshot: snapshot ? { ...snapshot } : null });
      } catch {
        // A failed broadcast must never break quota tracking or the app-server.
      }
    }
  }
}

/** Providers routes and server startup share this single in-memory quota cache. */
export const codexRateLimitsService = new CodexRateLimitsService();
