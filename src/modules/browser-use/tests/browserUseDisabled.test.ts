import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

/** Browser Use is retired, so the workspace check must never read old server settings. */
const settings = vi.fn(async () => ({
  ok: true,
  json: async () => ({ success: true, data: { settings: { enabled: true } } }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    browserUse: { settings },
  },
}));

test('a stored enabled=true does not enable the Browser tab or request settings', async () => {
  const { useBrowserUseEnabled } = await import('@/modules/browser-use/hooks/useBrowserUseEnabled');
  const { result } = renderHook(() => useBrowserUseEnabled());

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.current, false);
  assert.deepEqual(settings.mock.calls, []);
});
