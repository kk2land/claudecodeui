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
