import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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
import {createInterface} from 'node:readline';
if(process.argv.includes('acp')) {
  const rl=createInterface({input:process.stdin});
  const output=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
  rl.on('line',line=>{
    const frame=JSON.parse(line);
    if(frame.method==='initialize')output({id:frame.id,result:{protocolVersion:1}});
    if(frame.method==='session/new')output({id:frame.id,result:{sessionId:'native-queue'}});
    if(frame.method==='session/prompt')appendFileSync(process.env.FAKE_DSH_LOG,JSON.stringify(frame.params.prompt[0].text)+'\\n');
  });
  rl.on('close',()=>process.exit(0));
} else {
let text='';
process.stdin.on('data',part=>text+=part);
process.stdin.on('end',()=>{
  appendFileSync(process.env.FAKE_DSH_LOG,JSON.stringify(text)+'\\n');
  process.stdout.write(JSON.stringify({type:'session',sessionId:'native-queue'})+'\\n'+JSON.stringify({type:'final',text:'done'})+'\\n');
  process.exitCode=text==='fail'?1:0;
});
}
`;

for (const firstPrompt of ['first', 'fail', 'stop']) test(`DSH queue preserves the next turn after ${firstPrompt}`, { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-queue-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  const bin = path.join(root, 'dsh.mjs'), log = path.join(root, 'prompts.jsonl');
  await writeFile(bin, actor, { mode: 0o755 });
  const config = new DshConfigurationProvider({ PATH: process.env.PATH, DSH_HOME: root, CLOUDCLI_DSH_BIN: bin,
    CLOUDCLI_DSH_RUNTIME: firstPrompt === 'stop' ? 'acp' : 'headless', FAKE_DSH_LOG: log });
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
    isQueueBlocked: (id) => runtime.isQueueBlocked(id),
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
    const options = { model: 'default' };
    sessionDraftsDb.saveDraft(userId, 'app-queue', { text: '', queuedMessage: { content: 'second', options } });
    const running = runDetachedChatTurn({ sessionId: 'app-queue', userId, content: firstPrompt, options }, { runtime: gateway });
    if (firstPrompt === 'stop') {
      for (let attempts = 0; attempts < 200; attempts++) {
        if (await readFile(log, 'utf8').catch(() => '')) break;
        await delay(10);
      }
      assert.equal((await readFile(log, 'utf8')).trim(), JSON.stringify('stop'));
      await runtime.management.control('app-queue', { action: 'stop' });
    }
    const result = await running;
    assert.equal(result.started, true);
    assert(queuedPoll);
    if (firstPrompt === 'stop') {
      assert.equal(await queuedPoll, 0, 'the terminal event cannot restart an explicitly stopped ACP process');
      assert.equal(sessionDraftsDb.getDrafts(userId).length, 1);
      await runtime.management.control('app-queue', { action: 'runtime', runtime: 'headless' });
      assert.equal(await dispatchQueuedMessages(gateway), 0, 'changing transport preserves the hold');
      await runtime.management.control('app-queue', { action: 'queue-resume' });
      assert.equal(await dispatchQueuedMessages(gateway), 1);
    } else {
      assert.equal(await queuedPoll, 1);
    }
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
