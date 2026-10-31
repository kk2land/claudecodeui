import { sessionsDb } from '@/modules/database/index.js';
import { cleanupExpiredCodexSessions } from '@/modules/providers/list/codex/codex-session-retention.provider.js';
import { cleanupExpiredDshSessions } from '@/modules/providers/list/dsh/dsh-session-retention.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Providers' bootstrap singleton and isolated scheduler tests share this lifecycle. */
export function createSessionRetentionService(options: {
  now?: () => number;
  cleanupCodex?: typeof cleanupExpiredCodexSessions;
  cleanupDsh?: typeof cleanupExpiredDshSessions;
} = {}) {
  const { now = Date.now, cleanupCodex = cleanupExpiredCodexSessions, cleanupDsh = cleanupExpiredDshSessions } = options;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let closing = false;

  const run = (): Promise<void> => {
    if (closing) return Promise.resolve();
    if (inFlight) return inFlight;
    const startedAt = now();
    inFlight = (async () => {
      const running = chatRunRegistry.listRunningRuns();
      const active = { codex: new Set<string>(), dsh: new Set<string>() };
      for (const provider of ['codex', 'dsh'] as const) {
        const appSessionIds = new Set([
          ...running.filter((run) => run.provider === provider).map((run) => run.sessionId),
          ...(providerRegistry.resolveProvider(provider).runtime.listActiveSessions?.() ?? []).map((run) => run.sessionId),
        ]);
        for (const appSessionId of appSessionIds) {
          const session = sessionsDb.getSessionById(appSessionId);
          if (session?.provider_session_id) active[provider].add(session.provider_session_id);
        }
      }

      const results = await Promise.allSettled([
        cleanupCodex(startedAt, active.codex),
        cleanupDsh(startedAt, active.dsh),
      ]);
      const [codex, dsh] = results;
      if (codex.status === 'fulfilled') {
        console.info('[SessionRetention] Codex exec', codex.value.exec);
        console.info('[SessionRetention] Codex non-exec', codex.value.other);
      } else {
        console.error('[SessionRetention] Codex sweep failed', String(codex.reason));
      }
      if (dsh.status === 'fulfilled') {
        console.info('[SessionRetention] DSH', dsh.value);
      } else {
        console.error('[SessionRetention] DSH sweep failed', String(dsh.reason));
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
