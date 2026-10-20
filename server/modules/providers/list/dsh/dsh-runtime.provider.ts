import { randomUUID, createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshProcess } from '@/modules/providers/list/dsh/dsh-process.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshSessionSynchronizer } from '@/modules/providers/list/dsh/dsh-session-synchronizer.provider.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, DshConfiguration, ProviderPermissionDecision, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';
import { appendFilesInputTag, normalizeAttachmentDescriptors } from '@/shared/image-attachments.js';

type DshOwner = {
  id: string;
  nativeId: string | null;
  cwd: string;
  signature: string;
  config: DshConfiguration;
  child?: DshProcess;
  directory?: string;
  writer: ProviderRuntimeWriter;
  busy: boolean;
  aborted: boolean;
  startedAt: number;
  idle?: NodeJS.Timeout;
  done?: Promise<void>;
  releasing?: Promise<void>;
  configOptions?: AnyRecord[];
  defaultModel?: string;
  approvalBypass?: boolean;
  mcpSignature?: string;
};
type DshApproval = { owner: DshOwner; message: AnyRecord; options: AnyRecord[]; resolve(value: unknown): void };

/** Owns DSH ACP/headless processes for the provider runtime dispatcher. */
export class DshRuntimeProvider implements IProviderRuntime {
  private readonly owners = new Map<string, DshOwner>();
  private readonly approvals = new Map<string, DshApproval>();

  constructor(
    private readonly configuration: DshConfigurationProvider,
    private readonly events: DshEventsProvider,
    private readonly mcp: DshMcpProvider,
    private readonly synchronizer: Pick<DshSessionSynchronizer, 'synchronize'>,
  ) {}

  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
    const id = String(options.sessionId || randomUUID());
    if (this.owners.get(id)?.busy) throw new Error('DSH session is already running; queue the next message.');
    const config = this.configuration.read();
    const cwd = path.resolve(options.cwd || options.projectPath || process.cwd());
    const signature = createHash('sha256').update(JSON.stringify({ config, cwd })).digest('hex');
    let owner = this.owners.get(id);
    const previous = owner && (owner.signature !== signature || owner.child?.isClosed || owner.releasing) ? owner : undefined;
    if (previous) owner = undefined;
    owner ??= { id, nativeId: context.resolveProviderSessionId(options.sessionId), cwd, signature, config, writer, busy: false, aborted: false, startedAt: Date.now() };
    clearTimeout(owner.idle);
    owner.writer = writer; owner.busy = true; owner.aborted = false; owner.startedAt = Date.now();
    owner.approvalBypass = options.permissionMode === 'bypassPermissions';
    this.owners.set(id, owner);
    owner.done = this.execute(owner, command, options, context, previous);
    return owner.done;
  }

  private async execute(owner: DshOwner, command: string, options: AnyRecord, context: ProviderRuntimeContext, previous?: DshOwner): Promise<void> {
    let success = false;
    try {
      if (previous) await this.release(previous);
      if (owner.aborted) return;
      if (options.permissionMode && !['default', 'bypassPermissions'].includes(options.permissionMode)) throw new Error('DSH supports the default permission policy; native plan and permission modes are unavailable.');
      if (normalizeAttachmentDescriptors(options.images).length) throw new Error('DSH image uploads are not enabled for this integration.');
      const prompt = appendFilesInputTag(command, options.files);
      const model = await context.resolveResumeModel(owner.id, options.model);
      const mcpSignature = JSON.stringify(await this.servers(owner));
      if (owner.child && owner.mcpSignature !== mcpSignature) {
        await owner.child.close();
        owner.child = undefined;
      }
      owner.mcpSignature = mcpSignature;
      if (owner.aborted) return;
      if (owner.config.mode === 'headless') await this.headless(owner, prompt, model, options);
      else await this.acp(owner, prompt, model, options);
      success = !owner.aborted;
    } catch (error) {
      if (!owner.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        owner.writer.send(createNormalizedMessage({ kind: 'error', provider: 'dsh', sessionId: owner.id, content: message }));
        notifyRunFailed({ userId: owner.writer.userId, provider: 'dsh', sessionId: options.sessionId ?? owner.id, error: message });
        // Never retry a prompt after a timeout or broken transport: delivery
        // may already have happened. Release the writer before any next run.
        await this.release(owner, false);
        throw error;
      }
    } finally {
      try {
        this.cancelApprovals(owner);
        if (owner.nativeId) {
          try { await this.synchronizer.synchronize(); } catch (error) { console.warn('[DSH] History indexing failed:', error instanceof Error ? error.message : String(error)); }
        }
        if (!owner.aborted) {
          if (success) notifyRunStopped({ userId: owner.writer.userId, provider: 'dsh', sessionId: options.sessionId ?? owner.id, stopReason: 'completed' });
          owner.writer.send(createCompleteMessage({ provider: 'dsh', sessionId: owner.id, exitCode: success ? 0 : 1 }));
        }
        if (this.owners.get(owner.id) === owner) {
          if (owner.config.mode === 'headless' || owner.aborted || !success) await this.release(owner);
          else {
            owner.idle = setTimeout(() => { void this.release(owner).catch((error) => console.warn('[DSH] Idle cleanup failed:', error.message)); }, owner.config.idleMs);
            owner.idle.unref();
          }
        }
      } finally {
        // Indexing and teardown belong to the same run. Releasing this guard
        // early lets another prompt replace its writer and completion state.
        owner.busy = false;
      }
    }
  }

  private async launch(owner: DshOwner, extraRows: AnyRecord[] = [], extraArgs: string[] = []): Promise<DshProcess> {
    const args = ['--profile', owner.config.mode];
    for (const patch of owner.config.patches) args.push('--patch', patch);
    if (extraRows.length) {
      owner.directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-dsh-'));
      const patch = path.join(owner.directory, 'run.patch.yml');
      // JSON is a YAML subset; argv and configuration stay data even when a
      // model name, MCP env, or path contains quotes or shell metacharacters.
      await writeFile(patch, JSON.stringify(extraRows), { mode: 0o600 });
      args.push('--patch', patch);
    }
    if (owner.aborted) throw new Error('DSH launch was cancelled.');
    const child = new DshProcess(owner.config, owner.cwd, [...args, ...extraArgs]);
    owner.child = child;
    return child;
  }

  private async servers(owner: DshOwner): Promise<AnyRecord[]> {
    const grouped = await this.mcp.listServers({ workspacePath: owner.cwd });
    const merged = new Map([...grouped.user, ...grouped.project].map((server) => [server.name, server]));
    return Promise.all([...merged.values()].map(async (server) => server.transport === 'stdio'
      ? { name: server.name, command: await this.executable(server.command!, owner), args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) }
      : { name: server.name, type: 'http', url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }));
  }

  private async executable(command: string, owner: DshOwner): Promise<string> {
    const directories = path.isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? [owner.cwd] : (owner.config.env.PATH || '').split(path.delimiter);
    const suffixes = process.platform === 'win32' ? ['', ...(owner.config.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
    for (const directory of directories) for (const suffix of suffixes) {
      const candidate = path.resolve(directory, command + suffix);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the remaining PATH entries. */ }
    }
    throw new Error(`DSH MCP executable was not found: ${command}`);
  }

  private async acp(owner: DshOwner, prompt: string, model: string | undefined, options: AnyRecord): Promise<void> {
    const timeout = owner.config.timeoutMs;
    if (!owner.child) {
      const child = await this.launch(owner);
      child.onFrame = (frame) => {
        if (frame.method === 'session/update' && frame.params?.sessionId === owner.nativeId && owner.busy && !owner.aborted) {
          for (const message of this.events.normalize(frame.params, owner.id)) owner.writer.send(message);
        }
      };
      child.onRequest = async (method, params) => {
        if (method !== 'session/request_permission') throw new Error(`Unsupported ACP client method: ${method}`);
        if (params.sessionId !== owner.nativeId || !owner.busy || owner.aborted) return { outcome: { outcome: 'cancelled' } };
        const once = params.options?.find((entry: AnyRecord) => entry.kind === 'allow_once');
        if (owner.approvalBypass && once) return { outcome: { outcome: 'selected', optionId: once.optionId } };
        return new Promise((resolve) => {
          const requestId = `dsh:${randomUUID()}`;
          const availableDecisions = ['cancel', ...(once ? ['accept'] : []),
            ...(params.options?.some((entry: AnyRecord) => entry.kind === 'reject_once') ? ['decline'] : [])];
          const message = createNormalizedMessage({ provider: 'dsh', sessionId: owner.id, kind: 'permission_request', requestId,
            toolName: params.toolCall?.title ?? 'Tool', input: params.toolCall?.rawInput ?? params.toolCall,
            context: { provider: 'dsh', availableDecisions } });
          this.approvals.set(requestId, { owner, resolve, message, options: params.options ?? [] });
          owner.writer.send(message);
        });
      };
      const initialized = await child.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cloudcli', version: '1' } }, timeout);
      if (initialized.protocolVersion !== 1) throw new Error('Unsupported DSH ACP protocol version.');
      if (owner.aborted) return;
      const servers = await this.servers(owner);
      const created = owner.nativeId
        ? await child.request('session/resume', { sessionId: owner.nativeId, cwd: owner.cwd, mcpServers: servers }, timeout)
        : await child.request('session/new', { cwd: owner.cwd, mcpServers: servers }, timeout);
      const nativeId = owner.nativeId ?? created.sessionId;
      if (typeof nativeId !== 'string' || !nativeId) throw new Error('DSH did not return a session id.');
      owner.nativeId = nativeId;
      owner.writer.setSessionId?.(nativeId);
      owner.configOptions = created.configOptions ?? [];
      owner.defaultModel = owner.configOptions?.find((entry) => entry.id === 'model')?.currentValue;
    }
    const child = owner.child;
    if (!child || owner.aborted) return;
    const requestedModel = model === 'default' ? owner.defaultModel : model;
    if (requestedModel) {
      const modelOption = owner.configOptions?.find((entry) => entry.id === 'model');
      const choices: AnyRecord[] = (modelOption?.options ?? []).flatMap((entry: AnyRecord) => entry.options ?? [entry]);
      const matches = choices.filter((entry) => {
        if (entry.value === requestedModel) return true;
        try { const [provider, name] = JSON.parse(entry.value); return requestedModel === `${provider}/${name}` || requestedModel === name; } catch { return false; }
      });
      if (matches.length > 1) throw new Error(`DSH model ${model} is ambiguous. Use provider/model or an advertised ACP value.`);
      const match = matches[0];
      if (!match) throw new Error(`DSH does not advertise model ${model}. Use provider/model or an advertised ACP value.`);
      const selected = await child.request('session/set_config_option', { sessionId: owner.nativeId, configId: 'model', value: match.value }, timeout);
      owner.configOptions = selected.configOptions ?? owner.configOptions;
    }
    if (options.effort && options.effort !== 'default') {
      const effort = owner.configOptions?.find((entry) => entry.id === 'reasoning_effort');
      if (!effort?.options?.some((entry: AnyRecord) => entry.value === options.effort)) throw new Error('The selected DSH model does not advertise this reasoning effort.');
      await child.request('session/set_config_option', { sessionId: owner.nativeId, configId: 'reasoning_effort', value: options.effort }, timeout);
    }
    if (owner.aborted) return;
    const result = await child.request('session/prompt', { sessionId: owner.nativeId, prompt: [{ type: 'text', text: prompt }] }, 0);
    if (!owner.aborted && result.stopReason !== 'end_turn') throw new Error(`DSH stopped: ${result.stopReason || 'unknown reason'}`);
  }

  private async headless(owner: DshOwner, prompt: string, model: string | undefined, options: AnyRecord): Promise<void> {
    const rows: AnyRecord[] = [];
    if (model && model !== 'default' || options.effort && options.effort !== 'default') {
      if (!model || model === 'default') throw new Error('Choose an explicit DSH provider/model before setting headless effort.');
      let route: string[];
      try { route = JSON.parse(model); } catch {
        const slash = model.indexOf('/');
        route = slash >= 0 ? [model.slice(0, slash), model.slice(slash + 1)] : [owner.config.env.CLOUDCLI_DSH_PROVIDER || 'deepseek-official', model];
      }
      if (!Array.isArray(route) || route.length !== 2 || route.some((part) => typeof part !== 'string' || !part)) throw new Error('Invalid DSH model route.');
      rows.push({ id: 'agent-default-model', config: { provider: route[0], model: route[1], ...(options.effort && options.effort !== 'default' ? { reasoningEffort: options.effort } : {}) } });
    }
    const servers = await this.servers(owner);
    if (servers.length) rows.push({ insert: servers.map((server, index) => ({ id: `cloudcli-mcp-${index}`, name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: server.name, transport: server.type === 'http' ? 'streamable-http' : 'stdio',
      ...(server.type === 'http' ? { url: server.url, headers: Object.fromEntries(server.headers.map((entry: AnyRecord) => [entry.name, entry.value])) }
        : { command: server.command, args: server.args, env: Object.fromEntries(server.env.map((entry: AnyRecord) => [entry.name, entry.value])) }),
    } })) });
    const args = ['--json', ...(owner.nativeId ? ['--session-id', owner.nativeId] : []), '-'];
    const child = await this.launch(owner, rows, args);
    let final = false, step = 0, text = '';
    const runId = randomUUID();
    child.onFrame = (event) => {
      if (event.type === 'session') {
        if (typeof event.sessionId !== 'string' || owner.nativeId && owner.nativeId !== event.sessionId) throw new Error('DSH headless session identity changed unexpectedly.');
        owner.nativeId = event.sessionId; owner.writer.setSessionId?.(event.sessionId);
      } else if (event.type === 'status' && event.phase === 'step_start') { step++; text = ''; }
      else if (event.type === 'text' || event.type === 'final') {
        if (event.type === 'final') { final = true; text = event.text; } else text += event.text ?? '';
        if (text) owner.writer.send(createNormalizedMessage({ id: `dsh:${runId}:text:${step}`, provider: 'dsh', sessionId: owner.id, kind: 'text', role: 'assistant', content: text }));
      } else for (const message of this.events.normalize(event, owner.id)) owner.writer.send(message);
    };
    child.child.stdin?.end(prompt);
    const code = await child.exited;
    if (!owner.aborted && child.transportError) throw child.transportError;
    if (!owner.aborted && (code !== 0 || !final)) throw new Error(`DSH headless failed (${code ?? 'signal'}). ${child.errorTail}`);
  }

  private cancelApprovals(owner: DshOwner): void {
    for (const [id, request] of this.approvals) if (request.owner === owner) {
      this.approvals.delete(id); request.resolve({ outcome: { outcome: 'cancelled' } });
      owner.writer.send(createNormalizedMessage({ provider: 'dsh', sessionId: owner.id, kind: 'permission_resolved', requestId: id }));
    }
  }

  readonly permissions = {
    resolve: (id: string, decision: ProviderPermissionDecision): void => {
      const request = this.approvals.get(id);
      if (!request) return;
      const option = request.options.find((entry) => entry.kind === (decision.allow ? 'allow_once' : 'reject_once'));
      this.approvals.delete(id);
      request.resolve(decision.nativeDecision === 'cancel' || !option ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } });
      request.owner.writer.send(createNormalizedMessage({ provider: 'dsh', sessionId: request.owner.id, kind: 'permission_resolved', requestId: id }));
    },
    listPending: (sessionId: string): unknown[] => [...this.approvals.values()].filter((request) => request.owner.id === sessionId).map((request) => request.message),
  };

  async abort(sessionId: string): Promise<boolean> {
    const owner = this.owners.get(sessionId);
    if (!owner?.busy) return false;
    owner.aborted = true;
    this.cancelApprovals(owner);
    if (owner.config.mode === 'acp' && owner.nativeId && owner.child && !owner.child.isClosed) {
      owner.child.notify('session/cancel', { sessionId: owner.nativeId });
      const kill = setTimeout(() => { void owner.child?.close(); }, owner.config.timeoutMs);
      try { await owner.done; } finally { clearTimeout(kill); }
    } else { await owner.child?.close(); await owner.done; }
    return true;
  }

  private async release(owner: DshOwner, forget = true): Promise<void> {
    owner.releasing ??= (async () => {
      clearTimeout(owner.idle);
      this.cancelApprovals(owner);
      if (owner.config.mode === 'acp' && !owner.busy && owner.nativeId && owner.child && !owner.child.isClosed) {
        try { await owner.child.request('session/close', { sessionId: owner.nativeId }, owner.config.timeoutMs); } catch { /* EOF and signals still reap an unresponsive peer. */ }
      }
      await owner.child?.close();
      if (owner.directory) await rm(owner.directory, { recursive: true, force: true });
    })();
    try { await owner.releasing; } finally {
      if (forget && this.owners.get(owner.id) === owner) this.owners.delete(owner.id);
    }
  }

  listActiveSessions() { return [...this.owners.values()].filter((owner) => owner.busy).map((owner) => ({ sessionId: owner.id, startedAt: owner.startedAt })); }

  async close(): Promise<void> {
    await Promise.all([...this.owners.values()].map(async (owner) => { owner.aborted = true; await this.release(owner); await owner.done; }));
  }
}
