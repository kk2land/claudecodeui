import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ChatMessage, WorkerConversationMessage } from '@/shared/types';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';

/** Distance from the bottom, in pixels, still counted as reading the newest output. */
const BOTTOM_PROXIMITY_PX = 50;

/** Fallback tool name so a tool row without one still renders a readable card. */
const UNKNOWN_TOOL_NAME = 'UnknownTool';

type ConversationOutputProps = {
  /** Provider label handed to the transcript components; a Worker engine such as `pi`. */
  provider: string;
  /** Rows as the plugin parsed them from its run's raw event log; `update` replaces them. */
  messages: WorkerConversationMessage[];
  /**
   * The element whose scroll position this view drives. The plugin host passes the container it
   * portals into, because the plugin owns that container's scroll styling (the Worker panel is the
   * scroller). Omitted keeps the view's own scroll area, which is what a standalone mount needs.
   */
  scrollContainer?: HTMLElement | null;
};

/**
 * Placeholder timestamp for every row. Worker rows have no native time, and the transcript is told
 * not to display one, so nothing is invented while the shared components still get their field.
 */
const NO_TIMESTAMP = 0;

/**
 * Projects one plugin conversation row onto the shape the main transcript renders, so a Worker
 * panel looks like the conversation it belongs to. Tool calls and their results stay one row: the
 * plugin already merges them by call id, and both halves are passed to the shared `ToolRenderer`.
 */
function toChatMessage(message: WorkerConversationMessage): ChatMessage {
  if (message.role === 'user') {
    return { type: 'user', content: message.text, timestamp: NO_TIMESTAMP };
  }
  if (message.role === 'error') {
    return { type: 'error', content: message.text, timestamp: NO_TIMESTAMP };
  }
  if (message.role === 'assistant') {
    return {
      type: 'assistant',
      content: message.text,
      timestamp: NO_TIMESTAMP,
      isThinking: message.thinking,
      isStreaming: Boolean(message.streaming),
    };
  }
  // ToolRenderer takes a tool's input as the JSON text its own parser reads, serialized once here.
  const toolInput = message.toolInput && JSON.stringify(message.toolInput, null, 2);
  // A tool row with nothing but text is not a call to draw: keep its words instead of an empty card.
  if (!message.toolName && !toolInput && message.toolOutput === undefined) {
    return {
      type: 'assistant',
      content: message.text,
      timestamp: NO_TIMESTAMP,
      isStreaming: Boolean(message.streaming),
    };
  }
  return {
    type: 'assistant',
    content: '',
    // Main-conversation tool rows carry their readable line here; the raw payload stays below it.
    displayText: message.text || undefined,
    timestamp: NO_TIMESTAMP,
    isToolUse: true,
    toolName: message.toolName || UNKNOWN_TOOL_NAME,
    toolInput,
    toolId: message.toolId,
    toolResult: message.toolOutput === undefined
      ? null
      : { content: message.toolOutput, isError: Boolean(message.isError) },
    // The provider reports a call still streaming as in progress, which is what draws it live.
    toolStatus: message.streaming ? 'in_progress' : undefined,
  };
}

/**
 * Read-only conversation view for a Worker plugin run, exported by the chat module for the plugins
 * module to mount through the optional host capability `mountConversationOutput`.
 *
 * It renders the real transcript components, so a Worker run reads like the main conversation, and
 * it owns exactly one thing: scrolling. Newest output stays in view while the reader is at the
 * bottom, a reader who scrolled up is left where they are, and the returned view is pure display —
 * no history request, socket subscription or provider session is created here.
 */
export const ConversationOutput = memo(function ConversationOutput({
  provider,
  messages,
  scrollContainer = null,
}: ConversationOutputProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // The rendered rows, measured on their own so late layout growth is observable even when this
  // view owns the scroller (a viewport-sized root would not change size as content grows).
  const contentRef = useRef<HTMLDivElement>(null);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  /**
   * Whether the newest output stays in view. Pausing is the reader's own action (scrolling up), so
   * a run that keeps writing cannot drag them down while they read.
   */
  const [following, setFollowing] = useState(true);
  /** Mirrors `following` for the resize callback, which can fire before a pause is committed. */
  const followingRef = useRef(true);

  const chatMessages = useMemo(() => messages.map(toChatMessage), [messages]);

  const readScroller = useCallback(
    () => scrollContainer ?? rootRef.current,
    [scrollContainer],
  );

  const applyFollow = useCallback((next: boolean) => {
    // The ref changes with the reader's action, so a resize already in flight cannot undo a pause.
    followingRef.current = next;
    // Scroll events arrive continuously; only the moment follow mode actually changes is state.
    setFollowing(current => (current === next ? current : next));
  }, [setFollowing]);

  // Runs on every update, including the same row growing while a run streams, so following keeps
  // the newest output in view instead of only reacting to newly added rows.
  useLayoutEffect(() => {
    const scroller = readScroller();
    if (!scroller || !following) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [chatMessages, following, readScroller]);

  // The rows can grow after the commit that drew them — a reply's layout settles, a tool row
  // expands, an image decodes, or the plugin publishes a row on its own later tick — and none of
  // that changes `messages`. Watching the content itself keeps a follower at the bottom through
  // that growth, while a reader who paused is never moved.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const scroller = readScroller();
    if (!content || !scroller) return;
    const observer = new ResizeObserver(() => {
      if (!followingRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [readScroller]);

  const handleScroll = useCallback(() => {
    const scroller = readScroller();
    if (!scroller) return;
    applyFollow(
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < BOTTOM_PROXIMITY_PX,
    );
  }, [readScroller, applyFollow]);

  // The scroller can be the plugin's own container, so the listener lives exactly as long as this
  // mount and is removed with it; nothing else in the host view survives an unmount.
  useLayoutEffect(() => {
    const scroller = readScroller();
    if (!scroller) return;
    scroller.addEventListener('scroll', handleScroll);
    return () => scroller.removeEventListener('scroll', handleScroll);
  }, [handleScroll, readScroller]);

  const returnToNewest = useCallback(() => applyFollow(true), [applyFollow]);

  return (
    <div
      ref={rootRef}
      className={
        scrollContainer
          ? 'px-3 py-3'
          : 'h-full overflow-y-auto px-3 py-3'
      }
    >
      <div ref={contentRef} className="space-y-3">
        {chatMessages.length === 0 && (
          <p className="text-xs text-muted-foreground">还没有对话输出。</p>
        )}
        {chatMessages.map((message, index) => (
          <MessageComponent
            key={messages[index]?.id ?? index}
            message={message}
            prevMessage={index > 0 ? chatMessages[index - 1] : null}
            createDiff={createDiff}
            provider={provider}
            // A Worker transcript is read-only: no edit, fork or permission controls are possible,
            // and thinking rows are the run's own reasoning the user came to read.
            showThinking
            // Rows have no native time, so the shared footer draws none rather than a placeholder.
            showTimestamp={false}
          />
        ))}
        {/* Sticky in the flow, so the control sits at the bottom of whichever element scrolls. */}
        {!following && (
          <div className="sticky bottom-2 flex justify-end">
            <button
              type="button"
              onClick={returnToNewest}
              className="rounded-md border border-border bg-background px-3 py-1 text-xs text-foreground shadow-sm hover:bg-muted"
            >
              回到最新
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
