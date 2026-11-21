import express from 'express';

import { AppError } from '@/shared/index.js';

import type { createUserService } from './user.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readUserId(request: express.Request): number {
  const rawUserId = (request as AuthenticatedRequest).user?.id;
  return Number(rawUserId);
}

/** Creates thin user routes that parse authenticated input and call the service. */
export function createUserRouter(service: ReturnType<typeof createUserService>): express.Router {
  const router = express.Router();

  router.get('/git-config', async (req, res, next) => {
    try {
      res.json(await service.getGitConfig(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/git-config', async (req, res, next) => {
    try {
      const body = req.body as { gitName?: unknown; gitEmail?: unknown };
      res.json(await service.updateGitConfig(readUserId(req), body.gitName, body.gitEmail));
    } catch (error) {
      next(error);
    }
  });

  router.post('/complete-onboarding', (req, res, next) => {
    try {
      res.json(service.completeOnboarding(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/onboarding-status', (req, res, next) => {
    try {
      res.json(service.getOnboardingStatus(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/preferences', (req, res, next) => {
    try {
      res.json(service.getPreferences(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/preferences', (req, res, next) => {
    try {
      res.json(service.savePreferences(readUserId(req), req.body));
    } catch (error) {
      next(error);
    }
  });

  router.get('/drafts', (req, res, next) => {
    try {
      res.json(service.getDrafts(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // The scope is a session id or `project:<id>`, so it is read from the body
  // rather than the path: neither form is guaranteed to be URL-path-safe.
  router.put('/drafts', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.saveDraft(readUserId(req), body?.scope, req.body));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/drafts', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.deleteDraft(readUserId(req), body?.scope));
    } catch (error) {
      next(error);
    }
  });

  // Append against the stored queue. Automatic steering can require it to be empty.
  router.post('/drafts/queued-message', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown; queuedMessage?: unknown; ifEmpty?: unknown };
      const ifEmpty = body?.ifEmpty;
      if (ifEmpty !== undefined && typeof ifEmpty !== 'boolean') {
        throw new AppError('ifEmpty must be a boolean.', { code: 'INVALID_IF_EMPTY', statusCode: 400 });
      }
      res.json(service.appendQueuedMessage(readUserId(req), body?.scope, body?.queuedMessage, ifEmpty));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/drafts/queued-message', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.clearQueuedMessage(readUserId(req), body?.scope));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
