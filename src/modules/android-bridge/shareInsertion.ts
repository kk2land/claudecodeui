import { getAndroidBridge } from '@/modules/android-bridge/androidBridge';
import { notifyAndroidSharesChanged } from '@/modules/android-bridge/bridgeRuntime';
import type { AndroidShare } from '@/shared/types';

/**
 * A tiny queue between the share inbox and the chat composer. The composer
 * registers a handler for the session it currently owns; an insertion is
 * dispatched only to that handler, so a file share queued before navigation is
 * applied after the target composer mounts. Successful insertion consumes the
 * native share; a failure keeps the share pending and reports why.
 */

type ShareInsertionResult = { ok: true } | { ok: false; error: string };
type ShareInsertionHandler = (share: AndroidShare) => Promise<ShareInsertionResult>;

type QueuedInsertion = {
  share: AndroidShare;
  scope: string;
};

const queue: QueuedInsertion[] = [];
const handlers = new Map<string, ShareInsertionHandler>();
const errorListeners = new Set<(message: string | null) => void>();
let lastError: string | null = null;
let draining = false;

const reportError = (message: string | null): void => {
  lastError = message;
  for (const listener of errorListeners) {
    listener(message);
  }
};

/** The last insertion failure, kept so an inbox mounted after the failure can still show it. */
export function readAndroidShareInsertionError(): string | null {
  return lastError;
}

/** Clears the visible insertion error without touching the queued share. */
export function clearAndroidShareInsertionError(): void {
  if (lastError !== null) {
    reportError(null);
  }
}

/** Subscribes the share inbox to insertion failures. */
export function subscribeAndroidShareInsertionError(
  listener: (message: string | null) => void,
): () => void {
  errorListeners.add(listener);
  listener(lastError);
  return () => {
    errorListeners.delete(listener);
  };
}

/** Queues one share for insertion into the composer that owns `scope`. */
export function enqueueAndroidShareInsertion(share: AndroidShare, scope: string): void {
  if (!queue.some((entry) => entry.share.id === share.id)) {
    queue.push({ share, scope });
  }
  void drainQueue();
}

/** Drops any pending insertion for a share the user discarded. */
export function cancelAndroidShareInsertion(shareId: string): void {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index].share.id === shareId) {
      queue.splice(index, 1);
    }
  }
}

/**
 * Registers the composer for one session and drains anything already queued
 * for it. Returns an unsubscribe used when the composer switches sessions.
 */
export function registerAndroidShareInsertionHandler(
  scope: string,
  handler: ShareInsertionHandler,
): () => void {
  handlers.set(scope, handler);
  void drainQueue();
  return () => {
    if (handlers.get(scope) === handler) {
      handlers.delete(scope);
    }
  };
}

async function drainQueue(): Promise<void> {
  if (draining) {
    return;
  }

  draining = true;
  try {
    while (true) {
      const index = queue.findIndex((entry) => handlers.has(entry.scope));
      if (index === -1) {
        return;
      }

      const [entry] = queue.splice(index, 1);
      const handler = handlers.get(entry.scope);
      if (!handler) {
        continue;
      }

      let result: ShareInsertionResult;
      try {
        result = await handler(entry.share);
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : 'Could not insert the shared item',
        };
      }

      if (!result.ok) {
        // The native share stays pending; the user can retry after freeing
        // composer capacity or dismissing the error.
        reportError(result.error);
        continue;
      }

      try {
        await getAndroidBridge()?.consumeShare(entry.share.id);
      } catch (error) {
        console.warn('[AndroidBridge] Could not consume an inserted share:', error);
      }
      notifyAndroidSharesChanged();
    }
  } finally {
    draining = false;
  }
}
