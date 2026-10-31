import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WorkerStore } from "./store.js";
import { WorkspaceManager } from "./worktree.js";
import {
  nativeHome,
  newProgress,
  parseDsh,
  parsePi,
  prepareLaunch,
  resolveExecutable,
  trackProgress,
  PI_THINKING_LEVELS,
} from "./native.js";
import type { ProgressTracker } from "./native.js";
import { readLogPage } from "./logs.js";
import { sweepNativeSessions } from "./native-retention.js";
import type {
  GuardianEvidence,
  WorkerCancelInput,
  WorkerCleanupInput,
  WorkerDefaults,
  WorkerLogQuery,
  WorkerNotification,
  WorkerNotificationDelivery,
  WorkerOwner,
  WorkerRecord,
  WorkerRecoverInput,
  WorkerResumeInput,
  WorkerRun,
  WorkerSettings,
  WorkerSettingsInput,
  WorkerStartInput,
  WorkerStateQuery,
  WorkerStateSnapshot,
  WorkerStatus,
  WorkerType,
} from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";

const STATUSES: WorkerStatus[] = [
  "queued",
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
];
const OCCUPYING: WorkerStatus[] = ["starting", "running", "stopping", "unknown"];
const ACTIVE_REFERENCES: WorkerStatus[] = ["queued", ...OCCUPYING];
const TERMINAL: WorkerStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];
const MAX_WAIT_MS = 25_000;

type RegisteredOwner = { owner: WorkerOwner; token: string };
type NativeSelection = {
  model: string | null;
  provider: string | null;
  effort: string | null;
};

type RunHandle = {
  runId: string;
  workerId: string;
  ownerId: string;
  child: ChildProcess;
  ended: Promise<void>;
  resolveEnded: () => void;
  finalized: boolean;
  holdNotification: boolean;
  stopRequested: boolean;
  progress: ProgressTracker;
  expectedSessionId: string | null;
  lastProgressSave: number;
  stopTimer?: NodeJS.Timeout;
};

export type WorkerServiceOptions = {
  dataDirectory: string;
  environment?: NodeJS.ProcessEnv;
  /** Tests inject fixture executables; production resolves `dsh`/`pi` from PATH. */
  executablePaths?: Partial<Record<WorkerType, string>>;
  /** Tests inject a source guardian invocation; production uses compiled guardian.mjs. */
  guardianCommand?: string[];
  dshPatch?: string;
  now?: () => number;
  /** Test/diagnostic hook mirroring IPC events; never exposes tokens. */
  onEvent?: (event: unknown) => void;
};

/** Typed execution service shared by MCP, protected UI REST, and host IPC. */
export class WorkerService {
  readonly store: WorkerStore;
  readonly workspace: WorkspaceManager;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly owners = new Map<string, RegisteredOwner>();
  private readonly tokens = new Map<string, string>();
  private readonly handles = new Map<string, RunHandle>();
  private readonly prompts = new Map<string, string>();
  private readonly pendingAdmissions = new Set<string>();
  private readonly reminderTimer: NodeJS.Timeout;
  private readonly retentionTimer: NodeJS.Timeout;
  private nativeRetentionTimer: NodeJS.Timeout | null = null;
  private nativeRetentionSweep: Promise<void> | null = null;
  private dispatching = false;
  private closing = false;
  private recovering = false;
  private storeClosed = false;

  constructor(private readonly options: WorkerServiceOptions) {
    this.store = new WorkerStore(options.dataDirectory);
    this.workspace = new WorkspaceManager(options.dataDirectory);
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.reminderTimer = setInterval(() => this.checkReminders(), 1000);
    this.reminderTimer.unref?.();
    this.retentionTimer = setInterval(() => this.pruneHistory(), 60_000);
    this.retentionTimer.unref?.();
  }

  //------------------ OWNERS AND SETTINGS ----------------

  registerOwner(owner: WorkerOwner, token: string): WorkerOwner {
    if (!owner || typeof owner !== "object")
      throw new WorkerFailure("INVALID_OWNER", "owner 必须为对象");
    for (const key of [
      "id",
      "parentSessionId",
      "projectId",
      "projectPath",
      "appServerInstanceId",
    ] as const) {
      if (typeof owner[key] !== "string" || !owner[key].trim())
        throw new WorkerFailure("INVALID_OWNER", "owner." + key + " 不能为空");
    }
    if (typeof token !== "string" || !token.trim())
      throw new WorkerFailure("INVALID_TOKEN", "owner token 不能为空");
    if (owner.userId !== null && !["string", "number"].includes(typeof owner.userId))
      throw new WorkerFailure("INVALID_OWNER", "owner.userId 必须是字符串、数字或 null");
    if (this.tokens.has(token) && this.tokens.get(token) !== owner.id)
      throw new WorkerFailure("TOKEN_CONFLICT", "owner token 已被占用");
    // Copy only contract fields so a stray token in the owner object is never persisted.
    const stored: WorkerOwner = {
      id: owner.id,
      parentSessionId: owner.parentSessionId,
      projectId: owner.projectId,
      projectPath: owner.projectPath,
      userId: owner.userId,
      appServerInstanceId: owner.appServerInstanceId,
      paused: Boolean(owner.paused),
      pausedReason: owner.pausedReason ?? undefined,
    };
    const previous = this.owners.get(stored.id);
    if (previous) this.tokens.delete(previous.token);
    this.owners.set(stored.id, { owner: stored, token });
    this.tokens.set(token, stored.id);
    this.store.saveOwner(stored);
    if (stored.paused) this.holdPendingNotifications(stored.id);
    return stored;
  }

  ownerForToken(token: string | undefined): WorkerOwner | null {
    if (!token) return null;
    const id = this.tokens.get(token);
    return id ? this.owners.get(id)?.owner ?? null : null;
  }

  owner(ownerId: string): WorkerOwner | null {
    return this.owners.get(ownerId)?.owner ?? null;
  }

  settings(): WorkerSettings {
    return this.store.settings();
  }

  updateSettings(input: WorkerSettingsInput): WorkerSettings {
    const dsh = input?.concurrency?.dsh;
    const pi = input?.concurrency?.pi;
    if (
      !Number.isSafeInteger(dsh) ||
      (dsh as number) < 1 ||
      !Number.isSafeInteger(pi) ||
      (pi as number) < 1
    )
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "concurrency.dsh 和 concurrency.pi 必须是正整数",
      );
    if (
      input.defaultWorkerType !== undefined &&
      input.defaultWorkerType !== "dsh" &&
      input.defaultWorkerType !== "pi"
    )
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "defaultWorkerType 必须是 dsh 或 pi",
      );
    if (
      input.retentionDays !== undefined &&
      (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1)
    )
      throw new WorkerFailure("INVALID_SETTINGS", "retentionDays 必须是正整数");
    const current = this.store.settings();
    // Validate the complete candidate before mutating or saving anything, so an invalid field
    // never partially persists.
    const settings: WorkerSettings = {
      ...current,
      concurrency: { dsh: dsh as number, pi: pi as number },
      defaultWorkerType: input.defaultWorkerType ?? current.defaultWorkerType,
      defaults:
        input.defaults === undefined
          ? current.defaults
          : this.validateDefaults(input.defaults),
      retentionDays: input.retentionDays ?? current.retentionDays,
    };
    this.store.saveSettings(settings);
    this.pruneHistory();
    void this.dispatch();
    return settings;
  }

  /** Validates a full dsh/pi defaults map and normalizes blank strings to null. */
  private validateDefaults(value: WorkerDefaults): WorkerDefaults {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "defaults 必须包含 dsh 和 pi 两个配置对象",
      );
    const result = {} as WorkerDefaults;
    for (const type of ["dsh", "pi"] as const) {
      const entry = value[type];
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults." + type + " 必须是配置对象",
        );
      const model = entry.model;
      const effort = entry.effort;
      if (model !== undefined && model !== null && typeof model !== "string")
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults." + type + ".model 必须是字符串或 null",
        );
      if (effort !== undefined && effort !== null && typeof effort !== "string")
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults." + type + ".effort 必须是字符串或 null",
        );
      const normalizedModel = clean(model);
      const normalizedEffort = clean(effort);
      if (
        type === "pi" &&
        normalizedEffort &&
        !(PI_THINKING_LEVELS as readonly string[]).includes(normalizedEffort)
      )
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults.pi.effort 必须是受支持的 Pi thinking 级别",
        );
      if (type === "dsh" && normalizedEffort && !normalizedModel)
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults.dsh.effort 需要同时配置 defaults.dsh.model",
        );
      result[type] = { model: normalizedModel, effort: normalizedEffort };
    }
    return result;
  }

  //------------------ START AND RESUME ----------------

  async start(
    ownerId: string,
    input: WorkerStartInput,
  ): Promise<{ worker: WorkerRecord; run: WorkerRun }> {
    const owner = this.requireOwner(ownerId);
    if (owner.paused)
      throw new WorkerFailure("OWNER_PAUSED", "owner 已暂停，不接受新任务");
    this.validateStart(input);
    const requestId = input.requestId.trim();
    const requestKey = this.requestKey(owner);
    const fingerprint = this.fingerprint("start", this.startFingerprint(input));
    const existing = this.store.request(requestKey, requestId);
    if (existing) {
      this.assertReplay(existing, "start", fingerprint);
      return this.resultOf(existing.workerId, existing.runId);
    }
    // Resolve mutable settings only after replay lookup: an omitted type must not reinterpret a
    // request whose original run already exists.
    const settings = this.store.settings();
    const type = input.type ?? settings.defaultWorkerType;
    const selection = this.startSelection(type, input, settings.defaults[type]);
    this.validateSelection(type, selection);
    const timeoutSeconds = this.timeoutFor(input.timeoutSeconds, settings);
    const id = randomUUID();
    const runId = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    const homes = nativeHome(type, this.options.dataDirectory, this.environment);
    const run: WorkerRun = {
      id: runId,
      workerId: id,
      requestId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      model: selection.model,
      provider: selection.provider,
      effort: selection.effort,
      timeoutSeconds,
      home: homes.home,
      sessionsRoot: homes.sessionsRoot,
      nativeSessionId: null,
      nativeSessionFile: null,
      exitCode: null,
      finalText: null,
      error: null,
      usage: null,
      progress: {
        steps: null,
        phase: null,
        currentTool: null,
        lastEventAt: null,
        softReminderSentAt: null,
        hardTimeoutAt: null,
      },
    };
    const worker: WorkerRecord = {
      id,
      type,
      taskName: input.taskName.trim(),
      ownerId,
      parentSessionId: owner.parentSessionId,
      projectId: owner.projectId,
      projectPath: owner.projectPath,
      writePaths: [...input.writePaths],
      workspace: {
        mode: input.workspace.mode,
        path: owner.projectPath,
      },
      cwd: owner.projectPath,
      createdAt,
      latestRun: null,
    };
    // Admission is synchronous so a concurrent duplicate cannot observe a half-created worker.
    this.store.createWorker(
      worker,
      run,
      requestKey,
      requestId,
      "start",
      fingerprint,
    );
    this.prompts.set(runId, input.prompt);
    this.pendingAdmissions.add(runId);
    try {
      const workspace = await this.workspace.resolve(
        id,
        owner.projectPath,
        input.workspace,
      );
      worker.workspace = workspace;
      worker.cwd = workspace.path;
      this.store.replaceWorkspace(id, workspace);
    } catch (error) {
      this.finishAdmissionFailure(run, error);
      return this.resultOf(id, runId);
    } finally {
      this.pendingAdmissions.delete(runId);
    }
    void this.dispatch();
    return this.resultOf(id, runId);
  }

  async resume(
    ownerId: string,
    input: WorkerResumeInput,
  ): Promise<{ worker: WorkerRecord; run: WorkerRun }> {
    const owner = this.requireOwner(ownerId);
    if (owner.paused)
      throw new WorkerFailure("OWNER_PAUSED", "owner 已暂停，不接受新任务");
    this.validateResume(input);
    const requestId = input.requestId.trim();
    const requestKey = this.requestKey(owner);
    const fingerprint = this.fingerprint("resume", this.resumeFingerprint(input));
    const existing = this.store.request(requestKey, requestId);
    if (existing) {
      this.assertReplay(existing, "resume", fingerprint);
      return this.resultOf(existing.workerId, existing.runId);
    }
    const worker = this.ownedWorker(ownerId, input.workerId);
    if (this.store.workerCleanedAt(worker.id))
      throw new WorkerFailure("WORKSPACE_CLEANED", "worktree 已清理，请为后续任务创建新的 worker");
    const previous = this.store.latestRun(worker.id);
    if (!previous)
      throw new WorkerFailure("RUN_NOT_FOUND", "worker 尚无运行记录");
    if (!TERMINAL.includes(previous.status))
      throw new WorkerFailure("ACTIVE_RUN", "worker 仍有活动运行，不能续接");
    if (
      !previous.nativeSessionId ||
      (worker.type === "pi" && !previous.nativeSessionFile)
    )
      throw new WorkerFailure(
        "NATIVE_SESSION_UNKNOWN",
        "上一次运行没有可核实的原生会话身份，不能续接",
      );
    const selection = this.resumeSelection(input, previous);
    this.validateSelection(worker.type, selection);
    const settings = this.store.settings();
    const runId = randomUUID();
    const timeoutSeconds =
      input.timeoutSeconds === undefined
        ? previous.timeoutSeconds
        : this.timeoutFor(input.timeoutSeconds, settings);
    const run: WorkerRun = {
      id: runId,
      workerId: worker.id,
      requestId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      model: selection.model,
      provider: selection.provider,
      effort: selection.effort,
      timeoutSeconds,
      home: previous.home,
      sessionsRoot: previous.sessionsRoot,
      nativeSessionId: previous.nativeSessionId,
      nativeSessionFile: previous.nativeSessionFile,
      exitCode: null,
      finalText: null,
      error: null,
      usage: null,
      progress: {
        steps: null,
        phase: null,
        currentTool: null,
        lastEventAt: null,
        softReminderSentAt: null,
        hardTimeoutAt: null,
      },
    };
    const rebound: WorkerRecord = {
      ...worker,
      ownerId: owner.id,
      parentSessionId: owner.parentSessionId,
      projectId: owner.projectId,
    };
    this.store.transaction(() => {
      // An explicit resume rebinds only this stopped worker to the current generation.
      this.store.saveWorker(rebound);
      this.store.insertRun(run);
      this.store.addRequest(
        requestKey,
        requestId,
        worker.id,
        run.id,
        "resume",
        fingerprint,
      );
    });
    this.prompts.set(runId, input.prompt);
    void this.dispatch();
    return this.resultOf(worker.id, runId);
  }

  private validateStart(input: WorkerStartInput): void {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_INPUT", "请求体无效");
    if (typeof input.taskName !== "string" || !input.taskName.trim())
      throw new WorkerFailure("INVALID_INPUT", "taskName 不能为空");
    if (
      input.type !== undefined &&
      input.type !== "dsh" &&
      input.type !== "pi"
    )
      throw new WorkerFailure("INVALID_INPUT", "type 必须是 dsh 或 pi");
    if (typeof input.prompt !== "string" || !input.prompt.trim())
      throw new WorkerFailure("INVALID_INPUT", "prompt 不能为空");
    if (typeof input.requestId !== "string" || !input.requestId.trim())
      throw new WorkerFailure("INVALID_INPUT", "requestId 不能为空");
    if (!input.workspace || typeof input.workspace !== "object")
      throw new WorkerFailure("INVALID_INPUT", "workspace 不能为空");
    if (input.workspace.mode !== "worktree" && input.workspace.mode !== "existing")
      throw new WorkerFailure(
        "INVALID_INPUT",
        "workspace.mode 必须显式选择 worktree 或 existing",
      );
    if (!Array.isArray(input.writePaths) || input.writePaths.some((item) => typeof item !== "string"))
      throw new WorkerFailure("INVALID_INPUT", "writePaths 必须是字符串数组");
    if (input.workspace.cwd !== undefined && typeof input.workspace.cwd !== "string")
      throw new WorkerFailure("INVALID_INPUT", "workspace.cwd 必须是字符串");
    if (input.workspace.baseRef !== undefined && typeof input.workspace.baseRef !== "string")
      throw new WorkerFailure("INVALID_INPUT", "workspace.baseRef 必须是字符串");
    if (
      input.workspace.allowDirtySource !== undefined &&
      typeof input.workspace.allowDirtySource !== "boolean"
    )
      throw new WorkerFailure("INVALID_INPUT", "allowDirtySource 必须是布尔值");
    if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null) {
      if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0)
        throw new WorkerFailure("INVALID_INPUT", "timeoutSeconds 必须是正整数或 null");
    }
    this.validateOptionalSelection(input);
  }

  private validateResume(input: WorkerResumeInput): void {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_INPUT", "请求体无效");
    if (typeof input.workerId !== "string" || !input.workerId.trim())
      throw new WorkerFailure("INVALID_INPUT", "workerId 不能为空");
    if (typeof input.prompt !== "string" || !input.prompt.trim())
      throw new WorkerFailure("INVALID_INPUT", "prompt 不能为空");
    if (typeof input.requestId !== "string" || !input.requestId.trim())
      throw new WorkerFailure("INVALID_INPUT", "requestId 不能为空");
    if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null) {
      if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0)
        throw new WorkerFailure("INVALID_INPUT", "timeoutSeconds 必须是正整数或 null");
    }
    this.validateOptionalSelection(input);
  }

  private validateOptionalSelection(input: {
    model?: string;
    provider?: string;
    effort?: string;
  }): void {
    for (const key of ["model", "provider", "effort"] as const)
      if (input[key] !== undefined && typeof input[key] !== "string")
        throw new WorkerFailure("INVALID_INPUT", key + " 必须是字符串");
  }

  private fingerprint(operation: string, payload: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify({ operation, payload }))
      .digest("hex");
  }

  private startFingerprint(input: WorkerStartInput): unknown {
    return {
      taskName: input.taskName.trim(),
      type: input.type,
      prompt: input.prompt,
      workspace: {
        mode: input.workspace.mode,
        cwd: clean(input.workspace.cwd),
        baseRef: clean(input.workspace.baseRef),
        allowDirtySource: input.workspace.allowDirtySource === true,
      },
      writePaths: [...input.writePaths],
      model: clean(input.model),
      provider: clean(input.provider),
      effort: clean(input.effort),
      timeoutSeconds:
        input.timeoutSeconds === undefined ? "default" : input.timeoutSeconds,
    };
  }

  private resumeFingerprint(input: WorkerResumeInput): unknown {
    return {
      workerId: input.workerId.trim(),
      prompt: input.prompt,
      model: clean(input.model),
      provider: clean(input.provider),
      effort: clean(input.effort),
      timeoutSeconds:
        input.timeoutSeconds === undefined ? "default" : input.timeoutSeconds,
    };
  }

  private assertReplay(
    existing: {
      operation: string;
      fingerprint: string;
      workerId: string;
      runId: string;
    },
    operation: string,
    fingerprint: string,
  ): void {
    if (
      existing.operation !== operation ||
      existing.fingerprint !== fingerprint
    )
      throw new WorkerFailure(
        "REQUEST_ID_CONFLICT",
        "requestId 已用于不同的请求内容或操作",
      );
  }

  /**
   * New runs snapshot the explicit request first, then the selected type's configured defaults,
   * then the existing Pi environment fallback. DSH has no environment model fallback.
   */
  private startSelection(
    type: WorkerType,
    input: {
      model?: string;
      provider?: string;
      effort?: string;
    },
    defaults: WorkerDefaults[WorkerType],
  ): NativeSelection {
    const configuredModel = clean(defaults.model);
    const configuredEffort = clean(defaults.effort);
    if (type === "dsh")
      return {
        model: clean(input.model) ?? configuredModel,
        provider: clean(input.provider),
        effort: clean(input.effort) ?? configuredEffort,
      };
    return {
      model:
        clean(input.model) ??
        configuredModel ??
        clean(this.environment.CODEX_PI_MODEL),
      provider:
        clean(input.provider) ?? clean(this.environment.CODEX_PI_PROVIDER),
      effort:
        clean(input.effort) ??
        configuredEffort ??
        clean(this.environment.CODEX_PI_THINKING),
    };
  }

  /** Resume never re-reads the environment; explicit values override the recorded run. */
  private resumeSelection(
    input: { model?: string; provider?: string; effort?: string },
    previous: WorkerRun,
  ): NativeSelection {
    return {
      model: clean(input.model) ?? previous.model,
      provider: clean(input.provider) ?? previous.provider,
      effort: clean(input.effort) ?? previous.effort,
    };
  }

  private validateSelection(type: WorkerType, selection: NativeSelection): void {
    if (selection.provider && !selection.model)
      throw new WorkerFailure("MODEL_REQUIRED", "provider 需要同时选择模型");
    if (type === "dsh" && selection.effort && !selection.model)
      throw new WorkerFailure("MODEL_REQUIRED", "DSH effort 需要同时选择模型");
    if (
      type === "pi" &&
      selection.effort &&
      !(PI_THINKING_LEVELS as readonly string[]).includes(selection.effort)
    )
      throw new WorkerFailure("INVALID_INPUT", "不支持的 Pi thinking 级别");
  }

  private timeoutFor(
    value: number | null | undefined,
    settings: WorkerSettings,
  ): number | null {
    if (value === null) return null;
    if (value === undefined) return settings.hardTimeoutSeconds;
    return value;
  }

  //------------------ DISPATCH AND GUARDIAN ----------------

  private async dispatch(): Promise<void> {
    if (this.dispatching || this.closing || this.recovering) return;
    this.dispatching = true;
    try {
      const skipped = new Set<string>();
      for (;;) {
        const queued = this.store.queuedRuns().filter((run) => !skipped.has(run.id));
        if (!queued.length) return;
        const settings = this.store.settings();
        const occupied = this.store.occupyingRuns();
        const counts = new Map<string, number>();
        for (const run of occupied) {
          const worker = this.store.worker(run.workerId);
          if (!worker) continue;
          const key = [worker.parentSessionId, worker.projectId, worker.type].join("\u0000");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let selected: WorkerRun | null = null;
        for (const run of queued) {
          // Worktree admission is still resolving; never spawn from a placeholder cwd.
          if (this.pendingAdmissions.has(run.id)) continue;
          const worker = this.store.worker(run.workerId);
          if (!worker) {
            skipped.add(run.id);
            continue;
          }
          const registered = this.owners.get(worker.ownerId);
          if (!registered || registered.owner.paused) {
            skipped.add(run.id);
            continue;
          }
          const key = [worker.parentSessionId, worker.projectId, worker.type].join("\u0000");
          if ((counts.get(key) ?? 0) >= settings.concurrency[worker.type]) continue;
          selected = run;
          break;
        }
        if (!selected) return;
        const worker = this.store.worker(selected.workerId);
        const owner = worker ? this.owners.get(worker.ownerId)?.owner : null;
        if (!worker || !owner) {
          skipped.add(selected.id);
          continue;
        }
        selected.status = "starting";
        selected.startedAt = new Date(this.now()).toISOString();
        selected.progress.hardTimeoutAt = selected.timeoutSeconds === null
          ? null
          : new Date(Date.parse(selected.startedAt) + selected.timeoutSeconds * 1000).toISOString();
        this.store.saveRun(selected);
        try {
          this.launch(worker, owner, selected);
        } catch (error) {
          this.finishAdmissionFailure(selected, error);
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  private launch(worker: WorkerRecord, owner: WorkerOwner, run: WorkerRun): void {
    const runDirectory = this.runDirectory(worker.id, run.id);
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const prompt = this.prompts.get(run.id) ?? "";
    if (!prompt) throw new WorkerFailure("PROMPT_MISSING", "运行 prompt 已丢失");
    fs.writeFileSync(path.join(runDirectory, "prompt.md"), prompt, { mode: 0o600 });
    // Admission snapshots the native identity so queued resumes survive history expiration.
    const previous = run.nativeSessionId ? run : null;
    const executable = this.executable(worker.type);
    // Strip plugin control tokens before they can reach the spec file or the CLI environment.
    const safeEnvironment = this.guardianEnvironment(this.environment);
    const launch = prepareLaunch({
      type: worker.type,
      run,
      cwd: worker.cwd,
      prompt,
      previous,
      dataDirectory: this.options.dataDirectory,
      runDirectory,
      executable,
      baseEnvironment: safeEnvironment,
      dshPatch: this.dshPatch(),
    });
    // Pi names its transcript before spawn; persist it so cleanup can protect the file.
    if (!run.nativeSessionFile && launch.sessionFile) {
      run.nativeSessionFile = launch.sessionFile;
      this.store.saveRun(run);
    }
    const specPath = path.join(runDirectory, "spec.json");
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        argv: launch.argv,
        cwd: launch.cwd,
        prompt,
        timeoutSeconds: run.timeoutSeconds,
        runDirectory,
        executable: launch.argv[0],
      }),
      { mode: 0o600 },
    );
    const [command, ...prefix] = this.guardianCommand();
    const child = spawn(command!, [...prefix, specPath], {
      cwd: runDirectory,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
    });
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
    const handle: RunHandle = {
      runId: run.id,
      workerId: worker.id,
      ownerId: worker.ownerId,
      child,
      ended,
      resolveEnded,
      finalized: false,
      holdNotification: false,
      stopRequested: false,
      progress: newProgress(),
      expectedSessionId: launch.expectedSessionId,
      lastProgressSave: 0,
    };
    this.handles.set(run.id, handle);
    child.stderr?.on("data", (chunk: Buffer) => {
      // Guardian diagnostics stay in the plugin stderr, never in the user-facing event log.
      process.stderr.write(chunk);
    });
    child.on("message", (message: { type?: string; line?: string }) => {
      if (message?.type === "line" && typeof message.line === "string")
        this.onEventLine(handle, message.line);
    });
    child.once("error", (error) => {
      if (this.storeClosed) return;
      this.finalizeRun(run.id, null, "无法启动监护进程: " + error.message);
    });
    child.once("exit", () => {
      if (this.storeClosed) return;
      const evidence = this.readEvidence(run.id);
      this.finalizeRun(run.id, evidence, null);
    });
  }

  private guardianCommand(): string[] {
    if (this.options.guardianCommand?.length) return [...this.options.guardianCommand];
    const override = clean(this.environment.CLOUDCLI_WORKER_GUARDIAN);
    if (override) return [process.execPath, override];
    return [
      process.execPath,
      fileURLToPath(new URL("./guardian.mjs", import.meta.url)),
    ];
  }

  /** Removes every plugin control token before the native CLI or guardian can inherit it. */
  private guardianEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...base };
    for (const key of Object.keys(environment))
      if (key.startsWith("CLOUDCLI_PLUGIN_")) delete environment[key];
    return environment;
  }

  private executable(type: WorkerType): string {
    const injected = this.options.executablePaths?.[type];
    if (injected) return path.resolve(injected);
    if (type === "dsh") {
      const explicit = clean(this.environment.CLOUDCLI_DSH_BIN);
      if (explicit) return resolveExecutable(explicit, this.environment);
    }
    return resolveExecutable(type, this.environment);
  }

  private dshPatch(): string {
    return (
      this.options.dshPatch ??
      fileURLToPath(new URL("../patches/dsh-session.patch.yml", import.meta.url))
    );
  }

  private onEventLine(handle: RunHandle, line: string): void {
    if (this.storeClosed) return;
    const run = this.store.run(handle.runId);
    if (!run || TERMINAL.includes(run.status)) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const worker = this.store.worker(handle.workerId);
    trackProgress(worker?.type ?? "dsh", event, handle.progress);
    let identityChanged = false;
    if (worker?.type === "dsh" && !run.nativeSessionId) {
      const value = event as Record<string, unknown> | null;
      const id = value?.type === "session" ? value.sessionId : null;
      const cwd = value?.type === "session" ? value.cwd : null;
      if (
        typeof id === "string" &&
        id.trim() &&
        path.basename(id) === id &&
        typeof cwd === "string" &&
        path.isAbsolute(cwd) &&
        path.resolve(cwd) === path.resolve(worker.cwd)
      ) {
        run.nativeSessionId = id;
        identityChanged = true;
      }
    }
    run.progress.steps = handle.progress.steps ? handle.progress.steps : null;
    run.progress.phase = handle.progress.phase;
    run.progress.currentTool = handle.progress.currentTool;
    run.progress.lastEventAt = new Date(this.now()).toISOString();
    if (run.status === "starting") run.status = "running";
    const timestamp = this.now();
    const important =
      identityChanged ||
      handle.progress.phase === "turn_end" ||
      handle.progress.phase === "final" ||
      handle.progress.phase === "error";
    if (important || timestamp - handle.lastProgressSave >= 250) {
      handle.lastProgressSave = timestamp;
      this.store.saveRun(run);
      this.emitChanged(run.workerId);
    }
  }

  private readEvidence(runId: string): GuardianEvidence | null {
    if (this.storeClosed) return null;
    const run = this.store.run(runId);
    if (!run) return null;
    try {
      const value = JSON.parse(
        fs.readFileSync(path.join(this.runDirectory(run.workerId, runId), "final.json"), "utf8"),
      ) as GuardianEvidence;
      if (typeof value?.groupExited !== "boolean") return null;
      return value;
    } catch {
      return null;
    }
  }

  //------------------ TERMINAL STATE ----------------

  /**
   * Applies one terminal outcome. Unknown evidence keeps the slot and leaves the record open so
   * a later guardian exit or verified recovery can settle it.
   */
  private finalizeRun(
    runId: string,
    evidence: GuardianEvidence | null,
    spawnError: string | null,
  ): void {
    if (this.storeClosed) return;
    const run = this.store.run(runId);
    if (!run || TERMINAL.includes(run.status)) return;
    const worker = this.store.worker(run.workerId);
    if (!worker) return;
    const handle = this.handles.get(runId);
    if (handle?.finalized) return;
    if (handle) handle.finalized = true;
    const parsed =
      run.status === "queued"
        ? null
        : this.parseRun(worker, run, handle?.expectedSessionId ?? run.nativeSessionId);
    let status: WorkerStatus;
    let error: WorkerFailure | null = null;
    let hold = handle?.holdNotification ?? false;
    if (this.owners.get(worker.ownerId)?.owner.paused) hold = true;
    if (!evidence) {
      if (spawnError) {
        status = "failed";
        error = new WorkerFailure("GUARDIAN_SPAWN_FAILED", spawnError);
      } else {
        status = "unknown";
        error = new WorkerFailure(
          "EVIDENCE_MISSING",
          "未找到监护进程的最终退出证据，运行状态未知",
        );
      }
    } else if (!evidence.groupExited) {
      status = "unknown";
      error = new WorkerFailure("STOP_UNCONFIRMED", "无法确认原生进程组已经退出");
    } else if (evidence.reason === "cancelled") {
      status = "cancelled";
      error = new WorkerFailure("CANCELLED", "运行已取消");
    } else if (evidence.reason === "timeout") {
      status = "failed";
      error = new WorkerFailure("TIMEOUT", evidence.error || "运行超过硬超时");
    } else if (evidence.reason === "error") {
      status = "failed";
      error = new WorkerFailure(
        "GUARDIAN_ERROR",
        evidence.error || "监护进程报告执行错误",
      );
    } else if (evidence.reason === "disconnect") {
      if (evidence.exitCode === 0 && parsed?.success) status = "completed";
      else {
        status = "interrupted";
        hold = true;
        error = new WorkerFailure(
          "INTERRUPTED",
          parsed?.error || evidence.error || "插件断开时运行尚未成功完成",
        );
      }
    } else if (evidence.exitCode === 0 && parsed?.success) {
      status = "completed";
    } else {
      status = "failed";
      error = new WorkerFailure(
        evidence.exitCode === 0 ? "PROTOCOL_INVALID" : "NATIVE_FAILED",
        parsed?.error ||
          evidence.error ||
          "原生执行器退出码 " + String(evidence.exitCode),
      );
    }
    if (parsed) {
      run.nativeSessionId = parsed.nativeSessionId ?? run.nativeSessionId;
      run.nativeSessionFile = parsed.nativeSessionFile ?? run.nativeSessionFile;
      run.finalText = parsed.finalText;
      run.usage = parsed.usage;
    }
    run.exitCode = evidence?.exitCode ?? run.exitCode;
    if (!handle && (status === "cancelled" || status === "interrupted")) hold = true;
    run.status = status;
    if (status !== "unknown") run.finishedAt = new Date(this.now()).toISOString();
    run.error =
      error && status !== "completed" ? { code: error.code, message: error.message } : null;
    run.progress.phase = status;
    run.progress.currentTool = null;
    this.store.saveRun(run);
    if (handle) {
      clearTimeout(handle.stopTimer);
      this.handles.delete(runId);
      this.prompts.delete(runId);
      handle.resolveEnded();
    }
    if (status !== "unknown")
      this.notify(worker, run, status, hold);
    this.emitChanged(worker.id);
    if (status !== "unknown") void this.dispatch();
  }

  private parseRun(
    worker: WorkerRecord,
    run: WorkerRun,
    expectedSessionId: string | null,
  ): ReturnType<typeof parseDsh> | null {
    const events = path.join(this.runDirectory(worker.id, run.id), "events.log");
    if (!fs.existsSync(events)) return null;
    try {
      return worker.type === "dsh"
        ? parseDsh(events, expectedSessionId, worker.cwd, run.sessionsRoot)
        : parsePi(
            events,
            expectedSessionId,
            worker.cwd,
            run.nativeSessionFile ??
              path.join(run.sessionsRoot, run.id + ".jsonl"),
          );
    } catch {
      return null;
    }
  }

  private finishAdmissionFailure(run: WorkerRun, failure: unknown): void {
    const current = this.store.run(run.id);
    if (!current || TERMINAL.includes(current.status)) return;
    const message = failure instanceof Error ? failure.message : String(failure);
    const code = failure instanceof WorkerFailure ? failure.code : "WORKSPACE_FAILED";
    current.status = "failed";
    current.finishedAt = new Date(this.now()).toISOString();
    current.error = { code, message };
    current.progress.phase = "failed";
    this.store.saveRun(current);
    const worker = this.store.worker(current.workerId);
    if (worker) {
      this.notify(worker, current, "failed", false);
      this.emitChanged(worker.id);
    }
    this.prompts.delete(current.id);
    void this.dispatch();
  }

  private notify(
    worker: WorkerRecord,
    run: WorkerRun,
    status: WorkerNotification["status"],
    hold: boolean,
    reminderSummary?: string,
  ): void {
    const notifications = this.store.notifications().filter((item) => item.runId === run.id);
    const reminder = status === "running";
    if (notifications.some((item) => (item.status === "running") === reminder)) return;
    // A result supersedes a reminder still waiting behind the parent's user queue.
    // Keep its history, but only the result should automatically wake that parent.
    if (!reminder) for (const item of notifications) {
      if (item.status !== "running" || item.delivery !== "pending") continue;
      item.delivery = "held";
      this.store.updateNotification(item);
    }
    const summary = reminderSummary ?? (
      worker.taskName +
      " " +
      status +
      (run.finalText
        ? ": " + run.finalText.replace(/\s+/g, " ").slice(0, 240)
        : run.error
          ? ": " + run.error.message
          : ""));
    const notification: WorkerNotification = {
      id: randomUUID(),
      ownerId: worker.ownerId,
      workerId: worker.id,
      runId: run.id,
      summary,
      status,
      createdAt: new Date(this.now()).toISOString(),
      delivery: hold ? "held" : "pending",
      batchId: null,
    };
    this.store.saveNotification(notification);
    this.emitNotification(notification);
  }

  //------------------ QUERIES ----------------

  state(query: WorkerStateQuery = {}): WorkerStateSnapshot {
    const workers = this.store.workers(query);
    const counts = {
      dsh: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      pi: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      total: Object.fromEntries(STATUSES.map((status) => [status, 0])),
    } as WorkerStateSnapshot["counts"];
    for (const worker of workers) {
      const status = worker.latestRun?.status;
      if (!status) continue;
      (counts[worker.type] as Record<WorkerStatus, number>)[status]++;
      counts.total[status]++;
    }
    const ids = new Set(workers.map((worker) => worker.id));
    const notifications =
      query.projectId || query.parentSessionId
        ? this.store.notifications().filter((item) => ids.has(item.workerId))
        : this.store.notifications();
    return { workers, counts, settings: this.store.settings(), notifications };
  }

  get(workerId: string, ownerId?: string): { worker: WorkerRecord; runs: WorkerRun[] } {
    const worker = this.ownedWorker(ownerId, workerId);
    return { worker, runs: this.store.runs(worker.id) };
  }

  context(ownerId: string): Record<string, unknown> {
    const owner = this.requireOwner(ownerId);
    const snapshot = this.state({
      projectId: owner.projectId,
      parentSessionId: owner.parentSessionId,
    });
    return {
      owner,
      settings: snapshot.settings,
      counts: snapshot.counts,
      activeWorkers: snapshot.workers.filter((worker) =>
        worker.latestRun ? OCCUPYING.includes(worker.latestRun.status) : false,
      ),
      notifications: snapshot.notifications,
    };
  }

  notificationsForWorker(
    workerId: string,
    ownerId: string,
  ): WorkerNotification[] {
    const worker = this.ownedWorker(ownerId, workerId);
    return this.store
      .notifications()
      .filter((item) => item.workerId === worker.id);
  }

  notificationsForScope(ownerId: string): WorkerNotification[] {
    const owner = this.requireOwner(ownerId);
    return this.store.notifications().filter((item) => {
      const worker = this.store.worker(item.workerId);
      return (
        worker !== null &&
        worker.parentSessionId === owner.parentSessionId &&
        worker.projectId === owner.projectId
      );
    });
  }

  logs(workerId: string, query: WorkerLogQuery, ownerId?: string) {
    const worker = this.ownedWorker(ownerId, workerId);
    if (query.stream !== "events" && query.stream !== "stderr")
      throw new WorkerFailure("INVALID_STREAM", "stream 必须是 events 或 stderr");
    const run = query.runId
      ? this.store.run(query.runId)
      : this.store.latestRun(worker.id);
    if (!run || run.workerId !== worker.id)
      throw new WorkerFailure("RUN_NOT_FOUND", "运行记录不存在");
    return readLogPage(
      this.runDirectory(worker.id, run.id),
      query.stream,
      query.cursor,
      query.limit,
      TERMINAL.includes(run.status),
    );
  }

  async wait(
    workerId: string,
    timeoutSeconds: number,
    ownerId?: string,
  ): Promise<{ worker: WorkerRecord; run: WorkerRun }> {
    const worker = this.ownedWorker(ownerId, workerId);
    const deadline =
      this.now() + Math.min(MAX_WAIT_MS, Math.max(1, timeoutSeconds) * 1000);
    for (;;) {
      const current = this.store.worker(worker.id);
      const run = this.store.latestRun(worker.id);
      if (!current || !run)
        throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
      if (TERMINAL.includes(run.status) || this.now() >= deadline)
        return { worker: current, run };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  //------------------ CANCEL, PAUSE, RECOVER, CLEANUP ----------------

  async cancel(
    input: WorkerCancelInput,
    source: "ui" | "host" = "ui",
    scopeOwnerId?: string,
  ): Promise<string[]> {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_INPUT", "取消请求无效");
    const workers = this.cancelTargets(input, scopeOwnerId);
    if (input.pause) {
      const ownerIds = new Set(workers.map((worker) => worker.ownerId));
      for (const candidate of this.store.owners()) {
        if (scopeOwnerId && candidate.id !== scopeOwnerId) continue;
        if (input.parentSessionId && candidate.parentSessionId !== input.parentSessionId)
          continue;
        if (input.projectId && candidate.projectId !== input.projectId) continue;
        if (
          !input.parentSessionId &&
          !input.projectId &&
          scopeOwnerId === undefined
        )
          continue;
        ownerIds.add(candidate.id);
      }
      if (scopeOwnerId) ownerIds.add(scopeOwnerId);
      for (const ownerId of ownerIds)
        this.setPaused(ownerId, true, "取消并暂停新任务");
    }
    const ids: string[] = [];
    const hold = source === "host" || input.pause === true;
    const stops: Promise<void>[] = [];
    let unconfirmed = false;
    for (const worker of workers) {
      const run = this.store.latestRun(worker.id);
      if (!run || TERMINAL.includes(run.status)) continue;
      ids.push(worker.id);
      if (run.status === "queued") {
        this.finalizeQueued(run, hold);
        continue;
      }
      const handle = this.handles.get(run.id);
      if (!handle) {
        // No live guardian (for example after a restart): cancellation cannot confirm exit.
        run.status = "unknown";
        run.error = {
          code: "STOP_UNCONFIRMED",
          message: "没有可用的监护进程证据，无法确认停止",
        };
        this.store.saveRun(run);
        this.emitChanged(worker.id);
        unconfirmed = true;
        continue;
      }
      handle.holdNotification = hold || handle.holdNotification;
      handle.stopRequested = true;
      run.status = "stopping";
      run.progress.phase = "stopping";
      this.store.saveRun(run);
      this.emitChanged(worker.id);
      try {
        handle.child.send?.({ type: "stop" });
      } catch {
        // A closed IPC channel already triggers guardian disconnect cleanup.
      }
      stops.push(
        (async () => {
          const settled = await this.settleHandle(handle);
          const current = this.store.run(run.id);
          if (!settled) {
            if (current && !TERMINAL.includes(current.status)) {
              current.status = "unknown";
              current.error = {
                code: "STOP_UNCONFIRMED",
                message: "取消请求已发出，但未确认进程组退出",
              };
              this.store.saveRun(current);
              this.emitChanged(worker.id);
            }
            unconfirmed = true;
            return;
          }
          if (!current || !TERMINAL.includes(current.status)) unconfirmed = true;
        })(),
      );
    }
    await Promise.all(stops);
    if (unconfirmed)
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "至少一个原生进程组尚未确认停止",
      );
    return [...new Set(ids)];
  }

  private cancelTargets(
    input: WorkerCancelInput,
    scopeOwnerId?: string,
  ): WorkerRecord[] {
    const owner = scopeOwnerId
      ? this.owners.get(scopeOwnerId)?.owner ?? this.store.owner(scopeOwnerId)
      : null;
    const inAuthenticatedScope = (worker: WorkerRecord) =>
      !scopeOwnerId ||
      (worker.ownerId === scopeOwnerId &&
        (owner === null ||
          (worker.parentSessionId === owner.parentSessionId &&
            worker.projectId === owner.projectId)));
    const matches = (worker: WorkerRecord) =>
      inAuthenticatedScope(worker) &&
      (!input.projectId || worker.projectId === input.projectId) &&
      (!input.parentSessionId ||
        worker.parentSessionId === input.parentSessionId);
    const workers = this.store.workers();
    if (input.all) return workers.filter(matches);
    if (input.workerIds !== undefined) {
      if (!Array.isArray(input.workerIds) || input.workerIds.some((id) => typeof id !== "string"))
        throw new WorkerFailure("INVALID_INPUT", "workerIds 必须是字符串数组");
      const wanted = new Set(input.workerIds);
      return workers.filter((worker) => wanted.has(worker.id) && matches(worker));
    }
    if (input.projectId === undefined && input.parentSessionId === undefined)
      throw new WorkerFailure(
        "INVALID_CANCEL",
        "取消必须指定 workerIds、all、parentSessionId 或 projectId",
      );
    return workers.filter(matches);
  }

  private finalizeQueued(run: WorkerRun, hold: boolean): void {
    const worker = this.store.worker(run.workerId);
    run.status = "cancelled";
    run.finishedAt = new Date(this.now()).toISOString();
    run.error = { code: "CANCELLED", message: "排队中的运行已取消" };
    run.progress.phase = "cancelled";
    this.store.saveRun(run);
    this.prompts.delete(run.id);
    const queuedHandle = this.handles.get(run.id);
    this.handles.delete(run.id);
    queuedHandle?.resolveEnded();
    if (worker) {
      this.notify(worker, run, "cancelled", hold);
      this.emitChanged(worker.id);
    }
  }

  private setPaused(ownerId: string, paused: boolean, reason?: string): void {
    const stored = this.store.owner(ownerId);
    const registered = this.owners.get(ownerId);
    const owner = registered?.owner ?? stored;
    if (!owner) return;
    const value: WorkerOwner = {
      ...owner,
      paused,
      pausedReason: paused ? reason ?? owner.pausedReason : undefined,
    };
    this.store.saveOwner(value);
    if (registered) registered.owner = value;
    if (paused) this.holdPendingNotifications(ownerId);
  }

  private holdPendingNotifications(ownerId: string): void {
    for (const notification of this.store.notifications(ownerId)) {
      if (notification.delivery !== "pending") continue;
      notification.delivery = "held";
      this.store.updateNotification(notification);
      this.emitNotification(notification);
    }
  }

  async setOwnerPaused(
    ownerId: string,
    paused: boolean,
    reason?: string,
  ): Promise<{ confirmed: true }> {
    if (!this.owners.has(ownerId) && !this.store.owner(ownerId))
      throw new WorkerFailure("OWNER_NOT_FOUND", "owner 未注册");
    this.setPaused(ownerId, paused, reason);
    if (paused) {
      const workers = this.store.workers().filter((worker) => worker.ownerId === ownerId);
      const stops: Promise<void>[] = [];
      for (const worker of workers) {
        const run = this.store.latestRun(worker.id);
        if (!run || TERMINAL.includes(run.status)) continue;
        if (run.status === "queued") {
          this.finalizeQueued(run, true);
          continue;
        }
        stops.push(this.stopForHost(worker.id, run));
      }
      const outcomes = await Promise.allSettled(stops);
      const failed = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (failed) throw failed.reason;
    } else {
      void this.dispatch();
    }
    return { confirmed: true };
  }

  private settleHandle(handle: RunHandle): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 12_500);
      void handle.ended.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async stopForHost(workerId: string, run: WorkerRun): Promise<void> {
    const handle = this.handles.get(run.id);
    if (!handle) {
      run.status = "unknown";
      run.error = {
        code: "STOP_UNCONFIRMED",
        message: "没有可用的监护进程证据，无法确认停止",
      };
      this.store.saveRun(run);
      this.emitChanged(workerId);
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "没有可用的监护进程证据，无法确认停止",
      );
    }
    handle.holdNotification = true;
    handle.stopRequested = true;
    run.status = "stopping";
    run.progress.phase = "stopping";
    this.store.saveRun(run);
    this.emitChanged(workerId);
    try {
      handle.child.send?.({ type: "stop" });
    } catch {
      // A closed IPC channel already triggers guardian disconnect cleanup.
    }
    const settled = await this.settleHandle(handle);
    if (!settled) {
      const current = this.store.run(run.id);
      if (current && !TERMINAL.includes(current.status)) {
        current.status = "unknown";
        current.error = {
          code: "STOP_UNCONFIRMED",
          message: "停止请求已发出，但未确认进程组退出",
        };
        this.store.saveRun(current);
        this.emitChanged(workerId);
      }
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "停止请求已发出，但未确认进程组退出",
      );
    }
    const current = this.store.run(run.id);
    if (!current || !TERMINAL.includes(current.status))
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "监护进程已退出，但运行结果仍为未知",
      );
  }

  async closeInstance(
    appServerInstanceId: string,
    reason: string,
  ): Promise<{ workerIds: string[] }> {
    const owners = this.store
      .owners()
      .filter((owner) => owner.appServerInstanceId === appServerInstanceId);
    for (const owner of owners) this.setPaused(owner.id, true, reason);
    // Authority is gone synchronously even if process cleanup later fails.
    for (const owner of owners) this.retireOwner(owner.id);
    return {
      workerIds: await this.cancelOwners(
        owners.map((owner) => owner.id),
        reason,
      ),
    };
  }

  async closeAll(reason: string): Promise<{ workerIds: string[] }> {
    const ids = new Set(this.store.owners().map((owner) => owner.id));
    for (const worker of this.store.workers()) ids.add(worker.ownerId);
    for (const id of ids) this.setPaused(id, true, reason);
    for (const id of [...this.owners.keys()]) this.retireOwner(id);
    return { workerIds: await this.cancelOwners([...ids], reason) };
  }

  private async cancelOwners(ownerIds: string[], reason: string): Promise<string[]> {
    const ids: string[] = [];
    const stops: Promise<void>[] = [];
    for (const ownerId of ownerIds) {
      const workers = this.store
        .workers()
        .filter((worker) => worker.ownerId === ownerId);
      for (const worker of workers) {
        const run = this.store.latestRun(worker.id);
        if (!run || TERMINAL.includes(run.status)) continue;
        ids.push(worker.id);
        if (run.status === "queued") this.finalizeQueued(run, true);
        else stops.push(this.stopForHost(worker.id, run));
      }
    }
    void reason;
    const outcomes = await Promise.allSettled(stops);
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "至少一个原生进程组尚未确认停止",
      );
    return [...new Set(ids)];
  }

  recover(input: WorkerRecoverInput): WorkerRecord {
    this.validateRecover(input);
    const worker = this.store.worker(input.workerId);
    if (!worker) throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    const run = this.store.latestRun(worker.id);
    if (!run) throw new WorkerFailure("RUN_NOT_FOUND", "worker 尚无运行记录");
    if (run.status !== "unknown")
      throw new WorkerFailure("RECOVER_NOT_ALLOWED", "只有 unknown 运行可以人工恢复");
    if (this.handles.has(run.id))
      throw new WorkerFailure("PROCESS_ALIVE", "监护进程尚未确认退出，不能恢复");
    run.status = "interrupted";
    run.finishedAt = new Date(this.now()).toISOString();
    run.error = {
      code: "RECOVERED",
      message: input.notes.trim().slice(0, 2000),
    };
    run.progress.phase = "interrupted";
    this.store.saveRun(run);
    this.notify(worker, run, "interrupted", true);
    this.emitChanged(worker.id);
    void this.dispatch();
    return this.store.worker(worker.id)!;
  }

  private validateRecover(input: WorkerRecoverInput): void {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_INPUT", "恢复请求无效");
    if (typeof input.workerId !== "string" || !input.workerId.trim())
      throw new WorkerFailure("INVALID_INPUT", "workerId 不能为空");
    if (typeof input.notes !== "string" || !input.notes.trim())
      throw new WorkerFailure("INVALID_INPUT", "notes 不能为空");
    if (input.confirmedStopped !== true)
      throw new WorkerFailure("NOT_CONFIRMED", "必须确认原生会话已停止");
  }

  async cleanup(input: WorkerCleanupInput): Promise<WorkerRecord> {
    if (!input || typeof input.workerId !== "string" || !input.workerId.trim())
      throw new WorkerFailure("INVALID_INPUT", "workerId 不能为空");
    const worker = this.store.worker(input.workerId);
    if (!worker) throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    const run = this.store.latestRun(worker.id);
    if (run && !TERMINAL.includes(run.status))
      throw new WorkerFailure("ACTIVE_RUN", "worker 尚未停止，不能清理");
    if (this.store.workerCleanedAt(worker.id))
      throw new WorkerFailure("ALREADY_CLEANED", "worktree 已清理");
    const target = realPath(worker.cwd);
    for (const other of this.store.workers()) {
      if (other.id === worker.id || realPath(other.cwd) !== target) continue;
      const otherRun = this.store.latestRun(other.id);
      if (
        otherRun &&
        ACTIVE_REFERENCES.includes(otherRun.status)
      )
        throw new WorkerFailure(
          "WORKSPACE_IN_USE",
          "同一工作目录仍有活动 worker，拒绝清理",
        );
    }
    await this.workspace.cleanup(worker);
    this.store.markCleaned(worker.id);
    this.emitChanged(worker.id);
    return this.store.worker(worker.id)!;
  }

  //------------------ NOTIFICATIONS ----------------

  notifications(ownerId?: string): WorkerNotification[] {
    return this.store.notifications(ownerId);
  }

  claimNotifications(
    ownerId: string,
    eventIds: string[],
    batchId: string,
  ): { batchId: string; notifications: WorkerNotification[] } {
    if (typeof ownerId !== "string" || !ownerId)
      throw new WorkerFailure("INVALID_OWNER", "ownerId 不能为空");
    const registered = this.owners.get(ownerId);
    if (!registered)
      throw new WorkerFailure("OWNER_NOT_LIVE", "owner 不在当前宿主进程");
    if (registered.owner.paused)
      throw new WorkerFailure("OWNER_PAUSED", "owner 已暂停，不能领取通知");
    if (typeof batchId !== "string" || !batchId.trim())
      throw new WorkerFailure("INVALID_BATCH", "batchId 不能为空");
    if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string"))
      throw new WorkerFailure("INVALID_INPUT", "eventIds 必须是字符串数组");
    return {
      batchId,
      notifications: this.store.claimNotifications(ownerId, eventIds, batchId),
    };
  }

  settleNotifications(
    batchId: string,
    delivery: WorkerNotificationDelivery,
  ): { settled: true } {
    if (!["delivered", "pending", "held", "unknown"].includes(delivery))
      throw new WorkerFailure("INVALID_DELIVERY", "delivery 值无效");
    this.store.settleBatch(batchId, delivery);
    return { settled: true };
  }

  ack(ownerId: string, eventIds: string[]): { acknowledged: number } {
    if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string"))
      throw new WorkerFailure("INVALID_INPUT", "eventIds 必须是字符串数组");
    let acknowledged = 0;
    const owner = this.owners.get(ownerId)?.owner ?? this.store.owner(ownerId);
    for (const id of eventIds) {
      const item = this.store.notification(id);
      if (!item) continue;
      const worker = this.store.worker(item.workerId);
      const allowed =
        item.ownerId === ownerId ||
        (owner !== null && worker !== null && this.inScope(worker, ownerId, owner));
      if (!allowed) continue;
      item.delivery = "delivered";
      this.store.updateNotification(item);
      acknowledged++;
    }
    return { acknowledged };
  }

  retryNotifications(eventIds: string[]): { retried: number } {
    if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string"))
      throw new WorkerFailure("INVALID_INPUT", "eventIds 必须是字符串数组");
    let retried = 0;
    for (const id of eventIds) {
      const notification = this.store.notification(id);
      if (!notification) continue;
      const worker = this.store.worker(notification.workerId);
      // Explicit retry may move a historical event to the live generation of the same scope.
      const live = worker ? this.liveOwnerForWorker(worker) : null;
      if (live) notification.ownerId = live.id;
      notification.delivery = "pending";
      notification.batchId = null;
      this.store.updateNotification(notification);
      this.emitNotification(notification);
      retried++;
    }
    return { retried };
  }

  //------------------ RECOVERY, SHUTDOWN, EVENTS ----------------

  /** Restores persisted records without ever re-running an old task. */
  recoverFromDisk(): void {
    this.recovering = true;
    try {
      for (const run of this.store.activeRuns()) {
        if (run.status === "queued") {
          this.finalizeQueued(run, true);
          continue;
        }
        const evidence = this.readEvidence(run.id);
        if (evidence) {
          this.finalizeRun(run.id, evidence, null);
          continue;
        }
        const worker = this.store.worker(run.workerId);
        if (!worker) continue;
        if (!run.nativeSessionId || !run.nativeSessionFile) {
          const parsed = this.parseRun(worker, run, run.nativeSessionId);
          run.nativeSessionId = parsed?.nativeSessionId ?? run.nativeSessionId;
          run.nativeSessionFile = parsed?.nativeSessionFile ?? run.nativeSessionFile;
        }
        run.status = "unknown";
        run.error = {
          code: "RESTART_UNKNOWN",
          message: "插件重启且没有可核实的进程退出证据",
        };
        run.progress.phase = "unknown";
        this.store.saveRun(run);
        this.emitChanged(worker.id);
      }
      // Historical pending/claimed events for a paused owner stay held across restart.
      for (const owner of this.store.owners())
        if (owner.paused) this.holdPendingNotifications(owner.id);
    } finally {
      this.recovering = false;
    }
    this.pruneHistory();
    this.startNativeSessionCleanup();
  }

  /** Starts one immediate sweep and a per-instance 24-hour timer, once per service. */
  private startNativeSessionCleanup(): void {
    if (this.closing || this.storeClosed || this.nativeRetentionTimer) return;
    this.nativeRetentionTimer = setInterval(
      () => void this.runNativeSessionCleanup(),
      24 * 60 * 60 * 1000,
    );
    this.nativeRetentionTimer.unref?.();
    void this.runNativeSessionCleanup();
  }

  private runNativeSessionCleanup(): Promise<void> {
    if (this.closing || this.storeClosed) return Promise.resolve();
    if (this.nativeRetentionSweep) return this.nativeRetentionSweep;
    const sweep = (async () => {
      // Yield once so a concurrent trigger observes the in-flight sweep.
      await Promise.resolve();
      try {
        sweepNativeSessions({
          dataDirectory: this.options.dataDirectory,
          environment: this.environment,
          now: this.now(),
          activeRuns: this.store.activeRuns().flatMap((run) => {
            const worker = this.store.worker(run.workerId);
            return worker
              ? [{
                  type: worker.type,
                  sessionsRoot: run.sessionsRoot,
                  nativeSessionId: run.nativeSessionId,
                  nativeSessionFile: run.nativeSessionFile,
                }]
              : [];
          }),
          log: (message) => this.logNativeSessionCleanup(message),
        });
      } catch (error) {
        this.logNativeSessionCleanup(
          "native session cleanup failed: " + String(error),
        );
      } finally {
        this.nativeRetentionSweep = null;
      }
    })();
    this.nativeRetentionSweep = sweep;
    return sweep;
  }

  private logNativeSessionCleanup(message: string): void {
    process.stderr.write("worker " + message + "\n");
  }

  private pruneHistory(): void {
    try {
      const cutoff = this.now() - this.store.settings().retentionDays * 86_400_000;
      for (const run of this.store.expiredRuns(cutoff)) {
        const worker = this.store.worker(run.workerId)!;
        const directory = this.runDirectory(worker.id, run.id);
        fs.rmSync(directory, { recursive: true, force: true });
        this.store.deleteRun(run);
        if (!this.store.worker(worker.id))
          fs.rmSync(path.dirname(directory), { recursive: true, force: true });
        this.send({
          channel: "cloudcli-workers",
          kind: "event",
          event: "changed",
          value: { ownerId: worker.ownerId, workerIds: [worker.id] },
        });
      }
    } catch (error) {
      // Keep failed deletions eligible for the next sweep without breaking the plugin timer/API.
      process.stderr.write("worker history cleanup failed: " + String(error) + "\n");
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.reminderTimer);
    clearInterval(this.retentionTimer);
    if (this.nativeRetentionTimer) {
      clearInterval(this.nativeRetentionTimer);
      this.nativeRetentionTimer = null;
    }
    let failure: unknown;
    try {
      await this.nativeRetentionSweep;
      await this.closeAll("插件进程退出");
    } catch (error) {
      failure = error;
    } finally {
      this.storeClosed = true;
      this.store.close();
    }
    if (failure)
      process.stderr.write(
        "worker shutdown cleanup unconfirmed: " +
          (failure instanceof Error ? failure.message : String(failure)) +
          "\n",
      );
  }

  private checkReminders(): void {
    if (this.closing || this.storeClosed) return;
    // A guardian from the previous plugin generation may finish writing evidence after restart.
    for (const unknown of this.store.activeRuns()) {
      if (unknown.status !== "unknown" || this.handles.has(unknown.id)) continue;
      const evidence = this.readEvidence(unknown.id);
      if (evidence) this.finalizeRun(unknown.id, evidence, null);
    }
    const settings = this.store.settings();
    for (const handle of this.handles.values()) {
      const run = this.store.run(handle.runId);
      if (!run || run.status !== "running") continue;
      if (run.progress.softReminderSentAt) continue;
      const dueTime =
        run.startedAt !== null &&
        this.now() - Date.parse(run.startedAt) >= settings.softReminderSeconds * 1000;
      // Progress writes are throttled; use validated live steps so a long tool
      // call after the threshold does not postpone its reminder until completion.
      const steps = handle.progress.steps || null;
      const dueSteps =
        steps !== null && steps >= settings.softReminderSteps;
      if (!dueTime && !dueSteps) continue;
      run.progress.steps = steps;
      run.progress.softReminderSentAt = new Date(this.now()).toISOString();
      this.store.saveRun(run);
      const worker = this.store.worker(run.workerId)!;
      const elapsed = run.startedAt === null ? 0 : Math.floor((this.now() - Date.parse(run.startedAt)) / 1000);
      this.notify(worker, run, "running", this.owners.get(worker.ownerId)?.owner.paused === true,
        `${worker.taskName}: soft budget reached (${elapsed}s elapsed, ${run.progress.steps ?? "unknown"} steps; thresholds ${settings.softReminderSeconds}s / ${settings.softReminderSteps} steps). Check actual progress before deciding whether to intervene.`);
      // The reminder wakes an idle parent for review; it never cancels the run.
      this.emitChanged(run.workerId);
    }
  }

  private emitChanged(workerId: string): void {
    const worker = this.store.worker(workerId);
    if (!worker) return;
    this.send({
      channel: "cloudcli-workers",
      kind: "event",
      event: "changed",
      value: { ownerId: worker.ownerId, workerIds: [worker.id] },
    });
  }

  private emitNotification(notification: WorkerNotification): void {
    this.send({
      channel: "cloudcli-workers",
      kind: "event",
      event: "notification",
      value: notification,
    });
  }

  private send(message: unknown): void {
    this.options.onEvent?.(message);
    if (!process.connected) return;
    try {
      process.send?.(message);
    } catch {
      /* host restarting; persisted state remains authoritative */
    }
  }

  //------------------ HELPERS ----------------

  private requireOwner(ownerId: string): WorkerOwner {
    const owner = this.owners.get(ownerId)?.owner ?? this.store.owner(ownerId);
    if (!owner) throw new WorkerFailure("OWNER_NOT_FOUND", "owner 未注册");
    return owner;
  }

  private ownedWorker(ownerId: string | undefined, workerId: string): WorkerRecord {
    const worker = this.store.worker(workerId);
    if (!worker) throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    if (ownerId) {
      const owner = this.owners.get(ownerId)?.owner ?? this.store.owner(ownerId);
      if (!this.inScope(worker, ownerId, owner))
        throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    }
    return worker;
  }

  /** Historical access follows the logical parent+project; destructive live control does not. */
  private inScope(
    worker: WorkerRecord,
    ownerId: string,
    owner: WorkerOwner | null,
  ): boolean {
    if (worker.ownerId === ownerId) return true;
    return (
      owner !== null &&
      worker.parentSessionId === owner.parentSessionId &&
      worker.projectId === owner.projectId
    );
  }

  /** Removes live authority only; persisted owner/worker/run records stay untouched. */
  private retireOwner(ownerId: string): void {
    const registered = this.owners.get(ownerId);
    if (!registered) return;
    this.tokens.delete(registered.token);
    this.owners.delete(ownerId);
  }

  private liveOwnerForWorker(worker: WorkerRecord): WorkerOwner | null {
    // Prefer the most recently registered generation in the same logical scope.
    for (const registered of [...this.owners.values()].reverse()) {
      if (
        registered.owner.parentSessionId === worker.parentSessionId &&
        registered.owner.projectId === worker.projectId
      )
        return registered.owner;
    }
    return null;
  }

  private requestKey(owner: WorkerOwner): string {
    return owner.parentSessionId + "\u0000" + owner.projectId;
  }

  private resultOf(
    workerId: string,
    runId: string,
  ): { worker: WorkerRecord; run: WorkerRun } {
    const worker = this.store.worker(workerId);
    const run = this.store.run(runId);
    if (!worker || !run) throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    return { worker, run };
  }

  private runDirectory(workerId: string, runId: string): string {
    return path.join(this.options.dataDirectory, "logs", workerId, runId);
  }
}

function realPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function clean(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
