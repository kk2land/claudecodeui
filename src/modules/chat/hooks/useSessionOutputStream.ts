import { useEffect, useRef, useState } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { LLMProvider, NormalizedMessage, PendingPermissionRequest, ServerEvent } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  advanceLiveEventWatermark,
  EMPTY_LIVE_EVENT_WATERMARK,
  type LiveEventWatermark,
} from '@/modules/chat/utils/liveEventWatermark';

/** Transcript kinds this read-only view can show; every other frame is state, not a row. */
const TRANSCRIPT_MESSAGE_KINDS = new Set([
  'text', 'thinking', 'tool_use', 'tool_result', 'error', 'task_status', 'task_notification',
]);

/** How long stream text is buffered before it reaches the store, matching the chat view. */
const STREAM_FLUSH_INTERVAL_MS = 100;

type UseSessionOutputStreamArgs = {
  sessionId: string;
  store: SessionStore;
  /** Provider reported by the session (or by its first message), used for message rendering. */
  provider: LLMProvider;
};

type UseSessionOutputStreamResult = {
  /** The run's permission prompts, shown read-only: answering them requires the foreground chat. */
  pendingPermissions: PendingPermissionRequest[];
  /** False when a requested replay could not be completed, so the caller can offer a retry. */
  replayComplete: boolean;
};

/**
 * Feeds one read-only viewer (the resident task detail) from the shared chat socket.
 *
 * The socket is broadcast to every listener on this browser, and `chat.subscribe` replays a
 * running turn from its first event. Both mean the same frame can arrive twice — a viewer's own
 * replay plus the live broadcast, or two viewers of one session on one socket — while
 * `stream_delta` carries only text, so a second application of a frame silently duplicates the
 * visible output. This hook therefore keeps its own consumption watermark, keyed by execution and
 * `seq`, and drops anything at or below it before it can touch the transcript. It never writes
 * the shared chat hook's watermark: a new viewer must be able to replay from 0.
 */
export function useSessionOutputStream({
  sessionId,
  store,
  provider,
}: UseSessionOutputStreamArgs): UseSessionOutputStreamResult {
  const { subscribe, sendMessage, isConnected } = useWebSocket();
  // What this viewer has already applied, keyed by execution: a new execution restarts the run's
  // sequence, so its watermark is never reused.
  const watermarkRef = useRef<LiveEventWatermark>(EMPTY_LIVE_EVENT_WATERMARK);
  // Accumulated `stream_delta` text for the current execution, flushed on a timer for speed.
  const accumulatedStreamRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  // Latest pending prompts for the run, replaced by every subscribe ack.
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermissionRequest[]>([]);
  // Whether the last gap-aware refill has finished, so a visible warning can be cleared.
  const [replayComplete, setReplayComplete] = useState(true);

  const storeRef = useRef(store);
  storeRef.current = store;

  const flushStream = () => {
    if (streamTimerRef.current !== null) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    if (accumulatedStreamRef.current) {
      storeRef.current.updateStreaming(sessionId, accumulatedStreamRef.current, provider);
    }
  };

  const requestSubscribe = () => {
    const { executionId, consumedSeq } = watermarkRef.current;
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId,
        // This viewer's own watermark, not a shared one: 0 replays the whole run so a detail
        // panel opened mid-turn still shows the output produced before it opened.
        lastSeq: consumedSeq,
        ...(executionId ? { executionId } : {}),
      }],
    });
  };

  useEffect(() => {
    store.setActiveSession(sessionId);
    // Subscribe before reading history so no live frame falls between the two.
    requestSubscribe();
    void store.fetchFromServer(sessionId, { limit: 100 }).catch((error: unknown) => {
      console.error('[SessionOutput] Failed to load history:', error);
    });
    return () => {
      if (streamTimerRef.current !== null) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      accumulatedStreamRef.current = '';
      watermarkRef.current = EMPTY_LIVE_EVENT_WATERMARK;
    };
    // `sendMessage`/`store` are stable per socket and per mounted store instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // The mount effect above already subscribes; only a later reconnect re-subscribes, so the first
  // render sends exactly one `chat.subscribe` per viewer.
  const hasSubscribedRef = useRef(false);
  useEffect(() => {
    if (!hasSubscribedRef.current) {
      hasSubscribedRef.current = true;
      return;
    }
    // A reconnect reopened the socket, so live frames stopped and the run moved on without this
    // viewer. Re-subscribing replays from this viewer's watermark.
    if (!isConnected) return;
    requestSubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, sessionId]);

  // Switching the watched session inside the same hook instance drops the previous session's
  // prompt banner and replay warning instead of carrying them over.
  useEffect(() => {
    setPendingPermissions([]);
    setReplayComplete(true);
  }, [sessionId]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      // Every frame is filtered by session first: a broadcast carries other sessions' output, and
      // `stream_delta` is bare text, so routing by the viewed session would splice another
      // conversation's words into this transcript.
      if (typeof msg.sessionId !== 'string' || msg.sessionId !== sessionId) {
        return;
      }

      if (msg.kind === 'chat_subscribed') {
        // The ack's `lastSeq` is the *server's* watermark, not what this viewer has consumed, so
        // it is never used as the viewer's position. It only seeds gap detection.
        if (Array.isArray(msg.pendingPermissions)) {
          setPendingPermissions(msg.pendingPermissions as PendingPermissionRequest[]);
        }
        return;
      }

      const previousExecution = watermarkRef.current.executionId;
      const step = advanceLiveEventWatermark(watermarkRef.current, {
        executionId: msg.executionId,
        seq: msg.seq,
      });
      if (step.watermark.executionId !== previousExecution) {
        // A new execution: its sequence restarts, and its text must not continue the old run's.
        flushStream();
        accumulatedStreamRef.current = '';
      }
      watermarkRef.current = step.watermark;
      if (step.gap) {
        // Frames were missed (buffered replay aged out, or this viewer fell behind). The provider
        // transcript is authoritative, so refill from it instead of inventing the rows locally.
        setReplayComplete(false);
        void storeRef.current.refreshLatestFromServer(sessionId)
          .then(() => setReplayComplete(true))
          .catch(() => undefined);
      }
      if (step.duplicate) {
        return;
      }

      if (msg.kind === 'stream_delta') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (!text) return;
        accumulatedStreamRef.current += text;
        if (streamTimerRef.current === null) {
          streamTimerRef.current = window.setTimeout(() => {
            streamTimerRef.current = null;
            if (accumulatedStreamRef.current) {
              storeRef.current.updateStreaming(sessionId, accumulatedStreamRef.current, provider);
            }
          }, STREAM_FLUSH_INTERVAL_MS);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        flushStream();
        storeRef.current.finalizeStreaming(sessionId);
        accumulatedStreamRef.current = '';
        return;
      }

      if (msg.kind === 'complete') {
        // The unified terminal frame every provider emits. Flushing first keeps the tail of the
        // response, then the persisted tail is re-read so the provisional stream row is replaced
        // by the provider's own row instead of sitting beside it as a duplicate.
        flushStream();
        storeRef.current.finalizeStreaming(sessionId);
        accumulatedStreamRef.current = '';
        // A finished or aborted run has no prompts left to answer.
        setPendingPermissions([]);
        void storeRef.current.refreshLatestFromServer(sessionId).catch(() => undefined);
        return;
      }

      if (msg.kind === 'permission_request') {
        if (typeof msg.requestId !== 'string' || !msg.requestId) return;
        setPendingPermissions((current) => (
          current.some((request) => request.requestId === msg.requestId)
            ? current
            : [...current, {
              requestId: msg.requestId as string,
              toolName: (msg.toolName as string) || 'UnknownTool',
              input: msg.input,
              context: msg.context,
              sessionId,
              receivedAt: new Date(),
            }]
        ));
        return;
      }

      if (msg.kind === 'permission_resolved' || msg.kind === 'permission_cancelled') {
        if (typeof msg.requestId !== 'string') return;
        // Answered from the foreground chat or another tab: the read-only banner must not linger.
        setPendingPermissions((current) => current.filter((request) => request.requestId !== msg.requestId));
        return;
      }

      if (TRANSCRIPT_MESSAGE_KINDS.has(String(msg.kind))) {
        storeRef.current.appendRealtime(sessionId, msg as unknown as NormalizedMessage);
      }
    };

    return subscribe(handleEvent);
    // `provider` only affects how text is stamped; switching it remounts the viewer.
  }, [sessionId, provider, subscribe]);

  return { pendingPermissions, replayComplete };
}
