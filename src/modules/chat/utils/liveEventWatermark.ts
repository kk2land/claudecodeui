/**
 * Per-consumer consumption watermark for one live chat run.
 *
 * A sequenced run frame can reach the same viewer twice: `chat.subscribe` replays the buffered
 * events (`seq > lastSeq`) to the subscribing socket, and the live broadcast carries the same
 * frames to every listener on it. `stream_delta` carries bare text, so applying a frame a second
 * time appends a duplicate of text the user already sees. Both the foreground chat and the
 * read-only session output therefore filter on this watermark before touching a transcript.
 */
export type LiveEventWatermark = {
  /** Execution the watermark belongs to; a new execution restarts the sequence at 1. */
  executionId: string | null;
  /** Highest `seq` this consumer has already applied for that execution. */
  consumedSeq: number;
};

export type LiveEventWatermarkStep = {
  watermark: LiveEventWatermark;
  /** The frame was already applied (or is older than the watermark) and must be dropped. */
  duplicate: boolean;
  /** Frames before this one were never applied, so the transcript has to be refilled from REST. */
  gap: boolean;
};

export const EMPTY_LIVE_EVENT_WATERMARK: LiveEventWatermark = { executionId: null, consumedSeq: 0 };

/**
 * Advances one consumer's watermark by a received frame.
 *
 * A frame from a different execution starts a new watermark at that frame's `seq`, because the
 * new run's own sequence is unrelated to the previous one's; a frame without a `seq` (acks and
 * lifecycle events) leaves the watermark untouched and is never a duplicate.
 */
export function advanceLiveEventWatermark(
  current: LiveEventWatermark,
  event: { executionId?: unknown; seq?: unknown },
): LiveEventWatermarkStep {
  const executionId = typeof event.executionId === 'string' && event.executionId
    ? event.executionId
    : current.executionId;
  const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? Math.floor(event.seq) : null;
  const executionChanged = executionId !== current.executionId;
  const known = executionChanged ? 0 : current.consumedSeq;

  if (seq === null) {
    return {
      watermark: { executionId, consumedSeq: known },
      duplicate: false,
      gap: false,
    };
  }
  if (seq <= known) {
    return { watermark: { executionId, consumedSeq: known }, duplicate: true, gap: false };
  }
  return {
    watermark: { executionId, consumedSeq: seq },
    duplicate: false,
    // A jump means at least one frame never reached this viewer; only a refill can recover it.
    gap: seq > known + 1,
  };
}
