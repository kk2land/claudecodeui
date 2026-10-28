import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshRuntimeProvider } from '@/modules/providers/list/dsh/dsh-runtime.provider.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import type { AnyRecord, DshRuntimeMode, DshRuntimeSettings, ProviderRuntimeContext } from '@/shared/types.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';

const actor = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (v) => appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify(v)+'\\n');
log({args:process.argv.slice(2)});
const output = (v) => process.stdout.write(JSON.stringify(v)+'\\n');
if (process.argv.includes('headless')) {
  let input='';
  process.stdin.on('data',d=>input+=d);
  process.stdin.on('end',()=>{
    log({prompt:input});
    const sessionIndex=process.argv.indexOf('--session-id');
    output({type:'session',sessionId:sessionIndex<0?'native-headless':process.argv[sessionIndex+1]});
    if(input==='wait') {setInterval(()=>{},1000);return;}
    output({type:'status',phase:'step_start'});
    output({type:'tool_call',callId:'tool-1',tool:'bash',input:{command:'pwd'}});
    output({type:'tool_result',callId:'tool-1',status:'completed',result:'ok'});
    output({type:'text',text:'中文'});
    output({type:'status',phase:'step_end'});
    output({type:'final',text:'中文完成✅'});
    if(input==='broken-final'||input==='broken-hang') {
      process.on('SIGTERM',()=>{if(input==='broken-final')process.exit(0);});
      process.stdout.write('not json\\n');
      setInterval(()=>{},1000);
    }
    process.exitCode=input==='fail'?1:0;
  });
} else {
  const rl=createInterface({input:process.stdin});
  let pending;
  let permission;
  const choices=[{id:'model',currentValue:'["deepseek-official","flash"]',options:[{group:'deepseek-official',options:[{value:'["deepseek-official","flash"]'},{value:'["deepseek-official","pro"]'}]},{group:'other',options:[{value:'["other","flash"]'}]}]},{id:'reasoning_effort',options:[{value:'high'},{value:'low'}]}];
  const complete=()=>{
    output({method:'session/update',params:{sessionId:'native-acp',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'中文✅'}}}});
    output({id:pending,result:{stopReason:'end_turn'}});pending=undefined;
  };
  rl.on('line',line=>{
    const f=JSON.parse(line);log(f);
    if(f.method==='initialize') output({id:f.id,result:{protocolVersion:1,agentInfo:{version:'0.2.1-test'}}});
    else if(f.method==='session/new') output({id:f.id,result:{sessionId:'native-acp',configOptions:choices}});
    else if(f.method==='session/resume') {
      if(f.params.sessionId==='missing') output({id:f.id,error:{code:-32602,message:'unknown session'}});
      else output({id:f.id,result:{configOptions:choices}});
    } else if(f.method==='session/set_config_option') output({id:f.id,result:{configOptions:choices}});
    else if(f.method==='session/prompt') {
      pending=f.id;
      const text=f.params.prompt[0].text;
      if(text==='wait') return;
      if(text==='broken') {process.stdout.write('not json\\n');return;}
      if(text==='permission') {permission='ask';output({id:permission,method:'session/request_permission',params:{sessionId:'native-acp',toolCall:{title:'bash',rawInput:{command:'pwd'}},options:[{kind:'allow_once',optionId:'once'},{kind:'allow_always',optionId:'always'},{kind:'reject_once',optionId:'reject'}]}});return;}
      if(text==='usage') output({method:'session/update',params:{sessionId:'native-acp',update:{sessionUpdate:'usage_update',used:66408,size:1000000}}});
      complete();
    } else if(f.method==='session/cancel') {if(pending!==undefined)output({id:pending,result:{stopReason:'cancelled'}});pending=undefined;}
    else if(f.method==='session/close') setTimeout(()=>output({id:f.id,result:{}}),100);
    else if(f.id===permission && f.result) {log({approval:f.result});complete();}
  });
  rl.on('close',()=>process.exit(0));
}
`;

async function fixture(mode: DshRuntimeMode = 'acp', nativeId: string | null = null, synchronize?: () => Promise<number>, environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh runtime '));
  const bin = path.join(root, 'fake-dsh.mjs'), log = path.join(root, 'calls.jsonl');
  await writeFile(bin, actor, { mode: 0o755 });
  const config = new DshConfigurationProvider({ ...process.env, CLOUDCLI_DSH_RUNTIME: mode, CLOUDCLI_DSH_BIN: bin,
    DSH_HOME: root, CLOUDCLI_DSH_PATCHES: '[]', CLOUDCLI_DSH_TIMEOUT_MS: '2000', FAKE_DSH_LOG: log, ...environment });
  const messages: AnyRecord[] = [];
  let captured = nativeId;
  let syncs = 0;
  const saved = new Map<string, DshRuntimeSettings>();
  const settings = { getDsh: (id: string) => saved.get(id) ?? null, saveDsh: (id: string, value: DshRuntimeSettings) => { saved.set(id, value); } };
  const runtime = new DshRuntimeProvider(config, new DshEventsProvider(), new DshMcpProvider(config), { synchronize: async () => { syncs++; return synchronize ? synchronize() : 0; } }, settings);
  const context: ProviderRuntimeContext = { resolveProviderSessionId: () => captured, resolveResumeModel: async (_id, model) => model || 'default',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }), normalizeMessage: () => [], isProviderInstalled: async () => true };
  const run = (prompt: string, options: AnyRecord = {}) => runtime.run(prompt, { sessionId: 'app', cwd: root, ...options },
    { send: (value) => messages.push(value as AnyRecord), setSessionId: (id) => { captured = id; } }, context);
  return { runtime, messages, run, root, settings, get syncs() { return syncs; }, get captured() { return captured; },
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as AnyRecord),
    close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let n = 0; n < 200; n++) { if (await condition()) return; await delay(10); }
  assert.fail('Timed out waiting for protocol state.');
}

for (const mode of ['acp', 'headless'] as const) {
  test(`${mode} sends images and files as separate readable path references, including image-only turns`, { skip: process.platform === 'win32' }, async () => {
    const f = await fixture(mode);
    try {
      const image = { path: path.join(f.root, 'screen shot.png'), name: '界面.png', mimeType: 'image/png' };
      const file = { path: path.join(f.root, 'notes.txt'), name: 'notes.txt' };
      await writeFile(image.path, 'fixture');
      await writeFile(file.path, 'notes');
      await f.run('Describe this screenshot.', { images: [{ ...image, path: 'screen shot.png' }], files: [file] });
      await f.run('', { images: [image] });
      const prompts = (await f.calls()).flatMap((call) => mode === 'acp'
        ? call.method === 'session/prompt' ? [call.params.prompt[0].text] : []
        : typeof call.prompt === 'string' ? [call.prompt] : []);
      assert.equal(prompts.length, 2);
      const files = parseFilesInputTag(prompts[0]);
      const images = parseImagesInputTag(files.text);
      assert.equal(images.text, 'Describe this screenshot.');
      assert.deepEqual(images.attachments, [{ path: image.path, name: image.name }]);
      assert.deepEqual(files.attachments, [file]);
      assert.deepEqual(parseImagesInputTag(prompts[1]).attachments, images.attachments);
      assert.equal(parseImagesInputTag(prompts[1]).text, '');
      assert.equal(f.messages.filter((message) => message.kind === 'complete' && message.success).length, 2);
    } finally { await f.close(); }
  });

  test(`${mode} rejects missing images and image paths or symlinks escaping allowed roots`, { skip: process.platform === 'win32' }, async () => {
    const f = await fixture(mode);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'dsh-outside-'));
    try {
      const image = path.join(outside, 'private.png');
      const linked = path.join(f.root, 'linked.png');
      await writeFile(image, 'private');
      await symlink(image, linked);
      for (const imagePath of [image, linked]) {
        await assert.rejects(f.run('describe', { images: [imagePath] }), /inside the upload store or working directory/);
      }
      await assert.rejects(f.run('describe', { images: ['missing.png'] }), /ENOENT/);
      assert.equal(f.captured, null);
      assert.equal(f.runtime.listActiveSessions().length, 0);
      assert(f.messages.filter((message) => message.kind === 'complete').every((message) => !message.success));
    } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
  });
}

test('ACP reuses its process, maps ids, and selects an advertised model on later turns', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await f.run('hello'); await f.run('again', { model: 'deepseek-official/pro', effort: 'high' });
    const calls = await f.calls();
    assert.equal(calls.filter((call) => call.method === 'initialize').length, 1);
    assert.equal(calls.filter((call) => call.method === 'session/new').length, 1);
    assert.equal(calls.filter((call) => call.method === 'session/prompt').length, 2);
    assert(calls.some((call) => call.params?.value === '["deepseek-official","pro"]'));
    assert.equal(f.captured, 'native-acp');
    assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 2);
    assert(f.messages.some((message) => message.content === '中文✅'));
    assert.equal(f.syncs, 2);
  } finally { await f.close(); }
});

test('ACP resolves allow-once and drops stale approvals, including after a noninteractive turn', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await f.run('permission', { permissionMode: 'bypassPermissions' });
    const run = f.run('permission');
    await until(() => f.runtime.permissions.listPending('app').length === 1);
    const request = f.runtime.permissions.listPending('app')[0] as AnyRecord;
    f.runtime.permissions.resolve(request.requestId, { allow: true });
    f.runtime.permissions.resolve(request.requestId, { allow: true });
    await run;
    assert.equal(f.runtime.permissions.listPending('app').length, 0);
    const approvals = (await f.calls()).filter((call) => call.approval);
    assert.equal(approvals.length, 2);
    assert(approvals.every((call) => call.approval.outcome.optionId === 'once'));
  } finally { await f.close(); }
});

for (const prompt of ['hello', 'broken']) test(`ACP keeps a session busy until indexing and completion finish after ${prompt}`, { skip: process.platform === 'win32' }, async () => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const f = await fixture('acp', null, async () => { await gate; return 0; });
  try {
    const running = prompt === 'broken' ? assert.rejects(f.run(prompt), /Invalid DSH stdout/) : f.run(prompt);
    await until(() => f.syncs === 1);
    assert.equal(f.runtime.listActiveSessions().length, 1);
    await assert.rejects(f.run('too early'), /already running/);
    assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 0);
    resume(); await running;
    assert.equal(f.runtime.listActiveSessions().length, 0);
    assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 1);
  } finally { resume(); await f.close(); }
});

test('ACP waits for in-flight idle cleanup before resuming in a fresh process', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('acp', null, undefined, { CLOUDCLI_DSH_IDLE_MS: '100' });
  try {
    await f.run('hello');
    await until(async () => (await f.calls()).some((call) => call.method === 'session/close'));
    const running = f.run('after idle');
    await assert.rejects(f.run('concurrent restart'), /already running/);
    await running;
    const calls = await f.calls();
    assert.equal(calls.filter((call) => call.method === 'initialize').length, 2);
    assert.equal(calls.filter((call) => call.method === 'session/resume').length, 1);
    assert.equal(calls.filter((call) => call.method === 'session/prompt').length, 2);
  } finally { await f.close(); }
});

test('cancelling an ACP idle handoff prevents a replacement prompt from starting', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('acp', null, undefined, { CLOUDCLI_DSH_IDLE_MS: '100' });
  try {
    await f.run('hello');
    await until(async () => (await f.calls()).some((call) => call.method === 'session/close'));
    const running = f.run('cancel this handoff');
    assert.equal(await f.runtime.abort('app'), true);
    await running;
    assert.equal((await f.calls()).filter((call) => call.method === 'session/prompt').length, 1);
    assert.equal(f.runtime.listActiveSessions().length, 0);
  } finally { await f.close(); }
});

test('ACP rejects ambiguous bare model names before delivering the prompt', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run('hello', { model: 'flash' }), /ambiguous/);
    assert.equal((await f.calls()).filter((call) => call.method === 'session/prompt').length, 0);
    await f.run('hello', { model: 'deepseek-official/flash' });
    assert.equal(f.messages.at(-1)?.success, true);
  } finally { await f.close(); }
});

test('ACP cancel settles the run and prevents a second in-flight prompt', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const running = f.run('wait');
    await until(() => f.captured !== null);
    await delay(30);
    await assert.rejects(f.run('second'), /already running/);
    assert.equal(await f.runtime.abort('app'), true);
    await running;
    assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 0);
    assert.equal(f.runtime.listActiveSessions().length, 0);
  } finally { await f.close(); }
});

test('ACP resume failures never create replacement sessions or resend prompts', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('acp', 'missing');
  try {
    await assert.rejects(f.run('hello'), /unknown session/);
    assert.equal((await f.calls()).filter((call) => ['session/new', 'session/prompt'].includes(call.method)).length, 0);
    assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(f.messages.at(-1)?.success, false);
  } finally { await f.close(); }
});

test('ACP rejects malformed stdout and unsupported plan without a successful terminal', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run('broken'), /Invalid DSH stdout/);
    await assert.rejects(f.run('hello', { permissionMode: 'plan' }), /unavailable/);
    assert(f.messages.filter((message) => message.kind === 'complete').every((message) => !message.success));
  } finally { await f.close(); }
});

test('headless keeps multiline prompts in stdin and replaces the bounded text with lossless final output', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('headless', 'native-headless');
  try {
    const prompt = 'line one\n--fake-option; $(no-shell)';
    await f.run(prompt);
    const calls = await f.calls();
    assert(calls[0].args.includes('--session-id'));
    assert.equal(calls[1].prompt, prompt);
    const text = f.messages.filter((message) => message.kind === 'text');
    assert.equal(text[0].id, text[1].id);
    assert.equal(text.at(-1)?.content, '中文完成✅');
    const result = f.messages.find((message) => message.kind === 'tool_result');
    assert.equal(result?.content, 'ok');
    assert.equal(result?.isError, false);
    assert.equal(f.messages.at(-1)?.success, true);
  } finally { await f.close(); }
});

test('headless nonzero exit is a failure even after a final frame', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('headless');
  try { await assert.rejects(f.run('fail'), /headless failed/); assert.equal(f.messages.at(-1)?.success, false); }
  finally { await f.close(); }
});

test('headless protocol errors cannot become success after a final frame and zero exit', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('headless');
  try {
    await assert.rejects(f.run('broken-final'), /Invalid DSH stdout/);
    assert.equal(f.messages.at(-1)?.success, false);
  } finally { await f.close(); }
});

test('headless protocol errors reap a peer that ignores SIGTERM', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const f = await fixture('headless');
  try {
    await assert.rejects(f.run('broken-hang'), /Invalid DSH stdout/);
    assert.equal(f.runtime.listActiveSessions().length, 0);
    assert.equal(f.messages.at(-1)?.success, false);
  } finally { await f.close(); }
});

test('headless cancellation reaps a waiting child without emitting a second terminal', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('headless');
  try {
    const running = f.run('wait');
    await until(() => f.captured !== null);
    assert.equal(await f.runtime.abort('app'), true);
    await running;
    assert.equal(f.runtime.listActiveSessions().length, 0);
    assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 0);
  } finally { await f.close(); }
});

test('cancelling during startup prevents a process from being launched later', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const running = f.run('hello');
    assert.equal(await f.runtime.abort('app'), true);
    await running;
    await assert.rejects(f.calls(), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.equal(f.runtime.listActiveSessions().length, 0);
  } finally { await f.close(); }
});

test('configuration rejects unsupported transports and non-array patch arguments', () => {
  assert.throws(() => new DshConfigurationProvider({ CLOUDCLI_DSH_RUNTIME: 'sdk' }).read(), /acp or headless/);
  assert.throws(() => new DshConfigurationProvider({ CLOUDCLI_DSH_PATCHES: 'shell --flags' }).read(), /JSON array/);
});

test('runtime state is passive and selection persists before the first run', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('headless');
  try {
    assert.equal(f.runtime.management.getState(null).runtime, 'headless');
    assert.equal(f.runtime.management.getState('app').diagnostics.running, false);
    await assert.rejects(f.calls(), { code: 'ENOENT' });
    const state = await f.runtime.management.control('app', { action: 'runtime', runtime: 'acp' });
    assert.equal(state.runtime, 'acp');
    assert.equal(state.supportsPermissionRequests, true);
    assert.equal(state.diagnostics.pid, null);
    assert.deepEqual(f.settings.getDsh('app'), { runtime: 'acp', queueHeld: false });
    await assert.rejects(f.calls(), { code: 'ENOENT' });
    await f.run('hello');
    assert((await f.calls())[0].args.includes('acp'));
    await assert.rejects(f.runtime.management.control('app', { action: 'runtime', runtime: 'sdk' }), /acp and headless/);
  } finally { await f.close(); }
});

test('ACP diagnostics track the process lifetime and switching waits for release', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await f.run('hello');
    const first = f.runtime.management.getState('app');
    assert.equal(first.phase, 'idle');
    assert.equal(first.diagnostics.running, true);
    assert(first.diagnostics.pid);
    assert(first.diagnostics.startedAt);
    assert.equal(first.diagnostics.launcherPath, path.join(f.root, 'fake-dsh.mjs'));
    assert.equal(first.diagnostics.cliVersion, '0.2.1-test');
    await f.run('again');
    assert.deepEqual(f.runtime.management.getState('app').diagnostics, first.diagnostics);
    const switching = f.runtime.management.control('app', { action: 'runtime', runtime: 'headless' });
    assert.equal(f.runtime.management.getState('app').phase, 'switching');
    assert.equal(f.runtime.isQueueBlocked('app'), true);
    await assert.rejects(f.run('racing send'), /Wait for/);
    const next = await switching;
    assert.equal(next.runtime, 'headless');
    assert.equal(next.diagnostics.running, false);
    assert.equal(next.supportsPermissionRequests, false);
    await f.run('headless');
    assert((await f.calls()).some((call) => call.args?.includes('headless')));
    await assert.rejects(f.runtime.management.control('app', { action: 'stop' }), /Only.*ACP/);
  } finally { await f.close(); }
});

test('stopping idle ACP holds its queue and does not restart on polling', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await f.run('hello');
    const stopping = f.runtime.management.control('app', { action: 'stop' });
    const duplicate = f.runtime.management.control('app', { action: 'stop' });
    assert.equal(f.runtime.management.getState('app').phase, 'stopping');
    await assert.rejects(f.runtime.management.control('app', { action: 'runtime', runtime: 'headless' }), /Wait for/);
    await assert.rejects(f.runtime.management.control('app', { action: 'queue-resume' }), /Wait for/);
    const [state] = await Promise.all([stopping, duplicate]);
    assert.equal(state.queueHeld, true);
    assert.equal(state.diagnostics.running, false);
    assert.equal(f.runtime.isQueueBlocked('app'), true);
    assert.equal(f.runtime.isQueueBlocked('other'), false);
    assert.equal(f.runtime.management.getState('app').diagnostics.pid, null);
    assert.equal((await f.calls()).filter((call) => call.args).length, 1);
    await f.runtime.management.control('app', { action: 'runtime', runtime: 'headless' });
    assert.equal(f.runtime.isQueueBlocked('app'), true, 'switching must not clear an explicit stop');
    await f.runtime.management.control('app', { action: 'queue-resume' });
    assert.equal(f.runtime.isQueueBlocked('app'), false);
  } finally { await f.close(); }
});

for (const prompt of ['wait', 'permission']) test(`ACP process stop settles an active ${prompt} turn exactly once`, { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const running = f.run(prompt);
    await until(() => f.captured !== null);
    await until(async () => (await f.calls()).some((call) => call.method === 'session/prompt'));
    await assert.rejects(f.runtime.management.control('app', { action: 'runtime', runtime: 'headless' }), /Stop this session/);
    await f.runtime.management.control('app', { action: 'stop' });
    await running;
    assert.equal(f.runtime.listActiveSessions().length, 0);
    assert.equal(f.runtime.permissions.listPending('app').length, 0);
    const complete = f.messages.filter((message) => message.kind === 'complete');
    assert.equal(complete.length, 1);
    assert.equal(complete[0].aborted, true);
    assert.equal(f.runtime.management.getState('app').diagnostics.running, false);
  } finally { await f.close(); }
});

test('a process stop during startup prevents a late launch and leaves the queue held', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const running = f.run('hello');
    await f.runtime.management.control('app', { action: 'stop' });
    await running;
    assert.equal(f.runtime.isQueueBlocked('app'), true);
    assert.equal(f.runtime.management.getState('app').diagnostics.running, false);
    assert.equal(f.messages.filter((message) => message.kind === 'complete' && message.aborted).length, 1);
    await assert.rejects(f.calls(), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('stopping one ACP session leaves another session process and queue available', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await f.run('hello');
    await f.run('hello from another session', { sessionId: 'other' });
    const other = f.runtime.management.getState('other');
    assert(other.diagnostics.running);
    assert.notEqual(other.diagnostics.pid, f.runtime.management.getState('app').diagnostics.pid);
    await f.runtime.management.control('app', { action: 'stop' });
    assert.equal(f.runtime.management.getState('app').diagnostics.running, false);
    assert.deepEqual(f.runtime.management.getState('other').diagnostics, other.diagnostics);
    assert.equal(f.runtime.isQueueBlocked('other'), false);
    await f.run('continue other session', { sessionId: 'other' });
    assert.equal(f.messages.at(-1)?.success, true);
  } finally { await f.close(); }
});

test('ACP usage_update is scoped to its app session and cached for the token-usage refresh', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await f.run('usage', { sessionId: 'usage-a' });
    const budgets = f.messages.filter((message) => message.text === 'token_budget');
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0].sessionId, 'usage-a');
    assert.deepEqual(budgets[0].tokenBudget, { used: 66_408, total: 1_000_000 });

    const service = createProviderTokenUsageService({
      getSessionById: (sessionId) => ({
        session_id: sessionId, provider: 'dsh', provider_session_id: 'native-acp',
        project_path: null, jsonl_path: null, custom_name: null, model: null, effort: null,
        forked_from_session_id: null, isArchived: 0,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      }),
    });
    assert.deepEqual(await service.getSessionTokenUsage('usage-a'), {
      used: 66_408,
      total: 1_000_000,
    });
    assert.equal((await service.getSessionTokenUsage('usage-b')).unsupported, true);
  } finally { await f.close(); }
});
