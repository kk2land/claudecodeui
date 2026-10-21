import type { NormalizedMessage } from '@/shared/types';
import { messagesRepresentSamePersistedRow } from '@/modules/chat/utils/sessionMessagePagination';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;
/** Upper bound on identities remembered as handed over to persisted history. */
const MAX_RETIRED_USER_ECHOES = 500;

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  // The echo of an edited message may only be retired by a row that was not
  // in the transcript when the cut was made. Text and a time window are not
  // enough for it: a rewind that branches re-stamps every surviving turn to
  // the moment of the copy, so an earlier turn with the same words — "yes",
  // "continue", the typo being corrected — lands inside the window and would
  // retire the message the user just sent.
  const firstEligibleIndex = localMessage.replacesAfterRowCount ?? 0;

  const dedupeWindow = localFingerprint.text
    ? LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let closestMatch: NormalizedMessage | null = null;
  let closestTimeDifference = Number.POSITIVE_INFINITY;

  for (let index = firstEligibleIndex; index < serverMessages.length; index++) {
    const serverMessage = serverMessages[index];
    if (claimedServerIds.has(serverMessage.id)) {
      continue;
    }
    // A provider-confirmed send ID is stronger evidence than matching text.
    if (serverMessage.clientMessageId && serverMessage.clientMessageId !== localMessage.id) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (
      serverTime === null
      || serverTime < localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      || serverTime - localTime > dedupeWindow
    ) {
      continue;
    }

    const timeDifference = Math.abs(serverTime - localTime);
    if (timeDifference < closestTimeDifference) {
      closestMatch = serverMessage;
      closestTimeDifference = timeDifference;
    }
  }

  return closestMatch;
}

/** Local user identities already handed over to a persisted row, keyed by id or clientMessageId. */
type RetiredUserEchoMap = Map<string, NormalizedMessage>;

function isUserTurn(message: NormalizedMessage): boolean {
  return message.kind === 'text' && message.role === 'user';
}

function userEchoIdentities(message: NormalizedMessage): string[] {
  const identities = [message.id, message.clientMessageId];
  return identities.filter(
    (identity, index): identity is string => Boolean(identity) && identities.indexOf(identity) === index,
  );
}

/** Whether a realtime user row and a persisted row describe the same submission by ID alone. */
function isSameUserTurnIdentity(local: NormalizedMessage, server: NormalizedMessage): boolean {
  if (!isUserTurn(local)) return false;
  if (server.id === local.id) return true;
  if (server.clientMessageId && (server.clientMessageId === local.id || server.clientMessageId === local.clientMessageId)) {
    return true;
  }
  return Boolean(local.clientMessageId && server.id === local.clientMessageId);
}

function rememberRetiredUserEcho(
  retired: RetiredUserEchoMap,
  local: NormalizedMessage,
  server: NormalizedMessage,
): void {
  for (const identity of userEchoIdentities(local)) {
    // Re-insert so the oldest entries are the ones forgotten.
    retired.delete(identity);
    retired.set(identity, server);
  }
  while (retired.size > MAX_RETIRED_USER_ECHOES) {
    const oldest = retired.keys().next();
    if (oldest.done) break;
    retired.delete(oldest.value);
  }
}

/** Whether a late native snapshot or replay is an echo history already owns. */
export function isRetiredUserEchoMessage(
  message: NormalizedMessage,
  retired: RetiredUserEchoMap,
): boolean {
  if (!isUserTurn(message)) {
    return false;
  }
  // A different provider-confirmed send ID is a different submission, even if
  // its native row id happens to repeat an identity this session retired.
  if (message.clientMessageId) {
    return retired.has(message.clientMessageId);
  }
  return retired.has(message.id);
}

/**
 * Reserves the persisted rows named by identities that history has already
 * taken over, so a later identical send cannot claim the turn they own. This
 * exact pass runs before any content fallback.
 */
function reserveExactRetiredUserEchoes(
  serverMessages: NormalizedMessage[],
  retired: RetiredUserEchoMap,
  claimedServerIds: Set<string>,
): Set<string> {
  const unreserved = new Set<string>();
  for (const [identity, retiredRow] of retired) {
    const exact = serverMessages.find((serverMessage) => (
      serverMessage.id === retiredRow.id
      || (retiredRow.clientMessageId && serverMessage.clientMessageId === retiredRow.clientMessageId)
    ));
    if (!exact) {
      unreserved.add(identity);
      continue;
    }

    retired.set(identity, exact);
    claimedServerIds.add(exact.id);
  }
  return unreserved;
}

/**
 * Follows readers that regenerate row IDs, using the persisted-row comparison
 * already used for pagination. Distinct explicit send IDs make two rows
 * different submissions even when their time and text match.
 */
function reserveSimilarRetiredUserEchoes(
  serverMessages: NormalizedMessage[],
  retired: RetiredUserEchoMap,
  unreserved: Set<string>,
  claimedServerIds: Set<string>,
): void {
  for (const identity of unreserved) {
    const retiredRow = retired.get(identity);
    if (!retiredRow) continue;

    const similar = serverMessages.find((serverMessage) => (
      !claimedServerIds.has(serverMessage.id)
      && !(
        retiredRow.clientMessageId
        && serverMessage.clientMessageId
        && retiredRow.clientMessageId !== serverMessage.clientMessageId
      )
      && messagesRepresentSamePersistedRow(retiredRow, serverMessage)
    ));
    if (!similar) continue;

    retired.set(identity, similar);
    claimedServerIds.add(similar.id);
  }
}

/**
 * Removes local optimistic user rows once a corresponding persisted turn is
 * available. Used by the session store; exact IDs take precedence over the
 * one-to-one content fallback for providers that do not preserve send IDs.
 *
 * When the store supplies `retiredUserEchoes`, identities that have been handed
 * over are remembered there and filtered out of `realtimeMessages` even if they
 * arrive after the history refresh removed them.
 */
export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  retiredUserEchoes?: RetiredUserEchoMap,
): NormalizedMessage[] {
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const claimedServerIds = new Set<string>();
  // Inputs already resolved by ID or clientMessageId. The fingerprint pass must
  // not see them as unmatched just because their persisted row is now claimed.
  const resolvedRealtime = new Set<NormalizedMessage>();

  const unreservedRetired = retiredUserEchoes
    ? reserveExactRetiredUserEchoes(serverMessages, retiredUserEchoes, claimedServerIds)
    : new Set<string>();

  // Resolve strong identities for every input before any content fallback runs,
  // so a fingerprint match cannot claim the persisted row another input names.
  for (const message of realtimeMessages) {
    const exactServerId = serverIds.has(message.id) ? message.id : null;
    if (exactServerId !== null) {
      claimedServerIds.add(exactServerId);
      resolvedRealtime.add(message);
      if (retiredUserEchoes && isUserTurn(message)) {
        rememberRetiredUserEcho(retiredUserEchoes, message, serverMessages.find(
          (serverMessage) => serverMessage.id === exactServerId,
        )!);
      }
      continue;
    }

    if (!isUserTurn(message)) continue;
    const identityMatch = serverMessages.find((serverMessage) => (
      !claimedServerIds.has(serverMessage.id)
      && isSameUserTurnIdentity(message, serverMessage)
    ));
    if (!identityMatch) continue;

    claimedServerIds.add(identityMatch.id);
    resolvedRealtime.add(message);
    if (retiredUserEchoes) {
      rememberRetiredUserEcho(retiredUserEchoes, message, identityMatch);
    }
  }

  if (retiredUserEchoes) {
    reserveSimilarRetiredUserEchoes(
      serverMessages,
      retiredUserEchoes,
      unreservedRetired,
      claimedServerIds,
    );
  }

  return realtimeMessages.filter((message) => {
    if (resolvedRealtime.has(message)) {
      return false;
    }
    if (retiredUserEchoes && isRetiredUserEchoMessage(message, retiredUserEchoes)) {
      return false;
    }
    if (serverIds.has(message.id)) {
      return false;
    }
    if (!message.isOptimistic && !message.id.startsWith('local_')) {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    if (retiredUserEchoes) {
      rememberRetiredUserEcho(retiredUserEchoes, message, serverEcho);
    }
    return false;
  });
}
