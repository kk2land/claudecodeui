import assert from 'node:assert/strict';
import test from 'node:test';

import { createUserService } from '../user.service.js';

type UserDependencies = Parameters<typeof createUserService>[0];

const noDrafts: UserDependencies['drafts'] = {
  getDrafts: () => [],
  saveDraft: () => undefined,
  saveDraftText: () => undefined,
  appendQueuedMessage: (_userId, _scope, message) => ({ queuedMessage: message, appended: false }),
  clearQueuedMessage: () => undefined,
  deleteDraft: () => undefined,
};

function createDependencies(overrides: Partial<UserDependencies> = {}): UserDependencies {
  return {
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: () => undefined,
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    preferences: {
      getPreferences: () => ({}),
      savePreferences: () => undefined,
    },
    drafts: noDrafts,
    readSystemGitConfig: async () => ({ git_name: null, git_email: null }),
    applyGlobalGitConfig: async () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

test('getGitConfig imports system configuration when the repository is empty', async () => {
  const updates: unknown[][] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (...args) => updates.push(args),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    readSystemGitConfig: async () => ({ git_name: 'Alice', git_email: 'alice@example.com' }),
  }));

  const result = await service.getGitConfig(7);

  assert.equal(result.gitName, 'Alice');
  assert.deepEqual(updates, [[7, 'Alice', 'alice@example.com']]);
});

test('updateGitConfig persists valid input and invokes the Git adapter', async () => {
  const operations: string[] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (_id, name, email) => operations.push(`persist:${name}:${email}`),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    applyGlobalGitConfig: async (name, email) => {
      operations.push(`git:${name}:${email}`);
    },
  }));

  await service.updateGitConfig(1, 'Alice', 'alice@example.com');
  assert.deepEqual(operations, [
    'persist:Alice:alice@example.com',
    'git:Alice:alice@example.com',
  ]);
});

test('savePreferences forwards only the keys the client sent', () => {
  const saved: Array<Record<string, unknown>> = [];
  const service = createUserService(createDependencies({
    preferences: {
      getPreferences: () => ({ theme: 'dark' }),
      savePreferences: (_id, updates) => saved.push(updates),
    },
  }));

  const result = service.savePreferences(3, { theme: 'light' });

  assert.deepEqual(saved, [{ theme: 'light' }]);
  assert.deepEqual(result.preferences, { theme: 'dark' });
});

test('savePreferences rejects a non-object body', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, ['theme']), /object/i);
  assert.throws(() => service.savePreferences(3, 'theme'), /object/i);
});

test('savePreferences rejects an over-long preference key', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, { ['k'.repeat(201)]: 1 }), /1-200/);
});

test('saveDraft stores the text and queued message under the given scope', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: { ...noDrafts, saveDraft: (...args) => saved.push(args) },
  }));

  service.saveDraft(5, 'session-1', {
    scope: 'session-1',
    text: 'half a thought',
    queuedMessage: { content: 'later' },
  });

  assert.deepEqual(saved, [[5, 'session-1', {
    text: 'half a thought',
    queuedMessages: [{ content: 'later' }],
  }]]);
});

test('saveDraft without a queue writes only text and preserves the stored FIFO', () => {
  const saved: unknown[][] = [];
  const textOnly: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      ...noDrafts,
      saveDraft: (...args) => saved.push(args),
      saveDraftText: (...args) => textOnly.push(args),
    },
  }));

  service.saveDraft(5, 'session-1', { scope: 'session-1', text: 'typing' });

  assert.deepEqual(textOnly, [[5, 'session-1', 'typing']]);
  assert.deepEqual(saved, []);
});

test('saveDraft accepts a whole FIFO queue and rejects a fourth entry', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      ...noDrafts,
      getDrafts: () => [],
      saveDraft: (...args) => saved.push(args),
      deleteDraft: () => undefined,
    },
  }));
  const queue = ['one', 'two', 'three'].map((content) => ({ content }));

  service.saveDraft(5, 'session-1', { scope: 'session-1', queuedMessages: queue });
  assert.deepEqual(saved, [[5, 'session-1', { text: '', queuedMessages: queue }]]);

  assert.throws(
    () => service.saveDraft(5, 'session-1', {
      queuedMessages: [...queue, { content: 'four' }],
    }),
    (error: Error & { code?: string }) => error.code === 'QUEUE_LIMIT_REACHED',
  );
});

test('saveDraft adopts a legacy single queued message and rejects a non-array queue', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      ...noDrafts,
      getDrafts: () => [],
      saveDraft: (...args) => saved.push(args),
      deleteDraft: () => undefined,
    },
  }));

  service.saveDraft(5, 'session-1', { queuedMessage: { content: 'legacy' } });
  assert.deepEqual(saved, [[5, 'session-1', { text: '', queuedMessages: [{ content: 'legacy' }] }]]);

  assert.throws(
    () => service.saveDraft(5, 'session-1', { queuedMessages: 'not-an-array' }),
    (error: Error & { code?: string }) => error.code === 'INVALID_QUEUED_MESSAGES',
  );
});

test('appendQueuedMessage hands the repository the message and returns what is now queued', () => {
  const appended: unknown[][] = [];
  const changed: string[] = [];
  const service = createUserService(createDependencies({
    drafts: {
      ...noDrafts,
      appendQueuedMessage: (...args) => {
        appended.push(args);
        return { queuedMessage: { content: 'A\n\nB', attachments: [] }, appended: true };
      },
    },
    onQueueChanged: (scope) => changed.push(scope),
  }));

  const result = service.appendQueuedMessage(5, 'session-1', {
    content: 'B',
    options: { model: 'opus' },
    attachments: [{ name: 'b.txt' }],
    stray: 'dropped',
  });

  assert.deepEqual(appended, [[5, 'session-1', {
    content: 'B',
    options: { model: 'opus' },
    attachments: [{ name: 'b.txt' }],
  }]]);
  assert.deepEqual(result, {
    success: true,
    queuedMessage: { content: 'A\n\nB', attachments: [] },
    appended: true,
  });
  assert.deepEqual(changed, ['session-1'], 'an enqueue asks the dispatcher to try this scope immediately');
});

test('appendQueuedMessage refuses a message with nothing to send, or a bad scope', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.appendQueuedMessage(5, 'session-1', { content: '  ', attachments: [] }), /text or attachments/);
  assert.throws(() => service.appendQueuedMessage(5, 'session-1', 'not an object'), /text or attachments/);
  assert.throws(() => service.appendQueuedMessage(5, '   ', { content: 'B' }), /scope/i);
});

test('appendQueuedMessage refuses, as a conflict, a slash command the repository cannot combine', () => {
  const service = createUserService(createDependencies({
    drafts: { ...noDrafts, appendQueuedMessage: () => null },
  }));

  assert.throws(
    () => service.appendQueuedMessage(5, 'session-1', { content: '/compact', attachments: [] }),
    (error: unknown) => {
      const appError = error as { code?: string; statusCode?: number; message?: string };
      assert.equal(appError.code, 'QUEUED_MESSAGE_NOT_COMBINABLE');
      assert.equal(appError.statusCode, 409);
      assert.match(appError.message ?? '', /slash command/);
      return true;
    },
  );
});

test('clearQueuedMessage clears the named scope', () => {
  const cleared: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: { ...noDrafts, clearQueuedMessage: (...args) => cleared.push(args) },
  }));

  assert.deepEqual(service.clearQueuedMessage(5, 'session-1'), { success: true });
  assert.deepEqual(cleared, [[5, 'session-1']]);
});

test('saveDraft rejects a blank or over-long scope', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.saveDraft(5, '   ', { text: 'x' }), /scope/i);
  assert.throws(() => service.saveDraft(5, 'x'.repeat(201), { text: 'x' }), /scope/i);
});

test('saveDraft rejects text past the storage limit', () => {
  const service = createUserService(createDependencies());

  assert.throws(
    () => service.saveDraft(5, 'session-1', { text: 'x'.repeat(100_001) }),
    /too long/i,
  );
});

test('saveDraft validates and forwards the optional known ticket set', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: { ...noDrafts, saveDraft: (...args) => saved.push(args) },
  }));

  service.saveDraft(5, 'session-1', {
    queuedMessages: [{ id: 'A', content: 'A' }],
    knownQueuedMessageIds: ['A', 'A', ' B '],
  });
  assert.deepEqual(saved, [[5, 'session-1', {
    text: '',
    queuedMessages: [{ id: 'A', content: 'A' }],
    knownQueuedMessageIds: ['A', 'B'],
  }]]);

  for (const invalid of ['A', [1], ['']]) {
    assert.throws(
      () => service.saveDraft(5, 'session-1', {
        queuedMessages: [],
        knownQueuedMessageIds: invalid,
      }),
      (error: Error & { code?: string }) => error.code === 'INVALID_KNOWN_QUEUED_MESSAGE_IDS',
    );
  }
});
