import { AppError, MAX_QUEUED_MESSAGES } from '@/shared/index.js';
import type { ChatAttachmentDescriptor, QueuedChatMessage, TodoDraftMeta } from '@/shared/index.js';
import { filterAttachmentsToUploadStore } from '@/modules/websocket/index.js';

type GitConfig = {
  git_name: string | null;
  git_email: string | null;
};

/** One chat scope's unsent composer text and pending FIFO queue. */
type DraftRecord = {
  scope: string;
  text: string;
  /** Head of the queue, mirrored for single-message compatibility. */
  queuedMessage: unknown | null;
  /** The whole pending queue in send order. */
  queuedMessages: unknown[];
  /** Todo sources and their attachments saved beside the draft, or null. */
  meta: TodoDraftMeta | null;
  updatedAt: string;
};

/** A queued turn plus the durable ticket id the idempotent enqueue returned. */
type EnqueuedQueuedMessage = QueuedChatMessage & { id: string };

type UserDependencies = {
  users: {
    getGitConfig(userId: number): GitConfig | undefined;
    updateGitConfig(userId: number, gitName: string | null, gitEmail: string | null): void;
    completeOnboarding(userId: number): void;
    hasCompletedOnboarding(userId: number): boolean;
  };
  preferences: {
    getPreferences(userId: number): Record<string, unknown>;
    savePreferences(userId: number, updates: Record<string, unknown>): void;
  };
  drafts: {
    getDrafts(userId: number): DraftRecord[];
    saveDraft(userId: number, scope: string, draft: {
      text: string;
      queuedMessages: unknown[];
      /** Tickets the browser saw; omitted keeps the legacy whole-queue replacement. */
      knownQueuedMessageIds?: string[];
      /** Omitted keeps the stored meta; null clears it. */
      meta?: TodoDraftMeta | null;
    }): void;
    saveDraftText(userId: number, scope: string, text: string, meta?: TodoDraftMeta | null): void;
    appendQueuedMessage(userId: number, scope: string, message: QueuedChatMessage, ifEmpty?: boolean): { queuedMessage: QueuedChatMessage; appended: boolean } | null;
    enqueueChatMessage(
      userId: number,
      scope: string,
      message: QueuedChatMessage,
      clientMessageId: string,
      options?: { preserveHold?: boolean },
    ): { queuedMessage: EnqueuedQueuedMessage; appended: boolean; alreadySent: boolean };
    clearQueuedMessage(userId: number, scope: string): void;
    deleteDraft(userId: number, scope: string): void;
  };
  readSystemGitConfig(): Promise<GitConfig>;
  applyGlobalGitConfig(gitName: string, gitEmail: string): Promise<void>;
  /**
   * Asks the scheduled-messages dispatcher to try this scope immediately after
   * an enqueue. Injected by the module assembly so the User module never
   * deep-imports the dispatcher implementation.
   */
  onQueueChanged?(scope: string): void;
  logInfo(message: string): void;
  logError(message: string, error: unknown): void;
};

/**
 * The longest a draft scope or preference key may be.
 *
 * Scopes are session UUIDs or `project:<id>`, and preference keys are fixed
 * identifiers, so anything longer is a client bug or an attempt to use the
 * table as general storage.
 */
const MAX_KEY_LENGTH = 200;

/** Guards against a runaway composer filling the database with one row. */
const MAX_DRAFT_TEXT_LENGTH = 100_000;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/**
 * Reads the pending queue from a draft PUT body.
 *
 * `queuedMessages` is the whole FIFO queue and is authoritative whenever it is
 * present, including an empty array that clears the queue. Bodies from older
 * clients only carry `queuedMessage`; that singleton is adopted as a one-entry
 * queue. A queue longer than the shared cap is rejected instead of silently
 * truncated, so the client can keep the message in its composer and tell the
 * user why it was not queued.
 */
const readQueuedMessages = (payload: { queuedMessage?: unknown; queuedMessages?: unknown }): unknown[] => {
  if (payload.queuedMessages !== undefined) {
    if (!Array.isArray(payload.queuedMessages)) {
      throw new AppError('Queued messages must be sent as an array', {
        code: 'INVALID_QUEUED_MESSAGES',
        statusCode: 400,
      });
    }
    if (payload.queuedMessages.length > MAX_QUEUED_MESSAGES) {
      throw new AppError(`At most ${MAX_QUEUED_MESSAGES} messages can be queued for one chat.`, {
        code: 'QUEUE_LIMIT_REACHED',
        statusCode: 409,
      });
    }
    for (const message of payload.queuedMessages) {
      if (!isRecord(message)) {
        throw new AppError('Each queued message must be an object', {
          code: 'INVALID_QUEUED_MESSAGES',
          statusCode: 400,
        });
      }
    }
    return payload.queuedMessages;
  }

  if (payload.queuedMessage == null) {
    return [];
  }
  if (!isRecord(payload.queuedMessage)) {
    throw new AppError('A queued message must be an object', {
      code: 'INVALID_QUEUED_MESSAGES',
      statusCode: 400,
    });
  }
  return [payload.queuedMessage];
};

/**
 * Reads the optional set of queue tickets the browser saw in this snapshot.
 *
 * Omission keeps the legacy whole-queue replacement. When present every id must
 * be a non-empty string; duplicates are collapsed so the repository receives a
 * stable set without doing transport validation.
 */
const readKnownQueuedMessageIds = (value: unknown): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new AppError('knownQueuedMessageIds must be an array of message ids', {
      code: 'INVALID_KNOWN_QUEUED_MESSAGE_IDS',
      statusCode: 400,
    });
  }
  return [...new Set((value as string[]).map((id) => id.trim()))];
};

const readDraftScope = (value: unknown): string => {
  const scope = typeof value === 'string' ? value.trim() : '';
  if (!scope || scope.length > MAX_KEY_LENGTH) {
    throw new AppError('A draft scope of 1-200 characters is required', {
      code: 'INVALID_DRAFT_SCOPE',
      statusCode: 400,
    });
  }
  return scope;
};

/**
 * Reads the client-owned ticket of an automatic enqueue.
 *
 * The ticket is the queue idempotency key, so the client must supply it on
 * every attempt (a retry after a lost response reuses the same one). Only the
 * existing `chat.send` format rule applies: a trimmed, non-empty string.
 */
const readClientMessageId = (value: unknown): string => {
  const clientMessageId = typeof value === 'string' ? value.trim() : '';
  if (!clientMessageId) {
    throw new AppError('A non-empty clientMessageId is required', {
      code: 'INVALID_CLIENT_MESSAGE_ID',
      statusCode: 400,
    });
  }
  return clientMessageId;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/** Reads the message the composer asks to queue; one with nothing to send is refused. */
const readQueuedMessageInput = (value: unknown): QueuedChatMessage => {
  const message = isPlainObject(value) ? value : {};
  const content = typeof message.content === 'string' ? message.content : '';
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!content.trim() && attachments.length === 0) {
    throw new AppError('A queued message needs text or attachments', {
      code: 'INVALID_QUEUED_MESSAGE',
      statusCode: 400,
    });
  }
  return {
    content,
    ...(isPlainObject(message.options) ? { options: readQueuedMessageOptions(message.options) } : {}),
    attachments,
  };
};

/**
 * Keeps the composer's send options, normalizing the todo source ids a queued
 * turn carries so a real send can submit them later. Unknown keys pass through
 * unchanged, as every other option does.
 */
const readQueuedMessageOptions = (options: Record<string, unknown>): Record<string, unknown> => (
  'todoIds' in options ? { ...options, todoIds: readTodoIds(options.todoIds) } : options
);

/** Reads the todo source ids the composer selected; each must be a non-empty string. */
const readTodoIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new AppError('meta.todoIds must be an array of non-empty strings', {
      code: 'INVALID_TODO_IDS',
      statusCode: 400,
    });
  }
  return [...new Set((value as string[]).map((id) => id.trim()))];
};

/**
 * Reads the draft's todo sources (POST /api/todos prepare output).
 *
 * Attachments go through the same upload-store boundary a chat send uses, so a
 * draft can never point a later provider run at an arbitrary file. Omitted
 * keeps the stored value and null clears it; nothing else is accepted.
 */
const readTodoDraftMeta = (value: unknown): TodoDraftMeta | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new AppError('meta must be an object or null', { code: 'INVALID_DRAFT_META', statusCode: 400 });
  }
  const attachments: ChatAttachmentDescriptor[] = filterAttachmentsToUploadStore(value.attachments);
  return { todoIds: readTodoIds(value.todoIds), attachments };
};

const readPreferenceUpdates = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Preferences must be sent as an object', {
      code: 'INVALID_PREFERENCES',
      statusCode: 400,
    });
  }

  const updates = body as Record<string, unknown>;
  for (const key of Object.keys(updates)) {
    if (!key || key.length > MAX_KEY_LENGTH) {
      throw new AppError('Preference keys must be 1-200 characters', {
        code: 'INVALID_PREFERENCE_KEY',
        statusCode: 400,
      });
    }
  }

  return updates;
};

/** Creates user-profile workflows with explicit repository and Git adapters. */
export function createUserService(dependencies: UserDependencies) {
  return {
    async getGitConfig(userId: number) {
      let gitConfig = dependencies.users.getGitConfig(userId);
      if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
        const systemConfig = await dependencies.readSystemGitConfig();
        if (systemConfig.git_name || systemConfig.git_email) {
          dependencies.users.updateGitConfig(
            userId,
            systemConfig.git_name,
            systemConfig.git_email,
          );
          gitConfig = systemConfig;
          dependencies.logInfo(`Auto-populated Git config for user ${userId}`);
        }
      }

      return {
        success: true,
        gitName: gitConfig?.git_name ?? null,
        gitEmail: gitConfig?.git_email ?? null,
      };
    },

    async updateGitConfig(userId: number, gitNameInput: unknown, gitEmailInput: unknown) {
      const gitName = typeof gitNameInput === 'string' ? gitNameInput.trim() : '';
      const gitEmail = typeof gitEmailInput === 'string' ? gitEmailInput.trim() : '';
      if (!gitName || !gitEmail) {
        throw new AppError('Git name and email are required', {
          code: 'GIT_CONFIG_REQUIRED',
          statusCode: 400,
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gitEmail)) {
        throw new AppError('Invalid email format', {
          code: 'INVALID_GIT_EMAIL',
          statusCode: 400,
        });
      }

      dependencies.users.updateGitConfig(userId, gitName, gitEmail);
      try {
        await dependencies.applyGlobalGitConfig(gitName, gitEmail);
      } catch (error) {
        // Persisted user settings remain authoritative even if the host Git
        // installation cannot be updated (matching the previous behavior).
        dependencies.logError('Failed to apply global Git config', error);
      }
      return { success: true, gitName, gitEmail };
    },

    completeOnboarding(userId: number) {
      dependencies.users.completeOnboarding(userId);
      return { success: true, message: 'Onboarding completed successfully' };
    },

    getOnboardingStatus(userId: number) {
      return {
        success: true,
        hasCompletedOnboarding: dependencies.users.hasCompletedOnboarding(userId),
      };
    },

    /** Every stored preference at once; the client fills gaps with its defaults. */
    getPreferences(userId: number) {
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    /**
     * Merge-patch: only the keys in the request body are touched, so two
     * independent settings screens can save concurrently without one erasing
     * the other's work.
     */
    savePreferences(userId: number, body: unknown) {
      const updates = readPreferenceUpdates(body);
      dependencies.preferences.savePreferences(userId, updates);
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    getDrafts(userId: number) {
      return { success: true, drafts: dependencies.drafts.getDrafts(userId) };
    },

    saveDraft(userId: number, scopeInput: unknown, body: unknown) {
      const scope = readDraftScope(scopeInput);
      const payload = (body ?? {}) as {
        text?: unknown;
        queuedMessage?: unknown;
        queuedMessages?: unknown;
        knownQueuedMessageIds?: unknown;
        meta?: unknown;
      };
      const text = typeof payload.text === 'string' ? payload.text : '';
      const meta = readTodoDraftMeta(payload.meta);

      if (text.length > MAX_DRAFT_TEXT_LENGTH) {
        throw new AppError('Draft text is too long to store', {
          code: 'DRAFT_TEXT_TOO_LONG',
          statusCode: 413,
        });
      }

      // The composer's debounced save sends only the text. Its copy of the
      // queued message can be stale (already claimed by the dispatcher, or added
      // to from another tab), so a save without one leaves the stored one alone.
      if (payload.queuedMessages === undefined && payload.queuedMessage === undefined) {
        if (meta === undefined) dependencies.drafts.saveDraftText(userId, scope, text);
        else dependencies.drafts.saveDraftText(userId, scope, text, meta);
        return { success: true };
      }

      const queuedMessages = readQueuedMessages(payload);
      const knownQueuedMessageIds = readKnownQueuedMessageIds(payload.knownQueuedMessageIds);
      dependencies.drafts.saveDraft(userId, scope, {
        text,
        queuedMessages,
        ...(knownQueuedMessageIds ? { knownQueuedMessageIds } : {}),
        ...(meta === undefined ? {} : { meta }),
      });
      // A saved queue may be the first thing waiting on an otherwise idle
      // session (for example a stale busy badge); try it right away.
      if (queuedMessages.length) dependencies.onQueueChanged?.(scope);
      return { success: true };
    },

    /**
     * Queues a message behind the session's running turn. A message already
     * waiting there is kept and this one is added as a separate FIFO turn.
     * Each follow-up retains its own options and attachments; slash commands
     * also stay separate so later text cannot become their arguments. The
     * repository enforces the optional empty-queue precondition atomically.
     */
    appendQueuedMessage(userId: number, scopeInput: unknown, queuedMessageInput: unknown, ifEmpty?: boolean) {
      const scope = readDraftScope(scopeInput);
      const message = readQueuedMessageInput(queuedMessageInput);
      const result = dependencies.drafts.appendQueuedMessage(userId, scope, message, ifEmpty);
      if (!result) {
        throw new AppError(
          'A slash command runs as a turn of its own, so it cannot be combined with the queued message. '
            + 'Send it after the queued message has gone.',
          { code: 'QUEUED_MESSAGE_NOT_COMBINABLE', statusCode: 409 },
        );
      }
      dependencies.onQueueChanged?.(scope);
      return { success: true, queuedMessage: result.queuedMessage, appended: result.appended };
    },

    /**
     * Enqueues an automatically captured turn under a client-owned ticket.
     *
     * The ticket is both the queue id and the idempotency key, so a retry after
     * a lost HTTP response returns the original entry, or `alreadySent` once
     * the dispatcher/steer claimed it, without appending a second turn. A
     * retry of a still-waiting entry does not ask for a new dispatch attempt.
     * The body ticket is authoritative and is normalized into the stored
     * options; an options ticket is overwritten rather than trusted. Unlike the
     * manual append, this path never resumes a queue the user paused.
     */
    enqueueQueuedMessage(
      userId: number,
      scopeInput: unknown,
      clientMessageIdInput: unknown,
      queuedMessageInput: unknown,
    ) {
      const scope = readDraftScope(scopeInput);
      const clientMessageId = readClientMessageId(clientMessageIdInput);
      const queuedMessage = readQueuedMessageInput(queuedMessageInput);
      const message: QueuedChatMessage = {
        ...queuedMessage,
        options: { ...(queuedMessage.options ?? {}), clientMessageId },
      };
      const result = dependencies.drafts.enqueueChatMessage(
        userId,
        scope,
        message,
        clientMessageId,
        { preserveHold: true },
      );
      // Only the attempt that actually inserted the turn triggers dispatch: a
      // replay is already queued (and its first request notified) or claimed.
      if (result.appended) dependencies.onQueueChanged?.(scope);
      return {
        success: true,
        queuedMessage: result.queuedMessage,
        appended: result.appended,
        alreadySent: result.alreadySent,
      };
    },

    clearQueuedMessage(userId: number, scopeInput: unknown) {
      dependencies.drafts.clearQueuedMessage(userId, readDraftScope(scopeInput));
      return { success: true };
    },

    deleteDraft(userId: number, scopeInput: unknown) {
      dependencies.drafts.deleteDraft(userId, readDraftScope(scopeInput));
      return { success: true };
    },
  };
}
