import express from 'express';

import type { WorkerCancelFenceInput, WorkerHostService } from '@/shared/index.js';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Host-owned Worker control endpoint mounted before the generic plugin RPC
 * proxy. It locally fences automatic delivery synchronously, then delegates the
 * unchanged request to the plugin's own cancel implementation.
 */
export function createWorkerControlRouter(host: Pick<WorkerHostService, 'fenceCancel'>): express.Router {
  const router = express.Router();

  router.post('/cancel', (req, _res, next) => {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const input: WorkerCancelFenceInput = {
      all: body.all === true,
      ...(text(body.parentSessionId) ? { parentSessionId: text(body.parentSessionId) } : {}),
      ...(text(body.projectId) ? { projectId: text(body.projectId) } : {}),
      ...(typeof body.pause === 'boolean' ? { pause: body.pause } : {}),
    };
    host.fenceCancel(input);
    // The generic `/api/plugins/:name/rpc/*` proxy continues the same
    // request, so the plugin still performs the real worker cleanup.
    next();
  });

  return router;
}
