import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Drafts moved out of the browser and into auth.db so a message half-typed on
 * one device can be finished on another — the case the composer could not serve
 * at all before, because a draft only existed on the machine it was typed on.
 *
 * Each test loads a fresh module copy, because the store reads its localStorage
 * mirror once at module scope.
 */

type SavedDraft = { scope: string; text: string; queuedMessages?: unknown[] };

const savedDrafts: SavedDraft[] = [];
const deletedScopes: string[] = [];
let serverDrafts: unknown[] = [];
let draftsRequestFailed = false;

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      drafts: async () => {
        if (draftsRequestFailed) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify({ success: true, drafts: serverDrafts }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      saveDraft: async (scope: string, draft: { text: string; queuedMessages?: unknown[] }) => {
        savedDrafts.push({ scope, ...draft });
        return new Response('{}', { status: 200 });
      },
      deleteDraft: async (scope: string) => {
        deletedScopes.push(scope);
        return new Response('{}', { status: 200 });
      },
    },
  },
}));

const loadStore = async () => {
  vi.resetModules();
  return import('@/shared/chatDrafts');
};

beforeEach(() => {
  localStorage.clear();
  savedDrafts.length = 0;
  deletedScopes.length = 0;
  serverDrafts = [];
  draftsRequestFailed = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test('a draft is readable synchronously and reaches the server after the debounce', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'half a thought');

  assert.equal(store.readDraftText('session-a'), 'half a thought');
  assert.deepEqual(savedDrafts, [], 'the request must not fire on every keystroke');

  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [
    { scope: 'session-a', text: 'half a thought' },
  ]);
});

test('each session keeps its own draft', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'for A');
  store.writeDraftText('session-b', 'for B');

  assert.equal(store.readDraftText('session-a'), 'for A');
  assert.equal(store.readDraftText('session-b'), 'for B');
});

test('a chat with no session yet is scoped to its project', async () => {
  const store = await loadStore();

  store.writeDraftText('project:p1', 'unsent');

  assert.equal(store.readDraftText('project:p1'), 'unsent');
  assert.equal(store.readDraftText('session-a'), '');
});

test('clearing text leaves removal of an empty row to the server and preserves another tab\'s queue', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'typed');
  await vi.advanceTimersByTimeAsync(1_500);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', '');
  await vi.advanceTimersByTimeAsync(1_500);

  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '' }]);
  assert.deepEqual(deletedScopes, []);
});

test('a draft written in one page load is readable synchronously in the next', async () => {
  const first = await loadStore();
  first.writeDraftText('session-a', 'survives a reload');

  // No hydrate: this is the first paint of the next load, before any request
  // could have resolved.
  const second = await loadStore();
  assert.equal(second.readDraftText('session-a'), 'survives a reload');
});

test('hydrate brings in a draft typed on another device', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'typed on the laptop', queuedMessage: null }];

  const store = await loadStore();
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'typed on the laptop');
});

test('hydrate removes a mirrored queue after the server claims it', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { content: 'server-owned queue' });
  assert.equal(store.readQueuedMessage('session-a')?.content, 'server-owned queue');
  await vi.advanceTimersByTimeAsync(0);

  serverDrafts = [];
  await store.hydrateChatDrafts();

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('hydrate does not overwrite a scope the user is typing into right now', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'stale server copy', queuedMessage: null }];

  const store = await loadStore();
  store.writeDraftText('session-a', 'what I am writing');
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'what I am writing');
});

test('a failed hydrate keeps the mirrored draft rather than blanking the composer', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'local work');
  await vi.advanceTimersByTimeAsync(1_500);

  draftsRequestFailed = true;
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'local work');
});

test('a queued message round-trips alongside the draft text', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'still editing');
  store.writeQueuedMessage('session-a', { content: 'send this next', attachments: [] });

  assert.equal(store.readDraftText('session-a'), 'still editing');
  assert.deepEqual(store.readQueuedMessage('session-a'), {
    content: 'send this next',
    attachments: [],
  });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(savedDrafts.length, 1, 'queue actions persist without waiting for the draft debounce');
  assert.deepEqual(savedDrafts, [{
    scope: 'session-a',
    text: 'still editing',
    queuedMessages: [{ content: 'send this next', attachments: [] }],
  }]);
});

test('a queued message with neither text nor attachments reads as absent', async () => {
  const store = await loadStore();

  store.writeQueuedMessage('session-a', { content: '   ', attachments: [] });

  assert.equal(store.readQueuedMessage('session-a'), null);
});

for (const source of ['mirror', 'server'] as const) {
  test(`incomplete queued messages from the ${source} cannot crash the composer`, async () => {
    const records = [
      { scope: 'missing', text: 'keep draft', queuedMessage: {} },
      { scope: 'null', text: '', queuedMessage: { content: null } },
      { scope: 'number', text: '', queuedMessage: { content: 42 } },
      { scope: 'attachment', text: '', queuedMessage: { id: 'queued-file', attachments: [{ name: 'notes.txt' }] } },
      { scope: 'legacy-image', text: '', queuedMessage: { images: [{ name: 'shot.png' }] } },
    ];
    if (source === 'mirror') {
      localStorage.setItem('chat-drafts', JSON.stringify(Object.fromEntries(records.map(({ scope, ...draft }) => [scope, draft]))));
    } else {
      serverDrafts = records;
    }
    const store = await loadStore();
    if (source === 'server') await store.hydrateChatDrafts();

    assert.equal(store.readDraftText('missing'), 'keep draft');
    for (const scope of ['missing', 'null', 'number']) assert.equal(store.readQueuedMessage(scope), null);
    assert.deepEqual(store.readQueuedMessage('attachment'), {
      id: 'queued-file', content: '', attachments: [{ name: 'notes.txt' }],
    });
    assert.equal(store.readQueuedMessage('legacy-image')?.content, '');
    assert.deepEqual(store.readQueuedMessage('legacy-image')?.attachments, [{ name: 'shot.png' }]);
    assert.deepEqual(savedDrafts, [], 'reading old data must not overwrite the stored queue');
  });
}

test('legacy image-only descriptors are still readable as attachments', async () => {
  const store = await loadStore();

  store.writeQueuedMessage('session-a', { content: '', images: [{ name: 'shot.png' }] });

  assert.deepEqual(store.readQueuedMessage('session-a')?.attachments, [{ name: 'shot.png' }]);
});

test('clearing the queued message leaves the draft text alone', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'keep me');
  store.writeQueuedMessage('session-a', { content: 'queued' });

  store.clearQueuedMessage('session-a');

  assert.equal(store.readQueuedMessage('session-a'), null);
  assert.equal(store.readDraftText('session-a'), 'keep me');
});

test('subscribers are notified on a write', async () => {
  const store = await loadStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribeToChatDrafts(listener);

  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  // Writing the same text again changes nothing, so nobody is woken.
  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  unsubscribe();
  store.writeDraftText('session-a', 'more');
  assert.equal(listener.mock.calls.length, 1);
});

test('reset clears the drafts so the next user does not see them', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'private');

  store.resetChatDrafts();

  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});


test('hydrate preserves the newest draft while successive writes to the same scope are still pending', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  const releases: Array<() => void> = [];
  const save = vi.spyOn(api.user, 'saveDraft').mockImplementation(async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response('{}', { status: 200 });
  });
  store.writeDraftText('session-a', 'first');
  const first = store.persistQueuedMessage('session-a');
  await vi.advanceTimersByTimeAsync(0);
  store.writeDraftText('session-a', 'newest');
  const second = store.persistQueuedMessage('session-a');
  releases[0]();
  await first;
  await vi.advanceTimersByTimeAsync(0);
  serverDrafts = [{ scope: 'session-a', text: 'stale server value', queuedMessage: null }];
  await store.hydrateChatDrafts();
  assert.equal(store.readDraftText('session-a'), 'newest');
  releases[1]();
  await second;
  save.mockRestore();
});

test('sign-out cancels queued saves and deletes without blocking the next account', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  let account = 'A';
  const calls: Array<{ account: string; text: string }> = [];
  const releases: Array<() => void> = [];
  const save = vi.spyOn(api.user, 'saveDraft').mockImplementation(async (_scope, draft) => {
    calls.push({ account, text: draft.text });
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response('{}', { status: 200 });
  });
  try {
    store.writeDraftText('session-a', 'A in flight');
    const first = store.persistQueuedMessage('session-a');
    const firstCancelled = assert.rejects(first, /sign-out/);
    await vi.advanceTimersByTimeAsync(0);
    store.writeDraftText('session-a', 'A queued');
    const queued = store.persistQueuedMessage('session-a');
    const queuedCancelled = assert.rejects(queued, /sign-out/);
    store.writeDraftText('session-a', '');
    const deletion = store.persistQueuedMessage('session-a');
    const deletionCancelled = assert.rejects(deletion, /sign-out/);

    store.resetChatDrafts();
    account = 'B';
    store.writeDraftText('session-a', 'B own draft');
    const nextAccount = store.persistQueuedMessage('session-a');
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(calls, [{ account: 'A', text: 'A in flight' }, { account: 'B', text: 'B own draft' }]);
    releases[0]();
    await Promise.all([firstCancelled, queuedCancelled, deletionCancelled]);
    // Completion of A's old request must not release B's in-flight protection.
    serverDrafts = [{ scope: 'session-a', text: 'stale B value', queuedMessage: null }];
    await store.hydrateChatDrafts();
    assert.equal(store.readDraftText('session-a'), 'B own draft');
    releases[1](); await nextAccount;
    assert.equal(calls.length, 2);
    assert.deepEqual(deletedScopes, []);
  } finally { save.mockRestore(); }
});

test('sign-out discards a former account’s late draft hydration', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  let release!: (response: Response) => void;
  const request = vi.spyOn(api.user, 'drafts').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  try {
    const hydration = store.hydrateChatDrafts();
    store.resetChatDrafts();
    store.writeDraftText('session-b', 'B draft');
    release(new Response(JSON.stringify({ drafts: [{ scope: 'session-a', text: 'A private draft', queuedMessage: null }] }), { status: 200 }));
    await hydration;
    assert.equal(store.readDraftText('session-a'), '');
    assert.equal(store.readDraftText('session-b'), 'B draft');
  } finally { request.mockRestore(); }
});

test('a queue keeps three messages in FIFO order and rejects a fourth without losing it', async () => {
  const store = await loadStore();

  for (const content of ['one', 'two', 'three']) {
    store.writeQueuedMessage('session-a', { id: content, content });
  }

  assert.deepEqual(store.readQueuedMessages('session-a').map(({ content }) => content), ['one', 'two', 'three']);
  assert.equal(store.readQueuedMessage('session-a')?.content, 'one', 'the head is the single-slot view');

  assert.throws(
    () => store.writeQueuedMessage('session-a', { id: 'four', content: 'four' }),
    store.QueueLimitError,
  );
  assert.deepEqual(
    store.readQueuedMessages('session-a').map(({ content }) => content),
    ['one', 'two', 'three'],
    'the rejected message did not replace or truncate the queue',
  );
});

test('re-writing an entry with the same ticket updates it instead of appending', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { id: 'a', content: 'first draft' });
  store.writeQueuedMessage('session-a', { id: 'b', content: 'second' });

  store.writeQueuedMessage('session-a', { id: 'a', content: 'first draft, edited' });

  assert.deepEqual(
    store.readQueuedMessages('session-a').map(({ content }) => content),
    ['first draft, edited', 'second'],
  );
});

test('deleting one queued entry by id leaves the others in order', async () => {
  const store = await loadStore();
  for (const content of ['one', 'two', 'three']) store.writeQueuedMessage('session-a', { id: content, content });

  store.clearQueuedMessage('session-a', 'two');

  assert.deepEqual(store.readQueuedMessages('session-a').map(({ content }) => content), ['one', 'three']);
});

test('a queue persisted as an array survives a reload; a legacy singleton is adopted', async () => {
  const first = await loadStore();
  for (const content of ['one', 'two', 'three']) first.writeQueuedMessage('session-a', { id: content, content });

  const second = await loadStore();
  assert.deepEqual(second.readQueuedMessages('session-a').map(({ content }) => content), ['one', 'two', 'three']);

  localStorage.setItem('chat-drafts', JSON.stringify({
    'session-legacy': { text: '', queuedMessage: { content: 'legacy singleton' } },
  }));
  const third = await loadStore();
  assert.deepEqual(third.readQueuedMessages('session-legacy').map(({ content }) => content), ['legacy singleton']);
});

test('hydrate restores a whole server queue and adopts a legacy singleton payload', async () => {
  serverDrafts = [
    { scope: 'session-a', text: '', queuedMessages: [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }, { id: 'c', content: 'three' }] },
    { scope: 'session-legacy', text: '', queuedMessage: { id: 'old', content: 'legacy' } },
  ];

  const store = await loadStore();
  await store.hydrateChatDrafts();

  assert.deepEqual(store.readQueuedMessages('session-a').map(({ content }) => content), ['one', 'two', 'three']);
  assert.deepEqual(store.readQueuedMessages('session-legacy').map(({ content }) => content), ['legacy']);
});

test('a whole-queue write persists every entry rather than a single slot', async () => {
  const store = await loadStore();
  store.writeQueuedMessages('session-a', [
    { id: 'a', content: 'one' },
    { id: 'b', content: 'two' },
  ]);
  await vi.advanceTimersByTimeAsync(0);

  assert.deepEqual(savedDrafts.at(-1), {
    scope: 'session-a',
    text: '',
    queuedMessages: [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }],
  });
});

test('typing saves only text and adopts the server queue after its head is dispatched', async () => {
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessages: [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }] }];
  const store = await loadStore();
  await store.hydrateChatDrafts();
  store.writeDraftText('session-a', 'still typing');
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessages: [{ id: 'b', content: 'B' }] }];
  await store.hydrateChatDrafts();
  assert.deepEqual(store.readQueuedMessages('session-a').map(({ id }) => id), ['b']);
  assert.equal(store.readDraftText('session-a'), 'still typing');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: 'still typing' }]);
});

test('an older hydrate cannot undo a queue edit saved while its response was in flight', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  let answer!: (response: Response) => void;
  vi.spyOn(api.user, 'drafts').mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  const pending = store.hydrateChatDrafts();
  store.writeQueuedMessage('session-a', { id: 'new', content: 'queued meanwhile' });
  await store.persistQueuedMessage('session-a');
  answer(new Response(JSON.stringify({ drafts: [{ scope: 'session-a', text: 'server draft', queuedMessages: [] }] }), { status: 200 }));
  await pending;
  assert.deepEqual(store.readQueuedMessages('session-a').map(({ id }) => id), ['new']);
  assert.equal(store.readDraftText('session-a'), 'server draft');
});

test('a failed queue addition survives hydrate and typing retries its latest value', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const save = vi.spyOn(api.user, 'saveDraft').mockRejectedValueOnce(new Error('offline'));
  const message = { id: 'queued-1', content: 'must be sent', attachments: [{ path: '/uploads/notes.txt' }] };
  store.writeQueuedMessage('session-a', message);
  await vi.advanceTimersByTimeAsync(0);
  await store.hydrateChatDrafts();
  assert.deepEqual(store.readQueuedMessages('session-a'), [message]);
  store.writeDraftText('session-a', 'the next draft');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.equal(save.mock.calls.length, 2);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: 'the next draft', queuedMessages: [message] }]);
  await store.hydrateChatDrafts();
  assert.deepEqual(store.readQueuedMessages('session-a'), []);
  store.writeDraftText('session-a', 'draft after dispatch');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts.at(-1), { scope: 'session-a', text: 'draft after dispatch' });
});

test('a failed cancellation stays cancelled locally and retries the empty queue', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessages: [{ id: 'cancelled', content: 'do not send' }] }];
  await store.hydrateChatDrafts();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(api.user, 'saveDraft').mockResolvedValueOnce(new Response('{}', { status: 503 }));
  store.clearQueuedMessage('session-a', 'cancelled');
  await vi.advanceTimersByTimeAsync(0);
  await store.hydrateChatDrafts();
  assert.deepEqual(store.readQueuedMessages('session-a'), []);
  store.writeDraftText('session-a', 'keep this draft');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: 'keep this draft', queuedMessages: [] }]);
});

test('a transient queue failure retries without another keystroke', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const save = vi.spyOn(api.user, 'saveDraft').mockRejectedValueOnce(new Error('offline'));
  store.writeQueuedMessage('session-a', { id: 'retry', content: 'send when online' });
  await vi.advanceTimersByTimeAsync(1_500);
  assert.equal(save.mock.calls.length, 2);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '', queuedMessages: [{ id: 'retry', content: 'send when online' }] }]);
});

test('a text-only retry never carries a queue the server has dispatched', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessages: [{ id: 'sent', content: 'already sent' }] }];
  await store.hydrateChatDrafts();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const save = vi.spyOn(api.user, 'saveDraft').mockRejectedValueOnce(new Error('offline'));
  store.writeDraftText('session-a', 'keep this draft');
  await vi.advanceTimersByTimeAsync(1_000);
  serverDrafts = [];
  await store.hydrateChatDrafts();
  assert.deepEqual(store.readQueuedMessages('session-a'), []);
  await vi.advanceTimersByTimeAsync(1_500);
  assert.equal(save.mock.calls.length, 2);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: 'keep this draft' }]);
});

test('retrying an older failed request uses the latest queue rather than its old snapshot', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let rejectFirst!: (error: Error) => void;
  const save = vi.spyOn(api.user, 'saveDraft').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
  store.writeQueuedMessage('session-a', { id: 'old', content: 'cancel this' });
  await vi.advanceTimersByTimeAsync(0);
  store.clearQueuedMessage('session-a', 'old');
  const latest = { id: 'new', content: 'send this instead' };
  store.writeQueuedMessage('session-a', latest);
  rejectFirst(new Error('offline'));
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(save.mock.calls.at(-1)?.[1], { text: '', queuedMessages: [latest] });
  assert.deepEqual(store.readQueuedMessages('session-a').map(({ id }) => id), ['new']);
  assert.ok(save.mock.calls.slice(1).every(([, draft]) => !draft.queuedMessages?.some((entry) => (entry as { id?: string }).id === 'old')));
});

test('a newer queued save supersedes an older failure without replaying dispatched turns', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let rejectFirst!: (error: Error) => void;
  const save = vi.spyOn(api.user, 'saveDraft').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
  store.writeQueuedMessage('session-a', { id: 'first', content: 'first turn' });
  await vi.advanceTimersByTimeAsync(0);
  store.writeQueuedMessage('session-a', { id: 'second', content: 'second turn' });
  rejectFirst(new Error('offline'));
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(save.mock.calls.length, 2);
  assert.deepEqual(savedDrafts[0]?.queuedMessages?.map((entry) => (entry as { id: string }).id), ['first', 'second']);
  await store.hydrateChatDrafts();
  assert.deepEqual(store.readQueuedMessages('session-a'), []);
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(save.mock.calls.length, 2);
});

test('persistent network failures back off and sign-out cancels the retries', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const save = vi.spyOn(api.user, 'saveDraft').mockRejectedValue(new Error('offline'));
  store.writeQueuedMessage('session-a', { id: 'private', content: 'account A only' });
  await vi.advanceTimersByTimeAsync(30_000);
  assert.ok(save.mock.calls.length > 2);
  assert.ok(save.mock.calls.length < 10);
  const attempts = save.mock.calls.length;
  store.resetChatDrafts();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(save.mock.calls.length, attempts);
});

test('a former account\'s late queue failure cannot dirty the next account\'s draft', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  let rejectFirst!: (error: Error) => void;
  const save = vi.spyOn(api.user, 'saveDraft').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
  store.writeQueuedMessage('session-a', { id: 'private', content: 'account A only' });
  await vi.advanceTimersByTimeAsync(0);
  store.resetChatDrafts();
  store.writeDraftText('session-a', 'account B draft');
  await vi.advanceTimersByTimeAsync(1_500);
  rejectFirst(new Error('offline after sign-out'));
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(save.mock.calls.length, 2);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: 'account B draft' }]);
});

test('a non-retryable response retains the queue edit without a busy retry loop', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const save = vi.spyOn(api.user, 'saveDraft').mockResolvedValueOnce(new Response('{}', { status: 409 }));
  store.writeQueuedMessage('session-a', { id: 'held', content: 'keep my edit' });
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(save.mock.calls.length, 1);
  await store.hydrateChatDrafts();
  assert.equal(store.readQueuedMessage('session-a')?.content, 'keep my edit');
  store.resetChatDrafts();
});

test('an unsaved queue survives a page reload with its original ticket', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(api.user, 'saveDraft').mockRejectedValueOnce(new Error('offline'));
  const message = { id: 'durable-ticket', content: 'survive the reload', attachments: [] };
  store.writeQueuedMessage('session-a', message);
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  const resumed = await loadStore();
  await resumed.hydrateChatDrafts();
  assert.deepEqual(resumed.readQueuedMessages('session-a'), [message]);
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '', queuedMessages: [message] }]);
});

test('an unsaved cancellation survives reload even when the draft is empty', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessages: [{ id: 'cancelled', content: 'do not send' }] }];
  await store.hydrateChatDrafts();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(api.user, 'saveDraft').mockRejectedValueOnce(new Error('offline'));
  store.clearQueuedMessage('session-a', 'cancelled');
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  const resumed = await loadStore();
  await resumed.hydrateChatDrafts();
  assert.deepEqual(resumed.readQueuedMessages('session-a'), []);
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '', queuedMessages: [] }]);
});

test('a successfully saved mirror never replays a dispatched queue after reload', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { id: 'saved', content: 'send only once' });
  await vi.advanceTimersByTimeAsync(0);
  savedDrafts.length = 0;
  vi.clearAllTimers();
  const resumed = await loadStore();
  await resumed.hydrateChatDrafts();
  assert.deepEqual(resumed.readQueuedMessages('session-a'), []);
  resumed.writeDraftText('session-a', 'next draft');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: 'next draft' }]);
});

test('a cancellation survives reload while its first save is still unanswered', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessages: [{ id: 'cancelled', content: 'do not send' }] }];
  await store.hydrateChatDrafts();
  vi.spyOn(api.user, 'saveDraft').mockImplementationOnce(() => new Promise(() => {}));
  store.clearQueuedMessage('session-a', 'cancelled');
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  const resumed = await loadStore();
  await resumed.hydrateChatDrafts();
  assert.deepEqual(resumed.readQueuedMessages('session-a'), []);
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '', queuedMessages: [] }]);
});

test('clearing the last text survives reload before its debounce has sent a request', async () => {
  const store = await loadStore();
  serverDrafts = [{ scope: 'session-a', text: 'old draft', queuedMessages: [] }];
  await store.hydrateChatDrafts();
  store.writeDraftText('session-a', '');
  vi.clearAllTimers();
  const resumed = await loadStore();
  await resumed.hydrateChatDrafts();
  assert.equal(resumed.readDraftText('session-a'), '');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '' }]);
  assert.deepEqual(deletedScopes, []);
});
