import { useCallback, useState } from 'react';

import type { CodexComposerPrediction } from '@/shared/types';

type Args = {
  /** Preference, capability, provider and runtime all allowed the suggestion. */
  enabled: boolean;
  /** Open chat session; a suggestion belongs to exactly one conversation. */
  sessionId: string | null;
  /** Latest native snapshot for that session, published by useCodexControls. */
  prediction: CodexComposerPrediction | undefined;
  /** A turn is live here, so nothing may be shown; the request itself stays valid. */
  busy: boolean;
  /**
   * User state that makes this turn's answer inapplicable for good: attachments,
   * a queued draft, an edited message, or an open permission question.
   */
  suppressed: boolean;
  /** Raw composer text; any non-empty value retires the suggestion for that turn. */
  input: string;
};

type Result = {
  /** Ghost text to display; null when there is nothing showable right now. */
  suggestion: string | null;
  /** The current turn reported no usable suggestion while the composer stays empty and idle. */
  unavailable: boolean;
  /** Retires the current suggestion (and its pending result) for this turn. */
  dismiss(): void;
  /** Returns the accepted text and retires it; the caller owns the draft write. */
  accept(): string | null;
};

/** Local refusals plus the bookkeeping needed to notice a superseded turn. */
type PredictionMemory = {
  /** Conversation the refusals below belong to. */
  sessionId: string | null;
  /** Most recent `sessionId:sourceTurnId` the server offered. */
  lastKey: string | null;
  /** Keys this composer will never show again. */
  retired: ReadonlySet<string>;
  /** Whether the previous render allowed suggestions at all. */
  wasEnabled: boolean;
};

const emptyMemory = (sessionId: string | null): PredictionMemory => ({
  sessionId, lastKey: null, retired: new Set(), wasEnabled: false,
});

/** Returns a memory with `key` retired, or the same object when it already is. */
function withRetired(memory: PredictionMemory, key: string | null): PredictionMemory {
  if (!key || memory.retired.has(key)) return memory;
  const retired = new Set(memory.retired);
  retired.add(key);
  // Bounded so a long-lived tab cannot grow this set forever.
  if (retired.size > 200) retired.delete(retired.values().next().value!);
  return { ...memory, retired };
}

/**
 * Owns whether a native composer prediction may be shown.
 *
 * The server snapshot is authoritative for which turn a suggestion belongs to,
 * but it cannot know what the user did in this composer. Retired
 * `sessionId:sourceTurnId` keys therefore record a local refusal: accepting,
 * Esc, typing, attachments, queueing, editing, switching the preference off and
 * leaving the conversation all retire the current key for good, so a late result
 * — or the same result re-published after the box was cleared — can never
 * reappear. A new turn arrives with a new `sourceTurnId` and is unaffected.
 *
 * The visible value is derived during render from the snapshot, the composer
 * state and those refusals. Refusals discovered while deriving are committed
 * with a render-phase state adjustment, so the render that first observes the
 * new input, snapshot or session already hides the stale suggestion instead of
 * painting it for a frame.
 */
export function useComposerPrediction({ enabled, sessionId, prediction, busy, suppressed, input }: Args): Result {
  // Everything that survives a render and gates what may be shown; state so a
  // refusal first discovered in this render is committed before paint.
  const [memory, setMemory] = useState<PredictionMemory>(() => emptyMemory(sessionId));

  const key = prediction ? `${sessionId ?? ''}:${prediction.sourceTurnId}` : null;
  const text = prediction?.status === 'ready' && prediction.text ? prediction.text : null;
  const unavailable = prediction?.status === 'unavailable';

  let next = memory;
  if (memory.sessionId !== sessionId) {
    // Leaving a conversation retires the answer that belonged to it, so coming
    // back to the same snapshot cannot show it again.
    next = { ...withRetired(memory, memory.lastKey), sessionId, lastKey: null, wasEnabled: false };
  }
  // A key replaced by another one is stale by definition: this is what makes a
  // late result for an older turn inert even if the server re-publishes it.
  // The native runtime clears its snapshot as soon as a new turn starts,
  // before that turn can offer a replacement prediction.
  if (!key) next = withRetired(next, next.lastKey);
  if (key && key !== next.lastKey) next = { ...withRetired(next, next.lastKey), lastKey: key };
  if (enabled) {
    if (!next.wasEnabled) next = { ...next, wasEnabled: true };
    // Typing is a permanent refusal: this turn's answer must not appear later
    // just because the user deleted what they typed. Attachments, a queued
    // draft, an edit or an open question are equally inapplicable.
    if (input !== '' || suppressed) next = withRetired(next, key);
  } else if (next.wasEnabled) {
    // Only an actual on→off switch retires results; capabilities and the
    // preference are still loading on the first renders and must not.
    next = { ...withRetired(next, key), wasEnabled: false };
  }
  if (next !== memory) setMemory(next);

  const showable = enabled && !busy && !suppressed && input === '' && key !== null && !next.retired.has(key);

  const dismiss = useCallback(() => {
    setMemory((previous) => withRetired(previous, key));
  }, [key]);

  const accept = useCallback(() => {
    if (!showable || !text) return null;
    setMemory((previous) => withRetired(previous, key));
    return text;
  }, [key, showable, text]);

  return {
    suggestion: showable ? text : null,
    unavailable: Boolean(showable && !text && unavailable),
    dismiss,
    accept,
  };
}
