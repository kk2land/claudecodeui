import { describe, expect, test } from 'vitest';

import {
  advanceLiveEventWatermark,
  EMPTY_LIVE_EVENT_WATERMARK,
  type LiveEventWatermark,
} from '@/modules/chat/utils/liveEventWatermark';

/**
 * These cover the real duplication the session-output viewer caused: `chat.subscribe` replays
 * buffered frames and the live broadcast carries the same ones, so the same `seq` reaches one
 * consumer twice and `stream_delta` would append its text twice.
 */
describe('advanceLiveEventWatermark', () => {
  test('the first viewer consumes every replayed frame from 0 without gaps', () => {
    let watermark: LiveEventWatermark = EMPTY_LIVE_EVENT_WATERMARK;
    const applied: number[] = [];
    for (const seq of [1, 2, 3]) {
      const step = advanceLiveEventWatermark(watermark, { executionId: 'exec-1', seq });
      expect(step.duplicate).toBe(false);
      expect(step.gap).toBe(false);
      watermark = step.watermark;
      applied.push(seq);
    }
    expect(applied).toEqual([1, 2, 3]);
    expect(watermark).toEqual({ executionId: 'exec-1', consumedSeq: 3 });
  });

  test('a replayed frame already applied by this consumer is dropped, so text is not duplicated', () => {
    const afterLive = advanceLiveEventWatermark(
      { executionId: 'exec-1', consumedSeq: 4 },
      { executionId: 'exec-1', seq: 5 },
    );
    const replayedAgain = advanceLiveEventWatermark(afterLive.watermark, { executionId: 'exec-1', seq: 5 });
    expect(replayedAgain.duplicate).toBe(true);
    // Dropping it must not move the watermark backwards or forwards.
    expect(replayedAgain.watermark).toEqual({ executionId: 'exec-1', consumedSeq: 5 });
  });

  test('a stale frame below the watermark is dropped too', () => {
    const step = advanceLiveEventWatermark(
      { executionId: 'exec-1', consumedSeq: 9 },
      { executionId: 'exec-1', seq: 3 },
    );
    expect(step.duplicate).toBe(true);
    expect(step.watermark.consumedSeq).toBe(9);
  });

  test('a new execution restarts the sequence instead of inheriting the previous position', () => {
    const step = advanceLiveEventWatermark(
      { executionId: 'exec-1', consumedSeq: 12 },
      { executionId: 'exec-2', seq: 1 },
    );
    expect(step.duplicate).toBe(false);
    expect(step.gap).toBe(false);
    expect(step.watermark).toEqual({ executionId: 'exec-2', consumedSeq: 1 });
  });

  test('a sequence jump is reported as a gap so the caller refills from REST', () => {
    const step = advanceLiveEventWatermark(
      { executionId: 'exec-1', consumedSeq: 2 },
      { executionId: 'exec-1', seq: 7 },
    );
    expect(step.gap).toBe(true);
    expect(step.duplicate).toBe(false);
    expect(step.watermark.consumedSeq).toBe(7);
  });

  test('frames without a sequence are never duplicates and never move the watermark', () => {
    const step = advanceLiveEventWatermark(
      { executionId: 'exec-1', consumedSeq: 4 },
      { executionId: 'exec-1' },
    );
    expect(step.duplicate).toBe(false);
    expect(step.watermark).toEqual({ executionId: 'exec-1', consumedSeq: 4 });
  });
});
