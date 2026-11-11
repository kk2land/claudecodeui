import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { appendPreparedTodo, parseComposerTodoCommand } from '@/modules/chat/utils/todoCommands';
import { api } from '@/shared/api';
import {
  adoptQueuedChatMessage,
  readDraftMeta,
  readDraftText,
  readQueuedMessages,
  rejectPendingChatSend,
  rememberPendingChatSend,
  resetChatDrafts,
  writeDraftMeta,
  writeQueuedMessage,
} from '@/shared/chatDrafts';
import type { CodexControls, PermissionMode, Project, ProjectSession, TodoDraftMeta } from '@/shared/types';

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-a', projectId: 'project-1' } as ProjectSession;
const META: TodoDraftMeta = {
  todoIds: ['todo-1'],
  attachments: [{ path: '/store/spec.md', name: 'spec.md', size: 4 }],
};

const createdTodos: FormData[] = [];
let createFails = false;
let preparedDraft = { text: 'prepared body', todoIds: ['todo-2'], attachments: [] as TodoDraftMeta['attachments'] };

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
      commands: {
        list: () => okJson({ success: true, commands: [] }),
        execute: () => okJson({ type: 'builtin', action: 'help', data: { content: 'help' } }),
      },
      assets: { uploadFiles: () => okJson({ attachments: [{ path: '/store/upload.txt', name: 'notes.txt' }] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      todos: {
        create: (_pid: string, formData: FormData) => {
          createdTodos.push(formData);
          return Promise.resolve(new Response('{}', { status: createFails ? 500 : 200 }));
        },
        prepare: () => Promise.resolve(Response.json({ draft: preparedDraft })),
      },
    },
  };
});

const modelMissingControls = {
  state: { runtime: 'app-server', mode: 'plan', modelSelection: { model: null }, questions: [] },
  goalsEnabled: false,
  pending: false,
  predictionsSupported: false,
  predictionsUnsupported: false,
  control: vi.fn(),
} as unknown as CodexControls;

type RenderArgs = {
  session?: ProjectSession | null;
  isLoading?: boolean;
  codexControls?: CodexControls;
  sendMessage?: (message: unknown) => void;
  addMessage?: (message: unknown) => void;
};

const renderComposer = ({ session = SESSION, isLoading = false, codexControls, sendMessage, addMessage }: RenderArgs = {}) => renderHook(
  () => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'codex',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'gpt-5.4',
    currentProviderEffort: 'high',
    isLoading,
    codexControls,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: sendMessage ?? (() => undefined),
    scrollToBottom: () => undefined,
    addMessage: addMessage ?? (() => undefined),
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
);

const submit = () => ({ preventDefault() {} }) as Parameters<ReturnType<typeof useChatComposerState>['handleSubmit']>[0];

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  createdTodos.length = 0;
  createFails = false;
  preparedDraft = { text: 'prepared body', todoIds: ['todo-2'], attachments: [] };
});

test('the prefix wins with a body and a bare prefix opens the list', () => {
  assert.deepEqual(
    parseComposerTodoCommand('/todo Buy milk\nsecond line', { hasSources: false, hasAttachments: false }),
    { kind: 'create', text: 'Buy milk\nsecond line' },
  );
  assert.deepEqual(
    parseComposerTodoCommand('/todo', { hasSources: false, hasAttachments: false }),
    { kind: 'open', text: '' },
  );
  // A bare prefix with files saves them as an attachment-only todo.
  assert.deepEqual(
    parseComposerTodoCommand('/todo', { hasSources: false, hasAttachments: true }),
    { kind: 'create', text: '' },
  );
  // Other commands and inner mentions are ordinary text.
  assert.equal(parseComposerTodoCommand('/todolist all', { hasSources: false, hasAttachments: false }), null);
  assert.equal(parseComposerTodoCommand('see /todo later', { hasSources: false, hasAttachments: false }), null);
});

test('a tail /todo line opens the list without eating earlier text', () => {
  assert.deepEqual(
    parseComposerTodoCommand('keep this text\n/todo', { hasSources: false, hasAttachments: false }),
    { kind: 'open', text: 'keep this text' },
  );
  // A source draft is literal content, but its explicit tail still opens.
  assert.deepEqual(
    parseComposerTodoCommand('/todo is literal\n/todo', { hasSources: true, hasAttachments: false }),
    { kind: 'open', text: '/todo is literal' },
  );
  assert.equal(
    parseComposerTodoCommand('/todo is literal', { hasSources: true, hasAttachments: false }),
    null,
  );
});

test('appendPreparedTodo merges text, sources and attachments and refuses over the cap', () => {
  const appended = appendPreparedTodo({ text: 'existing', meta: null }, {
    text: 'todo body', todoIds: ['todo-2'], attachments: [{ path: '/store/a.png', name: 'a.png' }],
  });
  assert.deepEqual(appended, {
    text: 'existing\n\ntodo body',
    meta: { todoIds: ['todo-2'], attachments: [{ path: '/store/a.png', name: 'a.png' }] },
  });
  const full = Array.from({ length: 10 }, (_, index) => ({ path: `/store/${index}.png` }));
  assert.equal(appendPreparedTodo({ text: '', meta: { todoIds: [], attachments: full } }, {
    text: 'x', todoIds: ['t'], attachments: [{ path: '/store/extra.png' }],
  }), null);
});

test('a local /todo with no model or session saves without sending or creating one', async () => {
  const view = renderComposer({ session: null, codexControls: modelMissingControls });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    view.result.current.setInput('/todo Buy milk\nsecond line');
    view.result.current.setAttachedFiles([file]);
  });

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(createdTodos.length, 1);
  assert.equal(createdTodos[0].get('content'), 'Buy milk\nsecond line');
  assert.equal((createdTodos[0].getAll('files') as File[]).length, 1);
  assert.equal(view.result.current.input, '');
  assert.deepEqual(view.result.current.attachedFiles, []);
});

test('a failed todo save keeps every part of the input', async () => {
  createFails = true;
  const errors: unknown[] = [];
  const view = renderComposer({ session: null, addMessage: (message) => errors.push(message) });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    view.result.current.setInput('/todo keep me');
    view.result.current.setAttachedFiles([file]);
  });

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(view.result.current.input, '/todo keep me');
  assert.deepEqual(view.result.current.attachedFiles, [file]);
  assert.equal((errors[0] as { type: string }).type, 'error');
});

test('a bare /todo opens the dialog without any network send', async () => {
  const sendMessage = vi.fn();
  const view = renderComposer({ sendMessage });

  await act(async () => { view.result.current.setInput('/todo'); });
  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(view.result.current.todoDialogOpen, true);
  assert.equal(sendMessage.mock.calls.length, 0);
  assert.equal(createdTodos.length, 0);
  assert.equal(view.result.current.input, '');
});

test('a normal send carries the draft todo ids and stored attachments', async () => {
  writeDraftMeta(SESSION.id, META);
  const sendMessage = vi.fn();
  const view = renderComposer({ sendMessage });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    view.result.current.setInput('send the todo');
    view.result.current.setAttachedFiles([file]);
  });
  assert.deepEqual(view.result.current.todoSourceIds, ['todo-1']);

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  const sent = sendMessage.mock.calls[0][0] as { options: { todoIds?: string[]; attachments?: unknown[] } };
  assert.deepEqual(sent.options.todoIds, ['todo-1']);
  assert.deepEqual(sent.options.attachments?.[0], META.attachments[0]);
  assert.equal(view.result.current.input, '');
  assert.equal(readDraftMeta(SESSION.id), null);
});

test('a running turn queues the draft with its own sources and does not inherit another', async () => {
  writeDraftMeta(SESSION.id, META);
  const sendMessage = vi.fn();
  const view = renderComposer({ isLoading: true, sendMessage });
  await act(async () => { view.result.current.setInput('queue this'); });

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  const queued = readQueuedMessages(SESSION.id);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].options?.todoIds, ['todo-1']);
  assert.deepEqual(queued[0].attachments, META.attachments);
  assert.equal(readDraftText(SESSION.id), '');
  assert.equal(readDraftMeta(SESSION.id), null);
});

test('selecting a todo appends it, refuses a duplicate and detaches the source', async () => {
  const view = renderComposer();
  const todo = { id: 'todo-2', projectId: 'project-1', content: 'prepared body' } as Parameters<typeof view.result.current.selectProjectTodo>[0];
  await act(async () => { assert.equal(await view.result.current.selectProjectTodo(todo), true); });
  assert.equal(view.result.current.input, 'prepared body');
  assert.deepEqual(view.result.current.todoSourceIds, ['todo-2']);

  // A repeated selection is idempotent: close the list without duplicating.
  await act(async () => { assert.equal(await view.result.current.selectProjectTodo(todo), true); });
  assert.equal(view.result.current.input, 'prepared body');
  assert.deepEqual(view.result.current.todoSourceIds, ['todo-2']);

  writeDraftMeta(SESSION.id, META);
  await act(async () => { view.result.current.detachTodoSource(); });
  assert.deepEqual(view.result.current.todoSourceIds, []);
  assert.equal(view.result.current.input, 'prepared body');
  // Unlinking keeps the copied attachment so the draft can still send it.
  assert.deepEqual(view.result.current.storedAttachments, META.attachments);
  assert.deepEqual(readDraftMeta(SESSION.id), { todoIds: [], attachments: META.attachments });
});

test('a source draft sends its leading /todo text literally', async () => {
  writeDraftMeta(SESSION.id, META);
  const sendMessage = vi.fn();
  const view = renderComposer({ sendMessage });
  await act(async () => { view.result.current.setInput('/todo is literal'); });

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(createdTodos.length, 0);
  assert.equal(view.result.current.todoDialogOpen, false);
  assert.equal((sendMessage.mock.calls[0][0] as { content: string }).content, '/todo is literal');
});

test('clearing the input drops text and sources but keeps the queued turns', async () => {
  writeDraftMeta(SESSION.id, META);
  const { writeQueuedMessage } = await import('@/shared/chatDrafts');
  writeQueuedMessage(SESSION.id, { id: 'ticket-1', content: 'stays queued', attachments: [] });
  const view = renderComposer();
  const file = new File(['x'], 'x.txt', { type: 'text/plain' });
  await act(async () => {
    view.result.current.setInput('typed text');
    view.result.current.setAttachedFiles([file]);
  });

  await act(async () => { view.result.current.handleClearInput(); });

  assert.equal(view.result.current.input, '');
  assert.deepEqual(view.result.current.todoSourceIds, []);
  // The clear control keeps browser files as it did before todo sources existed.
  assert.deepEqual(view.result.current.attachedFiles, [file]);
  assert.equal(readQueuedMessages(SESSION.id)[0]?.content, 'stays queued');
});


test('a refused receipt restores its text, uploaded attachments and todo ids', async () => {
  writeDraftMeta(SESSION.id, META);
  const view = renderComposer();
  await act(async () => {
    rememberPendingChatSend({
      sessionId: SESSION.id,
      clientMessageId: 'client-1',
      content: 'retry this todo',
      options: { clientMessageId: 'client-1', todoIds: ['todo-1'] },
      files: [],
      attachments: META.attachments,
      todoIds: ['todo-1'],
    });
  });
  await act(async () => { rejectPendingChatSend('client-1'); });

  assert.equal(view.result.current.input, 'retry this todo');
  assert.ok(view.result.current.todoSourceIds.includes('todo-1'));
  assert.ok(view.result.current.storedAttachments.some((attachment) => attachment.path === META.attachments[0].path));
});

test('a full queue keeps the draft, its text and its todo source', async () => {
  for (let index = 0; index < 3; index += 1) {
    writeQueuedMessage(SESSION.id, { id: `ticket-${index}`, content: `queued ${index}`, attachments: [] });
  }
  writeDraftMeta(SESSION.id, META);
  const errors: unknown[] = [];
  const view = renderComposer({ isLoading: true, addMessage: (message) => errors.push(message) });
  await act(async () => { view.result.current.setInput('cannot queue'); });

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(view.result.current.input, 'cannot queue');
  assert.deepEqual(view.result.current.todoSourceIds, ['todo-1']);
  assert.equal((errors[0] as { type: string }).type, 'error');
  assert.equal(readQueuedMessages(SESSION.id).length, 3);
});

test('re-dispatching a queued entry never inherits the draft being edited', async () => {
  writeDraftMeta(SESSION.id, META);
  const view = renderComposer({ isLoading: true });
  await act(async () => {
    view.result.current.setInput('draft for another message');
  });
  await act(async () => {
    await view.result.current.handleSubmit(submit(), {
      id: 'ticket-9',
      content: 'own queued message',
      attachments: [],
      uploadedAttachments: [{ path: '/store/own.txt', name: 'own.txt' }],
      options: { todoIds: ['todo-9'], clientMessageId: 'client-9' },
    });
  });

  const queued = readQueuedMessages(SESSION.id).find((entry) => entry.id === 'ticket-9');
  assert.deepEqual(queued?.options?.todoIds, ['todo-9']);
  assert.deepEqual(queued?.attachments, [{ path: '/store/own.txt', name: 'own.txt' }]);
});

test('an unread steer returns its todo ids and uploaded attachments with the text', async () => {
  const sendMessage = vi.fn();
  const hook = renderHook(
    ({ isLoading }: { isLoading: boolean }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'model',
      currentProviderEffort: 'high',
      isLoading,
      supportsSteering: true,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { isLoading: true } },
  );
  writeDraftMeta(SESSION.id, META);
  await act(async () => { hook.result.current.setInput('steer this'); });
  await act(async () => {
    await hook.result.current.handleSubmit(submit(), undefined, { steerIntoTurn: true });
  });
  const steer = sendMessage.mock.calls.at(-1)?.[0] as { type: string; options: { todoIds?: string[]; attachments?: unknown[] } };
  assert.equal(steer.type, 'chat.steer');
  assert.deepEqual(steer.options.todoIds, ['todo-1']);
  assert.deepEqual(steer.options.attachments, META.attachments);

  const messageId = (steer as unknown as { messageId: string }).messageId;
  await act(async () => { hook.result.current.handleSteerOutcome(SESSION.id, messageId, 'accepted'); });
  await act(async () => { hook.rerender({ isLoading: false }); });

  assert.equal(hook.result.current.input, 'steer this');
  assert.deepEqual(hook.result.current.todoSourceIds, ['todo-1']);
  assert.deepEqual(hook.result.current.storedAttachments, META.attachments);
});

test('appending a todo checks the final stored + prepared + File total atomically', async () => {
  const storedFive: TodoDraftMeta = {
    todoIds: [],
    attachments: Array.from({ length: 5 }, (_, index) => ({ path: `/store/existing-${index}.txt`, name: `existing-${index}.txt` })),
  };
  writeDraftMeta(SESSION.id, storedFive);
  preparedDraft = {
    text: 'too many',
    todoIds: ['todo-new'],
    attachments: Array.from({ length: 5 }, (_, index) => ({ path: `/store/new-${index}.txt`, name: `new-${index}.txt` })),
  };
  const view = renderComposer();
  const files = [
    new File(['a'], 'a.txt', { type: 'text/plain' }),
    new File(['b'], 'b.txt', { type: 'text/plain' }),
  ];
  await act(async () => {
    view.result.current.setInput('keep this text');
    view.result.current.setAttachedFiles(files);
  });

  await act(async () => {
    assert.equal(await view.result.current.selectProjectTodo({ id: 'todo-new', projectId: 'project-1' } as never), false);
  });

  // Nothing was partially appended.
  assert.equal(view.result.current.input, 'keep this text');
  assert.deepEqual(view.result.current.attachedFiles, files);
  assert.deepEqual(view.result.current.storedAttachments, storedFive.attachments);
  assert.deepEqual(view.result.current.todoSourceIds, []);
  assert.deepEqual(readDraftMeta(SESSION.id), storedFive);
});

test('a stored-attachment-only /todo saves a todo without text, File, model, session or queue', async () => {
  const storedOnly: TodoDraftMeta = { todoIds: [], attachments: [{ path: '/store/photo.png', name: 'photo.png', size: 3 }] };
  writeDraftMeta(SESSION.id, storedOnly);
  const sendMessage = vi.fn();
  const view = renderComposer({ sendMessage });
  await act(async () => { view.result.current.setInput('/todo'); });

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(createdTodos.length, 1);
  assert.equal(createdTodos[0].get('content'), '');
  assert.deepEqual(JSON.parse(String(createdTodos[0].get('storedAttachments'))), storedOnly.attachments);
  assert.equal((createdTodos[0].getAll('files') as File[]).length, 0);
  assert.equal(view.result.current.input, '');
  assert.deepEqual(view.result.current.storedAttachments, []);
  assert.equal(readDraftMeta(SESSION.id), null);
  assert.equal(sendMessage.mock.calls.length, 0);
  assert.deepEqual(readQueuedMessages(SESSION.id), []);
});

test('a linked source tail /todo still opens the list and keeps text and attachments', async () => {
  writeDraftMeta(SESSION.id, META);
  const view = renderComposer();
  await act(async () => { view.result.current.setInput('todo body\n/todo'); });

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(view.result.current.todoDialogOpen, true);
  assert.equal(view.result.current.input, 'todo body');
  assert.deepEqual(view.result.current.todoSourceIds, ['todo-1']);
  assert.deepEqual(view.result.current.storedAttachments, META.attachments);
  assert.equal(createdTodos.length, 0);
});


test('a linked source draft never executes a menu command over its todo text', async () => {
  writeDraftMeta(SESSION.id, META);
  const { api } = await import('@/shared/api');
  const execute = vi.spyOn(api.commands, 'execute');
  const sendMessage = vi.fn();
  const view = renderComposer({ sendMessage });
  const file = new File(['x'], 'x.txt', { type: 'text/plain' });
  await act(async () => {
    view.result.current.setInput('todo body');
    view.result.current.setAttachedFiles([file]);
  });
  const command = { name: '/review', description: 'review', namespace: 'project', type: 'custom' } as never;

  await act(async () => { view.result.current.handleCommandSelect(command, 0, false); });

  assert.equal(execute.mock.calls.length, 0);
  assert.equal(view.result.current.input, 'todo body');
  assert.deepEqual(view.result.current.attachedFiles, [file]);
  assert.deepEqual(view.result.current.todoSourceIds, ['todo-1']);
  assert.ok(view.result.current.todoNotice);
  assert.equal(sendMessage.mock.calls.length, 0);

  // Unlinking restores the normal command path.
  await act(async () => { view.result.current.detachTodoSource(); });
  await act(async () => { view.result.current.handleCommandSelect(command, 0, false); });
  assert.equal(execute.mock.calls.length, 1);
});

test('editing a sent message that starts with /todo still sends it as an edit', async () => {
  const sendMessage = vi.fn();
  const view = renderComposer({ sendMessage });
  await act(async () => {
    view.result.current.beginEditMessage({ transcriptAnchorId: 'anchor-1', content: '/todo old body' } as never);
  });

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(createdTodos.length, 0);
  assert.equal(view.result.current.todoDialogOpen, false);
  const sent = sendMessage.mock.calls[0][0] as { type: string; content: string; anchorId: string };
  assert.equal(sent.type, 'chat.edit-send');
  assert.equal(sent.content, '/todo old body');
  assert.equal(sent.anchorId, 'anchor-1');
});

test('background confirmation for a source send offers no side question but still sends', async () => {
  writeDraftMeta(SESSION.id, META);
  const sendMessage = vi.fn();
  const processingSessions = new Map([[SESSION.id, { background: true, tasks: [] }]]);
  const hook = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'model',
    currentProviderEffort: 'high',
    isLoading: false,
    processingSessions: processingSessions as never,
    supportsSideQuestions: true,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  await act(async () => { hook.result.current.setInput('todo body'); });
  let sending!: Promise<void>;
  await act(async () => {
    sending = hook.result.current.handleSubmit(submit());
  });
  // Todo sources still allow queueing behind the background work; the side
  // question is gated by the dialog itself, not by canQueue.
  await vi.waitFor(() => assert.notEqual(hook.result.current.backgroundSendPrompt, null));
  // Absent means queueing is allowed; the dialog only blocks it on an explicit false.
  assert.notEqual(hook.result.current.backgroundSendPrompt?.canQueue, false);

  await act(async () => {
    hook.result.current.resolveBackgroundSendPrompt('queue');
    await sending;
  });
  assert.equal(sendMessage.mock.calls.length, 0);
  assert.equal(createdTodos.length, 0);
  const queued = readQueuedMessages(SESSION.id);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].content, 'todo body');
  assert.deepEqual(queued[0].options?.todoIds, ['todo-1']);
  // Stored descriptors appear exactly once, not merged twice by this branch.
  assert.deepEqual(queued[0].attachments, META.attachments);
});

test('editing a queued todo message restores durable descriptors and sources, and re-sends each once', async () => {
  const upload = vi.spyOn(api.assets, 'uploadFiles');
  writeDraftMeta(SESSION.id, META);
  const queuedView = renderComposer({ isLoading: true });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    queuedView.result.current.setInput('todo body');
    queuedView.result.current.setAttachedFiles([file]);
  });
  await act(async () => { await queuedView.result.current.handleSubmit(submit()); });

  const queued = readQueuedMessages(SESSION.id);
  assert.equal(queued.length, 1);
  const uploaded = { path: '/store/upload.txt', name: 'notes.txt' };
  // Stored todo descriptor plus the one new upload, each exactly once.
  assert.deepEqual(queued[0].attachments, [META.attachments[0], uploaded]);
  assert.equal(upload.mock.calls.length, 1);
  queuedView.unmount();

  const sendMessage = vi.fn();
  const view = renderComposer({ sendMessage });
  await act(async () => { view.result.current.editQueuedDraft(queued[0].id); });

  assert.equal(view.result.current.input, 'todo body');
  // Durable descriptors replace the browser files, so the retry cannot upload
  // the same file again under a second path.
  assert.deepEqual(view.result.current.attachedFiles, []);
  assert.deepEqual(view.result.current.todoSourceIds, ['todo-1']);
  assert.deepEqual(view.result.current.storedAttachments, [META.attachments[0], uploaded]);
  assert.deepEqual(readQueuedMessages(SESSION.id), []);

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  assert.equal(upload.mock.calls.length, 1);
  const sent = sendMessage.mock.calls[0][0] as { type: string; options: { todoIds?: string[]; attachments?: unknown[] } };
  assert.equal(sent.type, 'chat.send');
  assert.deepEqual(sent.options.todoIds, ['todo-1']);
  assert.deepEqual(sent.options.attachments, [META.attachments[0], uploaded]);
});

test('editing a plain or legacy queued entry restores only what that entry owns', async () => {
  const legacyFile = new File(['legacy'], 'legacy.txt', { type: 'text/plain' });
  // A legacy entry has only browser files retained for its ticket: it never
  // uploaded any descriptor.
  rememberPendingChatSend({
    sessionId: SESSION.id,
    clientMessageId: 'client-legacy',
    content: 'legacy queued',
    options: { clientMessageId: 'client-legacy' },
    files: [legacyFile],
    attachments: [],
  });
  adoptQueuedChatMessage({
    scope: SESSION.id,
    clientMessageId: 'client-legacy',
    messageId: 'ticket-legacy',
    queuedMessage: { content: 'legacy queued', attachments: [] },
  });
  writeQueuedMessage(SESSION.id, { id: 'ticket-plain', content: 'plain queued', attachments: [] });
  // The composer already holds a linked source from another draft.
  writeDraftMeta(SESSION.id, META);
  const view = renderComposer();
  assert.deepEqual(readQueuedMessages(SESSION.id).map((entry) => entry.id), ['ticket-legacy', 'ticket-plain']);

  await act(async () => { view.result.current.editQueuedDraft('ticket-plain'); });

  assert.equal(view.result.current.input, 'plain queued');
  assert.deepEqual(view.result.current.attachedFiles, []);
  assert.deepEqual(view.result.current.todoSourceIds, []);
  assert.deepEqual(view.result.current.storedAttachments, []);
  assert.equal(readDraftMeta(SESSION.id), null);
  // Only the edited card left; the FIFO remainder is untouched.
  assert.deepEqual(readQueuedMessages(SESSION.id).map((entry) => entry.id), ['ticket-legacy']);

  // A descriptor-less legacy entry keeps its File so it can be uploaded again.
  await act(async () => { view.result.current.editQueuedDraft('ticket-legacy'); });

  assert.equal(view.result.current.input, 'legacy queued');
  assert.deepEqual(view.result.current.attachedFiles, [legacyFile]);
  assert.deepEqual(view.result.current.todoSourceIds, []);
  assert.deepEqual(view.result.current.storedAttachments, []);
  assert.deepEqual(readQueuedMessages(SESSION.id), []);
});

test('a refused send restores uploaded descriptors instead of duplicating its browser file', async () => {
  const upload = vi.spyOn(api.assets, 'uploadFiles');
  const sendMessage = vi.fn();
  const view = renderComposer({ sendMessage });
  const file = new File(['once'], 'upload-once.txt', { type: 'text/plain' });
  const descriptor = { path: '/store/upload-once.txt', name: 'upload-once.txt' };
  await act(async () => {
    rememberPendingChatSend({
      sessionId: SESSION.id,
      clientMessageId: 'client-once',
      content: 'retry this todo',
      options: { clientMessageId: 'client-once', todoIds: ['todo-1'] },
      files: [file],
      attachments: [descriptor],
      todoIds: ['todo-1'],
    });
  });
  await act(async () => { rejectPendingChatSend('client-once'); });

  assert.deepEqual(view.result.current.attachedFiles, []);
  assert.deepEqual(view.result.current.storedAttachments, [descriptor]);
  assert.deepEqual(view.result.current.todoSourceIds, ['todo-1']);

  await act(async () => { await view.result.current.handleSubmit(submit()); });

  // The retry reuses the already-uploaded path; nothing is uploaded again.
  assert.equal(upload.mock.calls.length, 0);
  const retried = sendMessage.mock.calls[0][0] as { options: { todoIds?: string[]; attachments?: unknown[] } };
  assert.deepEqual(retried.options.todoIds, ['todo-1']);
  assert.deepEqual(retried.options.attachments, [descriptor]);
});

test('an accepted unread steer restores its descriptors once instead of its browser file', async () => {
  const upload = vi.spyOn(api.assets, 'uploadFiles');
  const sendMessage = vi.fn();
  const hook = renderHook(
    ({ isLoading }: { isLoading: boolean }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'model',
      currentProviderEffort: 'high',
      isLoading,
      supportsSteering: true,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { isLoading: true } },
  );
  const file = new File(['steer'], 'steer.txt', { type: 'text/plain' });
  await act(async () => {
    hook.result.current.setInput('steer with file');
    hook.result.current.setAttachedFiles([file]);
  });
  await act(async () => {
    await hook.result.current.handleSubmit(submit(), undefined, { steerIntoTurn: true });
  });
  const steer = sendMessage.mock.calls.at(-1)?.[0] as { type: string; messageId: string; options: { attachments?: unknown[] } };
  assert.equal(steer.type, 'chat.steer');
  const uploaded = steer.options.attachments as { path?: string; name?: string }[];
  assert.equal(uploaded.length, 1);
  assert.equal(upload.mock.calls.length, 1);

  await act(async () => { hook.result.current.handleSteerOutcome(SESSION.id, steer.messageId, 'accepted'); });
  await act(async () => { hook.rerender({ isLoading: false }); });

  assert.equal(hook.result.current.input, 'steer with file');
  assert.deepEqual(hook.result.current.attachedFiles, []);
  assert.deepEqual(hook.result.current.storedAttachments, uploaded);

  await act(async () => { await hook.result.current.handleSubmit(submit()); });

  assert.equal(upload.mock.calls.length, 1);
  const sent = sendMessage.mock.calls.at(-1)?.[0] as { type: string; options: { attachments?: unknown[] } };
  assert.equal(sent.type, 'chat.send');
  assert.deepEqual(sent.options.attachments, uploaded);
});
