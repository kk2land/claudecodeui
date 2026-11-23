import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) =>
    key === 'chat:misc.contextRemaining' ? `${options?.percent}% left` : key }),
}));
afterEach(cleanup);

it.each([
  [0, 200000, 100],
  [12000, 200000, 100],
  [106000, 200000, 50],
  [300000, 200000, 0],
  [1000, 12000, 0],
])('matches TUI for %i tokens in a %i window', (used, total, percent) => {
  render(<TokenUsageSummary provider="codex" usage={{ used, total }} />);
  expect(screen.getByText(`${percent}% left`)).toBeTruthy();
});

it('does not invent a percentage when the context window is unknown', () => {
  render(<TokenUsageSummary provider="codex" usage={{ used: 32000 }} />);
  expect(screen.queryByText(/% left/)).toBeNull();
  expect(screen.getByText('32K')).toBeTruthy();
});

it('keeps other providers independent of the Codex baseline', () => {
  render(<TokenUsageSummary provider="claude" usage={{ used: 32000, total: 200000 }} />);
  expect(screen.queryByText(/% left/)).toBeNull();
});
