import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { hydrateChatDrafts, persistQueuedMessage, readQueuedDelivery, readQueuedMessage, subscribeToChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';
import type { CodexControls, CodexControlAction, CodexSessionState, Project, SessionEstablishedContext } from '@/shared/types';

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
  // Snapshots remain session-scoped so a late response cannot repaint another conversation.
  const [snapshots, setSnapshots] = useState<Record<string, CodexSessionState>>({});
  // A control failure belongs to the action, independently of the model's running state.
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  // Outstanding commands disable conflicting controls while keeping the transcript live.
  const [pendingSessions, setPendingSessions] = useState<Set<string>>(new Set());
  // Delivery is read directly from the durable draft store to avoid a stale local copy.
  const delivery = useSyncExternalStore(subscribeToChatDrafts, useCallback(() => sessionId ? readQueuedDelivery(sessionId) : null, [sessionId]), () => null);
  // Opening /goal exposes the editor even when the native thread has no goal yet.
  const [visibleGoals, setVisibleGoals] = useState<Set<string>>(new Set());
  // Session allocation is itself a pending action, before a transport request id exists.
  const [creatingSession, setCreatingSession] = useState(false);
  const creation = useRef<{ projectId: string; promise: Promise<string> } | null>(null);
  useEffect(() => { if (sessionId) creation.current = null; }, [sessionId]);
  const pending = useRef(new Map<string, { sessionId: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>());
  const optionsRef = useRef(options);
  useEffect(() => { optionsRef.current = options; }, [options]);

  useEffect(() => subscribe((event) => {
    const sid = typeof event.sessionId === 'string' ? event.sessionId : null;
    if (!sid) return;
    if (event.codexState) setSnapshots((old) => ({ ...old, [sid]: event.codexState as CodexSessionState }));
    if (event.provider === 'codex' && event.role === 'user' && event.clientMessageId) void hydrateChatDrafts();
    if (event.kind !== 'control_result') return;
    setErrors((old) => ({ ...old, [sid]: event.ok ? null : String(event.error ?? 'Control failed') }));
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

  const send = useCallback(async (sid: string, action: unknown) => {
    const requestId = crypto.randomUUID();
    setErrors((old) => ({ ...old, [sid]: null }));
    setPendingSessions((old) => new Set([...old, sid]));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        setPendingSessions(new Set([...pending.current.values()].map((item) => item.sessionId)));
        const error = 'Confirmation pending. Reconnect to check the saved state.';
        setErrors((old) => ({ ...old, [sid]: error }));
        void hydrateChatDrafts();
        reject(new Error(error));
      }, 40_000);
      pending.current.set(requestId, { sessionId: sid, resolve, reject, timer });
      sendMessage({ type: 'chat.control', sessionId: sid, requestId, control: action, options: optionsRef.current });
    });
  }, [sendMessage]);

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    if (!project) throw new Error('Select a project first.');
    if (creation.current?.projectId === project.projectId) return creation.current.promise;
    setCreatingSession(true);
    const promise = (async () => {
      try {
        const response = await api.providers.createSession({ provider: 'codex', projectPath: project.fullPath || project.path || '', initialMessage: '' });
        if (!response.ok) throw new Error('Could not create a Codex session.');
        const body = await response.json();
        const id = body.data?.sessionId;
        if (!id) throw new Error('No session id returned.');
        onSessionEstablished(id, { provider: 'codex', project, summary: body.data?.sessionName || 'Codex' });
        return id as string;
      } catch (error) {
        creation.current = null;
        throw error;
      } finally { setCreatingSession(false); }
    })();
    creation.current = { projectId: project.projectId, promise };
    return promise;
  }, [sessionId, project, onSessionEstablished]);

  useEffect(() => subscribe((event) => {
    if (!enabled || !sessionId || event.kind !== 'websocket_reconnected') return;
    // Re-read native receipts as well as the run snapshot after a lost steer ACK.
    void send(sessionId, { action: 'state' }).then(() => send(sessionId, { action: 'goal', operation: 'get' }))
      .then(() => hydrateChatDrafts()).catch(() => {});
  }), [enabled, sessionId, send, subscribe]);

  const control = useCallback(async (action: CodexControlAction | { action: 'queue-resume' } | { action: 'queue-recover'; decision: 'queue' | 'discard' }) => {
    if (!enabled) throw new Error('Select Codex to use this command.');
    let sid = sessionId ?? '';
    try {
      sid = await ensureSession();
      if (action.action === 'goal') setVisibleGoals((old) => new Set([...old, sid]));
      await send(sid, action);
    } catch (error) {
      setErrors((old) => ({ ...old, [sid]: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }, [enabled, sessionId, ensureSession, send]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let active = true;
    // Query after subscription is installed; state restoration is a transport side effect.
    queueMicrotask(() => {
      if (!active) return;
      void send(sessionId, { action: 'state' }).then(() => {
        if (active) return send(sessionId, { action: 'goal', operation: 'get' });
      }).catch(() => {});
    });
    return () => { active = false; };
  }, [enabled, sessionId, send]);

  const steer = useCallback(async () => {
    if (!sessionId) return;
    const message = readQueuedMessage(sessionId);
    const state = snapshots[sessionId];
    if (!message || !state?.turnId) return;
    if (!message.id) {
      message.id = crypto.randomUUID();
      writeQueuedMessage(sessionId, message);
    }
    try {
      await persistQueuedMessage(sessionId);
      await send(sessionId, { action: 'steer', messageId: message.id, expectedTurnId: state.turnId });
      await hydrateChatDrafts();
    } catch (error) {
      setErrors((old) => ({ ...old, [sessionId]: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }, [sessionId, snapshots, send]);

  return { sessionId, goalVisible: visibleGoals.has(sessionId ?? ''), state: sessionId ? snapshots[sessionId] ?? null : null, error: errors[sessionId ?? ''] ?? null,
    pending: creatingSession || pendingSessions.has(sessionId ?? ''), delivery, control, steer };
}
