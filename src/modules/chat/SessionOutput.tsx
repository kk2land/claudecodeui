import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

/** Distance from the bottom, in pixels, still counted as reading the newest output. */
const BOTTOM_PROXIMITY_PX = 50;

/** How far a failed tail refresh stretches its retry interval before it gives up backing off. */
const POLL_FAILURE_BACKOFF_FACTOR = 8;

type SessionOutputProps = {
  sessionId: string;
  /**
   * Reads the provider from a session projection when the caller already has one. Without it the
   * viewer falls back to the provider stamped on the transcript rows it renders, so it never needs
   * the full chat interface (composer, provider settings, model selection) to display output.
   */
  session?: ProjectSession | null;
  /**
   * Re-reads the persisted tail at this interval while the viewer is mounted, for a host session a
   * CLI owns: that output is written to the provider transcript and never reaches the chat socket,
   * so polling is the only live source. Omitted (the default) leaves the viewer on its socket
   * subscription alone, so ordinary chat sessions behave exactly as before.
   */
  pollIntervalMs?: number;
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
 * keeps its own, so opening one beside the other cannot duplicate or cross-append rows. A host whose
 * session a CLI owns instead of this socket can pass `pollIntervalMs` to have it re-read the
 * persisted transcript.
 */
export function SessionOutput({ sessionId, session = null, pollIntervalMs, onOpenSession, className }: SessionOutputProps) {
  const store = useSessionStore();
  const messages = store.getMessages(sessionId);
  // The session's real provider, read once from the existing lookup route. It is the only
  // authoritative answer when the caller mounts the viewer with just a session id. Tagged with the
  // session it was read for, so a switch stops matching instead of letting a late answer for the
  // previous session stamp the rows now on screen.
  const [providerLookup, setProviderLookup] = useState<{ sessionId: string; provider: LLMProvider } | null>(null);
  useEffect(() => {
    if (session?.provider || session?.__provider) return;
    let live = true;
    void api.sessionDetails(sessionId)
      .then(async (response) => (response.ok ? await response.json() : null))
      .then((payload: { data?: { provider?: unknown } } | null) => {
        const provider = payload?.data?.provider;
        if (live && typeof provider === 'string' && provider.trim()) {
          setProviderLookup({ sessionId, provider: provider as LLMProvider });
        }
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [session?.provider, session?.__provider, sessionId]);
  const lookedUpProvider = providerLookup?.sessionId === sessionId ? providerLookup.provider : null;
  const provider = readProvider(session, lookedUpProvider, messages) ?? 'codex';
  const { pendingPermissions, replayComplete } = useSessionOutputStream({ sessionId, store, provider });
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const chatMessages = useMemo(() => normalizedToChatMessages(messages), [messages]);
  // The row at the top of the transcript. Only prepending rows changes it, which is how the layout
  // effect tells the older page apart from content that merely grew below the reader.
  const oldestMessageId = String(messages[0]?.id ?? '');
  // True while an older history page is being read, which disables the button instead of letting
  // a second click race the first.
  const [loadingOlder, setLoadingOlder] = useState(false);
  /**
   * Whether the newest output stays in view, tagged with the session it was chosen for. A switch
   * reads as following the new session again, while scrolling up pauses it for the current one so
   * a growing run cannot pull the reader down.
   */
  const [followMode, setFollowMode] = useState({ sessionId, following: true });
  const isFollowingLatest = followMode.sessionId === sessionId ? followMode.following : true;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  /**
   * The transcript as it was when the reader asked for an older page: its geometry, plus the id of
   * the oldest row then, which tells the layout effect that the requested rows have actually landed
   * instead of some other change having arrived first.
   */
  const pendingOlderPageScrollRef = useRef<{
    sessionId: string;
    oldestId: string;
    height: number;
    top: number;
  } | null>(null);
  const { hasMore, total } = store.getSessionSlot(sessionId) ?? { hasMore: false, total: 0 };
  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    const container = scrollContainerRef.current;
    if (container) {
      pendingOlderPageScrollRef.current = {
        sessionId,
        oldestId: oldestMessageId,
        height: container.scrollHeight,
        top: container.scrollTop,
      };
    }
    try {
      await store.fetchMore(sessionId);
    } catch (error) {
      console.error('[SessionOutput] Failed to load older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, oldestMessageId, sessionId, store]);

  // Runs on every transcript change, which includes the same message growing while a run streams,
  // so following keeps the newest output in view instead of only reacting to new rows.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let pending = pendingOlderPageScrollRef.current;
    if (pending && pending.sessionId !== sessionId) {
      // A page requested by a session that is no longer shown owns nothing here.
      pendingOlderPageScrollRef.current = null;
      pending = null;
    }
    if (pending) {
      if (oldestMessageId === pending.oldestId) {
        // Still in flight. A row that grew below the reader moved the transcript height meanwhile,
        // so the baseline moves with it: only the older page's own rows are compensated.
        pendingOlderPageScrollRef.current = {
          ...pending,
          height: container.scrollHeight,
          top: container.scrollTop,
        };
      } else {
        // The requested rows are above now, so keep the reader on the rows they were reading.
        pendingOlderPageScrollRef.current = null;
        container.scrollTop = pending.top + Math.max(container.scrollHeight - pending.height, 0);
        return;
      }
    }
    if (isFollowingLatest) container.scrollTop = container.scrollHeight;
  }, [isFollowingLatest, messages, oldestMessageId, sessionId]);

  // A CLI-owned session's output reaches the provider transcript rather than this socket, so the
  // host asks for a periodic tail refresh. Mounting is the only "open" signal this viewer has: it
  // polls exactly as long as the host mounts it with an interval.
  useEffect(() => {
    if (pollIntervalMs === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = pollIntervalMs;
    const poll = async () => {
      let refreshed = false;
      try {
        // The store serializes this with paging and stitches the tail onto any older page already
        // loaded, so polling neither races `fetchMore` nor drops or duplicates rows.
        refreshed = (await store.refreshLatestFromServer(sessionId, {
          canRequest: () => !cancelled,
        })).applied;
      } catch {
        // The store reports a failed refresh as a result; a rejection must not end the chain.
      }
      if (cancelled) return;
      // A failure retries at a slower rate, so an endpoint that is down cannot flood the console.
      delay = refreshed ? pollIntervalMs : Math.min(delay * 2, pollIntervalMs * POLL_FAILURE_BACKOFF_FACTOR);
      timer = setTimeout(() => void poll(), delay);
    };
    timer = setTimeout(() => void poll(), pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [pollIntervalMs, sessionId, store]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const following =
      container.scrollHeight - container.scrollTop - container.clientHeight < BOTTOM_PROXIMITY_PX;
    // Scroll events arrive continuously; only the moment follow mode actually changes is state.
    setFollowMode((current) => (
      current.sessionId === sessionId && current.following === following
        ? current
        : { sessionId, following }
    ));
  }, [sessionId]);
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
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="h-full space-y-3 overflow-y-auto px-3 py-3"
            >
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
            {/* Only offered after the reader has scrolled away from the newest output. */}
            {!isFollowingLatest && (
              <button
                type="button"
                onClick={() => setFollowMode({ sessionId, following: true })}
                className="absolute bottom-3 right-4 rounded-md border border-border bg-background px-3 py-1 text-xs text-foreground shadow-sm hover:bg-muted"
              >
                回到最新
              </button>
            )}
          </div>
        </div>
      </MarkdownWorkspaceContext.Provider>
    </TranscriptRenderContext.Provider>
  );
}
