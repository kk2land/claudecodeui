import { readdir, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import type { SessionRetentionSummary } from '@/shared/index.js';

/** Daily maintenance removes expired native generations using the configured DSH root. */
export async function cleanupExpiredDshSessions(
  now: number,
  activeSessionIds: ReadonlySet<string>,
  configuration = new DshConfigurationProvider(),
): Promise<SessionRetentionSummary> {
  const summary: SessionRetentionSummary = { deleted: 0, skipped: 0, failed: 0 };
  const cutoff = now - 30 * 86_400_000;
  const indexedByPath = new Map(sessionsDb.getSessionsWithTranscriptPath('dsh')
    .map((row) => [path.resolve(row.jsonl_path), row.session_id]));

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      summary.failed++;
      console.error('[SessionRetention] DSH directory read failed', { directory, error: String(error) });
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile() && /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        if (activeSessionIds.has(path.basename(directory))) {
          summary.skipped++;
          continue;
        }
        try {
          if ((await stat(filePath)).mtimeMs >= cutoff) {
            summary.skipped++;
            continue;
          }
          // The DSH reader indexes canonical paths even when DSH_HOME is a link.
          const indexedPath = await realpath(filePath);
          await unlink(filePath);
          const sessionId = indexedByPath.get(indexedPath);
          if (sessionId) {
            sessionsDb.deleteSessionById(sessionId);
            sessionHistoryCache.invalidate(sessionId);
          }
          summary.deleted++;
        } catch (error) {
          summary.failed++;
          console.error('[SessionRetention] DSH file cleanup failed', { filePath, error: String(error) });
        }
      }
    }
  };
  await walk(configuration.sessionsRoot);
  return summary;
}
