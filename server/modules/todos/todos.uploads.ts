import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type express from 'express';
import multer from 'multer';

import type { TodoUploadFile } from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

/** Temp folder the todo upload middleware writes into before the service archives a request's files. */
export const TODO_UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'cloudcli-todo-uploads');
fsSync.mkdirSync(TODO_UPLOAD_TEMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: TODO_UPLOAD_TEMP_DIR,
    filename: (_req, file, cb) => cb(
      null,
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`,
    ),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

/** Restores UTF-8 filenames that busboy decoded as latin1; already-valid names stay unchanged. */
function readUploadName(name: string): string {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

/** Maps multer files to the transport-neutral input the todo service accepts. */
export function readTodoUploads(files: unknown): TodoUploadFile[] {
  const uploaded = Array.isArray(files) ? files as Express.Multer.File[] : [];
  return uploaded.map((file) => ({
    tempPath: file.path,
    name: readUploadName(file.originalname),
    mimeType: file.mimetype,
    size: file.size,
  }));
}

/** Removes this request's temp uploads; safe to call after the service archived them. */
export async function removeTodoUploads(files: TodoUploadFile[]): Promise<void> {
  await Promise.all(files.map((file) => fs.rm(file.tempPath, { force: true }).catch(() => undefined)));
}

/** Runs multipart parsing and cleans the request's temp files when multer refuses it. */
export function receiveTodoUploads(request: express.Request, response: express.Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.array('files', 10)(request, response, (error: unknown) => {
      if (!error) {
        resolve();
        return;
      }
      void removeTodoUploads(readTodoUploads(request.files)).finally(() => {
        reject(new AppError(error instanceof Error ? error.message : 'Upload failed', {
          code: 'TODO_UPLOAD_FAILED',
          statusCode: 400,
        }));
      });
    });
  });
}

/** Opens a private todo attachment for the authenticated download route. */
export function openTodoAttachmentStream(filePath: string): fsSync.ReadStream {
  return fsSync.createReadStream(filePath);
}
