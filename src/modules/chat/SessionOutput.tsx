import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';

import { api } from '@/shared/api';
import type { LLMProvider, ProjectSession } from '@/shared/types';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useSessionOutputStream } from '@/modules/chat/hooks/useSessionOutputStream';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';

type SessionOutputProps = {
  sessionId: string;
  /**
   * Reads the provider from a session projection when the caller already has one. Without it the
   * viewer falls back to the provider stamped on the transcript rows it renders, so it never needs
   * the full chat interface (composer, provider settings, model selection) to display output.
   */
  session?: ProjectSession | null;
  /** Opens the writable session; supplied by the host that mounted the viewer. */
  onOpenSession?: (sessionId: string) => void;
  className?: string;
};

/**
 * The provider to stamp rows with, in order of authority: the caller's session projection, the
 * session lookup, then a row that already carries one.
 *
 * A live-only row is the weakest source, so it is only read after the lookup: a DSH session whose
 * first visible frame is a `stream_delta` must not be rendered as Codex just because the fallback
 * here ran before the session was read.
 */
function readProvider(
  session: ProjectSession | null | undefined,
  lookedUp: LLMProvider | null,
  messages: Array<{ provider?: string }>,
): LLMProvider | null {
  const fromSession = session?.provider ?? session?.__provider;
  if (typeof fromSession === 'string') return fromSession as LLMProvider;
  if (lookedUp) return lookedUp;
  const fromMessage = messages.find((message) => typeof message.provider === 'string')?.provider;
  return (fromMessage as LLMProvider | undefined) ?? null;
}

/**
 * Read-only transcript for one session: history plus the half-finished output of a run that is
 * still going. Exported by the chat module for the plugins module, which mounts it through the
 * plugin host capability `mountSessionOutput` so a resident task's detail can show what its
 * session is doing without linking away or polling the transcript.
 *
 * It deliberately owns its own session store instance and socket listener: the foreground chat
 * keeps its own, so opening one beside the other cannot duplicate or cross-append rows.
 */
export function SessionOutput({ sessionId, session = null, onOpenSession, className }: SessionOutputProps) {
  const store = useSessionStore();
  const messages = store.getMessages(sessionId);
  // The session's real provider, read once from the existing lookup route. It is the only
  // authoritative answer when the caller mounts the viewer with just a session id.
  const [lookedUpProvider, setLookedUpProvider] = useState<LLMProvider | null>(null);
  useEffect(() => {
    if (session?.provider || session?.__provider) return;
    let live = true;
    void api.sessionDetails(sessionId)
      .then(async (response) => (response.ok ? await response.json() : null))
      .then((payload: { data?: { provider?: unknown } } | null) => {
        const provider = payload?.data?.provider;
        if (live && typeof provider === 'string' && provider.trim()) {
          setLookedUpProvider(provider as LLMProvider);
        }
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [session?.provider, session?.__provider, sessionId]);
  const provider = readProvider(session, lookedUpProvider, messages) ?? 'codex';
  const { pendingPermissions, replayComplete } = useSessionOutputStream({ sessionId, store, provider });
  // True while an older history page is being read, which disables the button instead of letting
  // a second click race the first.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const { hasMore, total } = store.getSessionSlot(sessionId) ?? { hasMore: false, total: 0 };
  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      await store.fetchMore(sessionId);
    } catch (error) {
      console.error('[SessionOutput] Failed to load older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, sessionId, store]);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const chatMessages = useMemo(() => normalizedToChatMessages(messages), [messages]);
  return (
    <TranscriptRenderContext.Provider value={{ isExporting: false }}>
      <MarkdownWorkspaceContext.Provider value={{ projectId: null }}>
        <div className={className ?? 'flex h-full min-h-0 flex-col'}>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span>只读输出 · 实时</span>
            {onOpenSession && (
              <button
                type="button"
                onClick={() => onOpenSession(sessionId)}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground hover:bg-muted"
              >
                打开会话
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {pendingPermissions.length > 0 && (
            <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span className="min-w-0 flex-1">
                会话正在等待 {pendingPermissions.length} 个工具权限确认。只读视图不能代为确认，
                {onOpenSession ? (
                  <button
                    type="button"
                    onClick={() => onOpenSession(sessionId)}
                    className="ml-1 underline underline-offset-2"
                  >
                    打开会话处理
                  </button>
                ) : ' 请打开会话处理。'}
              </span>
            </div>
          )}
          {!replayComplete && (
            <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
              输出有缺口，正在从会话历史补齐…
            </div>
          )}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {/* The first page is only the tail; older pages stay behind this control rather
                than being presented as the whole transcript. */}
            {hasMore && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                  className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-60"
                >
                  {loadingOlder ? '正在加载更早消息…' : '加载更早消息'}
                </button>
              </div>
            )}
            {!hasMore && chatMessages.length > 0 && total > chatMessages.length && (
              <p className="text-center text-xs text-muted-foreground">已到最早一条</p>
            )}
            {chatMessages.length === 0 && (
              <p className="text-xs text-muted-foreground">这个会话还没有输出。</p>
            )}
            {chatMessages.map((message, index) => (
              <MessageComponent
                key={String(message.id ?? index)}
                message={message}
                prevMessage={index > 0 ? chatMessages[index - 1] : null}
                createDiff={createDiff}
                provider={provider}
                // Editing, forking and permission answers belong to the writable session; this
                // view stays read-only on purpose.
              />
            ))}
          </div>
        </div>
      </MarkdownWorkspaceContext.Provider>
    </TranscriptRenderContext.Provider>
  );
}
