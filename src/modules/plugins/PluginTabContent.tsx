import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { OPEN_CHAT_TAB_EVENT } from '@/shared/constants';
import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import { ConversationOutput, SessionOutput } from '@/modules/chat';
import type { Project, ProjectSession, WorkerConversationMessage } from '@/shared/types';

type PluginTabContentProps = {
  pluginName: string;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
};

type PluginContext = {
  theme: 'dark' | 'light';
  // Plugin contract historically used `name` for the project identifier; we
  // keep that key and populate it from the DB `projectId` so external plugins
  // continue to receive a stable opaque id.
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};

function buildContext(
  isDarkMode: boolean,
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): PluginContext {
  return {
    theme: isDarkMode ? 'dark' : 'light',
    project: selectedProject
      ? {
        name: selectedProject.projectId,
        path: selectedProject.fullPath || selectedProject.path || '',
      }
      : null,
    session: selectedSession
      ? {
        id: selectedSession.id,
        title: selectedSession.title || selectedSession.name || selectedSession.id,
      }
      : null,
  };
}

/**
 * Validated conversation rows from a plugin, read once here at the host boundary so the view never
 * re-checks them. The contract's required fields are enforced: a row without a non-empty `id`, a
 * string `text` or a supported `role` is rejected instead of being given a made-up value.
 */
function readConversationMessages(value: unknown): WorkerConversationMessage[] {
  if (!Array.isArray(value)) {
    throw new Error('mountConversationOutput requires a messages array');
  }
  return value.map((row, index) => {
    const record = row && typeof row === 'object' ? row as Record<string, unknown> : null;
    if (!record) {
      throw new Error(`mountConversationOutput received an invalid message at index ${index}`);
    }
    if (typeof record.id !== 'string' || !record.id) {
      throw new Error(`mountConversationOutput requires a message id at index ${index}`);
    }
    if (typeof record.text !== 'string') {
      throw new Error(`mountConversationOutput requires message text at index ${index}`);
    }
    const role = record.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'error') {
      throw new Error(`mountConversationOutput received an unsupported message role at index ${index}`);
    }
    const message: WorkerConversationMessage = { id: record.id, role, text: record.text };
    if (record.thinking === true) message.thinking = true;
    if (record.streaming === true) message.streaming = true;
    if (typeof record.toolId === 'string') message.toolId = record.toolId;
    if (typeof record.toolName === 'string') message.toolName = record.toolName;
    if (record.toolInput && typeof record.toolInput === 'object' && !Array.isArray(record.toolInput)) {
      message.toolInput = record.toolInput as Record<string, unknown>;
    }
    if (typeof record.toolOutput === 'string') message.toolOutput = record.toolOutput;
    if (record.isError === true) message.isError = true;
    return message;
  });
}

/** Rendered by the project-workspace module to host a plugin's own UI inside its workspace tab. */
export default function PluginTabContent({
  pluginName,
  selectedProject,
  selectedSession,
}: PluginTabContentProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { isDarkMode } = useTheme();
  const { plugins } = usePlugins();

  // Stable refs so effects don't need context values in their dep arrays
  const contextRef = useRef<PluginContext>(buildContext(isDarkMode, selectedProject, selectedSession));
  const contextCallbacksRef = useRef<Set<(ctx: PluginContext) => void>>(new Set());

  const moduleRef = useRef<any>(null);
  const navigate = useNavigate();

  /**
   * A mounted read-only session viewer, published by a plugin through `mountSessionOutput`.
   * It is rendered here, as a portal from this host tree, so the viewer keeps the app's React
   * context — router, theme, socket provider — instead of starting a second root that would have
   * none of it.
   */
  const [sessionOutput, setSessionOutput] = useState<{
    container: HTMLElement;
    sessionId: string;
    /** Forwarded verbatim to the viewer; absent keeps the viewer's own no-poll default. */
    pollIntervalMs?: number;
    key: number;
  } | null>(null);
  const sessionOutputKeyRef = useRef(0);
  /**
   * A mounted read-only conversation view, published through `mountConversationOutput`. Like the
   * session viewer it is portalled from this host tree, so it keeps the app's context; the plugin
   * owns the container's styling, so its element is handed to the view as the scroll target.
   */
  const [conversationOutput, setConversationOutput] = useState<{
    container: HTMLElement;
    provider: string;
    messages: WorkerConversationMessage[];
    key: number;
  } | null>(null);
  const conversationOutputKeyRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const openSession = useCallback((sessionId: string) => {
    const target = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!target) return;
    navigate(`/session/${encodeURIComponent(target)}`);
    // The caller is a plugin panel, so the workspace is still showing that panel's tab. Ask it to
    // reveal the conversation, which is what "opens the session" means to the user.
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_TAB_EVENT));
  }, [navigate]);

  const plugin = plugins.find(p => p.name === pluginName);

  // Keep contextRef current and notify the mounted plugin on every context change
  useEffect(() => {
    const ctx = buildContext(isDarkMode, selectedProject, selectedSession);
    contextRef.current = ctx;

    for (const cb of contextCallbacksRef.current) {
      try { cb(ctx); } catch { /* plugin error — ignore */ }
    }
  }, [isDarkMode, selectedProject, selectedSession]);

  useEffect(() => {
    // Drop any previous plugin's error before this load attempt starts, so a
    // stale overlay never covers a different (or successfully loaded) plugin.
    setLoadError(null);
    if (!containerRef.current || !plugin?.enabled) return;

    let active = true;
    const container = containerRef.current;
    const entryFile = plugin?.entry ?? 'index.js';
    const contextCallbacks = contextCallbacksRef.current;

    (async () => {
      try {
        // Fetch the plugin JS with auth headers (Cloudflare Worker requires auth on all routes).
        // Then import it via a Blob URL so the browser never makes an unauthenticated request.
        const res = await api.plugins.asset(pluginName, entryFile);
        if (!res.ok) throw new Error(`Failed to fetch plugin (HTTP ${res.status})`);
        const jsText = await res.text();
        const blob = new Blob([jsText], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        // @vite-ignore
        const mod = await import(/* @vite-ignore */ blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
        if (!active || !containerRef.current) return;

        moduleRef.current = mod;

        // The host surface handed to the plugin module, distinct from the
        // app's own `api` client that backs `rpc` below.
        const pluginHostApi = {
          get context(): PluginContext { return contextRef.current; },

          onContextChange(cb: (ctx: PluginContext) => void): () => void {
            contextCallbacks.add(cb);
            return () => contextCallbacks.delete(cb);
          },

          async rpc(method: string, path: string, body?: unknown): Promise<unknown> {
            const res = await api.plugins.rpc(pluginName, method, path, body);
            if (!res.ok) {
              const detail = await res.json().catch(() => null) as { error?: string | { message?: string } } | null;
              const message = typeof detail?.error === 'string' ? detail.error : detail?.error?.message;
              throw new Error(message || `RPC error ${res.status}`);
            }
            return res.json();
          },

          // Read-only provider model catalog for plugins whose forms let users
          // pick a model. This is an allowlisted host capability rather than a
          // generic passthrough, so a plugin cannot reach arbitrary endpoints.
          async models(provider: 'codex' | 'dsh'): Promise<unknown> {
            if (provider !== 'codex' && provider !== 'dsh') {
              throw new Error(`Unsupported provider: ${String(provider)}`);
            }
            const res = await api.providers.models(provider);
            if (!res.ok) {
              throw new Error(`Failed to load ${provider} models (HTTP ${res.status})`);
            }
            const body = await res.json() as {
              success?: boolean;
              data?: { provider?: string; models?: unknown };
            };
            if (!body.success || !body.data?.models) {
              throw new Error(`Failed to load ${provider} models`);
            }
            return body.data.models;
          },

          // Read-only Codex inference-service directory for plugins whose forms let
          // users pin a service. Both methods are allowlisted host capabilities; the
          // plugin still persists its own config and never changes the global default.
          async codexModelProviders(): Promise<unknown> {
            const res = await api.providers.codexModelProviders();
            if (!res.ok) {
              throw new Error(`Failed to load Codex model providers (HTTP ${res.status})`);
            }
            const body = await res.json() as { success?: boolean; data?: unknown };
            if (!body.success || !body.data) {
              throw new Error('Failed to load Codex model providers');
            }
            return body.data;
          },

          // Read-only session output for a resident task's detail. The plugin decides where the
          // transcript sits inside its own panel, but never imports host chat components or opens
          // its own socket; disposal is always the plugin's responsibility.
          mountSessionOutput(
            container: HTMLElement,
            options: { sessionId: string; pollIntervalMs?: number },
          ): () => void {
            if (!(container instanceof HTMLElement)) {
              throw new Error('mountSessionOutput requires a DOM container');
            }
            const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
            if (!sessionId) {
              throw new Error('mountSessionOutput requires a sessionId');
            }
            // Validated once here, at the host boundary: plugins pass a refresh cadence only when
            // they need live output, and an omitted value keeps every older plugin unpolled.
            const pollIntervalMs = options?.pollIntervalMs;
            if (
              pollIntervalMs !== undefined
              && (typeof pollIntervalMs !== 'number' || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0)
            ) {
              throw new Error('mountSessionOutput requires a positive finite pollIntervalMs');
            }
            const key = ++sessionOutputKeyRef.current;
            setSessionOutput({ container, sessionId, pollIntervalMs, key });
            return () => {
              if (!mountedRef.current) return;
              setSessionOutput(current => (current?.key === key ? null : current));
            };
          },

          // Read-only conversation a plugin parsed from its own run's event log. The host renders
          // it with the real transcript components instead of letting the plugin ship a renderer;
          // `update` replaces the rows in place, and only the disposer of the current mount can
          // clear it, so a stale plugin controller can never remove a newer view.
          mountConversationOutput(
            container: HTMLElement,
            options: { provider: string; messages: WorkerConversationMessage[] },
          ): { update(messages: WorkerConversationMessage[]): void; dispose(): void } {
            if (!(container instanceof HTMLElement)) {
              throw new Error('mountConversationOutput requires a DOM container');
            }
            const provider = typeof options?.provider === 'string' ? options.provider.trim() : '';
            if (!provider) {
              throw new Error('mountConversationOutput requires a provider');
            }
            const messages = readConversationMessages(options?.messages);
            const key = ++conversationOutputKeyRef.current;
            setConversationOutput({ container, provider, messages, key });
            return {
              update(nextMessages: WorkerConversationMessage[]): void {
                const next = readConversationMessages(nextMessages);
                if (!mountedRef.current) return;
                setConversationOutput(current => (
                  current?.key === key ? { ...current, messages: next } : current
                ));
              },
              dispose(): void {
                if (!mountedRef.current) return;
                setConversationOutput(current => (current?.key === key ? null : current));
              },
            };
          },

          /** Opens the writable session in the app; resident details link to it for input. */
          openSession,

          async codexModelProviderModels(modelProvider: string): Promise<unknown> {
            if (typeof modelProvider !== 'string' || !modelProvider.trim()) {
              throw new Error('A model provider id is required');
            }
            const res = await api.providers.codexModelProviderModels(modelProvider);
            if (!res.ok) {
              throw new Error(`Failed to load models for "${modelProvider}" (HTTP ${res.status})`);
            }
            const body = await res.json() as { success?: boolean; data?: unknown };
            if (!body.success || !body.data) {
              throw new Error(`Failed to load models for "${modelProvider}"`);
            }
            return body.data;
          },
        };

        await mod.mount?.(container, pluginHostApi);
        if (!active) {
          try { mod.unmount?.(container); } catch { /* ignore */ }
          moduleRef.current = null;
          return;
        }
      } catch (err) {
        if (!active) return;
        console.error(`[Plugin:${pluginName}] Failed to load:`, err);
        setLoadError(String(err));
      }
    })();

    return () => {
      active = false;
      try { moduleRef.current?.unmount?.(container); } catch { /* ignore */ }
      contextCallbacks.clear();
      moduleRef.current = null;
      setSessionOutput(null);
      setConversationOutput(null);
    };
  }, [pluginName, plugin?.entry, plugin?.enabled, openSession]); // re-mount when plugin or enabled state changes

  return (
    <div className="relative h-full w-full overflow-auto">
      <div ref={containerRef} className="h-full w-full overflow-auto" />
      {/* Portals keep the viewer inside this tree, so it shares the app's context. */}
      {sessionOutput && createPortal(
        // Keyed by session: switching the mounted session remounts the viewer, so no
        // pending-permission or replay watermark from the previous session survives it.
        <SessionOutput
          key={sessionOutput.sessionId}
          sessionId={sessionOutput.sessionId}
          pollIntervalMs={sessionOutput.pollIntervalMs}
          onOpenSession={openSession}
        />,
        sessionOutput.container,
      )}
      {conversationOutput && createPortal(
        // Keyed by mount, not by provider: a re-mount always starts a fresh transcript with the
        // newest row in view, and an older controller's updates land on a state it no longer owns.
        <ConversationOutput
          key={conversationOutput.key}
          provider={conversationOutput.provider}
          messages={conversationOutput.messages}
          scrollContainer={conversationOutput.container}
        />,
        conversationOutput.container,
      )}
      {loadError && (
        <div className="absolute inset-0 p-4 text-[13px] text-red-600">
          {t('common:misc.pluginLoadFailed', { error: loadError })}
        </div>
      )}
    </div>
  );
}
