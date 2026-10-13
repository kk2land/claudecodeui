import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const { capabilities } = vi.hoisted(() => ({ capabilities: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { capabilities } } }));

beforeEach(() => {
  vi.resetModules();
  capabilities.mockReset();
});

test.each([undefined, false, 'true', true])('requires explicit server capability true (received %s)', async (goal) => {
  let respond!: (response: Response) => void;
  capabilities.mockReturnValue(new Promise<Response>((resolve) => { respond = resolve; }));
  const { useProviderCapabilities } = await import('@/shared/hooks/useProviderCapabilities');
  const hook = renderHook(() => useProviderCapabilities().codex?.nativeControls?.goal === true);
  expect(hook.result.current).toBe(false);
  await act(async () => {
    respond(new Response(JSON.stringify({ success: true, data: { providers: [
      { provider: 'codex', nativeControls: { goal } },
    ] } }), { status: 200 }));
  });
  expect(hook.result.current).toBe(goal === true);
});
