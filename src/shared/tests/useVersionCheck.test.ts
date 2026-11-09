import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

/**
 * Update notifications are a `super`-deployment feature. The hook reads the
 * capability from the public `/health` response and only then asks GitHub for
 * the latest release; a `false`, missing or unreachable capability must leave
 * the update fields hidden and produce no release request at all. The running
 * version and restart hint stay independent of that gate.
 */

type HealthBody = {
  canCheckUpdates?: boolean;
  installMode?: string;
  version?: string;
};

const RELEASE_URL = 'https://api.github.com/repos/siteboon/claudecodeui/releases/latest';

const release = {
  tag_name: 'v0.0.1',
  name: '0.0.1',
  body: 'notes',
  html_url: 'https://github.com/siteboon/claudecodeui/releases/tag/v0.0.1',
  published_at: '2024-01-01T00:00:00Z',
};

let requested: string[] = [];

/** Answers `/health` with the given body (or a rejection) and counts every request. */
const mockFetch = (health: HealthBody | 'fail') => {
  requested = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url === '/health') {
      if (health === 'fail') {
        throw new Error('health unavailable');
      }
      return { ok: true, json: async () => health } as Response;
    }
    if (url === RELEASE_URL) {
      return { ok: true, json: async () => release } as Response;
    }
    throw new Error(`unexpected request: ${url}`);
  }));
};

const renderVersionCheck = () => renderHook(() => useVersionCheck('siteboon', 'claudecodeui'));

/** Lets the `/health` probe settle so a missing release request is meaningful. */
const settleHealth = async () => {
  await waitFor(() => assert.ok(requested.includes('/health')));
  await act(async () => {});
};

const assertHidden = (result: { current: ReturnType<typeof useVersionCheck> }) => {
  assert.equal(result.current.updateAvailable, false);
  assert.equal(result.current.latestVersion, null);
  assert.equal(result.current.releaseInfo, null);
  assert.equal(requested.some((url) => url.includes('releases/latest')), false);
};

beforeEach(() => {
  requested = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a super deployment sees the upstream release', async () => {
  mockFetch({ canCheckUpdates: true, installMode: 'git', version: '0.0.1-test' });
  const { result } = renderVersionCheck();

  await waitFor(() => assert.equal(result.current.updateAvailable, true));
  assert.equal(result.current.latestVersion, '0.0.1');
  assert.deepEqual(result.current.releaseInfo, {
    title: '0.0.1',
    body: 'notes',
    htmlUrl: release.html_url,
    publishedAt: release.published_at,
  });
  assert.equal(requested.filter((url) => url === RELEASE_URL).length, 1);
});

test('a non-super deployment hides updates but keeps the restart hint', async () => {
  mockFetch({ canCheckUpdates: false, installMode: 'npm', version: '9.9.9' });
  const { result } = renderVersionCheck();

  await waitFor(() => assert.equal(result.current.runningVersion, '9.9.9'));
  await settleHealth();

  assertHidden(result);
  assert.equal(result.current.installMode, 'npm');
  assert.equal(result.current.restartRequired, true);
});

test('a health response without the capability is hidden too', async () => {
  mockFetch({ installMode: 'git', version: '0.0.1-test' });
  const { result } = renderVersionCheck();

  await settleHealth();
  assertHidden(result);
});

test('an unreachable health endpoint hides updates without asking GitHub', async () => {
  mockFetch('fail');
  const { result } = renderVersionCheck();

  await settleHealth();
  assertHidden(result);
  assert.deepEqual(requested, ['/health']);
});
