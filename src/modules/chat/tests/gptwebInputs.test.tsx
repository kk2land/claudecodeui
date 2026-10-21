import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { api } from '@/shared/api';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { Project } from '@/shared/types';

const PROJECT = { projectId: 'web-project', fullPath: '/tmp/web-project' } as Project;

beforeEach(() => {
  localStorage.clear(); resetChatDrafts();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/files') ? [] : {
    success: true, commands: [], files: [], drafts: [], preferences: {},
  })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetChatDrafts(); });

test('image support follows the selected model metadata instead of the provider-wide capability', async () => {
  vi.spyOn(api.providers, 'models').mockImplementation(async () => Response.json({ success: true, data: { models: {
    DEFAULT: 'chatgpt-web/text', OPTIONS: [
      { value: 'chatgpt-web/text', label: 'Text', inputModalities: ['text'] },
      { value: 'chatgpt-web/vision', label: 'Vision', inputModalities: ['text', 'image'] },
    ],
  } } }));
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [
    { provider: 'gptweb', supportsImages: true },
  ] } }));
  const hook = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: PROJECT }));
  act(() => { hook.result.current.setProvider('gptweb'); });
  await waitFor(() => expect(hook.result.current.currentProviderModel).toBe('chatgpt-web/text'));
  expect(hook.result.current.supportsImages).toBe(false);
  await act(async () => { await hook.result.current.selectProviderModel('gptweb', 'chatgpt-web/vision'); });
  expect(hook.result.current.supportsImages).toBe(true);
  hook.unmount();
});

function renderComposer(supportsImages: boolean) {
  const send = vi.fn(), addMessage = vi.fn();
  const hook = renderHook(({ supportsImages }: { supportsImages: boolean }) => useChatComposerState({
    selectedProject: PROJECT, selectedSession: null, currentSessionId: null, provider: 'gptweb',
    permissionMode: 'default', cyclePermissionMode() {}, resolvePermissionModeForProvider: () => 'default',
    currentProviderModel: 'chatgpt-web/text', currentProviderEffort: 'default', supportsImages,
    isLoading: false, canAbortSession: false, tokenBudget: null, sendMessage: send, addMessage,
    scrollToBottom() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
  }), { initialProps: { supportsImages } });
  return { ...hook, send, addMessage };
}

test('pasting an image into a text-only model explains the restriction', () => {
  const hook = renderComposer(false);
  const image = new File(['image'], 'example.png', { type: 'image/png' });
  act(() => { hook.result.current.handlePaste({ clipboardData: {
    items: [{ type: 'image/png', getAsFile: () => image }], files: [],
  } } as unknown as Parameters<typeof hook.result.current.handlePaste>[0]); });
  expect(hook.result.current.attachedFiles).toEqual([]);
  expect(hook.result.current.fileErrors.get('example.png')).toContain('does not support images');
  hook.unmount();
});

test('switching to a text-only model preserves attached images and draft text until the user resolves them', async () => {
  const hook = renderComposer(true);
  const upload = vi.spyOn(api.assets, 'uploadFiles');
  const allocate = vi.spyOn(api.providers, 'createSession');
  const image = new File(['image'], 'example.png', { type: 'image/png' });
  act(() => { hook.result.current.setInput('keep this prompt'); hook.result.current.setAttachedFiles([image]); });
  hook.rerender({ supportsImages: false });
  await act(async () => { await hook.result.current.handleSubmit({ preventDefault() {} } as Parameters<typeof hook.result.current.handleSubmit>[0]); });
  expect(hook.send).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(allocate).not.toHaveBeenCalled();
  expect(hook.result.current.input).toBe('keep this prompt');
  expect(hook.result.current.attachedFiles).toEqual([image]);
  expect(hook.addMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', content: expect.stringContaining('does not support images') }));
  hook.unmount();
});
