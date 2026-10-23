import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { CodexRateLimitSnapshot, CodexRateLimitsState } from '@/shared/types';

/**
 * The earliest instant at which the cached snapshot is out of date because one
 * of its windows reached `resetsAt`, or null when no deadline applies. Shared
 * with the tests so the arithmetic is asserted once.
 */
function nextExpiryAt(snapshot: CodexRateLimitSnapshot | null): number | null {
  const resets = [snapshot?.weekly?.resetsAt, snapshot?.fiveHour?.resetsAt]
    .filter((value): value is number => typeof value === 'number');
  return resets.length ? Math.min(...resets) * 1000 : null;
}

/** A snapshot is out of date once any reported window has passed its reset instant. */
function isSnapshotExpired(snapshot: CodexRateLimitSnapshot, now: number): boolean {
  return [snapshot.weekly?.resetsAt, snapshot.fiveHour?.resetsAt]
    .some((value) => typeof value === 'number' && value * 1000 <= now);
}

/**
 * Owns the Codex account quota card's state for the settings account panel.
 *
 * Mounting loads only the server's cached snapshot (`GET .../rate-limits`), so
 * opening settings never starts the app-server. `refresh` is the only call that
 * asks the server for a new read, and it disables itself while in flight. Frames
 * from the existing chat websocket keep the card current during chat, and a
 * reconnect re-reads the cache rather than refreshing. `error` is the last
 * refresh failure; the previous snapshot is kept so the card can say it is stale
 * instead of blanking.
 *
 * Used only by the settings agents account panel.
 */
export function useCodexRateLimits(enabled: boolean) {
  // The deployment flag and cached quota as the server reported them. Null until
  // the cache has been read, so the card can hold its content back.
  const [state, setState] = useState<CodexRateLimitsState | null>(null);
  // Becomes true after the first cache read (successful or not), so the card
  // stops showing its loading line. Distinct from a null snapshot, which is the
  // server's real "no quota data yet".
  const [loaded, setLoaded] = useState(false);
  // Disables the refresh button while its own request is outstanding.
  const [refreshing, setRefreshing] = useState(false);
  // Last refresh failure, surfaced explicitly while the previous values stay.
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever an authoritative frame (or an applied refresh) replaces the
  // cache. An HTTP response that started before that change must be discarded,
  // including when the frame cleared the snapshot for a different account.
  const authoritativeVersion = useRef(0);
  // Identifies the newest GET so an older cache read cannot repaint the card.
  const cacheRequestId = useRef(0);
  // Identifies the in-flight refresh so a cache read or reconnect cannot strand
  // the loading state, while repeated clicks still share one request.
  const refreshRequest = useRef<{ id: number; promise: Promise<void> } | null>(null);
  const nextRefreshId = useRef(0);
  // Set on unmount/disable so a late response cannot write into a dead lifecycle.
  const active = useRef(true);
  // Identifies the enabled lifecycle. A request issued before a disable/re-enable
  // must not apply its result to the new lifecycle, even though `active` is true
  // again by the time it lands.
  const lifecycle = useRef(0);

  const applyServerState = useCallback((next: CodexRateLimitsState, version: number) => {
    // A frame that arrived after this request was issued owns the newer truth.
    if (version !== authoritativeVersion.current) return;
    const snapshot = next.snapshot;
    setState({
      ...next,
      // The server flags its own resets, but a long-open page may cross one
      // between responses; never present an expired window as current.
      snapshot: snapshot && isSnapshotExpired(snapshot, Date.now()) ? { ...snapshot, stale: true } : snapshot,
    });
  }, []);

  const loadCache = useCallback(async () => {
    const requestId = ++cacheRequestId.current;
    const versionAtStart = authoritativeVersion.current;
    const lifecycleAtStart = lifecycle.current;
    try {
      const payload = await readApiJson<{ data?: CodexRateLimitsState }>(await api.providers.codexRateLimits());
      if (!active.current || lifecycleAtStart !== lifecycle.current || requestId !== cacheRequestId.current) return;
      applyServerState(payload.data ?? { enabled: false, snapshot: null }, versionAtStart);
      setLoaded(true);
    } catch (loadError) {
      console.error('Error loading Codex rate limits:', loadError);
      if (active.current && lifecycleAtStart === lifecycle.current && requestId === cacheRequestId.current) {
        setLoaded(true);
      }
    }
  }, [applyServerState]);

  // Only an enabled deployment reads anything at all; a disabled one stays inert.
  useEffect(() => {
    lifecycle.current += 1;
    if (!enabled) {
      // Drop any outstanding refresh so a later re-enable starts unlocked; its
      // own `finally` will not unlock a request this lifecycle no longer owns.
      active.current = false;
      refreshRequest.current = null;
      setRefreshing(false);
      return undefined;
    }
    active.current = true;
    void loadCache();
    return () => { active.current = false; };
  }, [enabled, loadCache]);

  const { subscribe, isConnected } = useWebSocket();
  // The context exposes only connection status, so a cache re-read happens on a
  // false→true transition: that is the real "socket recovered" signal.
  const wasConnected = useRef(isConnected);
  useEffect(() => {
    const reconnected = !wasConnected.current && isConnected;
    wasConnected.current = isConnected;
    if (reconnected && enabled) void loadCache();
  }, [enabled, isConnected, loadCache]);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribe((event) => {
      if (event.kind !== 'codex_rate_limits_updated') return;
      // The frame is authoritative: invalidate any cache read already in flight,
      // and apply a clear (null) as the real answer it is.
      authoritativeVersion.current += 1;
      cacheRequestId.current += 1;
      applyServerState({
        enabled: event.enabled === true,
        snapshot: (event.snapshot as CodexRateLimitSnapshot | null) ?? null,
      }, authoritativeVersion.current);
      setLoaded(true);
      setError(null);
    });
  }, [applyServerState, enabled, subscribe]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    // Two clicks in the same tick share one request and one loading window.
    const inFlight = refreshRequest.current;
    if (inFlight) return inFlight.promise;
    const id = ++nextRefreshId.current;
    setRefreshing(true);
    setError(null);
    const versionAtStart = authoritativeVersion.current;
    const lifecycleAtStart = lifecycle.current;
    const promise = (async () => {
      try {
        const payload = await readApiJson<{ data?: CodexRateLimitSnapshot | null }>(await api.providers.refreshCodexRateLimits());
        if (!active.current || lifecycleAtStart !== lifecycle.current || versionAtStart !== authoritativeVersion.current) return;
        // This read is now the authority, so a null result (a cleared account)
        // is applied as a real clear rather than ignored.
        authoritativeVersion.current += 1;
        applyServerState({ enabled: true, snapshot: payload.data ?? null }, authoritativeVersion.current);
        setLoaded(true);
      } catch (refreshError) {
        if (!active.current || lifecycleAtStart !== lifecycle.current) return;
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        // Report the failed action without aging a newer authoritative frame.
        if (versionAtStart !== authoritativeVersion.current) return;
        // The server also flags the cache stale and announces it, but the socket
        // may be down; mark the retained values here so the card never presents a
        // failed refresh as current.
        setState((previous) => previous?.snapshot && !previous.snapshot.stale
          ? { ...previous, snapshot: { ...previous.snapshot, stale: true } }
          : previous);
      } finally {
        // Unlock only this request. A cache re-read or reconnect in the meantime
        // must never leave the button spinning.
        if (refreshRequest.current?.id === id) {
          refreshRequest.current = null;
          if (active.current) setRefreshing(false);
        }
      }
    })();
    refreshRequest.current = { id, promise };
    return promise;
  }, [applyServerState, enabled]);

  // Expiry is a client-side deadline, not a poll: one timer at the nearest reset
  // marks the retained values stale without any RPC or recomputed quota.
  const expiryAt = nextExpiryAt(state?.snapshot ?? null);
  useEffect(() => {
    if (!enabled || expiryAt === null) return undefined;
    // `setTimeout` delays above 2^31-1 ms overflow and fire immediately, which a
    // weekly reset easily exceeds; re-arm in bounded hops until the real instant.
    const MAX_TIMEOUT_MS = 2_147_483_647;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = expiryAt - Date.now();
      if (remaining <= 0) {
        setState((previous) => previous?.snapshot && !previous.snapshot.stale
          ? { ...previous, snapshot: { ...previous.snapshot, stale: true } }
          : previous);
        return;
      }
      timer = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_MS));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [enabled, expiryAt]);

  return {
    enabled: enabled && state?.enabled !== false,
    // The cached snapshot; may be stale, which the card reports explicitly.
    snapshot: state?.snapshot ?? null,
    loaded,
    // A disabled card is never busy, even if a request was abandoned mid-flight.
    refreshing: enabled && refreshing,
    error,
    refresh,
  };
}
