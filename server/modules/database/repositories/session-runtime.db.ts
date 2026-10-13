import { getConnection } from '@/modules/database/connection.js';
import type { SessionRuntimeSettings } from '@/shared/index.js';

/** Used by Providers and WebSocket/Scheduled Messages to persist mode and queue stop intent. */
export const sessionRuntimeDb = {
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
};
