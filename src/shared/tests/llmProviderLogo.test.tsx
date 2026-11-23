import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test } from 'vitest';

import { LLMProviderLogo } from '@/shared/ui';

test('other providers keep their own marks', () => {
  const { container } = render(<LLMProviderLogo provider="codex" />);

  assert.ok(container.querySelector('svg[aria-label="Codex"]'));
});
