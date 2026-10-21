import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('reconciles optimistic send IDs with history from providers that assign their own IDs', () => {
  const local = createUserMessage('composer-uuid', '2026-07-28T20:30:21.000Z', {
    content: 'hello', isOptimistic: true,
  });
  const persisted = createUserMessage('claude-id', '2026-07-28T20:30:26.000Z', { content: 'hello' });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('reserves exact history identities before matching another identical send by content', () => {
  const confirmed = createUserMessage('first-send', '2026-07-28T20:30:21.000Z', {
    provider: 'codex', content: 'continue',
  });
  const pending = createUserMessage('second-send', '2026-07-28T20:30:22.000Z', {
    provider: 'codex', content: 'continue', isOptimistic: true,
  });

  for (const realtime of [[confirmed, pending], [pending, confirmed]]) {
    assert.deepEqual(removeOptimisticUserEchoes([confirmed], realtime), [pending]);
  }
});

test('a replacement echo survives a kept turn that repeats its text', () => {
  // The exact shape a rewind that branches produces: the turn that survived
  // the cut is re-stamped to the moment of the copy, one second before the
  // replacement was typed, and happens to say the same thing the user just
  // corrected their message to.
  const userRow = (id: string, content: string, timestamp: string) => ({
    id,
    kind: 'text',
    role: 'user',
    provider: 'codex',
    sessionId: 's1',
    content,
    timestamp,
  }) as NormalizedMessage;

  const kept = [userRow('kept', 'continue', '2026-01-01T00:00:21.000Z')];
  const echo = {
    ...userRow('local_1', 'continue', '2026-01-01T00:00:20.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: kept.length,
  } as NormalizedMessage;

  assert.deepEqual(removeOptimisticUserEchoes(kept, [echo]), [echo]);

  // Once the provider has written the replacement, it is a row the cut did not
  // keep, so it retires the echo.
  const persisted = [...kept, userRow('persisted', 'continue', '2026-01-01T00:00:25.000Z')];
  assert.deepEqual(removeOptimisticUserEchoes(persisted, [echo]), []);
});

test('a retired identity is filtered even when its persisted row keeps changing ID', () => {
  const retired = new Map<string, NormalizedMessage>();
  const local = createUserMessage('local_send', '2026-07-28T20:30:21.000Z', {
    content: 'hello', isOptimistic: true,
  });
  const persisted = createUserMessage('read-1', '2026-07-28T20:30:26.000Z', { content: 'hello' });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local], retired), []);
  assert.deepEqual([...retired.keys()].sort(), ['local_send']);

  // The reader regenerates the row ID. The map follows it, and a late native
  // replay of the same send stays gone instead of becoming a second bubble.
  const reread = { ...persisted, id: 'read-2' };
  assert.deepEqual(removeOptimisticUserEchoes([reread], [local], retired), []);
  assert.equal(retired.get('local_send')?.id, 'read-2');

  // Re-evaluating the merged view repeatedly is stable.
  for (let pass = 0; pass < 3; pass++) {
    assert.deepEqual(removeOptimisticUserEchoes([reread], [local], retired), []);
  }
});

test('a retired history row cannot be claimed again by an identical second send', () => {
  const retired = new Map<string, NormalizedMessage>();
  const first = createUserMessage('first-send', '2026-07-28T20:30:21.000Z', {
    content: 'continue', isOptimistic: true,
  });
  const h1 = createUserMessage('read-1', '2026-07-28T20:30:22.000Z', { content: 'continue' });
  assert.deepEqual(removeOptimisticUserEchoes([h1], [first], retired), []);

  const second = createUserMessage('second-send', '2026-07-28T20:30:25.000Z', {
    content: 'continue', isOptimistic: true,
  });
  const reread = { ...h1, id: 'read-2' };
  assert.deepEqual(removeOptimisticUserEchoes([reread], [second], retired), [second]);

  const h2 = createUserMessage('read-3', '2026-07-28T20:30:27.000Z', { content: 'continue' });
  assert.deepEqual(removeOptimisticUserEchoes([reread, h2], [second], retired), []);
});

test('attaches the identity of a native snapshot that only carries the send ID', () => {
  const retired = new Map<string, NormalizedMessage>();
  const local = createUserMessage('composer-id', '2026-07-28T20:31:00.000Z', {
    content: 'hello', isOptimistic: true,
  });
  const snapshot = { ...createUserMessage('native-item-id', '2026-07-28T20:31:02.000Z', { content: 'hello' }), clientMessageId: 'composer-id' };

  assert.deepEqual(removeOptimisticUserEchoes([], [local], retired), [local]);
  assert.deepEqual(removeOptimisticUserEchoes([snapshot], [local], retired), []);
  assert.equal(retired.get('composer-id')?.id, 'native-item-id');
});

test('records an exact-ID retirement so a later identical send stays visible', () => {
  const retired = new Map<string, NormalizedMessage>();
  const first = createUserMessage('send-a', '2026-07-28T20:30:35.000Z', {
    content: 'ping', isOptimistic: true,
  });
  const h1 = createUserMessage('send-a', '2026-07-28T20:30:37.000Z', { content: 'ping' });

  assert.deepEqual(removeOptimisticUserEchoes([h1], [first], retired), []);

  // The identity was retired by exact ID, so the persisted row it owns must
  // stay reserved. Otherwise this identical second send claims it by text and
  // disappears until its own history row exists.
  const second = createUserMessage('send-b', '2026-07-28T20:30:40.000Z', {
    content: 'ping', isOptimistic: true,
  });
  assert.deepEqual(removeOptimisticUserEchoes([h1], [second], retired), [second]);
});

test('reserves a confirmed clientMessageId before content fallbacks claim its row', () => {
  const h1 = createUserMessage('first-send', '2026-07-28T20:30:37.000Z', { content: 'ping' });
  const later = createUserMessage('second-send', '2026-07-28T20:30:40.000Z', {
    content: 'ping', isOptimistic: true,
  });
  // The native snapshot names the first send even though its own row id differs.
  const native = {
    ...createUserMessage('native-first', '2026-07-28T20:30:37.000Z', {
      content: 'ping', isOptimistic: true,
    }),
    clientMessageId: 'first-send',
  };

  assert.deepEqual(removeOptimisticUserEchoes([h1], [later, native]), [later]);
});

test('the persisted-row fallback rejects different explicit clientMessageIds', () => {
  const retired = new Map<string, NormalizedMessage>();
  const first = createUserMessage('first-send', '2026-07-28T20:30:37.000Z', {
    content: 'ping', isOptimistic: true,
  });
  const h1 = {
    ...createUserMessage('history-1', '2026-07-28T20:30:37.000Z', { content: 'ping' }),
    clientMessageId: 'first-send',
  };
  assert.deepEqual(removeOptimisticUserEchoes([h1], [first], retired), []);

  // Re-reading history regenerated the row id but kept the second row's own
  // send ID. It is not the first send's persisted copy, even though time and
  // text match.
  const h2 = {
    ...createUserMessage('history-2', '2026-07-28T20:30:37.000Z', { content: 'ping' }),
    clientMessageId: 'second-send',
  };
  const second = createUserMessage('second-send', '2026-07-28T20:30:40.000Z', {
    content: 'ping', isOptimistic: true,
  });
  assert.deepEqual(removeOptimisticUserEchoes([h2], [second], retired), []);
});

test('a legacy history row retires the optimistic echo by send ID even when presentation differs', () => {
  const retired = new Map<string, NormalizedMessage>();
  const sendId = 'legacy-client-send';
  // This fixture differs only in line breaks and carries no files, so identity
  // alone decides the retirement; the persisted row's presentation is not
  // assumed to have been normalized in any particular way.
  const optimistic = createUserMessage(sendId, '2026-10-21T10:45:19.000Z', {
    provider: 'codex',
    sessionId: 's1',
    content: '请当我的 Python 入门教练。\n\n请先给出 7 天学习计划。',
    isOptimistic: true,
  });
  const persisted = createUserMessage(sendId, '2026-10-21T10:45:21.000Z', {
    provider: 'codex',
    sessionId: 's1',
    // `uuid` from a legacy `user_message` row becomes the send identity.
    clientMessageId: sendId,
    content: '请当我的 Python 入门教练。\n请先给出 7 天学习计划。',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [optimistic], retired), []);
  assert.equal(retired.get(sendId)?.id, sendId);
});

test('a legacy row with a different send ID does not retire an identical-looking echo', () => {
  const optimistic = createUserMessage('second-send', '2026-10-21T10:48:00.000Z', {
    provider: 'codex', sessionId: 's1', content: 'ping', isOptimistic: true,
  });
  const persisted = createUserMessage('first-send', '2026-10-21T10:47:58.000Z', {
    provider: 'codex', sessionId: 's1', clientMessageId: 'first-send', content: 'ping',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [optimistic]), [optimistic]);
});
