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
    const row = getConnection().prepare(`SELECT settings.runtime, settings.mode, settings.queue_held,
      settings.model_provider, sessions.model FROM session_runtime_settings AS settings
      LEFT JOIN sessions ON sessions.session_id = settings.session_id WHERE settings.session_id = ?`)
      .get(sessionId) as { runtime: string; mode: string; queue_held: number; model_provider: string | null; model: string | null } | undefined;
    return {
      runtime: row?.runtime === 'sdk' || (!row && process.env.CLOUDCLI_CODEX_RUNTIME_MODE === 'sdk') ? 'sdk' : 'app-server',
      mode: row?.mode === 'plan' ? 'plan' : 'default',
      queueHeld: Boolean(row?.queue_held),
      ...(row?.model_provider ? { modelSelection: { modelProvider: row.model_provider, model: row.model } } : {}),
    };
  },
  update(sessionId: string, patch: Partial<SessionRuntimeSettings>): SessionRuntimeSettings {
    const settings = { ...this.get(sessionId), ...patch };
    const db = getConnection();
    // The existing session model column remains the model's single source of
    // truth. Commit it together with the provider so reconnects never see half a choice.
    db.transaction(() => {
      db.prepare(`INSERT INTO session_runtime_settings(session_id, runtime, mode, queue_held, model_provider)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
        runtime = excluded.runtime, mode = excluded.mode, queue_held = excluded.queue_held,
        model_provider = excluded.model_provider`)
        .run(sessionId, settings.runtime, settings.mode, Number(settings.queueHeld), settings.modelSelection?.modelProvider ?? null);
      if (patch.modelSelection) db.prepare('UPDATE sessions SET model = ? WHERE session_id = ?')
        .run(patch.modelSelection.model, sessionId);
    })();
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
