import { stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { normalizeSessionName } from '@/shared/utils.js';

/** Adds ordinary native DSH conversations to the existing app session index. */
export class DshSessionSynchronizer implements IProviderSessionSynchronizer {
  constructor(private readonly store: DshSessionStore) {}

  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    for (const file of await this.store.files()) {
      if (since && (await stat(file)).mtime < since) continue;
      if (await this.synchronizeFile(file)) processed++;
    }
    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    const log = await this.store.read(filePath);
    if (log.header.origin === 'subagent' || log.header.parentSession || !log.header.cwd) return null;
    const id = log.header.id;
    const title = [...log.events].reverse().find((event) => event.type === 'session/title')?.data?.title;
    const firstUser = log.events.find((event) => event.type === 'user/message');
    const firstText = firstUser?.data?.content?.find((block: { type: string }) => block.type === 'text')?.text;
    const pending = sessionsDb.getSessionByProviderSessionId(id) ?? sessionsDb.findLatestPendingAppSession('dsh', log.header.cwd);
    if (pending && !pending.provider_session_id) sessionsDb.assignProviderSessionId(pending.session_id, id);
    const existing = sessionsDb.getSessionByProviderSessionId(id);
    const updated = log.events.at(-1)?.time ?? log.header.createdAt;
    return sessionsDb.createSession(id, 'dsh', log.header.cwd,
      normalizeSessionName(existing?.custom_name ?? title ?? firstText, 'Untitled DSH Session'),
      new Date(log.header.createdAt).toISOString(), new Date(updated).toISOString(), log.filePath);
  }
}
