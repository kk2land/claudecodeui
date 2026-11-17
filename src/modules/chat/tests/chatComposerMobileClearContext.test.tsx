import assert from 'node:assert/strict';

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';

/**
 * The mobile actions sheet is the only place a phone user reaches these
 * composer actions, so the context-clear control has to be there, use the
 * upstream capability/no-session gating (its callback absent means hidden),
 * and stay disabled while a turn is still writing to that context.
 */

vi.mock('@/shared/hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isMobile: true }) }));

type Props = ComponentProps<typeof ChatComposer>;

const props = (overrides: Partial<Props>): Props => ({
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: null,
  isLoading: false,
  onAbortSession: () => undefined,
  permissionMode: 'default',
  availablePermissionModes: ['default'],
  onSelectPermissionMode: () => undefined,
  providerLabel: 'Claude',
  effort: 'medium',
  availableEffortOptions: [],
  onSelectEffort: () => undefined,
  model: 'test-model',
  availableModelOptions: [],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: () => undefined,
  slashCommandsCount: 0,
  onToggleCommandMenu: () => undefined,
  hasInput: true,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDraft: null,
  backgroundSendPrompt: null,
  onResolveBackgroundSendPrompt: () => undefined,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: () => undefined,
  onCancelScheduledMessage: () => undefined,
  onEditQueuedDraft: () => undefined,
  onDeleteQueuedDraft: () => undefined,
  attachedFiles: [],
  onRemoveAttachment: () => undefined,
  fileErrors: new Map(),
  showFileDropdown: false,
  filteredFiles: [],
  selectedFileIndex: -1,
  onSelectFile: () => undefined,
  filteredCommands: [],
  selectedCommandIndex: -1,
  onCommandSelect: () => undefined,
  onCloseCommandMenu: () => undefined,
  isCommandMenuOpen: false,
  frequentCommands: [],
  getRootProps: () => ({}),
  getInputProps: () => ({}),
  openAttachmentPicker: () => undefined,
  inputHighlightRef: createRef<HTMLDivElement>() as Props['inputHighlightRef'],
  renderInputWithMentions: (text) => text,
  textareaRef: createRef<HTMLTextAreaElement>() as Props['textareaRef'],
  input: 'hello',
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Message',
  isTextareaExpanded: false,
  ...overrides,
});

const openActionsSheet = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add attachment or action' }));
};

const clearContextRow = () => screen.queryByRole('button', { name: 'Clear context' });

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the mobile actions sheet offers the context-clear action and closes on one tap', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const onClearContext = vi.fn();
  render(<UiPreferencesProvider><ChatComposer {...props({ onClearContext })} /></UiPreferencesProvider>);

  openActionsSheet();
  const clear = clearContextRow();
  assert.ok(clear !== null, 'the sheet lists Clear context');

  fireEvent.click(clear);

  assert.equal(onClearContext.mock.calls.length, 1, 'the passed callback is called exactly once');
  assert.equal(clearContextRow(), null, 'the sheet closed');
});

test('the clear action is disabled while a turn is running and cannot call the callback', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const onClearContext = vi.fn();
  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, onClearContext })} /></UiPreferencesProvider>);

  openActionsSheet();
  const clear = clearContextRow() as HTMLButtonElement | null;
  assert.ok(clear !== null, 'the sheet lists it while a turn runs too');
  assert.ok(clear.disabled, 'disabled while the running turn writes to that context');

  fireEvent.click(clear);
  assert.equal(onClearContext.mock.calls.length, 0, 'a disabled action calls nothing');
});

test('the action is hidden when the parent supplies no clear handler', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  render(<UiPreferencesProvider><ChatComposer {...props({})} /></UiPreferencesProvider>);

  openActionsSheet();
  assert.ok(screen.getByRole('button', { name: 'Token usage' }) !== null, 'the sheet is open');
  assert.equal(clearContextRow(), null, 'no capability or no session means no row');
});
