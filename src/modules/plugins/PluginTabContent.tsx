import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { OPEN_CHAT_TAB_EVENT } from '@/shared/constants';
import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import { SessionOutput } from '@/modules/chat';
import type { Project, ProjectSession } from '@/shared/types';

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
  const [sessionOutput, setSessionOutput] = useState<{ container: HTMLElement; sessionId: string; key: number } | null>(null);
  const sessionOutputKeyRef = useRef(0);
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
          mountSessionOutput(container: HTMLElement, options: { sessionId: string }): () => void {
            if (!(container instanceof HTMLElement)) {
              throw new Error('mountSessionOutput requires a DOM container');
            }
            const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
            if (!sessionId) {
              throw new Error('mountSessionOutput requires a sessionId');
            }
            const key = ++sessionOutputKeyRef.current;
            setSessionOutput({ container, sessionId, key });
            return () => {
              if (!mountedRef.current) return;
              setSessionOutput(current => (current?.key === key ? null : current));
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
    };
  }, [pluginName, plugin?.entry, plugin?.enabled, openSession]); // re-mount when plugin or enabled state changes

  return (
    <div className="relative h-full w-full overflow-auto">
      <div ref={containerRef} className="h-full w-full overflow-auto" />
      {/* Portals keep the viewer inside this tree, so it shares the app's context. */}
      {sessionOutput && createPortal(
        // Keyed by session: switching the mounted session remounts the viewer, so no
        // pending-permission or replay watermark from the previous session survives it.
        <SessionOutput key={sessionOutput.sessionId} sessionId={sessionOutput.sessionId} onOpenSession={openSession} />,
        sessionOutput.container,
      )}
      {loadError && (
        <div className="absolute inset-0 p-4 text-[13px] text-red-600">
          {t('common:misc.pluginLoadFailed', { error: loadError })}
        </div>
      )}
    </div>
  );
}
