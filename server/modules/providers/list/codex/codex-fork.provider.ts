import { sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexModelProviderService } from '@/modules/providers/list/codex/codex-model-provider.service.js';
import type { IProviderFork } from '@/shared/interfaces.js';
import { AppError } from '@/shared/index.js';
import type { ProviderForkInput, ProviderForkResult } from '@/shared/index.js';

/**
 * Branches a Codex conversation into an independent thread.
 *
 * `thread/fork` writes a real rollout with its own thread id and a
 * `forked_from_id` back-reference, which is what makes the copy resumable
 * rather than an inert duplicate of the file.
 *
 * One difference from the Claude fork worth knowing about: Codex's unit is a
 * turn, not a row. `upToAnchorId` names the turn a user message belongs to and
 * the cut is inclusive of it, so forking from a message keeps that message
 * *and the answer it got*. Claude's `upToMessageId` can stop at the prompt
 * itself. There is no way to express the finer cut here — a turn is written as
 * one thing — and the coarser one is the more useful of the two anyway.
 */
export class CodexForkProvider implements IProviderFork {
  async forkSession(input: ProviderForkInput): Promise<ProviderForkResult> {
    const source = sessionsDb.getSessionByProviderSessionId(input.providerSessionId, 'codex');
    const settings = source ? sessionRuntimeDb.get(source.session_id) : undefined;
    // `title` is deliberately not forwarded. The sidebar name lives in this
    // app's own session row, and naming the thread inside Codex would mean a
    // second call that could fail after the fork already succeeded.
    //
    // An explicit target wins over whatever the source had pending: the user
    // asked for this branch to run somewhere else, and a plain fork still
    // inherits the source's active service/model pair as before.
    const target = input.codexModelSelection;
    if (target) {
      // The native response proves what Codex accepted, not that the route is
      // one the user's config can serve. Confirm the pair against that
      // provider's catalog once, before any thread is created, so an unknown
      // service/model never leaves a fork behind. A plain fork inherits the
      // source's existing selection and is deliberately not re-validated.
      const catalog = await codexModelProviderService.models(target.modelProvider);
      if (!catalog.models.includes(target.model)) {
        throw new AppError(`Model "${target.model}" is not available for "${target.modelProvider}".`, {
          code: 'CODEX_MODEL_NOT_AVAILABLE',
          statusCode: 409,
        });
      }
    }
    const modelSelection = target
      ?? (settings?.runtime === 'app-server' && settings.modelSelection ? settings.modelSelection : undefined);
    const fork = await codexAppServer.forkThread({
      threadId: input.providerSessionId,
      lastTurnId: input.upToAnchorId,
      cwd: input.projectPath,
      ...(modelSelection ? { modelSelection } : {}),
    });

    // The path is the one the server reported and already confirmed on disk,
    // not one derived from the source: a fork lands in today's date directory
    // rather than beside the transcript it was copied from.
    return { providerSessionId: fork.threadId, jsonlPath: fork.path };
  }
}
