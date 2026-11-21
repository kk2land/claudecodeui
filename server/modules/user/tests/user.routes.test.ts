import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/index.js';

import { createUserRouter } from '../user.routes.js';
import { createUserService } from '../user.service.js';

type UserDependencies = Parameters<typeof createUserService>[0];
type DraftCall = [string, ...unknown[]];

const USER_ID = 7;

/** Serves the user routes over a service whose drafts store only records what it was asked to do. */
async function withUserServer(run: (baseUrl: string, calls: DraftCall[]) => Promise<void>): Promise<void> {
  const calls: DraftCall[] = [];
  const unexpected = () => {
    throw new Error('Unexpected user service call');
  };
  const dependencies: UserDependencies = {
    users: {
      getGitConfig: unexpected,
      updateGitConfig: unexpected,
      completeOnboarding: unexpected,
      hasCompletedOnboarding: unexpected,
    },
    preferences: { getPreferences: unexpected, savePreferences: unexpected },
    drafts: {
      getDrafts: () => [],
      saveDraft: (...args) => { calls.push(['saveDraft', ...args]); },
      saveDraftText: (...args) => { calls.push(['saveDraftText', ...args]); },
      appendQueuedMessage: (...args) => {
        calls.push(['appendQueuedMessage', ...args]);
        if (args[1] === 'session-with-command' && args[3]) {
          throw new AppError('This chat already has a message waiting to send.', { code: 'QUEUE_NOT_EMPTY', statusCode: 409 });
        }
        // Stands in for a scope whose waiting message cannot take this one.
        return args[1] === 'session-with-command' ? null : { queuedMessage: { ...args[2], id: 'ticket' }, appended: false };
      },
      clearQueuedMessage: (...args) => { calls.push(['clearQueuedMessage', ...args]); },
      deleteDraft: (...args) => { calls.push(['deleteDraft', ...args]); },
    },
    readSystemGitConfig: unexpected,
    applyGlobalGitConfig: unexpected,
    logInfo: () => undefined,
    logError: () => undefined,
  };
  const service = createUserService(dependencies);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: USER_ID };
    next();
  });
  app.use('/api/user', createUserRouter(service));
  app.use((error: AppError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code, message: error.message } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const send = (url: string, method: string, body: unknown) => fetch(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('POST /drafts/queued-message appends the message for the signed-in user', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const queuedMessage = { content: 'B', options: { model: 'opus' }, attachments: [] };
    for (const ifEmpty of [undefined, false, true]) {
      const response = await send(`${baseUrl}/api/user/drafts/queued-message`, 'POST', {
        scope: 'session-a', queuedMessage, ifEmpty,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        success: true,
        queuedMessage: { ...queuedMessage, id: 'ticket' },
        appended: false,
      });
      assert.deepEqual(calls.pop(), ['appendQueuedMessage', USER_ID, 'session-a', queuedMessage, ifEmpty]);
    }
    assert.deepEqual(calls, []);
  });
});

test('POST /drafts/queued-message returns a readable 409 when ifEmpty finds a waiting message', async () => {
  await withUserServer(async (baseUrl) => {
    const response = await send(`${baseUrl}/api/user/drafts/queued-message`, 'POST', {
      scope: 'session-with-command',
      queuedMessage: { content: 'voice follow-up' },
      ifEmpty: true,
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      success: false,
      error: { code: 'QUEUE_NOT_EMPTY', message: 'This chat already has a message waiting to send.' },
    });
  });
});

test('POST /drafts/queued-message rejects a non-boolean ifEmpty before appending', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts/queued-message`, 'POST', {
      scope: 'session-a', queuedMessage: { content: 'B' }, ifEmpty: 'true',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      success: false,
      error: { code: 'INVALID_IF_EMPTY', message: 'ifEmpty must be a boolean.' },
    });
    assert.deepEqual(calls, []);
  });
});

test('POST /drafts/queued-message refuses a message with nothing to send', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts/queued-message`, 'POST', {
      scope: 'session-a',
      queuedMessage: { content: '   ', attachments: [] },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      success: false,
      error: { code: 'INVALID_QUEUED_MESSAGE', message: 'A queued message needs text or attachments' },
    });
    assert.deepEqual(calls, []);
  });
});

test('POST /drafts/queued-message answers 409 when the message cannot be combined with the waiting one', async () => {
  await withUserServer(async (baseUrl) => {
    const response = await send(`${baseUrl}/api/user/drafts/queued-message`, 'POST', {
      scope: 'session-with-command',
      queuedMessage: { content: 'fix it', attachments: [] },
    });

    assert.equal(response.status, 409);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'QUEUED_MESSAGE_NOT_COMBINABLE');
  });
});

test('DELETE /drafts/queued-message clears only the queued message, not the draft text', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts/queued-message`, 'DELETE', { scope: 'session-a' });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['clearQueuedMessage', USER_ID, 'session-a']]);
  });
});

test('PUT /drafts without a queued message writes only the text', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts`, 'PUT', { scope: 'session-a', text: 'typing' });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['saveDraftText', USER_ID, 'session-a', 'typing']]);
  });
});
