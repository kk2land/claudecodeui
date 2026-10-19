import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('DSH tool approval offers allow-once without creating Claude permission rules', () => {
  const decide = vi.fn(), remember = vi.fn(() => ({ success: true }));
  render(<PermissionRequestsBanner pendingPermissionRequests={[{ requestId: 'dsh:once', toolName: 'bash', input: { command: 'pwd' }, context: { provider: 'dsh', availableDecisions: ['accept', 'decline', 'cancel'] } }]}
    handlePermissionDecision={decide} handleGrantToolPermission={remember} />);
  expect(screen.queryByText('Allow & remember')).toBeNull();
  fireEvent.click(screen.getByText('Allow once'));
  expect(decide).toHaveBeenCalledWith('dsh:once', { allow: true });
  expect(remember).not.toHaveBeenCalled();
});
