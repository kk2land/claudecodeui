import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionDraftsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

async function withDrafts(runTest: (userId: number, sessionId: string) => void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-drafts-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const userId = Number(userDb.createUser('drafts-test', 'hash').id);
    const sessionId = 'draft-queue-session';
    sessionsDb.createAppSession(sessionId, 'codex', root);
    runTest(userId, sessionId);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function queue(userId: number): Array<Record<string, unknown>> {
  return (sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? []) as Array<Record<string, unknown>>;
}

function ids(userId: number): string[] {
  return queue(userId).map((message) => String(message.id));
}

test('guarded append succeeds on an empty queue and unguarded appends keep FIFO', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraftText(userId, sessionId, 'draft text');
    const first = sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'voice', attachments: [] }, true);
    assert.equal(first.appended, false);
    assert.ok(first.queuedMessage.id);
    assert.deepEqual(queue(userId), [first.queuedMessage]);
    assert.deepEqual(sessionDraftsDb.listQueuedMessages(sessionId)[0]?.queuedMessage, first.queuedMessage);

    const next = { content: 'web', attachments: [] };
    assert.throws(() => sessionDraftsDb.appendQueuedMessage(userId, sessionId, next, true), { code: 'QUEUE_NOT_EMPTY' });
    assert.deepEqual(queue(userId), [first.queuedMessage]);

    const second = sessionDraftsDb.appendQueuedMessage(userId, sessionId, next);
    const third = sessionDraftsDb.appendQueuedMessage(userId, sessionId, next, false);
    assert.equal(second.appended, true);
    assert.equal(third.appended, true);
    assert.deepEqual(queue(userId), [first.queuedMessage, second.queuedMessage, third.queuedMessage]);
    assert.equal(sessionDraftsDb.getDrafts(userId)[0]?.text, 'draft text');
  });
});

test('guarded append leaves a web send and its steer receipt untouched', async () => {
  await withDrafts((userId, sessionId) => {
    const web = { content: 'web', attachments: [] };
    const voice = { content: 'voice', attachments: [] };
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, web, 'web-head');
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, web, 'web-tail');

    assert.throws(() => sessionDraftsDb.appendQueuedMessage(userId, sessionId, voice, true), { code: 'QUEUE_NOT_EMPTY' });
    sessionDraftsDb.beginSteer(userId, sessionId, 'web-head', 'steer-request');
    const before = sessionDraftsDb.getDrafts(userId);

    assert.throws(() => sessionDraftsDb.appendQueuedMessage(userId, sessionId, voice, true), { code: 'QUEUE_NOT_EMPTY' });
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), before);
    assert.deepEqual(ids(userId), ['web-head', 'web-tail']);
    assert.deepEqual(sessionDraftsDb.beginSteer(userId, sessionId, 'web-head', 'steer-request'), { status: 'steering', error: null });
  });
});

test('guarded append counts a dispatching head until its receipt is accepted', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, { content: 'web', attachments: [] }, 'web-head');
    const [head] = sessionDraftsDb.listQueuedMessages(sessionId);
    assert.equal(sessionDraftsDb.claimQueuedMessage(head), true);
    assert.deepEqual(queue(userId), []);

    const voice = { content: 'voice', attachments: [] };
    assert.throws(() => sessionDraftsDb.appendQueuedMessage(userId, sessionId, voice, true), { code: 'QUEUE_NOT_EMPTY' });
    assert.deepEqual(queue(userId), []);

    sessionDraftsDb.confirmQueuedMessageDispatch(head);
    const result = sessionDraftsDb.appendQueuedMessage(userId, sessionId, voice, true);
    assert.equal(result.appended, false);
    assert.deepEqual(queue(userId), [result.queuedMessage]);
    assert.equal(sessionDraftsDb.hasSentChatMessage(userId, sessionId, 'web-head'), true);
  });
});

test('a ticket-aware PUT replaces a known message and keeps a server-side ticket it did not see', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, { queuedMessages: [{ id: 'A', content: 'A' }] });
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, { content: 'B', attachments: [] }, 'B');

    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ id: 'A', content: 'A edited' }],
      knownQueuedMessageIds: ['A'],
    });

    assert.deepEqual(ids(userId), ['A', 'B']);
    assert.equal(queue(userId)[0].content, 'A edited');
  });
});

test('deleting the seen head with an empty snapshot keeps the unseen server ticket', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, { queuedMessages: [{ id: 'A', content: 'A' }] });
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, { content: 'B', attachments: [] }, 'B');

    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [],
      knownQueuedMessageIds: ['A'],
    });

    assert.deepEqual(ids(userId), ['B']);
  });
});

test('a newly appended local ticket lands after an unseen server ticket', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, { queuedMessages: [{ id: 'A', content: 'A' }] });
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, { content: 'B', attachments: [] }, 'B');

    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ id: 'A', content: 'A edited' }, { id: 'C', content: 'C' }],
      knownQueuedMessageIds: ['A'],
    });

    assert.deepEqual(ids(userId), ['A', 'B', 'C']);
  });
});

test('a reordered snapshot keeps an unseen server ticket in place and moves the legacy entry', async () => {
  await withDrafts((userId, sessionId) => {
    const legacy = { content: 'legacy' };
    const first = { id: 'A', content: 'A' };
    const last = { id: 'B', content: 'B' };
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [legacy, first, { id: 'unseen', content: 'unseen' }, last],
    });

    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [last, legacy, first, { id: 'C', content: 'C' }],
      knownQueuedMessageIds: ['A', 'B', 'C'],
    });

    assert.deepEqual(queue(userId).map(({ content }) => content), ['B', 'legacy', 'unseen', 'A', 'C']);
  });
});

test('reordering a rejected steer queue keeps it held until explicit resume', async () => {
  await withDrafts((userId, sessionId) => {
    const first = { id: 'first', content: 'first turn' };
    const second = { id: 'second', content: 'second turn' };
    const legacy = { content: 'legacy turn' };
    const held = { status: 'held', requestId: 'rejected-steer', error: 'Turn ended' };
    sessionDraftsDb.saveDraft(userId, sessionId, { queuedMessages: [first, second, legacy] });
    sessionDraftsDb.beginSteer(userId, sessionId, first.id, held.requestId);
    sessionDraftsDb.finishSteer(userId, sessionId, held.requestId, 'rejected', held.error);

    const reordered = [second, legacy, first];
    // The browser can save the same order again with normalized attachments and fields.
    const normalized = reordered.map((entry) => ({ attachments: [], ...entry }));
    for (const queuedMessages of [reordered, normalized]) {
      sessionDraftsDb.saveDraft(userId, sessionId, {
        queuedMessages,
        knownQueuedMessageIds: [first.id, second.id],
      });
      const [draft] = sessionDraftsDb.getDrafts(userId);
      assert.deepEqual(draft.queuedMessages, queuedMessages);
      assert.deepEqual(draft.queuedDelivery, held);
      assert.deepEqual(sessionDraftsDb.listQueuedMessages(sessionId), []);
    }

    sessionDraftsDb.resumeQueue(userId, sessionId);
    assert.deepEqual(sessionDraftsDb.listQueuedMessages(sessionId)[0]?.queuedMessage, normalized[0]);
  });
});

test('a ticket the browser has seen can be deleted explicitly', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ id: 'A', content: 'A' }, { id: 'B', content: 'B' }],
    });
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ id: 'A', content: 'A' }],
      knownQueuedMessageIds: ['A', 'B'],
    });
    assert.deepEqual(ids(userId), ['A']);
  });
});

test('a legacy PUT without the ticket set still replaces the whole queue', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ id: 'A', content: 'A' }, { id: 'B', content: 'B' }],
    });
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ id: 'A', content: 'A' }],
    });
    assert.deepEqual(ids(userId), ['A']);
  });
});

test('ticket-aware saves keep legacy entries without ids singular and positionally replaceable', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ content: 'legacy A' }],
    });

    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ content: 'legacy A' }],
      knownQueuedMessageIds: [],
    });

    assert.deepEqual(queue(userId), [{ content: 'legacy A' }]);
  });
});

test('an empty ticket-aware snapshot deletes a legacy entry without ids', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ content: 'legacy A' }],
    });
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [],
      knownQueuedMessageIds: [],
    });
    assert.deepEqual(queue(userId), []);
  });
});

test('deleting a legacy entry keeps a ticket-bearing server addition', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ content: 'legacy A' }],
    });
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, { content: 'B', attachments: [] }, 'B');

    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [],
      knownQueuedMessageIds: [],
    });

    assert.deepEqual(ids(userId), ['B']);
  });
});

test('an unchanged legacy snapshot plus a new server ticket does not duplicate or reorder', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ content: 'legacy A' }],
    });
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, { content: 'B', attachments: [] }, 'B');

    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ content: 'legacy A' }],
      knownQueuedMessageIds: [],
    });

    assert.deepEqual(queue(userId).map((message) => message.content), ['legacy A', 'B']);
    assert.equal(queue(userId).filter((message) => message.content === 'legacy A').length, 1);
  });
});

test('a new local ticket with a legacy snapshot stays after a server-side ticket', async () => {
  await withDrafts((userId, sessionId) => {
    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ content: 'legacy A' }],
    });
    sessionDraftsDb.enqueueChatMessage(userId, sessionId, { content: 'B', attachments: [] }, 'B');

    sessionDraftsDb.saveDraft(userId, sessionId, {
      queuedMessages: [{ content: 'legacy A' }, { id: 'C', content: 'C' }],
      knownQueuedMessageIds: [],
    });

    assert.deepEqual(queue(userId).map((message) => message.content), ['legacy A', 'B', 'C']);
    assert.equal(queue(userId).filter((message) => message.content === 'legacy A').length, 1);
  });
});
