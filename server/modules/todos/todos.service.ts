import { randomUUID } from 'node:crypto';
import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import mime from 'mime-types';

import { copyFilesIntoChatAssets } from '@/modules/assets/index.js';
import {
  projectTodosDb,
  projectsDb,
  sessionsDb,
  type ProjectTodoAttachmentRecord,
  type ProjectTodoRecord,
  type ProjectTodosRepository,
} from '@/modules/database/index.js';
import type {
  ChatAttachmentDescriptor,
  PreparedProjectTodo,
  ProjectTodo,
  TodoUploadFile,
} from '@/shared/index.js';
import { AppError, getGlobalImageAssetsDir } from '@/shared/index.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTACHMENTS = 10;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

let broadcastSink: ((payload: string) => void) | null = null;

/** Injected by server composition so Todos never imports the WebSocket feature (which imports Todos). */
export function setTodosBroadcastSink(sink: (payload: string) => void): void {
  broadcastSink = sink;
}

type TodoServiceDependencies = {
  db: ProjectTodosRepository;
  baseDir: string;
  chatAssetsDir: string;
  clock: () => Date;
  copyIntoChatAssets: (files: Array<{ sourcePath: string; name: string; mimeType?: string }>) => Promise<ChatAttachmentDescriptor[]>;
  broadcast: (projectId: string) => void;
};

export type TodoServiceOptions = {
  db?: ProjectTodosRepository;
  baseDir?: string;
  chatAssetsDir?: string;
  clock?: () => Date;
  copyIntoChatAssets?: TodoServiceDependencies['copyIntoChatAssets'];
  broadcast?: TodoServiceDependencies['broadcast'];
};

/** Sends only the project id so every open client refetches authoritative todo rows. */
function defaultBroadcast(projectId: string): void {
  broadcastSink?.(JSON.stringify({ kind: 'todos_changed', projectId }));
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe === '.' || safe === '..' || !safe ? '_' : safe;
}

/** Maps a stored row to the public DTO, hiding the private stored file name. */
function toDto(todo: ProjectTodoRecord): ProjectTodo {
  return {
    id: todo.id,
    projectId: todo.projectId,
    content: todo.content,
    attachments: todo.attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
    status: todo.status,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    stateChangedAt: todo.stateChangedAt,
    submittedSessionId: todo.submittedSessionId,
  };
}

function attachmentFileName(attachment: { id: string; name: string }): string {
  const safeName = attachment.name.replace(/[^a-zA-Z0-9.-]/g, '_') || 'attachment';
  return `${attachment.id}-${safeName}`;
}

function refreshCopiedAttachments(
  existing: ProjectTodoAttachmentRecord[],
  keepIds: string[] | undefined,
): ProjectTodoAttachmentRecord[] {
  const keep = keepIds ? new Set(keepIds) : null;
  return keep ? existing.filter((attachment) => keep.has(attachment.id)) : existing;
}

/** Builds the typed todo service; tests inject a temp base dir, clock, and asset copier. */
export function createTodoService(options: TodoServiceOptions = {}) {
  const deps: TodoServiceDependencies = {
    db: options.db ?? projectTodosDb,
    baseDir: options.baseDir ?? path.join(os.homedir(), '.cloudcli', 'todo-assets'),
    chatAssetsDir: options.chatAssetsDir ?? getGlobalImageAssetsDir(),
    clock: options.clock ?? (() => new Date()),
    copyIntoChatAssets: options.copyIntoChatAssets ?? copyFilesIntoChatAssets,
    broadcast: options.broadcast ?? defaultBroadcast,
  };

  function todoDir(userId: number, projectId: string, todoId: string): string {
    return path.join(deps.baseDir, safeSegment(String(userId)), safeSegment(projectId), safeSegment(todoId));
  }

  function isExpired(todo: ProjectTodoRecord): boolean {
    return todo.status !== 'pending'
      && new Date(todo.stateChangedAt).getTime() <= deps.clock().getTime() - RETENTION_MS;
  }

  function getProjectOrThrow(projectId: string): void {
    if (!projectsDb.getProjectById(projectId)) {
      throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }
  }

  async function removeTempFiles(files: TodoUploadFile[]): Promise<void> {
    await Promise.all(files.map((file) => fs.rm(file.tempPath, { force: true }).catch(() => undefined)));
  }

  /** Copies multer temp uploads into the todo folder, removing each temp file once archived. */
  async function archiveUploads(
    userId: number,
    projectId: string,
    todoId: string,
    files: TodoUploadFile[],
  ): Promise<ProjectTodoAttachmentRecord[]> {
    const directory = todoDir(userId, projectId, todoId);
    await fs.mkdir(directory, { recursive: true });
    const archived: ProjectTodoAttachmentRecord[] = [];
    try {
      for (const file of files) {
        const id = randomUUID();
        const record: ProjectTodoAttachmentRecord = {
          id,
          name: file.name,
          mimeType: file.mimeType || mime.lookup(file.name) || 'application/octet-stream',
          size: file.size,
          storedName: attachmentFileName({ id, name: file.name }),
        };
        await fs.copyFile(file.tempPath, path.join(directory, record.storedName));
        archived.push(record);
        await fs.rm(file.tempPath, { force: true });
      }
      return archived;
    } catch (error) {
      await removeFiles(userId, projectId, todoId, archived);
      throw error;
    }
  }

  /** Copies already-uploaded chat attachments from their direct assets path. */
  async function copyStoredChatAttachments(
    userId: number,
    projectId: string,
    todoId: string,
    attachments: ChatAttachmentDescriptor[],
  ): Promise<ProjectTodoAttachmentRecord[]> {
    if (attachments.length === 0) return [];
    const assetsDir = path.resolve(deps.chatAssetsDir);
    const directory = todoDir(userId, projectId, todoId);
    await fs.mkdir(directory, { recursive: true });
    const copied: ProjectTodoAttachmentRecord[] = [];
    try {
      for (const attachment of attachments) {
        const sourcePath = path.resolve(attachment.path ?? '');
        if (!attachment.path || path.dirname(sourcePath) !== assetsDir) {
          throw new AppError('Stored attachment must be a chat asset', {
            code: 'INVALID_STORED_ATTACHMENT',
            statusCode: 400,
          });
        }
        const id = randomUUID();
        const name = attachment.name || path.basename(sourcePath);
        const record: ProjectTodoAttachmentRecord = {
          id,
          name,
          mimeType: attachment.mimeType || mime.lookup(name) || 'application/octet-stream',
          size: attachment.size ?? (await fs.stat(sourcePath)).size,
          storedName: attachmentFileName({ id, name }),
        };
        await fs.copyFile(sourcePath, path.join(directory, record.storedName));
        copied.push(record);
      }
      return copied;
    } catch (error) {
      await removeFiles(userId, projectId, todoId, copied);
      throw error;
    }
  }

  async function removeTodoDirectory(userId: number, projectId: string, todoId: string): Promise<void> {
    await fs.rm(todoDir(userId, projectId, todoId), { recursive: true, force: true });
  }

  async function removeFiles(userId: number, projectId: string, todoId: string, attachments: ProjectTodoAttachmentRecord[]): Promise<void> {
    await Promise.all(attachments.map((attachment) => fs.rm(
      path.join(todoDir(userId, projectId, todoId), path.basename(attachment.storedName)),
      { force: true },
    ).catch(() => undefined)));
  }

  function getVisible(userId: number, projectId: string, todoId: string): ProjectTodoRecord {
    const todo = deps.db.get(userId, projectId, todoId);
    if (!todo || isExpired(todo)) {
      throw new AppError('Todo not found', { code: 'TODO_NOT_FOUND', statusCode: 404 });
    }
    return todo;
  }

  return {
    list(userId: number, projectId: string): ProjectTodo[] {
      getProjectOrThrow(projectId);
      return deps.db.listForUserProject(userId, projectId)
        .filter((todo) => !isExpired(todo))
        .map(toDto);
    },

    async create(userId: number, projectId: string, input: {
      content: string;
      files: TodoUploadFile[];
      storedAttachments: ChatAttachmentDescriptor[];
    }): Promise<ProjectTodo> {
      getProjectOrThrow(projectId);
      if (!input.content.trim() && input.files.length === 0 && input.storedAttachments.length === 0) {
        await removeTempFiles(input.files);
        throw new AppError('A todo needs text or an attachment', { code: 'EMPTY_TODO', statusCode: 400 });
      }
      if (input.files.length + input.storedAttachments.length > MAX_ATTACHMENTS) {
        await removeTempFiles(input.files);
        throw new AppError(`At most ${MAX_ATTACHMENTS} attachments are allowed`, {
          code: 'TODO_ATTACHMENT_LIMIT',
          statusCode: 400,
        });
      }
      const id = randomUUID();
      try {
        const uploaded = await archiveUploads(userId, projectId, id, input.files);
        const stored = await copyStoredChatAttachments(userId, projectId, id, input.storedAttachments);
        const now = deps.clock().toISOString();
        const created = toDto(deps.db.create({
          id,
          userId,
          projectId,
          content: input.content,
          attachments: [...uploaded, ...stored],
          createdAt: now,
        }));
        deps.broadcast(projectId);
        return created;
      } catch (error) {
        await removeTempFiles(input.files);
        await removeTodoDirectory(userId, projectId, id).catch(() => undefined);
        throw error;
      }
    },

    async update(userId: number, projectId: string, todoId: string, input: {
      content?: string;
      files: TodoUploadFile[];
      keepAttachmentIds?: string[];
      storedAttachments: ChatAttachmentDescriptor[];
    }): Promise<ProjectTodo> {
      const todo = getVisible(userId, projectId, todoId);
      if (todo.status !== 'pending') {
        await removeTempFiles(input.files);
        throw new AppError('Only pending todos can be edited', { code: 'TODO_NOT_EDITABLE', statusCode: 409 });
      }
      const kept = refreshCopiedAttachments(todo.attachments, input.keepAttachmentIds);
      if (kept.length + input.files.length + input.storedAttachments.length > MAX_ATTACHMENTS) {
        await removeTempFiles(input.files);
        throw new AppError(`At most ${MAX_ATTACHMENTS} attachments are allowed`, {
          code: 'TODO_ATTACHMENT_LIMIT',
          statusCode: 400,
        });
      }
      const content = input.content ?? todo.content;
      if (!content.trim() && kept.length + input.files.length + input.storedAttachments.length === 0) {
        await removeTempFiles(input.files);
        throw new AppError('A todo needs text or an attachment', { code: 'EMPTY_TODO', statusCode: 400 });
      }
      const added: ProjectTodoAttachmentRecord[] = [];
      try {
        added.push(...await archiveUploads(userId, projectId, todoId, input.files));
        added.push(...await copyStoredChatAttachments(userId, projectId, todoId, input.storedAttachments));
        const updated = deps.db.updatePendingContent({
          userId,
          projectId,
          id: todoId,
          content,
          attachments: [...kept, ...added],
          updatedAt: deps.clock().toISOString(),
        });
        if (!updated) {
          throw new AppError('Only pending todos can be edited', { code: 'TODO_NOT_EDITABLE', statusCode: 409 });
        }
        const removed = todo.attachments.filter((attachment) => !kept.some((item) => item.id === attachment.id));
        await removeFiles(userId, projectId, todoId, removed);
        const updatedTodo = toDto(deps.db.get(userId, projectId, todoId) as ProjectTodoRecord);
        deps.broadcast(projectId);
        return updatedTodo;
      } catch (error) {
        await removeTempFiles(input.files);
        await removeFiles(userId, projectId, todoId, added);
        throw error;
      }
    },

    async remove(userId: number, projectId: string, todoId: string): Promise<void> {
      const todo = getVisible(userId, projectId, todoId);
      if (todo.status !== 'pending') {
        throw new AppError('Only pending todos can be deleted', { code: 'TODO_NOT_DELETABLE', statusCode: 409 });
      }
      deps.db.setStatus({
        userId,
        projectId,
        id: todoId,
        status: 'deleted',
        submittedSessionId: null,
        stateChangedAt: deps.clock().toISOString(),
      });
      deps.broadcast(projectId);
    },

    restore(userId: number, projectId: string, todoId: string): ProjectTodo {
      const todo = getVisible(userId, projectId, todoId);
      if (todo.status === 'pending' || isExpired(todo)) {
        throw new AppError('This todo can no longer be restored', { code: 'TODO_NOT_RESTORABLE', statusCode: 409 });
      }
      const restoredAt = deps.clock().toISOString();
      if (!deps.db.restore({ userId, projectId, id: todoId, restoredAt })) {
        throw new AppError('This todo can no longer be restored', { code: 'TODO_NOT_RESTORABLE', statusCode: 409 });
      }
      deps.broadcast(projectId);
      return toDto(deps.db.get(userId, projectId, todoId) as ProjectTodoRecord);
    },

    async prepare(userId: number, projectId: string, todoIds: string[]): Promise<PreparedProjectTodo> {
      getProjectOrThrow(projectId);
      const uniqueIds = [...new Set(todoIds)];
      if (uniqueIds.length === 0) {
        throw new AppError('Select at least one todo', { code: 'EMPTY_TODO_SELECTION', statusCode: 400 });
      }
      const todos = uniqueIds.map((id) => deps.db.get(userId, projectId, id));
      if (todos.some((todo) => !todo || todo.status !== 'pending' || isExpired(todo))) {
        throw new AppError('Only pending todos can be prepared', { code: 'TODO_NOT_PREPARABLE', statusCode: 409 });
      }
      const pending = todos as ProjectTodoRecord[];
      const files = pending.flatMap((todo) => todo.attachments.map((attachment) => ({
        sourcePath: path.join(todoDir(userId, projectId, todo.id), path.basename(attachment.storedName)),
        name: attachment.name,
        mimeType: attachment.mimeType,
      })));
      if (files.length > MAX_ATTACHMENTS) {
        throw new AppError(`At most ${MAX_ATTACHMENTS} attachments are allowed`, {
          code: 'TODO_ATTACHMENT_LIMIT',
          statusCode: 400,
        });
      }
      const attachments = await deps.copyIntoChatAssets(files);
      return {
        todoIds: pending.map((todo) => todo.id),
        text: pending.map((todo) => todo.content).filter((content) => content.trim()).join('\n\n'),
        attachments,
      };
    },

    /** Resolves one private attachment to its todo-owned file; never accepts a path from the client. */
    openAttachment(userId: number, projectId: string, todoId: string, attachmentId: string): {
      status: 'found'; contentType: string; path: string; name: string;
    } | { status: 'missing' } {
      const todo = deps.db.get(userId, projectId, todoId);
      const attachment = todo?.attachments.find((item) => item.id === attachmentId);
      if (!todo || isExpired(todo) || !attachment) return { status: 'missing' };
      const directory = path.resolve(todoDir(userId, projectId, todoId));
      const resolved = path.resolve(directory, path.basename(attachment.storedName));
      if (!resolved.startsWith(directory + path.sep)) return { status: 'missing' };
      try {
        fsSync.accessSync(resolved);
      } catch {
        return { status: 'missing' };
      }
      return {
        status: 'found',
        contentType: mime.lookup(resolved) || attachment.mimeType || 'application/octet-stream',
        path: resolved,
        name: attachment.name,
      };
    },

    /** Removes seven-day-old submitted/deleted rows only after their private folder is gone. */
    async runRetention(): Promise<void> {
      const cutoff = new Date(deps.clock().getTime() - RETENTION_MS).toISOString();
      const changedProjects = new Set<string>();
      for (const todo of deps.db.listExpired(cutoff)) {
        try {
          await removeTodoDirectory(todo.userId, todo.projectId, todo.id);
          deps.db.delete(todo.id);
          changedProjects.add(todo.projectId);
        } catch (error) {
          console.warn(`[todos] Retention kept ${todo.id}:`, (error as Error).message);
        }
      }
      for (const projectId of changedProjects) deps.broadcast(projectId);
    },

    /** Project hard deletion calls this before dropping the project row; a failed folder removal throws. */
    async deleteProjectTodos(projectId: string): Promise<void> {
      for (const todo of deps.db.listByProject(projectId)) {
        await removeTodoDirectory(todo.userId, todo.projectId, todo.id);
        deps.db.delete(todo.id);
      }
    },

    markSubmitted(input: { userId: number; sessionId: string; todoIds: string[] }): void {
      if (!input.todoIds.length) return;
      const session = sessionsDb.getSessionById(input.sessionId);
      const projectPath = session?.project_path;
      const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
      if (!project) return;
      const changed = deps.db.markSubmitted({
        userId: input.userId,
        projectId: project.project_id,
        todoIds: input.todoIds,
        sessionId: input.sessionId,
        submittedAt: deps.clock().toISOString(),
      });
      if (changed > 0) deps.broadcast(project.project_id);
    },
  };
}

export type TodoService = ReturnType<typeof createTodoService>;

/** Hourly retention loop; `start` also runs once at boot so expired rows never wait an hour. */
export function createTodoRetentionService(service: TodoService, intervalMs = RETENTION_INTERVAL_MS) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await service.runRetention();
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (timer) return;
      void run();
      timer = setInterval(() => { void run(); }, intervalMs);
      timer.unref?.();
    },
    close(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export const todosService = createTodoService();
export const todoRetentionService = createTodoRetentionService(todosService);
