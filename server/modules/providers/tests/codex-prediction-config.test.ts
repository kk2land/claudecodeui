import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { CodexPredictionConfigProvider } from '@/modules/providers/list/codex/codex-prediction-config.provider.js';

const CONFIG_BODY = {
  is_enabled: true,
  prompt: 'Suggest the next message.',
  prompt_version: 'v1',
  prediction_reasoning_effort: '',
  sample_rate: 1,
};

/** A minimal base64url JWT with a configurable payload. */
function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function freshToken(): string {
  return jwt({
    sub: 'user-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-jwt', chatgpt_user_id: 'user-1' },
  });
}

// Every test gets an isolated default store, including cases that focus only
// on HTTP or caching and therefore do not create a store of their own.
let defaultHome: string | null = null;
let defaultPreviousHome: string | undefined;
beforeEach(async () => {
  defaultHome = await mkdtemp(path.join(os.tmpdir(), 'codex-pred-config-default-'));
  defaultPreviousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = defaultHome;
  await writeFile(path.join(defaultHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: freshToken(), account_id: 'acc-workspace' },
  }));
});
afterEach(async () => {
  if (defaultPreviousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = defaultPreviousHome;
  if (defaultHome) await rm(defaultHome, { recursive: true, force: true });
  defaultHome = null;
});

function okBody(fetchCalls: Array<{ url: string; init: RequestInit }>, body: unknown = CONFIG_BODY): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

async function withHome(fixture: unknown, fn: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-pred-config-'));
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await writeFile(path.join(home, 'auth.json'), JSON.stringify(fixture), 'utf8');
    await fn();
  } finally {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
    await rm(home, { recursive: true, force: true });
  }
}

test('loads configuration once and reuses the cache within TTL', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const provider = new CodexPredictionConfigProvider({ fetch: okBody(calls), ttlMs: 50 });
  const load = () => provider.load({ signal: new AbortController().signal, refreshCredentials: async () => {} });
  const first = await load();
  assert.equal(first.status, 'ready');
  await load();
  assert.equal(calls.length, 1, 'same identity within TTL reuses the cache');
  assert.equal(calls[0].init.redirect, 'error');
});

test('re-fetches after TTL expiry', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let now = 0;
  const provider = new CodexPredictionConfigProvider({ fetch: okBody(calls), ttlMs: 100, now: () => now });
  const load = () => provider.load({ signal: new AbortController().signal, refreshCredentials: async () => {} });
  await load();
  await load();
  assert.equal(calls.length, 1);
  now = 200;
  await load();
  assert.equal(calls.length, 2, 'expired cache re-fetches');
});

test('an apikey auth_mode store issues zero fetches even with residual OAuth tokens', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const provider = new CodexPredictionConfigProvider({ fetch: okBody(calls) });
  await withHome({
    auth_mode: 'apikey',
    tokens: { access_token: freshToken(), account_id: 'acc-1' },
    API_KEY: 'sk-legacy',
  }, async () => {
    const result = await provider.load({ signal: new AbortController().signal, refreshCredentials: async () => {} });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'ineligible');
    assert.equal(calls.length, 0, 'apikey mode must never fetch the OAuth endpoint');
  });
});

test('workspace account_id wins over the JWT default account', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const provider = new CodexPredictionConfigProvider({ fetch: okBody(calls) });
  await withHome({ tokens: { access_token: freshToken(), account_id: 'acc-workspace' } }, async () => {
    const result = await provider.load({ signal: new AbortController().signal, refreshCredentials: async () => {} });
    assert.equal(result.status, 'ready');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['ChatGPT-Account-ID'], 'acc-workspace');
    assert.equal(headers['X-OpenAI-Attach-Auth'], undefined, 'attach marker must not be sent');
  });
});

test('an expired JWT refreshes first and never reaches the endpoint with the stale token', async () => {
  let fetchCalls = 0;
  let refreshCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify(CONFIG_BODY), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const provider = new CodexPredictionConfigProvider({
    fetch: fetchImpl,
    readAuth: async () => ({ accessToken: 'stale-tok', accountId: null, userId: null, expired: true, identity: 'stale' }),
  });
  const result = await provider.load({
    signal: new AbortController().signal,
    refreshCredentials: async () => { refreshCalls++; },
  });
  // The stale identity is unchanged after a no-op refresh, so the loader stops.
  assert.equal(refreshCalls, 1);
  assert.equal(fetchCalls, 0, 'an expired token must never be sent to the endpoint');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'ineligible');
});

test('401 refreshes once and reuses the new identity', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let authorized = false;
  let refreshCalls = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    if (!authorized) return new Response('unauthorized', { status: 401 });
    return new Response(JSON.stringify(CONFIG_BODY), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const provider = new CodexPredictionConfigProvider({ fetch: fetchImpl });
  await withHome({ tokens: { access_token: freshToken(), account_id: 'acc-1' } }, async () => {
    const home = process.env.CODEX_HOME!;
    const result = await provider.load({
      signal: new AbortController().signal,
      refreshCredentials: async () => {
        refreshCalls++;
        authorized = true;
        // app-server rotates the token, so identity changes on re-read.
        await writeFile(path.join(home, 'auth.json'), JSON.stringify({
          tokens: { access_token: jwt({ sub: 'user-2', exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-2', chatgpt_user_id: 'user-2' } }), account_id: 'acc-2' },
        }), 'utf8');
      },
    });
    assert.equal(result.status, 'ready');
    assert.equal(refreshCalls, 1);
  });
});

test('401 with unchanged identity after refresh reports ineligible rather than looping', async () => {
  let authorized = false;
  const fetchImpl = (async () => (authorized ? new Response(JSON.stringify(CONFIG_BODY), { status: 200 }) : new Response('unauthorized', { status: 401 }))) as unknown as typeof fetch;
  const provider = new CodexPredictionConfigProvider({
    readAuth: async () => ({ accessToken: 'tok', accountId: null, userId: null, expired: false, identity: 'same' }),
    fetch: fetchImpl,
  });
  const result = await provider.load({
    signal: new AbortController().signal,
    refreshCredentials: async () => { authorized = true; },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'ineligible');
});

test('abort during readAuth performs zero fetches', async () => {
  let fetchCalls = 0;
  const controller = new AbortController();
  const provider = new CodexPredictionConfigProvider({
    readAuth: async () => {
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      return { accessToken: 'tok', accountId: null, userId: null, expired: false, identity: 'x' };
    },
    fetch: (async () => { fetchCalls++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
  });
  await assert.rejects(provider.load({ signal: controller.signal, refreshCredentials: async () => {} }));
  assert.equal(fetchCalls, 0);
});

test('a body that never ends respects the timeout and reports config_unavailable', async () => {
  const provider = new CodexPredictionConfigProvider({
    readAuth: async () => ({ accessToken: 'tok', accountId: null, userId: null, expired: false, identity: 'x' }),
    timeoutMs: 20,
    fetch: (async () => new Response(new ReadableStream({ start() { /* never ends */ } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch,
  });
  const result = await provider.load({ signal: new AbortController().signal, refreshCredentials: async () => {} });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'config_unavailable');
});

test('network and JSON errors surface only a non-sensitive reason', async () => {
  const network = new CodexPredictionConfigProvider({
    readAuth: async () => ({ accessToken: 'tok', accountId: null, userId: null, expired: false, identity: 'x' }),
    fetch: (async () => { throw new Error('ECONNREFUSED secret detail'); }) as unknown as typeof fetch,
  });
  let result = await network.load({ signal: new AbortController().signal, refreshCredentials: async () => {} });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'config_unavailable');

  const badJson = new CodexPredictionConfigProvider({
    readAuth: async () => ({ accessToken: 'tok', accountId: null, userId: null, expired: false, identity: 'x' }),
    fetch: (async () => new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch,
  });
  result = await badJson.load({ signal: new AbortController().signal, refreshCredentials: async () => {} });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'config_unavailable');
});

test('an account switch during the response cannot return or cache the old configuration', async () => {
  const store = path.join(process.env.CODEX_HOME!, 'auth.json');
  const accounts: string[] = [];
  const provider = new CodexPredictionConfigProvider({
    fetch: (async (_url, init) => {
      assert.ok(init?.headers);
      accounts.push((init.headers as Record<string, string>)['ChatGPT-Account-ID']);
      if (accounts.length === 1) {
        await writeFile(store, JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { access_token: freshToken(), account_id: 'switched-account' },
        }));
      }
      return new Response(JSON.stringify(CONFIG_BODY), { status: 200 });
    }) as typeof fetch,
  });
  const input = { signal: new AbortController().signal, refreshCredentials: async () => {} };
  assert.deepEqual(await provider.load(input), { status: 'unavailable', reason: 'ineligible' });
  assert.equal((await provider.load(input)).status, 'ready');
  assert.deepEqual(accounts, ['acc-workspace', 'switched-account']);
});

test('an expired-token refresh followed by 401 never performs a second refresh', async () => {
  const store = path.join(process.env.CODEX_HOME!, 'auth.json');
  await writeFile(store, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: jwt({ exp: 1 }), account_id: 'acc-workspace' },
  }));
  let refreshes = 0;
  let fetches = 0;
  const provider = new CodexPredictionConfigProvider({
    fetch: (async () => { fetches++; return new Response('{}', { status: 401 }); }) as typeof fetch,
  });
  const result = await provider.load({
    signal: new AbortController().signal,
    refreshCredentials: async () => {
      refreshes++;
      await writeFile(store, JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: freshToken(), account_id: 'acc-workspace' },
      }));
    },
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'ineligible' });
  assert.equal(refreshes, 1);
  assert.equal(fetches, 1);
});

test('caller cancellation also settles while a response body is pending', async () => {
  const controller = new AbortController();
  let headersReady!: () => void;
  const headers = new Promise<void>((resolve) => { headersReady = resolve; });
  const provider = new CodexPredictionConfigProvider({
    fetch: (async () => {
      headersReady();
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as typeof fetch,
  });
  const pending = provider.load({ signal: controller.signal, refreshCredentials: async () => {} });
  await headers;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
