import { api } from '@/shared/api';
import { MAX_QUEUED_MESSAGES } from '@/shared/constants';
import type { PendingChatSend, QueuedDelivery, QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror restores the draft on the first paint and retains
 * unsaved edits across reloads until the server confirms their persistence.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 */

/** A queued message as it is stored: text plus the send options it was composed under. */
type StoredQueuedMessage = {
  id?: string;
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  /** The pending FIFO queue, oldest first. Empty when nothing is queued. */
  queuedMessages: StoredQueuedMessage[];
  queuedDelivery?: QueuedDelivery;
};

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

const MIRROR_STORAGE_KEY = 'chat-drafts';

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;
/** Bound automatic retry traffic during a prolonged outage. */
const SERVER_WRITE_RETRY_MAX_MS = 30_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessages: [] };

/** Thrown when a write would exceed the per-chat queue cap; the caller keeps the message. */
export class QueueLimitError extends Error {
  constructor() {
    super(`At most ${MAX_QUEUED_MESSAGES} messages can be queued for one chat.`);
    this.name = 'QueueLimitError';
  }
}

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
// Sends awaiting a server receipt, keyed by the client message id the server
// echoes back. An acknowledgement turns one into the queue ticket it created;
// a refusal returns it to the composer instead of losing the prompt.
const pendingChatSends = new Map<string, PendingChatSend>();
// Refused sends are handed back to their own composer on its next draft
// notification, never to whichever session happens to be open.
const rejectedChatSends = new Map<string, PendingChatSend[]>();
const pendingScopes = new Set<string>();
// Browser files for acknowledged queue tickets, kept only for this page's
// lifetime so editing a hydrated card can resend the original attachments.
const queuedMessageFiles = new Map<string, Map<string, File[]>>();
// Queue tickets this page has seen per scope. An explicit queue PUT names the
// tickets its snapshot knew so the backend preserves later server entries.
const knownQueuedTickets = new Map<string, Set<string>>();
// Debounced text edits remain local until their own save completes.
const pendingTextScopes = new Set<string>();
// Only explicit queue mutations may send a queue snapshot to the server.
const pendingQueueScopes = new Set<string>();
// Hydration must not replace queue changes newer than the snapshot it requested.
const queueRevisions = new Map<string, number>();
// Composer edits and completed text saves invalidate older hydration snapshots.
const textRevisions = new Map<string, number>();
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;
// A transient failure retries even when the user has stopped typing.
let serverRetryTimer: ReturnType<typeof setTimeout> | null = null;
// Consecutive failures back off; a fully saved batch or sign-out resets the delay.
let serverRetryDelayMs = SERVER_WRITE_DEBOUNCE_MS;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessages.length === 0
);

const readQueuedMessageId = (message: StoredQueuedMessage): string | null => (
  typeof message.id === 'string' && message.id ? message.id : null
);

const readQueuedTicketIds = (messages: StoredQueuedMessage[] | undefined): string[] => (
  (messages ?? [])
    .map(readQueuedMessageId)
    .filter((id): id is string => id !== null)
);

/** Captures the union of tickets already seen and the snapshot's own tickets. */
function captureKnownQueuedTickets(scope: string, messages: StoredQueuedMessage[] | undefined): string[] {
  const ids = [...(knownQueuedTickets.get(scope) ?? [])];
  for (const id of readQueuedTicketIds(messages)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Drops tickets this snapshot successfully deleted, but leaves dirty newer
 * edits their own chance to settle. Current queue tickets always stay known.
 */
function settleKnownQueuedTickets(scope: string, savedTicketIds: string[]): void {
  const known = knownQueuedTickets.get(scope) ?? new Set<string>();
  const currentIds = new Set(readQueuedTicketIds(readQueuedMessages(scope)));
  for (const id of currentIds) known.add(id);
  const hasNewerQueueWrite = pendingQueueScopes.has(scope)
    || (writingQueueScopes.get(scope) ?? 0) > 1;
  if (!hasNewerQueueWrite) {
    for (const id of savedTicketIds) {
      if (!currentIds.has(id)) known.delete(id);
    }
  }
  if (known.size > 0) knownQueuedTickets.set(scope, known);
  else knownQueuedTickets.delete(scope);
}

function forgetQueuedMessageFiles(scope: string, ticketIds: string[]): void {
  const files = queuedMessageFiles.get(scope);
  if (!files || ticketIds.length === 0) return;
  for (const id of ticketIds) files.delete(id);
  if (files.size === 0) queuedMessageFiles.delete(scope);
}

/** The browser files retained for one acknowledged queue ticket on this page. */
export function readQueuedMessageFiles(scope: string, ticketId: string): File[] {
  return queuedMessageFiles.get(scope)?.get(ticketId) ?? [];
}

/**
 * Turns one stored entry into a usable queued message, or null when it has
 * nothing to send. Mirror and server payloads are untyped at runtime, and
 * older attachment-only queues can omit `content`, which must never reach the
 * composer as undefined.
 */
const normalizeQueuedMessage = (value: unknown): StoredQueuedMessage | null => {
  if (!isRecord(value)) {
    return null;
  }
  const queued = value as StoredQueuedMessage;
  const attachments = Array.isArray(queued.attachments)
    ? queued.attachments
    : Array.isArray(queued.images)
      ? queued.images
      : [];
  const content = typeof queued.content === 'string' ? queued.content : '';
  return content.trim() || attachments.length > 0
    ? { ...queued, content, attachments }
    : null;
};

/**
 * Reads a stored queue from any shape this app has ever persisted: the current
 * array, or the legacy single object under `queuedMessage`. The cap is applied
 * on read so a hand-edited mirror can never render more cards than the server
 * would accept.
 */
const normalizeQueuedMessages = (value: unknown): StoredQueuedMessage[] => {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw
    .map(normalizeQueuedMessage)
    .filter((message): message is StoredQueuedMessage => message !== null)
    .slice(0, MAX_QUEUED_MESSAGES);
};

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        // A mirror written before the queue existed holds the legacy singleton.
        queuedMessages: normalizeQueuedMessages(value.queuedMessages ?? value.queuedMessage),
      });
      // Persist intent as well as content: distinguish an unsaved edit from
      // a cached queue the server may already have dispatched after a reload.
      if (value.unsavedText === true) pendingTextScopes.add(scope);
      if (value.unsavedQueue === true) pendingQueueScopes.add(scope);
      if (Array.isArray(value.knownQueuedMessageIds)) {
        const known = value.knownQueuedMessageIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (known.length > 0) knownQueuedTickets.set(scope, new Set(known));
      }
      if (value.unsavedText === true || value.unsavedQueue === true) pendingScopes.add(scope);
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    const scopes = new Set([
      ...drafts.keys(), ...pendingScopes, ...pendingTextScopes, ...pendingQueueScopes, ...writingScopes.keys(),
    ]);
    const mirror = new Map<string, DraftRecord & {
      unsavedText?: boolean;
      unsavedQueue?: boolean;
      knownQueuedMessageIds?: string[];
    }>();
    for (const scope of scopes) {
      const draft = drafts.get(scope) ?? EMPTY_DRAFT;
      const unsavedText = pendingTextScopes.has(scope) || writingTextScopes.has(scope);
      const unsavedQueue = pendingQueueScopes.has(scope) || writingQueueScopes.has(scope);
      const known = unsavedQueue ? [...(knownQueuedTickets.get(scope) ?? [])] : [];
      // An empty record carries an unsaved cancellation across reloads.
      if (isEmptyDraft(draft) && !unsavedText && !unsavedQueue) continue;
      mirror.set(scope, {
        ...draft,
        ...(unsavedText ? { unsavedText: true } : {}),
        ...(unsavedQueue ? { unsavedQueue: true } : {}),
        ...(known.length > 0 ? { knownQueuedMessageIds: known } : {}),
      });
    }
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(mirror)));
  } catch {
    // Storage failures must not prevent in-memory edits or their server saves.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

// Serial writes prevent an old draft PUT arriving after the queue has been consumed.
let writeChain: Promise<void> = Promise.resolve();
// Logout invalidates asynchronous work before another account's credentials can be used.
let draftGeneration = 0;
// Counts only writes belonging to the current signed-in account.
const writingScopes = new Map<string, number>();
// Concurrent saves protect unsent text independently from the server's queue.
const writingTextScopes = new Map<string, number>();
// Queue edits stay protected until every outstanding snapshot has settled.
const writingQueueScopes = new Map<string, number>();
function flushServerWrites(): Promise<void> {
  if (serverWriteTimer !== null) clearTimeout(serverWriteTimer);
  serverWriteTimer = null;
  if (serverRetryTimer !== null) clearTimeout(serverRetryTimer);
  serverRetryTimer = null;
  const generation = draftGeneration;
  const entries = [...pendingScopes].map((scope) => {
    const draft = drafts.get(scope);
    const queueChanged = pendingQueueScopes.has(scope);
    return {
      scope,
      draft,
      textChanged: pendingTextScopes.has(scope),
      queueChanged,
      knownQueuedMessageIds: queueChanged ? captureKnownQueuedTickets(scope, draft?.queuedMessages) : undefined,
    };
  });
  pendingScopes.clear();
  pendingTextScopes.clear();
  pendingQueueScopes.clear();
  for (const { scope, textChanged, queueChanged } of entries) {
    writingScopes.set(scope, (writingScopes.get(scope) ?? 0) + 1);
    if (textChanged) writingTextScopes.set(scope, (writingTextScopes.get(scope) ?? 0) + 1);
    if (queueChanged) writingQueueScopes.set(scope, (writingQueueScopes.get(scope) ?? 0) + 1);
  }
  const result = writeChain.catch(() => {}).then(async () => {
    let failure: unknown;
    let retryableFailure = false;
    for (const { scope, draft, textChanged, queueChanged, knownQueuedMessageIds } of entries) {
      if (generation !== draftGeneration) throw new Error('Draft save cancelled after sign-out.');
      let response: Response | undefined;
      try {
        // An empty text-only save must also leave another tab's queue alone.
        response = await api.user.saveDraft(scope, {
          text: draft?.text ?? '',
          ...(queueChanged ? {
            queuedMessages: draft?.queuedMessages ?? [],
            knownQueuedMessageIds: knownQueuedMessageIds ?? [],
          } : {}),
        });
        if (response && !response.ok) throw new Error(`Draft save failed (${response.status})`);
        if (generation === draftGeneration) {
          // A hydrate may have read before this write but answer after it.
          if (queueChanged) {
            queueRevisions.set(scope, (queueRevisions.get(scope) ?? 0) + 1);
            settleKnownQueuedTickets(scope, knownQueuedMessageIds ?? []);
          }
          if (textChanged) textRevisions.set(scope, (textRevisions.get(scope) ?? 0) + 1);
        }
      } catch (error) {
        failure ??= error;
        if (generation === draftGeneration) {
          // Restore dirty markers, never the failed snapshot: a newer edit or
          // cancellation may have replaced it while this request was running.
          // Later serialized writes supersede this failure and own recovery if
          // they fail too, so they must not be replayed after they succeed.
          if (textChanged && (writingTextScopes.get(scope) ?? 0) === 1) pendingTextScopes.add(scope);
          if (queueChanged && (writingQueueScopes.get(scope) ?? 0) === 1) pendingQueueScopes.add(scope);
          if (pendingTextScopes.has(scope) || pendingQueueScopes.has(scope)) pendingScopes.add(scope);
          // Only transient errors schedule retries; validation and conflict
          // responses remain pending for a later edit or explicit save.
          retryableFailure ||= !response || response.status === 408 || response.status === 429 || response.status >= 500;
        }
      } finally {
        if (generation === draftGeneration) {
          const remaining = (writingScopes.get(scope) ?? 1) - 1;
          if (remaining) writingScopes.set(scope, remaining);
          else writingScopes.delete(scope);
          for (const [changed, scopes] of [[textChanged, writingTextScopes], [queueChanged, writingQueueScopes]] as const) {
            if (!changed) continue;
            const remainingWrites = (scopes.get(scope) ?? 1) - 1;
            if (remainingWrites) scopes.set(scope, remainingWrites);
            else scopes.delete(scope);
          }
          writeMirror();
        }
      }
    }
    if (generation !== draftGeneration) throw new Error('Draft save cancelled after sign-out.');
    if (failure) {
      if (retryableFailure && pendingScopes.size > 0) scheduleServerRetry();
      throw failure;
    }
    if (pendingScopes.size === 0 && writingScopes.size === 0) serverRetryDelayMs = SERVER_WRITE_DEBOUNCE_MS;
  });
  writeChain = result;
  void result.catch((error) => { if (generation === draftGeneration) console.error('Failed to save chat draft:', error); });
  return result;
}

/** Coalesces retries across scopes while flush reads their latest local state. */
function scheduleServerRetry(): void {
  if (serverRetryTimer !== null) return;
  serverRetryTimer = setTimeout(() => {
    serverRetryTimer = null;
    void flushServerWrites();
  }, serverRetryDelayMs);
  serverRetryDelayMs = Math.min(serverRetryDelayMs * 2, SERVER_WRITE_RETRY_MAX_MS);
}

/** Chat's steer control awaits persistence before referring to a queued message id. */
export async function persistQueuedMessage(scope: string): Promise<void> {
  pendingScopes.add(scope);
  pendingQueueScopes.add(scope);
  await flushServerWrites();
}

/** Remembers one chat.send until its queue receipt, native echo, refusal or reset clears it. */
export function rememberPendingChatSend(send: PendingChatSend): void {
  pendingChatSends.set(send.clientMessageId, send);
}

/** Drops receipt tracking for a send that no longer needs recovery. */
export function forgetPendingChatSend(clientMessageId: string): void {
  pendingChatSends.delete(clientMessageId);
}

/**
 * Adopts a server-accepted queue entry from a `chat_queued` receipt.
 *
 * The server's `messageId` becomes the durable ticket, while the original
 * send's content/options fill anything the receipt omits. This write is local
 * only: the backend already persisted the entry, and a whole-queue snapshot
 * from this composer could be stale. `hydrateChatDrafts` remains the authority
 * for the rest of the queue and its delivery receipt.
 */
export function adoptQueuedChatMessage(args: {
  scope: string;
  clientMessageId: string;
  messageId: string;
  queuedMessage: {
    content?: unknown;
    options?: unknown;
    attachments?: unknown[];
  };
}): void {
  const pending = pendingChatSends.get(args.clientMessageId);
  forgetPendingChatSend(args.clientMessageId);
  const receiptOptions = isRecord(args.queuedMessage.options)
    ? args.queuedMessage.options as QueuedSendOptions
    : undefined;
  const normalized = normalizeQueuedMessage({
    id: args.messageId,
    content: typeof args.queuedMessage.content === 'string'
      ? args.queuedMessage.content
      : pending?.content ?? '',
    options: {
      ...(pending?.options ?? {}),
      ...(receiptOptions ?? {}),
      clientMessageId: args.clientMessageId,
    },
    attachments: Array.isArray(args.queuedMessage.attachments)
      ? args.queuedMessage.attachments
      : pending?.attachments ?? [],
  });
  if (!normalized) {
    return;
  }
  if (pending && pending.files.length > 0) {
    const files = queuedMessageFiles.get(args.scope) ?? new Map<string, File[]>();
    files.set(args.messageId, pending.files);
    queuedMessageFiles.set(args.scope, files);
  }
  const queue = readQueuedMessages(args.scope);
  const index = queue.findIndex((entry) => entry.id === args.messageId);
  const next = index >= 0
    ? queue.map((entry, position) => (position === index ? normalized : entry))
    : [...queue, normalized];
  updateDraft(args.scope, { queuedMessages: next.slice(-MAX_QUEUED_MESSAGES) }, false);
}

/**
 * Keeps a refused send for its own composer. Returns the entry so the caller
 * can report the failure without triggering an automatic resend.
 */
export function rejectPendingChatSend(clientMessageId: string): PendingChatSend | null {
  const pending = pendingChatSends.get(clientMessageId);
  if (!pending) {
    return null;
  }
  forgetPendingChatSend(clientMessageId);
  const rejected = rejectedChatSends.get(pending.sessionId) ?? [];
  rejectedChatSends.set(pending.sessionId, [...rejected, pending]);
  notifyListeners();
  return pending;
}

/** Takes the refusals belonging to one scope so only that composer restores them. */
export function takeRejectedChatSends(scope: string): PendingChatSend[] {
  const rejected = rejectedChatSends.get(scope) ?? [];
  rejectedChatSends.delete(scope);
  return rejected;
}

/**
 * Removes the queued card a started turn now owns. Matching uses the server's
 * queue ticket and the original client id because a dispatched echo may carry
 * either identity. Returns true when the card was present.
 */
export function removeStartedQueuedMessage(
  scope: string,
  identity: { id?: string; clientMessageId?: string },
): boolean {
  const queue = readQueuedMessages(scope);
  const next = queue.filter((entry) => (
    entry.id !== identity.id
    && !(identity.clientMessageId && entry.options?.clientMessageId === identity.clientMessageId)
  ));
  if (next.length === queue.length) {
    return false;
  }
  const removedIds = queue.filter((entry) => !next.includes(entry)).map(readQueuedMessageId).filter((id): id is string => id !== null);
  forgetQueuedMessageFiles(scope, removedIds);
  // The server removed the entry when it dispatched the turn; a local snapshot
  // write here would race that acknowledgement.
  updateDraft(scope, { queuedMessages: next }, false);
  for (const id of removedIds) knownQueuedTickets.get(scope)?.delete(id);
  return true;
}

/** Chat's queue card reads the server-owned delivery state after hydrate/reconnect. */
export function readQueuedDelivery(scope: string): QueuedDelivery | null {
  return drafts.get(scope)?.queuedDelivery ?? null;
}

function queueServerWrite(scope: string): void {
  pendingScopes.add(scope);

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

function flushServerWritesNow(): void {
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  flushServerWrites();
}

/**
 * Applies a local draft change. A queue change normally schedules its server
 * snapshot; server-owned acknowledgements pass `persistQueue: false` because
 * the backend already stored them and a composer snapshot must not overwrite
 * the authoritative queue.
 */
function updateDraft(scope: string, update: Partial<DraftRecord>, persistQueue = true): void {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };

  if (next.text === current.text && next.queuedMessages === current.queuedMessages) {
    return;
  }

  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;

  if (update.text !== undefined) {
    pendingTextScopes.add(scope);
    textRevisions.set(scope, (textRevisions.get(scope) ?? 0) + 1);
  }
  if (update.queuedMessages !== undefined) {
    const known = knownQueuedTickets.get(scope) ?? new Set<string>();
    for (const id of [...readQueuedTicketIds(current.queuedMessages), ...readQueuedTicketIds(next.queuedMessages)]) {
      known.add(id);
    }
    if (known.size > 0) knownQueuedTickets.set(scope, known);
    if (persistQueue) pendingQueueScopes.add(scope);
    queueRevisions.set(scope, (queueRevisions.get(scope) ?? 0) + 1);
  }
  writeMirror();
  if (persistQueue) queueServerWrite(scope);
  notifyListeners();
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  updateDraft(scope, { text });
}

/**
 * The whole pending queue for a scope, oldest first.
 *
 * Entries are normalized on every read so payloads stored by older clients
 * (legacy `images`, missing `content`) are safe to render and send.
 */
export function readQueuedMessages(scope: string): StoredQueuedMessage[] {
  return (drafts.get(scope)?.queuedMessages ?? [])
    .map(normalizeQueuedMessage)
    .filter((message): message is StoredQueuedMessage => message !== null);
}

/** Head-of-queue compatibility helper for single-message callers. */
export function readQueuedMessage(scope: string): StoredQueuedMessage | null {
  return readQueuedMessages(scope)[0] ?? null;
}

/**
 * Appends a queued message, or updates an entry that already has the same
 * ticket. Throws {@link QueueLimitError} when the queue is full so the caller
 * can keep the user's text and attachments in the composer.
 */
export function writeQueuedMessage(scope: string, message: StoredQueuedMessage): void {
  const queue = readQueuedMessages(scope);
  const index = message.id ? queue.findIndex((entry) => entry.id === message.id) : -1;
  if (index >= 0) {
    const next = [...queue];
    next[index] = message;
    updateDraft(scope, { queuedMessages: next });
  } else {
    if (queue.length >= MAX_QUEUED_MESSAGES) {
      throw new QueueLimitError();
    }
    updateDraft(scope, { queuedMessages: [...queue, message] });
  }
  // Queueing is a send-like action, so persist it before the tab can close.
  flushServerWritesNow();
}

/**
 * Replaces the whole pending queue, used by the composer to reconcile its
 * rendered list (edits and deletions included) with the durable store. The tail
 * is never inferred: the caller passes every entry it still wants queued.
 */
export function writeQueuedMessages(scope: string, messages: StoredQueuedMessage[]): void {
  if (messages.length > MAX_QUEUED_MESSAGES) {
    throw new QueueLimitError();
  }
  const current = readQueuedMessages(scope);
  if (JSON.stringify(current) === JSON.stringify(messages)) {
    return;
  }
  const nextIds = new Set(readQueuedTicketIds(messages));
  forgetQueuedMessageFiles(scope, readQueuedTicketIds(current).filter((id) => !nextIds.has(id)));
  updateDraft(scope, { queuedMessages: messages });
  flushServerWritesNow();
}

/**
 * Removes one queued entry. Without an id the head is removed, matching the
 * single-slot helper this replaces; with an id only that entry is removed, so
 * editing or deleting a later card cannot dispatch an earlier one.
 */
export function clearQueuedMessage(scope: string, messageId?: string): void {
  const queue = readQueuedMessages(scope);
  if (queue.length === 0) {
    return;
  }
  const next = messageId
    ? queue.filter((entry) => entry.id !== messageId)
    : queue.slice(1);
  if (next.length === queue.length) {
    return;
  }
  const nextIds = new Set(readQueuedTicketIds(next));
  forgetQueuedMessageFiles(scope, readQueuedTicketIds(queue).filter((id) => !nextIds.has(id)));
  updateDraft(scope, { queuedMessages: next });
  // Editing or cancelling must beat the server's next dispatcher poll.
  flushServerWritesNow();
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * A scope the client has typed into since this page loaded is left alone: the
 * user is looking at that composer right now, and replacing its contents with a
 * staler server copy would delete what they are in the middle of writing.
 */
export async function hydrateChatDrafts(): Promise<void> {
  const generation = draftGeneration;
  const queueRevisionsAtRequest = new Map(queueRevisions);
  const textRevisionsAtRequest = new Map(textRevisions);
  let serverDrafts: Array<{
    scope?: unknown;
    text?: unknown;
    queuedMessage?: unknown;
    queuedMessages?: unknown;
    queuedDelivery?: QueuedDelivery;
  }> = [];

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    console.error('Failed to load chat drafts:', error);
    return;
  }

  if (generation !== draftGeneration) return;
  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (!scope) {
      continue;
    }

    merged.set(scope, {
      queuedDelivery: draft.queuedDelivery,
      text: typeof draft.text === 'string' ? draft.text : '',
      // `queuedMessages` is authoritative when present; the head field is the
      // fallback for a server that has not been upgraded yet.
      queuedMessages: normalizeQueuedMessages(draft.queuedMessages ?? draft.queuedMessage),
    });
  }

  // Preserve only fields edited locally. Typing must not resurrect a turn the
  // server dispatched, and an in-flight hydrate must not undo a queue edit.
  const queueChangedDuringRequest = (scope: string) => (
    (queueRevisions.get(scope) ?? 0) !== (queueRevisionsAtRequest.get(scope) ?? 0)
  );
  const textChangedDuringRequest = (scope: string) => (
    (textRevisions.get(scope) ?? 0) !== (textRevisionsAtRequest.get(scope) ?? 0)
  );
  const localScopes = new Set([
    ...pendingScopes,
    ...writingScopes.keys(),
    ...[...queueRevisions.keys()].filter(queueChangedDuringRequest),
    ...[...textRevisions.keys()].filter(textChangedDuringRequest),
  ]);
  for (const scope of localScopes) {
    const local = drafts.get(scope) ?? EMPTY_DRAFT;
    const server = merged.get(scope) ?? EMPTY_DRAFT;
    const next: DraftRecord = {
      text: pendingTextScopes.has(scope) || writingTextScopes.has(scope) || textChangedDuringRequest(scope)
        ? local.text : server.text,
      queuedMessages: pendingQueueScopes.has(scope) || writingQueueScopes.has(scope) || queueChangedDuringRequest(scope)
        ? local.queuedMessages : server.queuedMessages,
      queuedDelivery: server.queuedDelivery,
    };
    if (isEmptyDraft(next)) merged.delete(scope);
    else merged.set(scope, next);
  }

  drafts = merged;
  const retainedScopes = new Set([...merged.keys(), ...localScopes]);
  for (const scope of retainedScopes) {
    const queuePreserved = pendingQueueScopes.has(scope)
      || writingQueueScopes.has(scope)
      || queueChangedDuringRequest(scope);
    const tickets = readQueuedTicketIds(merged.get(scope)?.queuedMessages);
    if (queuePreserved) {
      const known = knownQueuedTickets.get(scope) ?? new Set<string>();
      for (const id of tickets) known.add(id);
      if (known.size > 0) knownQueuedTickets.set(scope, known);
      else knownQueuedTickets.delete(scope);
    } else if (tickets.length > 0) {
      knownQueuedTickets.set(scope, new Set(tickets));
    } else {
      knownQueuedTickets.delete(scope);
    }
  }
  for (const scope of [...knownQueuedTickets.keys()]) {
    if (!retainedScopes.has(scope)) knownQueuedTickets.delete(scope);
  }
  for (const [scope, files] of queuedMessageFiles) {
    const tickets = new Set(readQueuedTicketIds(merged.get(scope)?.queuedMessages));
    for (const id of [...files.keys()]) {
      if (!tickets.has(id)) files.delete(id);
    }
    if (files.size === 0) queuedMessageFiles.delete(scope);
  }
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  draftGeneration++;
  writeChain = Promise.resolve();
  writingScopes.clear();
  writingTextScopes.clear();
  writingQueueScopes.clear();
  drafts = new Map();
  queuedMessageFiles.clear();
  knownQueuedTickets.clear();
  pendingChatSends.clear();
  rejectedChatSends.clear();
  pendingScopes.clear();
  pendingTextScopes.clear();
  pendingQueueScopes.clear();
  queueRevisions.clear();
  textRevisions.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  if (serverRetryTimer !== null) {
    clearTimeout(serverRetryTimer);
    serverRetryTimer = null;
  }
  serverRetryDelayMs = SERVER_WRITE_DEBOUNCE_MS;
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
  if (pendingScopes.size > 0) scheduleServerRetry();
}
