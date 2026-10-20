import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { readDraftText, writeDraftText } from '@/shared/chatDrafts';
import { useProviderCapabilities } from '@/shared/hooks/useProviderCapabilities';
import type { LLMProvider, Project, ProviderRuntimeAction, ProviderRuntimeControls, ProviderRuntimeState, SessionEstablishedContext } from '@/shared/types';

type Args = {
  provider: LLMProvider;
  sessionId: string | null;
  project: Project | null;
  newSessionTrigger?: number;
  onSessionEstablished(sessionId: string, context: SessionEstablishedContext): void;
};

type PreparedSession = { id: string; establish(): boolean };

/** ChatInterface uses this controller only for adapters advertising application-level runtime management. */
export function useProviderRuntimeControls({ provider, sessionId, project, newSessionTrigger = 0, onSessionEstablished }: Args): ProviderRuntimeControls {
  const capabilities = useProviderCapabilities()[provider]?.runtimeManagement;
  const available = Boolean(capabilities);
  const scope = `${provider}:${sessionId ?? `new:${project?.projectId ?? ''}:${newSessionTrigger}`}`;
  const currentScope = useRef<string | null>(scope);
  useLayoutEffect(() => {
    currentScope.current = scope;
    return () => { currentScope.current = null; };
  }, [scope]);
  // Server snapshots stay scoped so a late poll cannot repaint another session or provider.
  const [snapshots, setSnapshots] = useState<Record<string, ProviderRuntimeState>>({});
  // Action failures remain visible until another explicit action or a successful retry.
  const [errors, setErrors] = useState<Record<string, { message: string; action: boolean } | null>>({});
  // Mutation acknowledgements disable conflicting controls without blocking other sessions.
  const [pendingScopes, setPendingScopes] = useState<Set<string>>(new Set());
  const mutations = useRef(new Map<string, Promise<void>>());
  const versions = useRef(new Map<string, number>());
  // Retain the allocation after adoption for sends still awaiting attachment uploads.
  const creation = useRef<{ scope: string; promise: Promise<PreparedSession> } | null>(null);

  const ensureSession = useCallback(async (initialMessage: string): Promise<PreparedSession> => {
    if (sessionId) return { id: sessionId, establish: () => currentScope.current === scope };
    if (!project) throw new Error('Select a project first.');
    if (creation.current?.scope !== scope) {
      const promise = (async () => {
        const body = await readApiJson<{ data: { sessionId: string; sessionName?: string } }>(await api.providers.createSession({
          provider, projectPath: project.fullPath || project.path || '', initialMessage,
        }));
        const id = body.data?.sessionId;
        if (!id) throw new Error('No session id returned.');
        let established = false;
        return {
          id,
          establish() {
            if (currentScope.current !== scope && currentScope.current !== `${provider}:${id}`) return false;
            if (!established) {
              established = true;
              // The new chat's latest draft must exist under its session key before navigation.
              const draftScope = `project:${project.projectId}`;
              writeDraftText(id, readDraftText(draftScope));
              writeDraftText(draftScope, '');
              onSessionEstablished(id, { provider, project, summary: body.data.sessionName?.trim() || initialMessage });
            }
            return true;
          },
        };
      })();
      creation.current = { scope, promise };
      void promise.catch(() => { if (creation.current?.promise === promise) creation.current = null; });
    }
    return creation.current.promise;
  }, [sessionId, scope, project, provider, onSessionEstablished]);

  useEffect(() => {
    if (!available) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      if (!mutations.current.has(scope)) {
        const version = (versions.current.get(scope) ?? 0) + 1;
        versions.current.set(scope, version);
        try {
          const body = await readApiJson<{ data: ProviderRuntimeState }>(
            await api.providers.runtimeState(provider, sessionId, { signal: abort.signal }),
          );
          if (active && versions.current.get(scope) === version) {
            setSnapshots((old) => ({ ...old, [scope]: body.data }));
            setErrors((old) => old[scope] && !old[scope].action ? { ...old, [scope]: null } : old);
          }
        } catch (error) {
          if (active && versions.current.get(scope) === version) {
            setErrors((old) => old[scope]?.action ? old : {
              ...old, [scope]: { message: error instanceof Error ? error.message : String(error), action: false },
            });
          }
        }
      }
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { active = false; abort.abort(); clearTimeout(timer); };
  }, [available, provider, sessionId, scope]);

  const control = useCallback((action: ProviderRuntimeAction): Promise<void> => {
    if (!available) return Promise.resolve();
    const pending = mutations.current.get(scope);
    if (pending) return pending;
    versions.current.set(scope, (versions.current.get(scope) ?? 0) + 1);
    setErrors((old) => ({ ...old, [scope]: null }));
    // Install the mutation before allocation starts so sends can await the whole operation.
    const operation = Promise.resolve().then(async () => {
      try {
        const session = await ensureSession('');
        const body = await readApiJson<{ data: ProviderRuntimeState }>(await api.providers.controlRuntime(provider, session.id, action));
        versions.current.set(scope, (versions.current.get(scope) ?? 0) + 1);
        setSnapshots((old) => ({ ...old, [scope]: body.data, [`${provider}:${session.id}`]: body.data }));
        session.establish();
      } catch (error) {
        setErrors((old) => ({ ...old, [scope]: { message: error instanceof Error ? error.message : String(error), action: true } }));
        throw error;
      } finally {
        mutations.current.delete(scope);
        setPendingScopes(new Set(mutations.current.keys()));
      }
    });
    mutations.current.set(scope, operation);
    setPendingScopes(new Set(mutations.current.keys()));
    return operation;
  }, [available, scope, provider, ensureSession]);

  const prepareSend = useCallback(async (initialMessage: string): Promise<string | null> => {
    if (currentScope.current !== scope && creation.current?.scope !== scope) return null;
    const session = await ensureSession(initialMessage);
    // A control started during session allocation must finish before the first prompt.
    let pending: Promise<void> | undefined;
    while ((pending = mutations.current.get(scope) ?? mutations.current.get(`${provider}:${session.id}`))) await pending;
    return session.establish() ? session.id : null;
  }, [scope, provider, ensureSession]);

  return {
    sessionId, available, modes: capabilities?.modes ?? [], stoppableModes: capabilities?.stoppableModes ?? [],
    state: snapshots[scope] ?? null, pending: pendingScopes.has(scope), error: errors[scope]?.message ?? null, control, prepareSend,
  };
}
