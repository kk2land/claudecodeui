import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test } from 'vitest';

import { LLMProviderLogo } from '@/shared/ui';

/**
 * DSH shipped with the generic lucide `Waves` glyph, which read as a placeholder
 * next to the real vendor marks of the other providers. The logo now has to be
 * the DeepSeek whale for every surface that renders `LLMProviderLogo`.
 */

test('the dsh provider renders the DeepSeek mark instead of a placeholder glyph', () => {
  const { container } = render(<LLMProviderLogo provider="dsh" />);

  const mark = container.querySelector('svg[aria-label="DeepSeek Harness"]');
  assert.ok(mark, 'expected the DeepSeek whale svg');
  // The placeholder glyph was lucide's stroked `Waves`; the whale is one filled
  // vendor path in DeepSeek brand blue, so both attributes pin the real mark.
  const path = mark.querySelector('path');
  assert.ok(path);
  assert.equal(path.getAttribute('fill'), '#4D6BFE');
  assert.match(path.getAttribute('d') ?? '', /^M23\.748 4\.651/);
});

test('other providers keep their own marks', () => {
  const { container } = render(<LLMProviderLogo provider="codex" />);

  assert.ok(container.querySelector('svg[aria-label="Codex"]'));
});
