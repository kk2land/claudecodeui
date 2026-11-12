import { randomUUID } from 'node:crypto';

import { residentBindingsDb, stageLogsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';
import { STAGE_LOG_DEFAULT_LIMIT, STAGE_LOG_MAX_LIMIT } from '@/shared/index.js';
import type {
  StageLogEntry,
  StageLogInput,
  StageLogPage,
  StageLogQuery,
  StageLogRecorded,
} from '@/shared/index.js';

/** Stage logs are kept for seven days from their server-issued creation time. */
const RETENTION_MS = 7 * 86_400_000;
/** Prune interval for expired rows; unref'd so it never holds the process open. */
const PRUNE_INTERVAL_MS = 3_600_000;
/** ISO-8601 calendar timestamp; `new Date('1')`-style leniency is not accepted. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Opaque keyset cursor: created-at plus id, encoded so callers never parse it. */
function encodeCursor(entry: StageLogEntry): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown[];
    if (typeof createdAt === 'string' && typeof id === 'string') return { createdAt, id };
  } catch {
    // Falls through to the single typed refusal below.
  }
  throw new AppError('Invalid log cursor.', { code: 'invalid_request', statusCode: 400 });
}

/**
 * ISO-8601 normalization of an agent-reported event time. Only an omitted value defaults to the
 * host's now; a supplied invalid value is rejected once here rather than silently replaced.
 */
function normalizeOccurredAt(value: string | undefined, serverNow: string): string {
  if (value === undefined) return serverNow;
  if (!ISO_8601.test(value)) {
    throw new AppError('occurredAt must be an ISO-8601 timestamp.', {
      code: 'invalid_request',
      statusCode: 400,
    });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('occurredAt must be an ISO-8601 timestamp.', {
      code: 'invalid_request',
      statusCode: 400,
    });
  }
  return parsed.toISOString();
}

type StageLogServiceDependencies = {
  /** Server-issued time; injected so retention/paging tests can move it. */
  now?: () => number;
};

/**
 * The host's only writer and reader for stage logs.
 *
 * Identity is derived server-side from the session's binding: a caller never supplies a task,
 * session, execution id or source. `createdAt` is always host-issued (retention and paging), and
 * `occurredAt` is the reported event time. No queue, outbox or provider lifecycle change lives
 * here; terminal runs and alerts are untouched.
 */
export function createStageLogService(dependencies: StageLogServiceDependencies = {}) {
  const now = dependencies.now ?? (() => Date.now());
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  function buildEntry(input: {
    sessionId: string;
    source: StageLogEntry['source'];
    content: string;
    status: string;
    occurredAt?: string;
    phase?: string;
    data?: Record<string, unknown>;
  }): StageLogEntry | null {
    const binding = residentBindingsDb.getBySessionId(input.sessionId);
    if (!binding) return null;
    // One server clock reading feeds both timestamps: an omitted occurredAt equals createdAt.
    const timestamp = new Date(now()).toISOString();
    return {
        id: randomUUID(),
        taskId: binding.taskId,
        sessionId: binding.sessionId,
        executionId: binding.executionId,
        source: input.source,
        occurredAt: normalizeOccurredAt(input.occurredAt, timestamp),
        createdAt: timestamp,
        content: input.content,
        status: input.status,
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.data ? { data: input.data } : {}),
    };
  }

  function write(entry: StageLogEntry): StageLogEntry {
    return stageLogsDb.insert(entry);
  }

  /** Retention cutoff: reads and pruning both exclude anything created before this instant. */
  function keepFrom(): string {
    return new Date(now() - RETENTION_MS).toISOString();
  }

  return {
    /** Records one agent report; `not_resident` writes nothing and never retries. */
    recordAgent(sessionId: string, input: StageLogInput): StageLogRecorded {
      const entry = buildEntry({ ...input, sessionId, source: 'agent' });
      if (!entry) return { recorded: false, reason: 'not_resident' };
      return { recorded: true, log: write(entry) };
    },

    /**
     * Records one host lifecycle entry for a bound session. Unbound sessions and duplicate state
     * reads are the caller's concern: this only writes real transitions it is told about.
     */
    recordSystem(input: {
      sessionId: string;
      content: string;
      status: string;
      phase?: string;
    }): StageLogEntry | null {
      const entry = buildEntry({ ...input, source: 'system' });
      return entry ? write(entry) : null;
    },

    /** Newest-first page (`createdAt DESC, id DESC`) that never returns expired rows. */
    list(query: StageLogQuery): StageLogPage {
      if (!residentBindingsDb.getByTaskId(query.taskId)) {
        throw new AppError('Unknown resident task.', { code: 'not_found', statusCode: 404 });
      }
      const limit = Math.min(
        STAGE_LOG_MAX_LIMIT,
        Math.max(1, Number.isInteger(query.limit) ? query.limit! : STAGE_LOG_DEFAULT_LIMIT),
      );
      const after = query.cursor ? decodeCursor(query.cursor) : undefined;
      const rows = stageLogsDb.listPage({
        taskId: query.taskId,
        keepFrom: keepFrom(),
        after,
        limit,
      });
      const page = rows.slice(0, limit);
      return {
        logs: page,
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
      };
    },

    /** Deletes expired entries; safe while the plugin is off and independent of any run state. */
    pruneExpired(): number {
      return stageLogsDb.prune(keepFrom());
    },

    start(): void {
      if (pruneTimer) return;
      this.pruneExpired();
      pruneTimer = setInterval(() => this.pruneExpired(), PRUNE_INTERVAL_MS);
      pruneTimer.unref?.();
    },

    stop(): void {
      if (!pruneTimer) return;
      clearInterval(pruneTimer);
      pruneTimer = null;
    },
  };
}

export type StageLogService = ReturnType<typeof createStageLogService>;
