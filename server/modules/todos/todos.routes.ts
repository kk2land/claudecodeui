import express from 'express';

import { AppError, asyncHandler } from '@/shared/index.js';

import { createTodoService } from './todos.service.js';
import { openTodoAttachmentStream, receiveTodoUploads, readTodoUploads, removeTodoUploads } from './todos.uploads.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readUserId(request: express.Request): number {
  return Number((request as AuthenticatedRequest).user?.id);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === '') return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AppError(`${field} must be a JSON array`, { code: 'INVALID_TODO_INPUT', statusCode: 400 });
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new AppError(`${field} must be an array of strings`, { code: 'INVALID_TODO_INPUT', statusCode: 400 });
  }
  return parsed;
}

function readStoredAttachments(value: unknown) {
  if (value === undefined || value === '') return [];
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AppError('storedAttachments must be a JSON array', { code: 'INVALID_TODO_INPUT', statusCode: 400 });
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new AppError('storedAttachments must be an array of objects', { code: 'INVALID_TODO_INPUT', statusCode: 400 });
  }
  return parsed.map((item) => {
    const attachment = item as { path?: unknown; name?: unknown; mimeType?: unknown; size?: unknown };
    if (typeof attachment.path !== 'string' || !attachment.path) {
      throw new AppError('storedAttachments entries need a path', { code: 'INVALID_TODO_INPUT', statusCode: 400 });
    }
    return {
      path: attachment.path,
      name: typeof attachment.name === 'string' ? attachment.name : undefined,
      mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : undefined,
      size: typeof attachment.size === 'number' ? attachment.size : undefined,
    };
  });
}

/** Creates the thin project-todo router; multipart parsing stays here and business/FS lives in the service. */
export function createTodosRouter(service = createTodoService()): express.Router {
  const router = express.Router();

  router.get('/:projectId/todos', asyncHandler(async (req, res) => {
    const todos = service.list(readUserId(req), readParam(req.params.projectId));
    res.json({ todos });
  }));

  router.post('/:projectId/todos', asyncHandler(async (req, res) => {
    await receiveTodoUploads(req, res);
    const files = readTodoUploads(req.files);
    try {
      const todo = await service.create(readUserId(req), readParam(req.params.projectId), {
        content: readString(req.body?.content),
        files,
        storedAttachments: readStoredAttachments(req.body?.storedAttachments),
      });
      res.json({ todo });
    } catch (error) {
      await removeTodoUploads(files);
      throw error;
    }
  }));

  router.post('/:projectId/todos/prepare', asyncHandler(async (req, res) => {
    const todoIds = readStringArray(req.body?.todoIds, 'todoIds') ?? [];
    const draft = await service.prepare(readUserId(req), readParam(req.params.projectId), todoIds);
    res.json({ draft });
  }));

  router.put('/:projectId/todos/:todoId', asyncHandler(async (req, res) => {
    await receiveTodoUploads(req, res);
    const files = readTodoUploads(req.files);
    try {
      const todo = await service.update(readUserId(req), readParam(req.params.projectId), readParam(req.params.todoId), {
        content: req.body?.content === undefined ? undefined : readString(req.body.content),
        files,
        keepAttachmentIds: readStringArray(req.body?.keepAttachmentIds, 'keepAttachmentIds'),
        storedAttachments: readStoredAttachments(req.body?.storedAttachments),
      });
      res.json({ todo });
    } catch (error) {
      await removeTodoUploads(files);
      throw error;
    }
  }));

  router.delete('/:projectId/todos/:todoId', asyncHandler(async (req, res) => {
    await service.remove(readUserId(req), readParam(req.params.projectId), readParam(req.params.todoId));
    res.json({ success: true });
  }));

  router.post('/:projectId/todos/:todoId/restore', asyncHandler(async (req, res) => {
    const todo = service.restore(readUserId(req), readParam(req.params.projectId), readParam(req.params.todoId));
    res.json({ todo });
  }));

  router.get('/:projectId/todos/:todoId/attachments/:attachmentId', asyncHandler(async (req, res) => {
    const attachment = service.openAttachment(
      readUserId(req),
      readParam(req.params.projectId),
      readParam(req.params.todoId),
      readParam(req.params.attachmentId),
    );
    if (attachment.status === 'missing') {
      throw new AppError('Todo attachment not found', { code: 'TODO_ATTACHMENT_NOT_FOUND', statusCode: 404 });
    }
    res.setHeader('Content-Type', attachment.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const fallbackName = attachment.name
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\\r\n]/g, '_');
    const encodedName = encodeURIComponent(attachment.name)
      .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    );
    const stream = openTodoAttachmentStream(attachment.path);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading todo attachment' });
      }
    });
    stream.pipe(res);
  }));

  return router;
}

export default createTodosRouter();
