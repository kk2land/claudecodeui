import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { AndroidShareInbox } from '@/modules/android-bridge';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, readQueuedMessages, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { AndroidBridge, AndroidShare, PermissionMode, Project, ProjectSession } from '@/shared/types';

type BridgeWindow = Window & { cloudcliAndroid?: unknown };

const SESSION_A: ProjectSession = { id: 'session-a' };
const SESSION_B: ProjectSession = { id: 'session-b' };
const SESSION_C: ProjectSession = { id: 'session-c' };
const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
  sessions: [SESSION_A, SESSION_B, SESSION_C],
};

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, builtIn: [] }) },
      providers: { skills: () => okJson({ data: { skills: [] } }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      getFiles: () => okJson([]),
    },
  };
});

const createShare = (overrides: Partial<AndroidShare>): AndroidShare => ({
  id: 'share-1',
  kind: 'text',
  text: null,
  name: null,
  mimeType: null,
  size: null,
  createdAt: Date.now(),
  ...overrides,
});

const createBridge = (
  share: AndroidShare,
  content: Blob,
  consumeShare: AndroidBridge['consumeShare'],
): AndroidBridge => ({
  version: 1,
  getState: async () => ({
    version: 1,
    siteOrigin: 'https://cloud.example.com',
    webBridgeReady: true,
    signedIn: true,
    notificationsEnabled: false,
    serviceRunning: false,
    connected: false,
    lastError: null,
    pendingShareCount: 1,
  }),
  notify: async () => ({ shown: true }),
  setNotificationsEnabled: async (enabled) => ({
    version: 1,
    siteOrigin: 'https://cloud.example.com',
    webBridgeReady: true,
    signedIn: true,
    notificationsEnabled: enabled,
    serviceRunning: enabled,
    connected: false,
    lastError: null,
    pendingShareCount: 1,
  }),
  getSession: async () => null,
  saveSession: async () => ({ accepted: true }),
  clearSession: async () => undefined,
  listShares: async () => [share],
  getShareContent: async () => ({
    name: share.name || 'shared.txt',
    mimeType: share.mimeType || 'text/plain',
    size: content.size,
    blob: content,
  }),
  consumeShare,
  discardShare: async () => undefined,
  pickFiles: async () => [],
  saveFile: async () => ({ saved: true }),
});

function ComposerProbe({ session }: { session: ProjectSession }) {
  const composer = useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session.id,
    provider: 'claude',
    permissionMode: 'default' as PermissionMode,
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: (_provider, mode) => mode as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  });

  return (
    <>
      <output data-testid="composer-input">{composer.input}</output>
      <output data-testid="composer-attachments">
        {composer.attachedFiles.map((file) => file.name).join(',')}
      </output>
    </>
  );
}

function ShareInboxProbe({ session }: { session: ProjectSession }) {
  return (
    <AndroidShareInbox
      projects={[PROJECT]}
      currentSession={session}
      onOpenSession={() => undefined}
    />
  );
}

const clickImport = async () => {
  const button = await screen.findByRole('button', { name: /import/i });
  fireEvent.click(button);
};

const composerInput = () => screen.getByTestId('composer-input').textContent;
const composerAttachments = () => screen.getByTestId('composer-attachments').textContent;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
});

afterEach(() => {
  delete (window as BridgeWindow).cloudcliAndroid;
});

test('a text share queued before its target composer mounts appends to the restored draft', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  const share = createShare({ id: 'share-pending', text: 'shared text' });
  (window as BridgeWindow).cloudcliAndroid = createBridge(share, new Blob(['x']), consumeShare);
  writeDraftText(SESSION_B.id, 'B original');

  const view = render(<ShareInboxProbe session={SESSION_B} />);
  await clickImport();
  view.rerender(<ComposerProbe session={SESSION_B} />);

  await waitFor(() => assert.equal(composerInput(), 'B original\n\nshared text'));
  assert.equal(consumeShare.mock.calls.length, 1);
  assert.equal(consumeShare.mock.calls[0][0], 'share-pending');
});

test('switching from session A to B keeps A intact and appends only B to B', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  const share = createShare({ id: 'share-cross-session', text: 'shared for B' });
  (window as BridgeWindow).cloudcliAndroid = createBridge(share, new Blob(['x']), consumeShare);
  writeDraftText(SESSION_A.id, 'A original');
  writeDraftText(SESSION_B.id, 'B original');

  const view = render(
    <>
      <ComposerProbe session={SESSION_A} />
      <ShareInboxProbe session={SESSION_A} />
    </>,
  );
  await waitFor(() => assert.equal(composerInput(), 'A original'));

  await screen.findByText('shared for B');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: SESSION_B.id } });
  await clickImport();

  view.rerender(<ComposerProbe session={SESSION_B} />);

  await waitFor(() => assert.equal(composerInput(), 'B original\n\nshared for B'));
  assert.equal(readDraftText(SESSION_A.id), 'A original');
  assert.deepEqual(readQueuedMessages(SESSION_B.id), []);
  assert.equal(consumeShare.mock.calls.length, 1);
});

test('the inserted text is written back to the existing draft store for its session', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  const share = createShare({ id: 'share-persistence', text: 'saved from Android' });
  (window as BridgeWindow).cloudcliAndroid = createBridge(share, new Blob(['x']), consumeShare);
  writeDraftText(SESSION_B.id, 'B draft');

  const view = render(<ShareInboxProbe session={SESSION_B} />);
  await clickImport();
  view.rerender(<ComposerProbe session={SESSION_B} />);

  await waitFor(() => assert.equal(readDraftText(SESSION_B.id), 'B draft\n\nsaved from Android'));
  assert.equal(consumeShare.mock.calls.length, 1);
});

test('a file share becomes a composer attachment and is consumed only after acceptance', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  const share = createShare({
    id: 'share-file',
    kind: 'image',
    name: 'shared.png',
    mimeType: 'image/png',
    size: 3,
  });
  (window as BridgeWindow).cloudcliAndroid = createBridge(share, new Blob(['png'], { type: 'image/png' }), consumeShare);

  const view = render(<ShareInboxProbe session={SESSION_B} />);
  await clickImport();
  view.rerender(<ComposerProbe session={SESSION_B} />);

  await waitFor(() => assert.equal(composerAttachments(), 'shared.png'));
  assert.equal(consumeShare.mock.calls.length, 1);
});

test('a file rejected by the composer stays pending and nothing is consumed', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  const oversized = new Blob([new Uint8Array(11 * 1024 * 1024)]);
  const share = createShare({
    id: 'share-too-large',
    kind: 'file',
    name: 'huge.bin',
    mimeType: 'application/octet-stream',
    size: oversized.size,
  });
  (window as BridgeWindow).cloudcliAndroid = createBridge(share, oversized, consumeShare);

  render(
    <>
      <ComposerProbe session={SESSION_B} />
      <ShareInboxProbe session={SESSION_B} />
    </>,
  );
  await clickImport();

  await screen.findByText(/cannot accept this file/i);
  assert.equal(composerAttachments(), '');
  assert.equal(consumeShare.mock.calls.length, 0);
});


test('a file read that finishes after switching away from B is neither inserted nor consumed', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  const share = createShare({
    id: 'share-slow-switch',
    kind: 'file',
    name: 'slow.bin',
    mimeType: 'application/octet-stream',
    size: 4,
  });
  const content = new Blob(['slow'], { type: 'application/octet-stream' });
  const pendingRead = deferred<{ name: string; mimeType: string; size: number; blob: Blob }>();
  const getShareContent = vi.fn()
    .mockReturnValueOnce(pendingRead.promise)
    .mockResolvedValue({
      name: share.name,
      mimeType: share.mimeType,
      size: content.size,
      blob: content,
    });
  const bridge = createBridge(share, content, consumeShare);
  bridge.getShareContent = getShareContent as AndroidBridge['getShareContent'];
  (window as BridgeWindow).cloudcliAndroid = bridge;

  const view = render(
    <>
      <ComposerProbe session={SESSION_B} />
      <ShareInboxProbe session={SESSION_B} />
    </>,
  );
  await clickImport();
  await waitFor(() => assert.equal(getShareContent.mock.calls.length, 1));

  view.rerender(
    <>
      <ComposerProbe session={SESSION_C} />
      <ShareInboxProbe session={SESSION_C} />
    </>,
  );

  await act(async () => {
    pendingRead.resolve({ name: share.name || 'slow.bin', mimeType: 'application/octet-stream', size: content.size, blob: content });
  });

  await waitFor(() => assert.equal(composerAttachments(), ''));
  assert.equal(consumeShare.mock.calls.length, 0);

  // The native share is still pending, so opening B again and importing retries it.
  view.rerender(
    <>
      <ComposerProbe session={SESSION_B} />
      <ShareInboxProbe session={SESSION_B} />
    </>,
  );
  await clickImport();
  await waitFor(() => assert.equal(composerAttachments(), 'slow.bin'));
  assert.equal(consumeShare.mock.calls.length, 1);
});

test('a file read that finishes after the composer unmounts is neither inserted nor consumed', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  const share = createShare({
    id: 'share-slow-unmount',
    kind: 'file',
    name: 'unmounted.bin',
    mimeType: 'application/octet-stream',
    size: 4,
  });
  const content = new Blob(['slow'], { type: 'application/octet-stream' });
  const pendingRead = deferred<{ name: string; mimeType: string; size: number; blob: Blob }>();
  const getShareContent = vi.fn()
    .mockReturnValueOnce(pendingRead.promise)
    .mockResolvedValue({
      name: share.name,
      mimeType: share.mimeType,
      size: content.size,
      blob: content,
    });
  const bridge = createBridge(share, content, consumeShare);
  bridge.getShareContent = getShareContent as AndroidBridge['getShareContent'];
  (window as BridgeWindow).cloudcliAndroid = bridge;

  const view = render(
    <>
      <ComposerProbe session={SESSION_B} />
      <ShareInboxProbe session={SESSION_B} />
    </>,
  );
  await clickImport();
  await waitFor(() => assert.equal(getShareContent.mock.calls.length, 1));

  view.unmount();

  await act(async () => {
    pendingRead.resolve({ name: share.name || 'unmounted.bin', mimeType: 'application/octet-stream', size: content.size, blob: content });
  });
  assert.equal(consumeShare.mock.calls.length, 0);
});
