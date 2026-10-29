import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { NormalizedMessage } from '@/shared/types';

beforeEach(async () => { await i18n.changeLanguage('en'); });

test('inherited user turns keep their portable fork identity, provenance and read-only behavior', () => {
  const normalized: NormalizedMessage = {
    id: 'transfer:target:0', sessionId: 'target', provider: 'codex', timestamp: '2026-10-29T00:00:00Z',
    kind: 'text', role: 'user', content: 'Keep Go 1.23 and TOML', inheritedFrom: { provider: 'codex', sessionId: 'source' },
  };
  const [message] = normalizedToChatMessages([normalized]);
  expect(message.historyMessageId).toBe(normalized.id);
  expect(message.inheritedFrom).toEqual(normalized.inheritedFrom);
  expect(message.transcriptAnchorId).toBeUndefined();
  const onEdit = vi.fn();
  const onFork = vi.fn();
  render(<UiPreferencesProvider>
    <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="dsh" onEditMessage={onEdit} onForkFromMessage={onFork} />
  </UiPreferencesProvider>);
  expect(screen.getByText('History inherited from codex · read only')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /edit and resend/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /fork from here/i }));
  expect(onFork).toHaveBeenCalledWith(message);
  expect(onEdit).not.toHaveBeenCalled();
});

test('optimistic user echoes are not offered as persistent portable fork points', () => {
  const [message] = normalizedToChatMessages([{
    id: 'optimistic', sessionId: 'target', provider: 'dsh', timestamp: '2026-10-29T00:00:00Z',
    kind: 'text', role: 'user', content: 'Sending…', isOptimistic: true,
  }]);
  expect(message.historyMessageId).toBeUndefined();
});
