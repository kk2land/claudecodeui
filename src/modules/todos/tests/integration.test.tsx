import assert from 'node:assert/strict';

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ProjectTodoDialog } from '@/modules/todos';
import { api } from '@/shared/api';
import {
  hydrateChatDrafts,
  readDraftMeta,
  resetChatDrafts,
  writeDraftMeta,
} from '@/shared/chatDrafts';
import type { ChatAttachment, ProjectTodo, TodoDraftMeta } from '@/shared/types';

const { subscribe, emit, translate } = vi.hoisted(() => {
  const handlers: Array<(event: { kind: string; projectId?: string }) => void> = [];
  return {
    emit: (event: { kind: string; projectId?: string }) => handlers.forEach((handler) => handler(event)),
    subscribe: (handler: (event: { kind: string; projectId?: string }) => void) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    translate: (key: string) => key,
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));
// The shared API module is mocked as a whole: each case drives the exact HTTP
// boundary the todos module and the draft mirror depend on.
vi.mock('@/shared/api', () => ({
  // The todos hook reads every response through this envelope helper; a stub
  // that only rejects failed responses keeps the real success path.
  readApiJson: async (response: Response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return data;
  },
  api: {
    user: {
      drafts: vi.fn(async () => Response.json({ success: true, drafts: [] })),
      saveDraft: vi.fn(async () => Response.json({ success: true })),
      deleteDraft: vi.fn(async () => Response.json({ success: true })),
    },
    todos: {
      list: vi.fn(),
      prepare: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
      attachment: vi.fn(),
    },
  },
}));

const PROJECT_ID = 'project-1';
const SESSION_ID = 'session-a';
const SCOPE = SESSION_ID;
const STORED: ChatAttachment = { path: '/store/spec.md', name: 'spec.md', size: 4, mimeType: 'text/markdown' };

const makeTodo = (overrides: Partial<ProjectTodo> = {}): ProjectTodo => ({
  id: 'todo-1',
  projectId: PROJECT_ID,
  content: 'Prepared body',
  attachments: [],
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stateChangedAt: '2026-01-01T00:00:00.000Z',
  submittedSessionId: null,
  ...overrides,
});

const renderDialog = (onSelectTodo: (todo: ProjectTodo) => Promise<boolean> = async () => true) => render(
  <ProjectTodoDialog
    projectId={PROJECT_ID}
    projectName="Project One"
    open
    onOpenChange={() => undefined}
    onSelectTodo={onSelectTodo}
  />,
);

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  vi.mocked(api.todos.list).mockReset();
  vi.mocked(api.todos.prepare).mockReset();
  vi.mocked(api.user.drafts).mockReset();
  vi.mocked(api.user.drafts).mockImplementation(async () => Response.json({ success: true, drafts: [] }));
  vi.mocked(api.user.saveDraft).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a todos_changed frame refetches only this project while the dialog stays open', async () => {
  vi.mocked(api.todos.list).mockImplementation(async () => Response.json({
    todos: [makeTodo({ id: 'pending-1', content: 'Pending one' })],
  }));

  const view = renderDialog();
  expect(await screen.findByText('Pending one')).toBeTruthy();
  const afterOpen = vi.mocked(api.todos.list).mock.calls.length;

  // Another project's row changed; this list must not refetch for it.
  await act(async () => { emit({ kind: 'todos_changed', projectId: 'project-2' }); });
  expect(vi.mocked(api.todos.list).mock.calls.length).toBe(afterOpen);

  // The same row was submitted server-side: refetch, and the pending tab empties.
  vi.mocked(api.todos.list).mockImplementation(async () => Response.json({
    todos: [makeTodo({
      id: 'pending-1',
      content: 'Pending one',
      status: 'submitted',
      submittedSessionId: SESSION_ID,
    })],
  }));
  await act(async () => { emit({ kind: 'todos_changed', projectId: PROJECT_ID }); });
  await waitFor(() => expect(screen.queryByText('Pending one')).toBeNull());
  expect(vi.mocked(api.todos.list).mock.calls.length).toBe(afterOpen + 1);

  // The submitted tab now shows the row and its session link.
  await act(async () => {
    screen.getByRole('button', { name: /projectTodo\.tabSubmitted/ }).click();
  });
  expect(await screen.findByText('Pending one')).toBeTruthy();

  // Closing unsubscribes instead of polling the project in the background.
  view.unmount();
  const afterUnmount = vi.mocked(api.todos.list).mock.calls.length;
  await act(async () => { emit({ kind: 'todos_changed', projectId: PROJECT_ID }); });
  expect(vi.mocked(api.todos.list).mock.calls.length).toBe(afterUnmount);
});

test('selecting a pending row prepares it without submitting, and its draft meta survives a reload', async () => {
  vi.mocked(api.todos.list).mockImplementation(async () => Response.json({
    todos: [makeTodo({ id: 'todo-2', content: 'Prepared body' })],
  }));
  vi.mocked(api.todos.prepare).mockImplementation(async () => Response.json({
    draft: { text: 'Prepared body', todoIds: ['todo-2'], attachments: [STORED] },
  }));

  const prepared: string[] = [];
  const view = renderDialog(async (todo) => {
    // The chat composition appends a prepared todo; this is the same server call.
    const response = await api.todos.prepare(PROJECT_ID, [todo.id]);
    const body = await response.json() as { draft: TodoDraftMeta & { text: string } };
    writeDraftMeta(SCOPE, { todoIds: body.draft.todoIds, attachments: body.draft.attachments });
    prepared.push(body.draft.text);
    return true;
  });

  const row = await screen.findByText('Prepared body');
  await act(async () => { row.click(); });
  await waitFor(() => expect(prepared).toEqual(['Prepared body']));
  expect(vi.mocked(api.todos.prepare).mock.calls[0]).toEqual([PROJECT_ID, ['todo-2']]);
  // Appending to the composer mutates no todo state and starts no send.
  expect(vi.mocked(api.todos.remove)).not.toHaveBeenCalled();
  expect(vi.mocked(api.user.saveDraft)).not.toHaveBeenCalled();
  assert.deepEqual(readDraftMeta(SCOPE), { todoIds: ['todo-2'], attachments: [STORED] });

  // The next page load reads the same meta back from the server draft payload.
  view.unmount();
  resetChatDrafts();
  vi.mocked(api.user.drafts).mockImplementation(async () => Response.json({
    success: true,
    drafts: [{
      scope: SCOPE,
      text: 'Prepared body',
      queuedMessages: [],
      meta: { todoIds: ['todo-2'], attachments: [STORED] },
    }],
  }));
  await act(async () => { await hydrateChatDrafts(); });
  assert.deepEqual(readDraftMeta(SCOPE), { todoIds: ['todo-2'], attachments: [STORED] });

  // Unlinking keeps the stored attachment, so a reload still offers the file.
  writeDraftMeta(SCOPE, { todoIds: [], attachments: [STORED] });
  resetChatDrafts();
  vi.mocked(api.user.drafts).mockImplementation(async () => Response.json({
    success: true,
    drafts: [{
      scope: SCOPE,
      text: 'Prepared body',
      queuedMessages: [],
      meta: { todoIds: [], attachments: [STORED] },
    }],
  }));
  await act(async () => { await hydrateChatDrafts(); });
  assert.deepEqual(readDraftMeta(SCOPE), { todoIds: [], attachments: [STORED] });
});
