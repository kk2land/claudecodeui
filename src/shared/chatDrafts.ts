import { api } from '@/shared/api';
import { MAX_QUEUED_MESSAGES } from '@/shared/constants';
import type { QueuedDelivery, QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
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
const pendingScopes = new Set<string>();
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessages.length === 0
);

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
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
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
function flushServerWrites(): Promise<void> {
  serverWriteTimer = null;
  const generation = draftGeneration;
  const entries = [...pendingScopes].map((scope) => [scope, drafts.get(scope)] as const);
  pendingScopes.clear();
  for (const [scope] of entries) writingScopes.set(scope, (writingScopes.get(scope) ?? 0) + 1);
  const result = writeChain.catch(() => {}).then(async () => {
    let failure: unknown;
    for (const [scope, draft] of entries) {
      if (generation !== draftGeneration) throw new Error('Draft save cancelled after sign-out.');
      try {
        const response = !draft || isEmptyDraft(draft)
          ? await api.user.deleteDraft(scope)
          : await api.user.saveDraft(scope, { text: draft.text, queuedMessages: draft.queuedMessages });
        if (response && !response.ok) throw new Error(`Draft save failed (${response.status})`);
      } catch (error) { failure ??= error; }
      finally {
        if (generation === draftGeneration) {
          const remaining = (writingScopes.get(scope) ?? 1) - 1;
          if (remaining) writingScopes.set(scope, remaining);
          else writingScopes.delete(scope);
        }
      }
    }
    if (generation !== draftGeneration) throw new Error('Draft save cancelled after sign-out.');
    if (failure) throw failure;
  });
  writeChain = result;
  void result.catch((error) => { if (generation === draftGeneration) console.error('Failed to save chat draft:', error); });
  return result;
}

/** Chat's steer control awaits persistence before referring to a queued message id. */
export async function persistQueuedMessage(scope: string): Promise<void> {
  pendingScopes.add(scope);
  await flushServerWrites();
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

function updateDraft(scope: string, update: Partial<DraftRecord>): void {
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

  writeMirror();
  queueServerWrite(scope);
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
    if (!scope || (pendingScopes.has(scope) || writingScopes.has(scope))) {
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

  // Local edits whose debounced write has not left the browser yet win over
  // the server snapshot. Every other missing scope was deleted remotely and
  // must also disappear from the mirror.
  for (const scope of new Set([...pendingScopes, ...writingScopes.keys()])) {
    const pending = drafts.get(scope);
    if (pending) {
      merged.set(scope, pending);
    }
  }

  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  draftGeneration++;
  writeChain = Promise.resolve();
  writingScopes.clear();
  drafts = new Map();
  pendingScopes.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
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
}
