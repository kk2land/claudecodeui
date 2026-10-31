import { randomUUID, createHash } from 'node:crypto';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshProcess } from '@/modules/providers/list/dsh/dsh-process.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshSessionSynchronizer } from '@/modules/providers/list/dsh/dsh-session-synchronizer.provider.js';
import { rememberDshContextUsage } from '@/modules/providers/services/provider-token-usage.service.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { sessionRuntimeDb } from '@/modules/database/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, DshConfiguration, DshWorkerBridge, ProviderPermissionDecision, ProviderRuntimeAction, ProviderRuntimeState, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { AppError, createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';
import { appendFilesInputTag, appendImagesInputTag, isAllowedImageSourcePath, normalizeAttachmentDescriptors, resolveImageAbsolutePath } from '@/shared/image-attachments.js';

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
  worker?: Awaited<ReturnType<DshWorkerBridge['prepareSession']>>;
  cliVersion?: string;
  processStopped?: boolean;
};
type DshApproval = { owner: DshOwner; message: AnyRecord; options: AnyRecord[]; resolve(value: unknown): void };

/** Owns DSH ACP/headless processes for the provider runtime dispatcher. */
export class DshRuntimeProvider implements IProviderRuntime {
  private readonly owners = new Map<string, DshOwner>();
  private readonly approvals = new Map<string, DshApproval>();
  // A handoff/stop excludes new sends and queue dispatch until teardown has actually finished.
  private readonly transitions = new Map<string, { phase: 'switching' | 'stopping'; done: Promise<void> }>();
  // The Worker host scopes owners to this logical DSH instance. It survives ACP
  // idle recycling, so the same token can be reused when a wake-up resumes.
  private readonly runtimeInstanceId = `dsh:${randomUUID()}`;
  private workerBridge: DshWorkerBridge | null = null;

  constructor(
    private readonly configuration: DshConfigurationProvider,
    private readonly events: DshEventsProvider,
    private readonly mcp: DshMcpProvider,
    private readonly synchronizer: Pick<DshSessionSynchronizer, 'synchronize'>,
    private readonly settings: Pick<typeof sessionRuntimeDb, 'getDsh' | 'saveDsh'> = sessionRuntimeDb,
  ) {}

  /** The composition root installs the Worker bridge; providers never import workers. */
  setWorkerBridge(bridge: DshWorkerBridge | null): void {
    this.workerBridge = bridge;
  }

  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
    const id = String(options.sessionId || randomUUID());
    if (this.transitions.has(id)) throw new AppError('Wait for the DSH runtime change or stop to finish.', { code: 'DSH_RUNTIME_BUSY', statusCode: 409 });
    if (this.owners.get(id)?.busy) throw new Error('DSH session is already running; queue the next message.');
    const config = this.configuration.read();
    config.mode = this.settings.getDsh(id)?.runtime ?? config.mode;
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
    // A deferred Worker wake-up is a normal pause, not a provider failure. It
    // releases the reservation without publishing an error or a terminal.
    let deferred = false;
    try {
      if (previous) await this.release(previous);
      if (owner.aborted) return;
      if (options.permissionMode && !['default', 'bypassPermissions'].includes(options.permissionMode)) throw new Error('DSH supports the default permission policy; native plan and permission modes are unavailable.');
      const images = normalizeAttachmentDescriptors(options.images);
      for (const image of images) {
        const resolved = resolveImageAbsolutePath(owner.cwd, image.path);
        if (!isAllowedImageSourcePath(resolved, owner.cwd)
          || !isAllowedImageSourcePath(await realpath(resolved), owner.cwd)) {
          throw new Error('DSH image attachments must be inside the upload store or working directory.');
        }
        image.path = resolved;
      }
      // Both transports can use DSH's read_image tool. It checks the selected
      // model's image support and persists the image in native session history.
      const prompt = appendFilesInputTag(appendImagesInputTag(command, images), options.files);
      const model = await context.resolveResumeModel(owner.id, options.model);
      // Worker MCP is ACP-only. prepareSession is idempotent per application
      // session and runtime instance, and a null/failed result keeps plain chat
      // working without Worker tools. Headless never asks for or injects it.
      if (owner.config.mode === 'acp') {
        try {
          owner.worker = await this.workerBridge?.prepareSession({
            sessionId: owner.id,
            projectPath: String(options.projectPath ?? options.cwd ?? owner.cwd),
            userId: owner.writer.userId ?? null,
            runtimeInstanceId: this.runtimeInstanceId,
          }) ?? null;
        } catch {
          owner.worker = null;
        }
        if (owner.aborted) return;
        // Only an explicit interactive user turn may clear a paused owner; an
        // automatic wake-up must never resume Worker delivery on its own.
        if (options.userTurn === true && options.workerWakeup !== true) {
          await this.workerBridge?.activateSession(owner.id).catch(() => {});
        }
      } else {
        owner.worker = null;
      }
      const mcpSignature = JSON.stringify({ servers: await this.servers(owner), worker: owner.worker ?? null });
      if (owner.child && owner.mcpSignature !== mcpSignature) await this.closeChild(owner);
      owner.mcpSignature = mcpSignature;
      if (owner.aborted) return;
      if (owner.config.mode === 'headless') await this.headless(owner, prompt, model, options);
      else await this.acp(owner, prompt, model, options);
      success = !owner.aborted;
    } catch (error) {
      if (error instanceof AppError && error.code === 'WORKER_WAKE_DEFERRED') {
        deferred = true;
      } else if (!owner.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        owner.writer.send(createNormalizedMessage({ kind: 'error', provider: 'dsh', sessionId: owner.id, content: message }));
        notifyRunFailed({ userId: owner.writer.userId, provider: 'dsh', sessionId: options.sessionId ?? owner.id, error: message });
        // Never retry a prompt after a timeout or broken transport: delivery
        // may already have happened. Release the writer before any next run.
        await this.release(owner, false);
      }
      if (deferred || !owner.aborted) throw error;
    } finally {
      let exitCode = 1;
      try {
        this.cancelApprovals(owner);
        if (owner.nativeId) {
          try { await this.synchronizer.synchronize(); } catch (error) { console.warn('[DSH] History indexing failed:', error instanceof Error ? error.message : String(error)); }
        }
        if (this.owners.get(owner.id) === owner) {
          if (owner.config.mode === 'headless' || owner.aborted || !success) await this.release(owner);
          else this.scheduleIdle(owner);
        }
        exitCode = success ? 0 : 1;
      } finally {
        // Complete makes the registry idle and allows the queue to claim its
        // next turn. Publish it only after teardown and this busy guard end.
        // No owner mutation or asynchronous cleanup may follow the terminal.
        owner.busy = false;
        if (!deferred && owner.processStopped) {
          owner.writer.send(createCompleteMessage({ provider: 'dsh', sessionId: owner.id, exitCode: 0, aborted: true }));
        } else if (!deferred && !owner.aborted) {
          if (exitCode === 0) notifyRunStopped({ userId: owner.writer.userId, provider: 'dsh', sessionId: options.sessionId ?? owner.id, stopReason: 'completed' });
          owner.writer.send(createCompleteMessage({ provider: 'dsh', sessionId: owner.id, exitCode }));
        }
      }
    }
  }

  /**
   * Idle recycling closes only this ACP process. While this owner's Workers
   * still run, keep the process and re-arm the same idle interval; explicit
   * Stop, runtime handoff and close clear the timer through release().
   */
  private scheduleIdle(owner: DshOwner): void {
    clearTimeout(owner.idle);
    owner.idle = setTimeout(() => { void this.releaseIdleOwner(owner); }, owner.config.idleMs);
    owner.idle.unref();
  }

  /** A Worker-lifecycle query or release failure must never escape the timer. */
  private async releaseIdleOwner(owner: DshOwner): Promise<void> {
    try {
      if (this.owners.get(owner.id) !== owner || owner.busy || owner.aborted) return;
      let active = false;
      // A failed query must not pin the transport forever; normal recycling wins.
      try { active = await this.workerBridge?.hasActiveWorkers(owner.id) ?? false; } catch { active = false; }
      // A turn, Stop or shutdown can replace or abort the owner while the bridge answers.
      if (this.owners.get(owner.id) !== owner || owner.busy || owner.aborted) return;
      if (active) this.scheduleIdle(owner);
      else await this.release(owner);
    } catch (error) {
      console.warn('[DSH] Idle cleanup failed:', error instanceof Error ? error.message : String(error));
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

  /** Closes one ACP generation and recycles its temporary patch directory. */
  private async closeChild(owner: DshOwner): Promise<void> {
    await owner.child?.close();
    owner.child = undefined;
    if (owner.directory) await rm(owner.directory, { recursive: true, force: true });
    owner.directory = undefined;
  }

  /** Fences and cancels the Worker owner; any rejection or synchronous throw is unconfirmed. */
  private async stopWorkerOwner(sessionId: string, reason: string): Promise<boolean> {
    try {
      return await this.workerBridge?.stopSession(sessionId, reason) ?? true;
    } catch {
      return false;
    }
  }

  /** Stop joins cleanup while the dispatcher still receives normal wake-up deferral. */
  private async waitForStoppedRun(owner: DshOwner): Promise<void> {
    try { await owner.done; } catch (error) {
      if (!(error instanceof AppError && error.code === 'WORKER_WAKE_DEFERRED')) throw error;
    }
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
      const child = await this.launch(owner, owner.worker ? [{ insert: [{
        id: 'cloudcli-workers-mcp', name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'cloudcli_workers', transport: 'streamable-http', ...owner.worker },
      }] }] : []);
      child.onFrame = (frame) => {
        if (frame.method === 'session/update' && frame.params?.sessionId === owner.nativeId && owner.busy && !owner.aborted) {
          for (const message of this.events.normalize(frame.params, owner.id)) {
            // usage_update is the only authoritative DSH context reading; keep
            // it for this app session so the token-usage refresh can reuse it.
            if (message.kind === 'status' && message.text === 'token_budget' && message.tokenBudget) {
              rememberDshContextUsage(owner.id, message.tokenBudget as { used: number; total: number });
            }
            owner.writer.send(message);
          }
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
      owner.cliVersion = typeof initialized.agentInfo?.version === 'string' ? initialized.agentInfo.version : undefined;
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
    // Consult the trusted final gate only after every model/initialization
    // await, immediately before the native prompt exists. A false result
    // leaves the host outbox pending without a failed run.
    const deferTurn = typeof options.deferTurn === 'function'
      ? options.deferTurn as () => boolean
      : null;
    if (deferTurn && !deferTurn()) {
      throw new AppError('The Worker wake-up was deferred until the session is idle.', {
        code: 'WORKER_WAKE_DEFERRED', statusCode: 409,
      });
    }
    // Covers a user message queued or Stop pressed during asynchronous
    // initialization; the trusted host callback confirms delivery now.
    options.onTurnStarting?.();
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

  /** Providers' runtime panel uses these application controls without issuing Codex-native commands. */
  readonly management = {
    getState: (sessionId: string | null): ProviderRuntimeState => {
      const owner = sessionId ? this.owners.get(sessionId) : undefined;
      const saved = sessionId ? this.settings.getDsh(sessionId) : null;
      const runtime = saved?.runtime ?? this.configuration.read().mode;
      const child = owner?.child;
      const running = Boolean(child?.isRunning);
      return {
        runtime,
        phase: (sessionId && this.transitions.get(sessionId)?.phase) || (owner?.busy ? running ? 'running' : 'starting' : 'idle'),
        queueHeld: saved?.queueHeld ?? false,
        supportsPermissionRequests: runtime === 'acp',
        workerEnabled: runtime === 'acp' && Boolean(sessionId && this.workerBridge?.isSessionEnabled(sessionId)),
        diagnostics: {
          running, pid: running ? child!.child.pid! : null,
          startedAt: running ? child!.startedAt : null,
          launcherPath: running ? child!.child.spawnfile : null,
          cliVersion: running ? owner?.cliVersion ?? null : null,
        },
      };
    },
    control: async (sessionId: string, action: ProviderRuntimeAction): Promise<ProviderRuntimeState> => {
      const transition = this.transitions.get(sessionId);
      if (transition) {
        if (action.action !== 'stop' || transition.phase !== 'stopping') {
          throw new AppError('Wait for the DSH runtime change or stop to finish.', { code: 'DSH_RUNTIME_BUSY', statusCode: 409 });
        }
        await transition.done;
        return this.management.getState(sessionId);
      }
      const state = this.management.getState(sessionId);
      const owner = this.owners.get(sessionId);
      if (action.action === 'queue-resume') {
        this.settings.saveDsh(sessionId, { runtime: state.runtime as DshConfiguration['mode'], queueHeld: false });
        return this.management.getState(sessionId);
      }
      if (action.action === 'runtime') {
        if (action.runtime !== 'acp' && action.runtime !== 'headless') {
          throw new AppError('DSH supports only acp and headless.', { code: 'INVALID_RUNTIME', statusCode: 400 });
        }
        if (owner?.busy) throw new AppError('Stop this session before changing its runtime.', { code: 'DSH_RUNTIME_BUSY', statusCode: 409 });
        if (state.runtime === action.runtime) return state;
      } else if (state.runtime !== 'acp') {
        throw new AppError('Only the DSH ACP process can be stopped from this panel.', { code: 'UNSUPPORTED_RUNTIME_CONTROL', statusCode: 409 });
      }

      // Stop the associated Workers immediately, before native teardown or any
      // other await. The host fences locally in stopSession, so a false or
      // rejected result must keep the queue held instead of claiming success.
      const stopWorkers = action.action === 'stop'
        || (action.action === 'runtime' && action.runtime === 'headless' && state.runtime === 'acp');
      const workerCleanup = stopWorkers
        ? this.stopWorkerOwner(sessionId, action.action === 'stop' ? 'session-stop' : 'runtime-headless')
        : Promise.resolve(true);
      // Defer cleanup until the gate is installed, including a stop during asynchronous startup.
      const done = Promise.resolve().then(async () => {
        if (action.action === 'stop') {
          this.settings.saveDsh(sessionId, { runtime: 'acp', queueHeld: true });
          if (owner) {
            owner.processStopped = owner.busy;
            owner.aborted = true;
            this.cancelApprovals(owner);
            // Closing stdio and bounded signals also stops a stuck initialize/prompt RPC.
            if (owner.busy) {
              await owner.child?.close();
              // execute owns cleanup until startup/indexing finish, including patches created after stop.
              await this.waitForStoppedRun(owner);
            }
            await this.release(owner);
          }
          if (!await workerCleanup) {
            throw new AppError('DSH Worker cleanup was not confirmed. The session remains paused; retry the stop.', {
              code: 'DSH_WORKER_STOP_UNCONFIRMED', statusCode: 409,
            });
          }
        } else {
          if (owner) await this.release(owner);
          if (!await workerCleanup) {
            // Keep the current transport and explicit pause: a Worker owner
            // that did not confirm cancellation must not be handed to headless.
            this.settings.saveDsh(sessionId, { runtime: state.runtime as DshConfiguration['mode'], queueHeld: true });
            throw new AppError('DSH Worker cleanup was not confirmed. The runtime was not changed and the session remains paused.', {
              code: 'DSH_WORKER_STOP_UNCONFIRMED', statusCode: 409,
            });
          }
          this.settings.saveDsh(sessionId, { runtime: action.runtime as DshConfiguration['mode'], queueHeld: state.queueHeld });
        }
      });
      this.transitions.set(sessionId, { phase: action.action === 'stop' ? 'stopping' : 'switching', done });
      try { await done; } finally { this.transitions.delete(sessionId); }
      return this.management.getState(sessionId);
    },
  };

  isQueueBlocked(sessionId: string): boolean {
    return this.transitions.has(sessionId) || Boolean(this.settings.getDsh(sessionId)?.queueHeld);
  }

  async abort(sessionId: string): Promise<boolean> {
    // Stop is a synchronous host fence first; native interruption is
    // independent. This also cancels Workers when ACP idle recycling already
    // removed the local owner.
    const workerCleanup = this.stopWorkerOwner(sessionId, 'session-stop');
    const owner = this.owners.get(sessionId);
    if (!owner?.busy) {
      const workersStopped = await workerCleanup;
      if (!workersStopped) {
        this.settings.saveDsh(sessionId, { runtime: this.management.getState(sessionId).runtime as DshConfiguration['mode'], queueHeld: true });
      }
      return workersStopped;
    }
    owner.aborted = true;
    this.cancelApprovals(owner);
    if (owner.config.mode === 'acp' && owner.nativeId && owner.child && !owner.child.isClosed) {
      owner.child.notify('session/cancel', { sessionId: owner.nativeId });
      const kill = setTimeout(() => { void owner.child?.close(); }, owner.config.timeoutMs);
      try { await this.waitForStoppedRun(owner); } finally { clearTimeout(kill); }
    } else { await owner.child?.close(); await this.waitForStoppedRun(owner); }
    const workersStopped = await workerCleanup;
    if (!workersStopped) {
      this.settings.saveDsh(sessionId, { runtime: owner.config.mode, queueHeld: true });
      return false;
    }
    return true;
  }

  private async release(owner: DshOwner, forget = true): Promise<void> {
    owner.releasing ??= (async () => {
      clearTimeout(owner.idle);
      this.cancelApprovals(owner);
      if (owner.config.mode === 'acp' && !owner.busy && owner.nativeId && owner.child && !owner.child.isClosed) {
        try { await owner.child.request('session/close', { sessionId: owner.nativeId }, owner.config.timeoutMs); } catch { /* EOF and signals still reap an unresponsive peer. */ }
      }
      await this.closeChild(owner);
    })();
    try { await owner.releasing; } finally {
      if (forget && this.owners.get(owner.id) === owner) this.owners.delete(owner.id);
    }
  }

  listActiveSessions() { return [...this.owners.values()].filter((owner) => owner.busy).map((owner) => ({ sessionId: owner.id, startedAt: owner.startedAt })); }

  async close(): Promise<void> {
    await Promise.all([...this.owners.values()].map(async (owner) => { owner.aborted = true; await this.release(owner); await this.waitForStoppedRun(owner); }));
    // Closing the runtime cancels every Worker owner scoped to this logical DSH
    // instance. A single ACP process exit is not a runtime lifetime boundary.
    await this.workerBridge?.closeRuntime(this.runtimeInstanceId, 'DSH runtime closed.').catch(() => {});
  }
}
