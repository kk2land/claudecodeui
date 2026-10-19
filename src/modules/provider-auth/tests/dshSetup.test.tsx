import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import ProviderLoginModal from '@/modules/provider-auth/ProviderLoginModal';

const { shell } = vi.hoisted(() => ({ shell: vi.fn(() => <div>provider-shell</div>) }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: shell }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('DSH setup shows configuration instructions without launching another provider login shell', () => {
  render(<ProviderLoginModal provider="dsh" isOpen onClose={() => {}} />);
  expect(screen.getByText('DeepSeek Harness setup')).toBeTruthy();
  expect(screen.getByText('npm install -g @deepseek-ai/dsh')).toBeTruthy();
  expect(shell).not.toHaveBeenCalled();
});

