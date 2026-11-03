import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Behavioural test of the shipped public/sw.js inside a VM with fake Cache Storage
// and a controllable network. It asserts what the service worker does to requests,
// not how its source is written.
const SERVICE_WORKER_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../../../../public/sw.js', import.meta.url)),
  'utf8',
);
const ORIGIN = 'https://app.test';

type FetchCall = { url: string; init?: { cache?: string } };

class FakeCache {
  readonly entries = new Map<string, Response>();

  constructor(
    private readonly fetchImpl: (request: Request) => Promise<Response>,
    private readonly writeShouldFail: () => boolean,
  ) {}

  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) {
      const request = new Request(new URL(url, ORIGIN));
      const response = await this.fetchImpl(request);
      assert.equal(response.status, 200, `precache failed for ${url}`);
      await this.put(request, response);
    }
  }

  async put(request: Request | string, response: Response): Promise<void> {
    if (this.writeShouldFail()) throw new DOMException('quota exceeded', 'QuotaExceededError');
    this.entries.set(FakeCache.key(request), response);
  }

  async match(request: Request | string): Promise<Response | undefined> {
    const response = this.entries.get(FakeCache.key(request));
    return response?.clone();
  }

  private static key(request: Request | string): string {
    return typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  constructor(
    private readonly fetchImpl: (request: Request) => Promise<Response>,
    private readonly writeShouldFail: () => boolean,
  ) {}

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache(this.fetchImpl, this.writeShouldFail);
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async match(request: Request | string): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const response = await cache.match(request);
      if (response) return response;
    }
    return undefined;
  }
}

type ServiceWorkerEnvironment = {
  fetchCalls: FetchCall[];
  offline: () => void;
  online: (handler: (request: Request) => Response | Promise<Response>) => void;
  fetch: (request: { url: string; method?: string; mode?: string }) => Promise<Response | undefined>;
  navigate: (path: string) => Promise<Response | undefined>;
  request: (path: string, options?: { mode?: string; method?: string }) => Promise<Response | undefined>;
  run: (eventName: 'install' | 'activate') => Promise<void>;
  cacheNames: () => Promise<string[]>;
  cacheEntryCount: () => number;
  failCacheWrites: () => void;
  flushWaitUntil: () => Promise<void>;
  clientClaimCount: () => number;
  skipWaitingCount: () => number;
  seedCache: (name: string, path: string, body: string) => Promise<void>;
  seedManifest: (body: string) => void;
};

function createEnvironment(): ServiceWorkerEnvironment {
  const fetchCalls: FetchCall[] = [];
  let networkHandler: (request: Request) => Response | Promise<Response> = () =>
    Promise.reject(new Error('offline'));
  let skipWaitingCount = 0;
  let clientClaimCount = 0;
  let cacheWritesShouldFail = false;
  const pendingWaitUntils: Promise<unknown>[] = [];

  const fetchStub = async (request: Request, init?: { cache?: string }) => {
    fetchCalls.push({ url: request.url, init });
    return networkHandler(request);
  };

  const cacheStorage = new FakeCacheStorage(
    (request) => fetchStub(request),
    () => cacheWritesShouldFail,
  );
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    skipWaiting: async () => {
      skipWaitingCount += 1;
    },
    clients: {
      claim: async () => {
        clientClaimCount += 1;
      },
      matchAll: async () => [],
      openWindow: async () => undefined,
    },
    registration: { showNotification: async () => undefined },
  };

  vm.runInNewContext(
    SERVICE_WORKER_SOURCE,
    {
      self,
      caches: cacheStorage,
      fetch: fetchStub,
      Request,
      Response,
      Headers,
      URL,
    },
    { filename: 'public/sw.js' },
  );

  async function dispatchFetch(request: { url: string; method?: string; mode?: string; headers?: Headers }) {
    const event = {
      request: {
        method: 'GET',
        mode: 'cors',
        headers: new Headers(),
        ...request,
      },
      respondWith: (promise?: Promise<Response>) => {
        event.respondWithPromise = promise;
      },
      respondWithPromise: undefined as Promise<Response> | undefined,
      waitUntil: (promise: Promise<unknown>) => {
        pendingWaitUntils.push(promise);
      },
    };
    for (const handler of listeners.get('fetch') ?? []) handler(event);
    return event.respondWithPromise ? await event.respondWithPromise : undefined;
  }

  async function runLifecycleEvent(name: 'install' | 'activate') {
    let pending: Promise<unknown> | undefined;
    const event = {
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    };
    for (const handler of listeners.get(name) ?? []) handler(event);
    assert.ok(pending, `${name} handler must call waitUntil`);
    await pending;
  }

  return {
    fetchCalls,
    offline: () => {
      networkHandler = () => Promise.reject(new Error('offline'));
    },
    online: (handler) => {
      networkHandler = handler;
    },
    fetch: (request) => dispatchFetch(request),
    navigate: (path) => dispatchFetch({ url: new URL(path, ORIGIN).href, mode: 'navigate' }),
    request: (path, options) => dispatchFetch({ url: new URL(path, ORIGIN).href, ...options }),
    run: runLifecycleEvent,
    cacheNames: () => cacheStorage.keys(),
    cacheEntryCount: () =>
      [...cacheStorage.caches.values()].reduce((total, cache) => total + cache.entries.size, 0),
    failCacheWrites: () => {
      cacheWritesShouldFail = true;
    },
    flushWaitUntil: async () => {
      await Promise.all(pendingWaitUntils.splice(0));
    },
    clientClaimCount: () => clientClaimCount,
    skipWaitingCount: () => skipWaitingCount,
    seedCache: async (name, path, body) => {
      const cache = await cacheStorage.open(name);
      await cache.put(new Request(new URL(path, ORIGIN)), new Response(body));
    },
    seedManifest: (body) => {
      networkHandler = () => new Response(body, { status: 200 });
    },
  };
}

test('navigation is network-only, bypasses the HTTP cache and never stores HTML', async () => {
  const environment = createEnvironment();
  environment.online(() => new Response('build-a', { status: 200 }));

  const first = await environment.navigate('/session/1');
  assert.equal(await first?.text(), 'build-a');
  assert.equal(environment.fetchCalls[0].init?.cache, 'no-store');

  environment.online(() => new Response('build-b', { status: 200 }));
  const second = await environment.navigate('/session/1');
  assert.equal(await second?.text(), 'build-b');
  assert.equal(environment.fetchCalls.length, 2);
  assert.equal(environment.cacheEntryCount(), 0, 'HTML must not be written to Cache Storage');
});

test('offline navigation shows the offline notice instead of a stale document', async () => {
  const environment = createEnvironment();
  environment.online(() => new Response('build-a', { status: 200 }));
  await environment.navigate('/session/1');

  environment.offline();
  const response = await environment.navigate('/session/1');
  assert.equal(response?.status, 200);
  assert.match((await response?.text()) ?? '', /Offline/);
});

test('offline navigation without any cached document returns an offline page', async () => {
  const environment = createEnvironment();
  environment.offline();

  const response = await environment.navigate('/');
  assert.equal(response?.status, 200);
  assert.match((await response?.text()) ?? '', /Offline/);
});

test('hashed build assets are cache-first and a new build gets a new entry', async () => {
  const environment = createEnvironment();
  environment.online((request) =>
    new Response(`asset:${new URL(request.url).pathname}`, { status: 200 }),
  );

  const first = await environment.request('/assets/index-AAAA1111.js');
  assert.equal(await first?.text(), 'asset:/assets/index-AAAA1111.js');
  await environment.flushWaitUntil();

  const cached = await environment.request('/assets/index-AAAA1111.js');
  assert.equal(await cached?.text(), 'asset:/assets/index-AAAA1111.js');
  assert.equal(environment.fetchCalls.length, 1, 'second load must not hit the network');

  const rebuilt = await environment.request('/assets/index-BBBB2222.js');
  assert.equal(await rebuilt?.text(), 'asset:/assets/index-BBBB2222.js');
  await environment.flushWaitUntil();
  assert.equal(environment.fetchCalls.length, 2);
});

test('a rejected Cache Storage write does not fail a freshly fetched hashed asset', async () => {
  const environment = createEnvironment();
  environment.online(() => new Response('console.log("build-c")', { status: 200 }));
  environment.failCacheWrites();

  const first = await environment.request('/assets/index-CCCC3333.js');
  assert.equal(first?.status, 200);
  assert.equal(await first?.text(), 'console.log("build-c")');
  // The best-effort write runs after the response and rejects without surfacing.
  await environment.flushWaitUntil();
  assert.equal(environment.cacheEntryCount(), 0);

  const second = await environment.request('/assets/index-CCCC3333.js');
  assert.equal(second?.status, 200);
  assert.equal(await second?.text(), 'console.log("build-c")');
  await environment.flushWaitUntil();
  assert.equal(environment.fetchCalls.length, 2, 'nothing was cached, so both loads use the network');
});

test('non-hashed assets stay network-first and are not written to Cache Storage', async () => {
  const environment = createEnvironment();
  environment.online(() => new Response('logo-v1', { status: 200 }));
  await environment.request('/logo-256.png');

  environment.online(() => new Response('logo-v2', { status: 200 }));
  const updated = await environment.request('/logo-256.png');
  assert.equal(await updated?.text(), 'logo-v2');
  assert.equal(environment.fetchCalls.length, 2);
  assert.equal(environment.cacheEntryCount(), 0);

  // Nothing was stored, so offline does not pretend to have the latest file.
  environment.offline();
  assert.equal(await environment.request('/logo-256.png'), undefined);
});

test('API, websocket, cross-origin and non-GET requests are not intercepted', async () => {
  const environment = createEnvironment();
  environment.online(() => new Response('should-not-be-used', { status: 200 }));

  for (const path of ['/api/sessions', '/ws', '/shell', '/plugin-ws', '/android-notifications']) {
    assert.equal(await environment.request(path), undefined, path);
  }
  assert.equal(await environment.request(ORIGIN, { method: 'POST' }), undefined);
  assert.equal(
    await environment.fetch({ url: 'https://cdn.example.test/app.js', mode: 'no-cors' }),
    undefined,
  );
  assert.equal(environment.fetchCalls.length, 0);
});

test('install precaches only the manifest and a new version claims clients', async () => {
  const environment = createEnvironment();
  environment.seedManifest('{"name":"CloudCLI UI"}');

  await environment.run('install');
  assert.equal(environment.skipWaitingCount(), 1);
  assert.deepEqual(await environment.cacheNames(), ['claude-ui-v3']);
  assert.equal(environment.cacheEntryCount(), 1, 'only the manifest is precached');

  environment.offline();
  const manifest = await environment.request('/manifest.json');
  assert.equal(await manifest?.text(), '{"name":"CloudCLI UI"}');

  await environment.seedCache('claude-ui-v2', '/assets/index-old.js', 'old');
  await environment.seedCache('claude-ui-v3', '/assets/index-current.js', 'current');
  await environment.seedCache('another-app-v1', '/app.js', 'another app');

  await environment.run('activate');
  assert.deepEqual((await environment.cacheNames()).sort(), ['another-app-v1', 'claude-ui-v3']);
  assert.equal(environment.clientClaimCount(), 1);
});
