import { getConnection } from '@/modules/database/connection.js';
import type { SessionRuntimeSettings } from '@/shared/index.js';
import type { DshRuntimeSettings } from '@/shared/types.js';

/** Used by Providers and WebSocket/Scheduled Messages to persist mode and queue stop intent. */
export const sessionRuntimeDb = {
  /** DSH uses the existing unconstrained runtime column without changing Codex defaults or modes. */
  getDsh(sessionId: string): DshRuntimeSettings | null {
    const row = getConnection().prepare('SELECT runtime, queue_held FROM session_runtime_settings WHERE session_id = ?')
      .get(sessionId) as { runtime: string; queue_held: number } | undefined;
    return row?.runtime === 'acp' || row?.runtime === 'headless'
      ? { runtime: row.runtime, queueHeld: Boolean(row.queue_held) }
      : null;
  },
  /** Providers saves the chosen DSH transport and explicit queue pause across server restarts. */
  saveDsh(sessionId: string, settings: DshRuntimeSettings): void {
    getConnection().prepare(`INSERT INTO session_runtime_settings(session_id, runtime, queue_held)
      VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      runtime = excluded.runtime, queue_held = excluded.queue_held`)
      .run(sessionId, settings.runtime, Number(settings.queueHeld));
  },
  get(sessionId: string): SessionRuntimeSettings {
    const row = getConnection().prepare('SELECT runtime, mode, queue_held FROM session_runtime_settings WHERE session_id = ?')
      .get(sessionId) as { runtime: string; mode: string; queue_held: number } | undefined;
    return {
      runtime: row?.runtime === 'sdk' || (!row && process.env.CLOUDCLI_CODEX_RUNTIME_MODE === 'sdk') ? 'sdk' : 'app-server',
      mode: row?.mode === 'plan' ? 'plan' : 'default',
      queueHeld: Boolean(row?.queue_held),
    };
  },
  update(sessionId: string, patch: Partial<SessionRuntimeSettings>): SessionRuntimeSettings {
    const settings = { ...this.get(sessionId), ...patch };
    getConnection().prepare(`INSERT INTO session_runtime_settings(session_id, runtime, mode, queue_held)
      VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      runtime = excluded.runtime, mode = excluded.mode, queue_held = excluded.queue_held`)
      .run(sessionId, settings.runtime, settings.mode, Number(settings.queueHeld));
    return settings;
  },
  /** Providers holds all native Codex queues before stopping their shared process, including unloaded sessions. */
  holdCodexAppServerQueues(): void {
    getConnection().prepare(`INSERT INTO session_runtime_settings(session_id, runtime, mode, queue_held)
      SELECT sessions.session_id, 'app-server', COALESCE(settings.mode, 'default'), 1
      FROM sessions LEFT JOIN session_runtime_settings AS settings ON settings.session_id = sessions.session_id
      WHERE sessions.provider = 'codex' AND COALESCE(settings.runtime, ?) = 'app-server'
      ON CONFLICT(session_id) DO UPDATE SET queue_held = 1`)
      .run(process.env.CLOUDCLI_CODEX_RUNTIME_MODE === 'sdk' ? 'sdk' : 'app-server');
  },
};
