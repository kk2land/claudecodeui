import { getConnection } from '@/modules/database/connection.js';
import type { SessionRuntimeSettings } from '@/shared/index.js';

/** Used by Providers and WebSocket/Scheduled Messages to persist mode and queue stop intent. */
export const sessionRuntimeDb = {
  /** Providers advertises this deployment default for Codex sessions without saved settings. */
  getDefaultCodexRuntime(): SessionRuntimeSettings['runtime'] {
    return process.env.CLOUDCLI_CODEX_RUNTIME_MODE === 'sdk' ? 'sdk' : 'app-server';
  },
  get(sessionId: string): SessionRuntimeSettings {
    const row = getConnection().prepare(`SELECT settings.runtime, settings.mode, settings.queue_held,
      settings.model_provider, sessions.model FROM session_runtime_settings AS settings
      LEFT JOIN sessions ON sessions.session_id = settings.session_id WHERE settings.session_id = ?`)
      .get(sessionId) as { runtime: string; mode: string; queue_held: number; model_provider: string | null; model: string | null } | undefined;
    const runtime = row ? row.runtime : this.getDefaultCodexRuntime();
    return {
      runtime: runtime === 'sdk' ? 'sdk' : 'app-server',
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
      .run(this.getDefaultCodexRuntime());
  },
};
