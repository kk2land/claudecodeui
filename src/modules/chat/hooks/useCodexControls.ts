import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useSessionWorkerActivity } from '@/modules/chat/hooks/useSessionWorkerActivity';
import { api } from '@/shared/api';
import { createUuid } from '@/shared/utils';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useProviderCapabilities } from '@/shared/hooks/useProviderCapabilities';
import { hydrateChatDrafts, persistQueuedMessage, readDraftText, readQueuedDelivery, readQueuedMessage, readQueuedMessages, subscribeToChatDrafts, writeDraftText, writeQueuedMessages } from '@/shared/chatDrafts';
import type { CodexControls, CodexControlAction, CodexSessionState, Project, SessionEstablishedContext } from '@/shared/types';

/** Retained control failure; the code is kept only to retire an uncertain Stop on native idle. */
type CodexControlError = { message: string; code?: string };

type Args = {
  enabled: boolean;
  sessionId: string | null;
  project: Project | null;
  options: Record<string, unknown>;
  sendMessage(message: unknown): void;
  onSessionEstablished(sessionId: string, context: SessionEstablishedContext): void;
};

/** ChatInterface owns this controller; all native controls wait for a scoped server acknowledgement. */
export function useCodexControls({ enabled, sessionId, project, options, sendMessage, onSessionEstablished }: Args): CodexControls {
  const { subscribe } = useWebSocket();
  const capabilities = useProviderCapabilities();
  const goalsEnabled = capabilities.codex?.nativeControls?.goal === true;
  // Integration support needs both the adapter's static capability and the real
  // per-session CLI gate; account/model eligibility is still reported by the
  // per-turn prediction snapshot and never assumed here.
  const predictionsImplemented = capabilities.codex?.nativeControls?.predictions === true;
  // Snapshots remain session-scoped so a late response cannot repaint another conversation.
  const [snapshots, setSnapshots] = useState<Record<string, CodexSessionState>>({});
  // A control failure keeps its source so a native idle snapshot can retire only
  // the uncertain Stop alert, never an unrelated model/Goal/steer failure.
  const [errors, setErrors] = useState<Record<string, CodexControlError | null>>({});
  // Outstanding commands disable conflicting controls while keeping the transcript live.
  const [pendingSessions, setPendingSessions] = useState<Set<string>>(new Set());
  // Delivery is read directly from the durable draft store to avoid a stale local copy.
  const delivery = useSyncExternalStore(subscribeToChatDrafts, useCallback(() => sessionId ? readQueuedDelivery(sessionId) : null, [sessionId]), () => null);
  // Opening /goal exposes the editor even when the native thread has no goal yet.
  const [visibleGoals, setVisibleGoals] = useState<Set<string>>(new Set());
  // Returning to the same project after navigation still owns a fresh allocation scope.
  const allocationScope = useMemo(() => ({ enabled, sessionId, projectId: project?.projectId }),
    [enabled, sessionId, project?.projectId]);
  // Only the allocation owned by the current Codex selection can block its controls.
  const [creatingSession, setCreatingSession] = useState<{ scope: typeof allocationScope } | null>(null);
  const creation = useRef<{ scope: typeof allocationScope; promise: Promise<string> | null } | null>(null);
  useEffect(() => {
    creation.current = null;
    return () => { creation.current = null; };
  }, [allocationScope]);
  const pending = useRef(new Map<string, { sessionId: string; synchronize: boolean; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>());
  const optionsRef = useRef(options);
  useEffect(() => { optionsRef.current = options; }, [options]);

  useEffect(() => subscribe((event) => {
    const sid = typeof event.sessionId === 'string' ? event.sessionId : null;
    if (!sid) return;
    if (event.codexState) setSnapshots((old) => ({ ...old, [sid]: event.codexState as CodexSessionState }));
    if (event.provider === 'codex' && event.role === 'user' && event.clientMessageId) void hydrateChatDrafts();
    const nativeState = event.codexState as CodexSessionState | undefined;
    // Only a clean native idle snapshot proves the previous Stop settled.
    const confirmedIdle = nativeState?.runtime === 'app-server' && nativeState.phase === 'idle' && !nativeState.error;
    if (event.kind !== 'control_result') {
      // Text/status/completion events can carry the recovery snapshot; they never
      // write a control error, so only the uncertain Stop alert may be retired.
      if (confirmedIdle) setErrors((old) => old[sid]?.code === 'STOP_NOT_CONFIRMED' ? { ...old, [sid]: null } : old);
      return;
    }
    // The same response can report a failed Stop and an already-recovered idle
    // snapshot. Decide inside one update so the stale failure is not written back.
    setErrors((old) => {
      const failure = event.ok ? null : {
        message: String(event.error ?? 'Control failed'),
        ...(typeof event.code === 'string' && event.code ? { code: event.code } : {}),
      };
      if (failure?.code === 'STOP_NOT_CONFIRMED' && confirmedIdle) return { ...old, [sid]: null };
      return { ...old, [sid]: failure };
    });
    const entry = pending.current.get(String(event.requestId));
    if (entry && entry.sessionId === sid) {
      clearTimeout(entry.timer);
      pending.current.delete(String(event.requestId));
      setPendingSessions(new Set([...pending.current.values()].map((item) => item.sessionId)));
      if (event.ok) entry.resolve(); else entry.reject(new Error(String(event.error ?? 'Control failed')));
    }
    void hydrateChatDrafts();
  }), [subscribe]);

  useEffect(() => () => {
    for (const entry of pending.current.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Chat controls were closed.'));
    }
    pending.current.clear();
  }, []);

  const send = useCallback(async (sid: string, action: unknown, synchronize = false) => {
    // A new automatic state -> goal/get refresh supersedes an earlier one that
    // never got its receipt. Only these read-only reconciliation calls may be
    // dropped: a user mutation keeps waiting for its own receipt, because a
    // successful snapshot cannot prove that mutation was applied.
    if (synchronize) {
      for (const [oldRequestId, entry] of pending.current) {
        if (entry.sessionId !== sid || !entry.synchronize) continue;
        clearTimeout(entry.timer);
        pending.current.delete(oldRequestId);
        entry.reject(new Error('Session state refresh was superseded.'));
      }
    }
    const requestId = createUuid();
    setErrors((old) => ({ ...old, [sid]: null }));
    setPendingSessions((old) => new Set([...old, sid]));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        setPendingSessions(new Set([...pending.current.values()].map((item) => item.sessionId)));
        const error = 'Confirmation pending. Reconnect to check the saved state.';
        setErrors((old) => ({ ...old, [sid]: { message: error } }));
        void hydrateChatDrafts();
        reject(new Error(error));
      }, 40_000);
      pending.current.set(requestId, { sessionId: sid, synchronize, resolve, reject, timer });
      sendMessage({ type: 'chat.control', sessionId: sid, requestId, control: action, options: optionsRef.current });
    });
  }, [sendMessage]);

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    if (!project) throw new Error('Select a project first.');
    if (creation.current?.scope === allocationScope && creation.current.promise) return creation.current.promise;
    const entry: NonNullable<typeof creation.current> = { scope: allocationScope, promise: null };
    creation.current = entry;
    setCreatingSession(entry);
    entry.promise = (async () => {
      let succeeded = false;
      try {
        const response = await api.providers.createSession({ provider: 'codex', projectPath: project.fullPath || project.path || '', initialMessage: '' });
        if (!response.ok) throw new Error('Could not create a Codex session.');
        const body = await response.json();
        const id = body.data?.sessionId;
        if (!id) throw new Error('No session id returned.');
        if (creation.current !== entry) throw new Error('The Codex selection or project changed while creating the session.');
        // The new chat's latest draft must live under its session key before
        // navigation, or switching to Plan mode drops what the user typed.
        const draftScope = `project:${project.projectId}`;
        writeDraftText(id, readDraftText(draftScope));
        writeDraftText(draftScope, '');
        onSessionEstablished(id, { provider: 'codex', project, summary: body.data?.sessionName || 'Codex' });
        succeeded = true;
        return id as string;
      } finally {
        setCreatingSession((current) => current === entry ? null : current);
        if (creation.current === entry && !succeeded) creation.current = null;
      }
    })();
    return entry.promise;
  }, [sessionId, project, onSessionEstablished, allocationScope]);

  useEffect(() => subscribe((event) => {
    if (!enabled || !sessionId || event.kind !== 'websocket_reconnected') return;
    // goal/get also reconciles persisted steer receipts. The server skips native
    // Goal RPCs when disabled, but history recovery must always remain available.
    void send(sessionId, { action: 'state' }, true).then(() => send(sessionId, { action: 'goal', operation: 'get' }, true))
      .then(() => hydrateChatDrafts()).catch(() => {});
  }), [enabled, sessionId, send, subscribe]);

  const control = useCallback(async (action: CodexControlAction | { action: 'queue-resume' } | { action: 'queue-recover'; decision: 'queue' | 'discard' }) => {
    if (!enabled) throw new Error('Select Codex to use this command.');
    let sid = sessionId ?? '';
    try {
      if (action.action === 'goal' && !goalsEnabled) throw new Error('Codex Goals are disabled.');
      sid = await ensureSession();
      if (action.action === 'goal') setVisibleGoals((old) => new Set([...old, sid]));
      await send(sid, action);
    } catch (error) {
      setErrors((old) => ({ ...old, [sid]: { message: error instanceof Error ? error.message : String(error) } }));
      throw error;
    }
  }, [enabled, sessionId, ensureSession, send, goalsEnabled]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let active = true;
    // Restore persisted receipts after subscription, independently of the Goal UI.
    queueMicrotask(() => {
      if (!active) return;
      void send(sessionId, { action: 'state' }, true).then(() => {
        if (active) return send(sessionId, { action: 'goal', operation: 'get' }, true);
      }).catch(() => {});
    });
    return () => { active = false; };
  }, [enabled, sessionId, send]);

  const steer = useCallback(async () => {
    if (!sessionId) return;
    // Only the queue head may be steered: it is the oldest pending turn, and
    // promoting a later entry would reorder what the user queued.
    const message = readQueuedMessage(sessionId);
    const state = snapshots[sessionId];
    if (!message || !state?.turnId) return;
    if (!message.id) {
      message.id = createUuid();
      // Stamp only the head; rewriting the whole queue keeps every later
      // entry untouched and in order.
      writeQueuedMessages(sessionId, [message, ...readQueuedMessages(sessionId).slice(1)]);
    }
    try {
      await persistQueuedMessage(sessionId);
      await send(sessionId, { action: 'steer', messageId: message.id, expectedTurnId: state.turnId });
      await hydrateChatDrafts();
    } catch (error) {
      setErrors((old) => ({ ...old, [sessionId]: { message: error instanceof Error ? error.message : String(error) } }));
      throw error;
    }
  }, [sessionId, snapshots, send]);

  const allocating = Boolean(enabled && !sessionId && creatingSession?.scope === allocationScope);
  // Before a session exists the backend cannot have reported its CLI build, so a
  // first send opts in optimistically; the runtime gates the real protocol after
  // the handshake and never falls back to an ordinary turn on an unknown build.
  const sessionSnapshot = sessionId ? snapshots[sessionId] : undefined;
  const nativeRuntime = sessionSnapshot?.runtime !== 'sdk';
  // Worker activity is its own signal: a native Codex turn or queued prompt never
  // substitutes for a Worker plugin run owned by this exact chat.
  const hasActiveWorkers = useSessionWorkerActivity({
    enabled, native: nativeRuntime, projectId: project?.projectId, sessionId,
  });
  const predictionsSupported = predictionsImplemented && nativeRuntime
    && (sessionSnapshot ? sessionSnapshot.predictionSupported === true : true);
  // A known-incompatible build is reported explicitly instead of silently
  // offering a toggle that could never produce a suggestion.
  const predictionsUnsupported = predictionsImplemented && nativeRuntime
    && Boolean(sessionId) && sessionSnapshot?.predictionSupported === false;
  return { sessionId, goalsEnabled, predictionsSupported, predictionsUnsupported, hasActiveWorkers, goalVisible: visibleGoals.has(sessionId ?? ''), state: sessionId ? snapshots[sessionId] ?? null : null, error: errors[sessionId ?? '']?.message ?? null,
    pending: allocating || pendingSessions.has(sessionId ?? ''), delivery, control, steer };
}
