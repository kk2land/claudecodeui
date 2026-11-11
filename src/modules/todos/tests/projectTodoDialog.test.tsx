import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ProjectTodoDialog } from '@/modules/todos';
import { api } from '@/shared/api';
import type { ProjectTodo } from '@/shared/types';

const { subscribe, translate } = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  translate: (key: string) => key,
}));

vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
// The dialog only needs the keys to be distinguishable, so `t` echoes them.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));

const PROJECT_ID = 'project-1';
const PROJECT_NAME = 'Demo';

const makeTodo = (overrides: Partial<ProjectTodo> = {}): ProjectTodo => ({
  id: 'todo-1',
  projectId: PROJECT_ID,
  content: 'Pending text',
  attachments: [],
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  stateChangedAt: '2026-01-02T00:00:00.000Z',
  submittedSessionId: null,
  ...overrides,
});

const json = (body: unknown, status = 200) => Response.json(body, { status });

let list: MockInstance<typeof api.todos.list>;
let update: MockInstance<typeof api.todos.update>;
let remove: MockInstance<typeof api.todos.remove>;
let restore: MockInstance<typeof api.todos.restore>;
let attachment: MockInstance<typeof api.todos.attachment>;

// Every call needs a fresh Response: a body can only be read once, and the
// dialog reloads the list after each mutation.
const mockList = (todos: ProjectTodo[]) => {
  list.mockImplementation(async () => json({ todos }));
};

beforeEach(() => {
  list = vi.spyOn(api.todos, 'list').mockImplementation(async () => json({ todos: [] }));
  update = vi.spyOn(api.todos, 'update').mockImplementation(async () => json({ todo: makeTodo() }));
  remove = vi.spyOn(api.todos, 'remove').mockImplementation(async () => json({ success: true }));
  restore = vi.spyOn(api.todos, 'restore').mockImplementation(async () => json({ todo: makeTodo() }));
  attachment = vi.spyOn(api.todos, 'attachment').mockImplementation(
    async () => new Response(new Uint8Array([1, 2, 3])),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderDialog = (props: Partial<Parameters<typeof ProjectTodoDialog>[0]> = {}) => {
  const onOpenChange = vi.fn();
  const onSelectTodo = vi.fn(async (_todo: ProjectTodo): Promise<boolean> => true);
  const view = render(
    <ProjectTodoDialog
      projectId={PROJECT_ID}
      projectName={PROJECT_NAME}
      open
      onOpenChange={onOpenChange}
      onSelectTodo={onSelectTodo}
      {...props}
    />,
  );
  return { view, onOpenChange, onSelectTodo };
};

describe('ProjectTodoDialog list', () => {
  test('filters rows by tab, defaulting to pending', async () => {
    mockList([
      makeTodo({ id: 'pending-1', content: 'Pending one' }),
      makeTodo({ id: 'submitted-1', content: 'Submitted one', status: 'submitted', submittedSessionId: 'session-1' }),
      makeTodo({ id: 'deleted-1', content: 'Deleted one', status: 'deleted' }),
    ]);

    renderDialog();

    expect(await screen.findByText('Pending one')).toBeTruthy();
    expect(screen.queryByText('Submitted one')).toBeNull();
    expect(screen.queryByText('Deleted one')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /projectTodo\.tabSubmitted/ }));
    expect(await screen.findByText('Submitted one')).toBeTruthy();
    expect(screen.queryByText('Pending one')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /projectTodo\.tabDeleted/ }));
    expect(await screen.findByText('Deleted one')).toBeTruthy();
  });

  test('clicking a pending row appends it and closes on success', async () => {
    mockList([makeTodo()]);
    const { onOpenChange, onSelectTodo } = renderDialog();

    fireEvent.click(await screen.findByText('Pending text'));

    await waitFor(() => expect(onSelectTodo).toHaveBeenCalledTimes(1));
    expect(onSelectTodo.mock.calls[0][0]).toMatchObject({ id: 'todo-1' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test('a failed append keeps the list open with a short message', async () => {
    mockList([makeTodo()]);
    const onSelectTodo = vi.fn(async (_todo: ProjectTodo): Promise<boolean> => false);
    const { onOpenChange } = renderDialog({ onSelectTodo });

    fireEvent.click(await screen.findByText('Pending text'));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'projectTodo.selectFailed');
    expect(screen.getByText('Pending text')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('ProjectTodoDialog row actions', () => {
  test('edit saves content and the kept attachment ids through the todo endpoint', async () => {
    mockList([makeTodo({
      content: 'Original',
      attachments: [{ id: 'attachment-1', name: 'note.pdf', mimeType: 'application/pdf', size: 10 }],
    })]);
    const { view, onOpenChange } = renderDialog();

    fireEvent.click(await screen.findByLabelText('projectTodo.edit'));
    const textarea = screen.getByPlaceholderText('projectTodo.editor.contentPlaceholder') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Original');

    fireEvent.change(textarea, { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'projectTodo.editor.save' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(PROJECT_ID, 'todo-1', expect.any(FormData));
    const formData = update.mock.calls[0][2] as FormData;
    expect(formData.get('content')).toBe('Edited');
    expect(JSON.parse(String(formData.get('keepAttachmentIds')))).toEqual(['attachment-1']);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(onOpenChange).not.toHaveBeenCalled();
    // The editor closed after the save, leaving the list behind.
    await waitFor(() => expect(view.queryByPlaceholderText('projectTodo.editor.contentPlaceholder')).toBeNull());
  });

  test('a failed save keeps the edited text', async () => {
    mockList([makeTodo({ content: 'Original' })]);
    update.mockImplementation(async () => json({ success: false, error: 'nope' }, 500));

    renderDialog();

    fireEvent.click(await screen.findByLabelText('projectTodo.edit'));
    const textarea = screen.getByPlaceholderText('projectTodo.editor.contentPlaceholder') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Edited but unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'projectTodo.editor.save' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByPlaceholderText('projectTodo.editor.contentPlaceholder') as HTMLTextAreaElement).value)
      .toBe('Edited but unsaved');
  });

  test('an empty edit is rejected locally without calling the endpoint', async () => {
    mockList([makeTodo({ content: 'Only text' })]);

    renderDialog();

    fireEvent.click(await screen.findByLabelText('projectTodo.edit'));
    const textarea = screen.getByPlaceholderText('projectTodo.editor.contentPlaceholder');
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'projectTodo.editor.save' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveProperty('textContent', 'projectTodo.editor.errorEmpty'));
    expect(update).not.toHaveBeenCalled();
  });

  test('deleting a pending row moves it through the server and reloads', async () => {
    mockList([makeTodo()]);

    renderDialog();

    fireEvent.click(await screen.findByLabelText('projectTodo.delete'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(PROJECT_ID, 'todo-1'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  test('submitted rows navigate to their session and restore to pending', async () => {
    mockList([makeTodo({ content: 'Already sent', status: 'submitted', submittedSessionId: 'session-42' })]);
    const onNavigateToSession = vi.fn();
    const { onOpenChange } = renderDialog({ onNavigateToSession });

    fireEvent.click(await screen.findByRole('button', { name: /projectTodo\.tabSubmitted/ }));
    expect(await screen.findByText('Already sent')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'projectTodo.viewSession' }));
    expect(onNavigateToSession).toHaveBeenCalledWith('session-42');
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'projectTodo.restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(PROJECT_ID, 'todo-1'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  test('deleted rows restore without a session action', async () => {
    mockList([makeTodo({ content: 'Dropped', status: 'deleted' })]);

    renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: /projectTodo\.tabDeleted/ }));
    expect(await screen.findByText('Dropped')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'projectTodo.viewSession' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'projectTodo.restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(PROJECT_ID, 'todo-1'));
  });
});

describe('ProjectTodoDialog attachments', () => {
  test('preview opens without selecting the row', async () => {
    mockList([makeTodo({
      attachments: [{ id: 'attachment-1', name: 'notes.pdf', mimeType: 'application/pdf', size: 10 }],
    })]);
    const { onSelectTodo } = renderDialog();

    fireEvent.click(await screen.findByLabelText('projectTodo.previewAttachments'));

    const overlay = await screen.findByLabelText('projectTodo.previewTitle');
    expect(overlay.textContent).toContain('notes.pdf');
    expect(onSelectTodo).not.toHaveBeenCalled();
  });

  test('images load from the private todo attachment route and revoke their URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:todo-image');
    const revokeObjectURL = vi.fn();
    // jsdom has no object-URL implementation, so stand one in for this case.
    const urlClass = URL as unknown as Record<string, unknown>;
    const originalCreate = urlClass.createObjectURL;
    const originalRevoke = urlClass.revokeObjectURL;
    urlClass.createObjectURL = createObjectURL;
    urlClass.revokeObjectURL = revokeObjectURL;
    mockList([makeTodo({
      attachments: [{ id: 'image-1', name: 'shot.png', mimeType: 'image/png', size: 10 }],
    })]);

    try {
      const { view } = renderDialog();

      const image = await screen.findByAltText('shot.png');
      expect(image.getAttribute('src')).toBe('blob:todo-image');
      expect(attachment).toHaveBeenCalledWith(PROJECT_ID, 'todo-1', 'image-1');

      view.unmount();
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:todo-image'));
    } finally {
      if (originalCreate) urlClass.createObjectURL = originalCreate;
      else delete urlClass.createObjectURL;
      if (originalRevoke) urlClass.revokeObjectURL = originalRevoke;
      else delete urlClass.revokeObjectURL;
    }
  });
});
