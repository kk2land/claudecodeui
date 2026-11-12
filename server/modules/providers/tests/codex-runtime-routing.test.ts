import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexRuntimeRouter } from '@/modules/providers/list/codex/codex-runtime-router.provider.js';
import type { CodexRuntimeMode } from '@/shared/types.js';

/**
 * The resident host hands every turn to the existing Codex provider gateway.
 * These cases pin that the gateway still routes by the session's configured
 * runtime — app-server to the shared native connection, `sdk` (the existing
 * Codex exec adapter) to its own adapter — and never starts a third,
 * resident-only runtime.
 */
function harness(mode: CodexRuntimeMode) {
  const calls: string[] = [];
  const settings = { runtime: mode, mode: 'default' as const, queueHeld: false };
  const router = createCodexRuntimeRouter({
    native: {
      run: async () => { calls.push('native.run'); },
      abort: async () => { calls.push('native.abort'); return true; },
      getState: () => ({ runtime: 'app-server', queueHeld: false, phase: 'idle' }),
    } as never,
    sdk: {
      run: async () => { calls.push('sdk.run'); },
      abort: async () => { calls.push('sdk.abort'); return true; },
    } as never,
    settings: {
      get: () => settings,
      update: () => settings,
      holdCodexAppServerQueues: () => undefined,
    } as never,
    isCodexSession: () => true,
    stop: async () => undefined,
    isStopping: () => false,
  });
  return { router, calls, settings };
}

const writer = {} as never;
const context = { resolveProviderSessionId: () => 'native-thread' } as never;

test('an exec-mode session dispatches to the existing exec adapter with the same native session', async () => {
  const { router, calls } = harness('sdk');
  await router.run('continue', {
    sessionId: 'app-session',
    providerSessionId: 'native-thread',
    permissionMode: 'acceptEdits',
    model: 'gpt-5',
  }, writer, context);
  // The existing Codex exec adapter owns the turn; the shared app-server is untouched.
  assert.deepEqual(calls, ['sdk.run']);
});

test('an app-server session still dispatches to the shared native connection', async () => {
  const { router, calls } = harness('app-server');
  await router.run('continue', {
    sessionId: 'app-session',
    providerSessionId: 'native-thread',
  }, writer, context);
  assert.deepEqual(calls, ['native.run']);
});

test('abort follows the live exec run, then falls back to the configured runtime adapter when idle', async () => {
  let release: () => void = () => {};
  const calls: string[] = [];
  const settings = { runtime: 'sdk' as CodexRuntimeMode, mode: 'default' as const, queueHeld: false };
  const router = createCodexRuntimeRouter({
    native: {
      run: async () => undefined,
      abort: async () => { calls.push('native.abort'); return true; },
      getState: () => ({ runtime: 'app-server', queueHeld: false, phase: 'idle' }),
    } as never,
    sdk: {
      run: async () => {
        calls.push('sdk.run');
        await new Promise<void>((resolve) => { release = resolve; });
      },
      abort: async () => { calls.push('sdk.abort'); return true; },
    } as never,
    settings: {
      get: () => settings,
      update: () => settings,
      holdCodexAppServerQueues: () => undefined,
    } as never,
    isCodexSession: () => true,
    stop: async () => undefined,
    isStopping: () => false,
  });

  const running = router.run('continue', { sessionId: 'app-session' }, writer, context);
  // Let the adapter's run() reach its pending state before stopping it.
  await Promise.resolve();
  assert.equal(await router.abort('app-session'), true);
  release();
  await running;
  assert.deepEqual(calls, ['sdk.run', 'sdk.abort']);

  // With no live exec run, abort falls back to the existing idle-control path
  // (the native adapter), which is the router's unchanged behavior.
  await router.abort('app-session');
  assert.equal(calls.at(-1), 'native.abort');
});
