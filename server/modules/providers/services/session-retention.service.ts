import { sessionsDb } from '@/modules/database/index.js';
import { cleanupExpiredCodexSessions } from '@/modules/providers/list/codex/codex-session-retention.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Providers' bootstrap singleton and isolated scheduler tests share this lifecycle. */
export function createSessionRetentionService(options: {
  now?: () => number;
  cleanupCodex?: typeof cleanupExpiredCodexSessions;
} = {}) {
  const { now = Date.now, cleanupCodex = cleanupExpiredCodexSessions } = options;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let closing = false;

  const run = (): Promise<void> => {
    if (closing) return Promise.resolve();
    if (inFlight) return inFlight;
    const startedAt = now();
    inFlight = (async () => {
      const running = chatRunRegistry.listRunningRuns();
      const active = new Set<string>();
      const appSessionIds = new Set([
        ...running.filter((run) => run.provider === 'codex').map((run) => run.sessionId),
        ...(providerRegistry.resolveProvider('codex').runtime.listActiveSessions?.() ?? []).map((run) => run.sessionId),
      ]);
      for (const appSessionId of appSessionIds) {
        const session = sessionsDb.getSessionById(appSessionId);
        if (session?.provider_session_id) active.add(session.provider_session_id);
      }

      try {
        const codex = await cleanupCodex(startedAt, active);
        console.info('[SessionRetention] Codex exec', codex.exec);
        console.info('[SessionRetention] Codex non-exec', codex.other);
      } catch (error) {
        console.error('[SessionRetention] Codex sweep failed', String(error));
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  const reportFailure = (error: unknown) => console.error('[SessionRetention] Sweep failed', String(error));
  return {
    run,
    start(): void {
      if (timer) return;
      closing = false;
      timer = setInterval(() => { void run().catch(reportFailure); }, RETENTION_INTERVAL_MS);
      timer.unref?.();
      void run().catch(reportFailure);
    },
    async close(): Promise<void> {
      closing = true;
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight;
    },
  };
}

/** Server bootstrap starts daily provider maintenance and drains it before closing runtimes. */
export const sessionRetentionService = createSessionRetentionService();
