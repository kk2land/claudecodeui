import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshRuntimeProvider } from '@/modules/providers/list/dsh/dsh-runtime.provider.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeGateway } from '@/shared/types.js';

const actor = `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
let text='';
process.stdin.on('data',part=>text+=part);
process.stdin.on('end',()=>{
  appendFileSync(process.env.FAKE_DSH_LOG,JSON.stringify(text)+'\\n');
  process.stdout.write(JSON.stringify({type:'session',sessionId:'native-queue'})+'\\n'+JSON.stringify({type:'final',text:'done'})+'\\n');
  process.exitCode=text==='fail'?1:0;
});
`;

for (const firstPrompt of ['first', 'fail']) test(`headless completion dispatches a persisted queued turn after ${firstPrompt} without losing it`, { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-queue-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  const bin = path.join(root, 'dsh.mjs'), log = path.join(root, 'prompts.jsonl');
  await writeFile(bin, actor, { mode: 0o755 });
  const config = new DshConfigurationProvider({ PATH: process.env.PATH, DSH_HOME: root, CLOUDCLI_DSH_BIN: bin,
    CLOUDCLI_DSH_RUNTIME: 'headless', FAKE_DSH_LOG: log });
  const runtime = new DshRuntimeProvider(config, new DshEventsProvider(), new DshMcpProvider(config), { synchronize: async () => 0 });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: (id) => id ? sessionsDb.getSessionById(id)?.provider_session_id ?? null : null,
    resolveResumeModel: async (_id, model) => model ?? 'default',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }), normalizeMessage: () => [], isProviderInstalled: async () => true,
  };
  const failures: string[] = [], busyAtComplete: boolean[] = [];
  let queuedPoll: Promise<number> | undefined;
  const gateway: ProviderRuntimeGateway = {
    hasRuntime: () => true, hasBackgroundWork: () => false,
    abort: (_provider, id) => runtime.abort(id), stopBackgroundTask: async () => false,
    resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
    async run(_provider, command, options, writer) {
      try {
        return await runtime.run(command, options, {
          setSessionId: (id) => writer.setSessionId?.(id),
          send(message) {
            writer.send(message);
            if ((message as AnyRecord).kind === 'complete') {
              busyAtComplete.push(runtime.listActiveSessions().length > 0);
              // Let the real dispatcher observe the terminal event immediately,
              // while the previous dispatchRun promise has not yet settled.
              if (command === firstPrompt) queuedPoll = dispatchQueuedMessages(gateway);
            }
          },
        }, context);
      } catch (error) { failures.push((error as Error).message); throw error; }
    },
  };
  try {
    await initializeDatabase();
    const user = userDb.createUser('dsh-queue-review', 'hash');
    const userId = Number(user.id);
    sessionsDb.createAppSession('app-queue', 'dsh', root, 'Queue test');
    const options = { model: 'deepseek-official/test' };
    sessionDraftsDb.saveDraft(userId, 'app-queue', { text: '', queuedMessage: { content: 'second', options } });
    const result = await runDetachedChatTurn({ sessionId: 'app-queue', userId, content: firstPrompt, options }, { runtime: gateway });
    assert.equal(result.started, true);
    assert(queuedPoll);
    assert.equal(await queuedPoll, 1);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)), [firstPrompt, 'second']);
    assert.deepEqual(busyAtComplete, [false, false]);
    assert.equal(failures.length, firstPrompt === 'fail' ? 1 : 0);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    assert.equal(chatRunRegistry.getRun('app-queue')?.status, 'completed');
  } finally {
    await runtime.close(); chatRunRegistry.clearAll(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
