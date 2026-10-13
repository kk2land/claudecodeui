import { afterEach, expect, test, vi } from 'vitest';

import { createUuid } from '@/shared/utils';

afterEach(() => vi.unstubAllGlobals());

test('uses the native UUID implementation when available', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const randomUUID = vi.fn().mockReturnValue(id);
  const getRandomValues = vi.fn();
  vi.stubGlobal('crypto', { randomUUID, getRandomValues });

  expect(createUuid()).toBe(id);
  expect(randomUUID).toHaveBeenCalledTimes(1);
  expect(getRandomValues).not.toHaveBeenCalled();
});

test.each([
  [0x00, '00000000-0000-4000-8000-000000000000'],
  [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
])('builds a v4 UUID from random bytes (%i) without randomUUID', (byte, expected) => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(byte));
  vi.stubGlobal('crypto', { getRandomValues });

  expect(createUuid()).toBe(expected);
  expect(getRandomValues).toHaveBeenCalledTimes(1);
  expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
});
