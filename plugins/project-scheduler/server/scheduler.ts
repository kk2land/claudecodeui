import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";
import { parseTasks } from "./configuration.js";
import {
  previewProjectConfiguration,
  readProjectConfiguration,
  saveProjectConfiguration,
} from "./configuration-editor.js";
import { appendLog, readLog } from "./logs.js";
import { terminateTree } from "./process-tree.js";
import type { SchedulerStore } from "./store.js";
import type {
  SchedulerConfigurationDocument,
  SchedulerConfigurationPreview,
  SchedulerConfigurationSave,
  SchedulerImport,
  SchedulerProject,
  SchedulerRun,
  SchedulerTask,
} from "../shared/contracts.js";

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
type ActiveRun = {
  run: SchedulerRun;
  child?: ChildProcess;
  commandPid?: number;
  finish?: () => void;
  stopped?: "stopped" | "timed_out";
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
};

/** Plugin scheduling owner. Reservations, cron reloads and manual starts share one concurrency gate. */
export class ProjectScheduler {
  private readonly timers = new Map<string, Cron>();
  private readonly active = new Map<string, ActiveRun>();
  private closing = false;
  private catalogSignature = "";
  constructor(
    readonly store: SchedulerStore,
    private readonly projectsFile: string,
    private readonly onFinished: () => void = () => {},
  ) {}
  projects(): SchedulerProject[] {
    const content = JSON.parse(fs.readFileSync(this.projectsFile, "utf8")) as {
      generatedAt: number;
      projects: SchedulerProject[];
    };
    if (
      !Number.isFinite(content.generatedAt) ||
      Date.now() - content.generatedAt > 30000 ||
      !Array.isArray(content.projects)
    )
      throw new Error("宿主项目目录不可用或已过期，调度已暂停");
    return content.projects;
  }
  recover(): void {
    for (const run of this.store.unfinished()) {
      if (alive(run.workerPid)) {
        run.reason = "等待上次中断的 worker 退出";
        this.active.set(run.id, { run });
      } else this.finishInterrupted(run);
    }
    this.refresh();
  }
  private finishInterrupted(run: SchedulerRun): void {
    run.status = "interrupted";
    run.endedAt = new Date().toISOString();
    run.reason = "调度进程意外退出，本次执行未自动重试";
    // Recovery must use the run's original policy, even after reload or deletion.
    let notify = false;
    try {
      const file = path.join(this.store.directory, "runs", run.id, "task.json");
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as SchedulerTask;
      notify = snapshot.notify === true;
    } catch {
      // Missing or damaged snapshots must not opt a task into notifications.
    }
    run.alertStatus = notify && this.store.settings().telegram.enabled
      ? "pending"
      : "none";
    this.store.saveRun(run);
    this.onFinished();
  }
  maintenance(): void {
    for (const [id, item] of this.active)
      if (!item.child && !alive(item.run.workerPid)) {
        this.active.delete(id);
        this.finishInterrupted(item.run);
      }
    let signature = "";
    try {
      signature = JSON.stringify(this.projects());
    } catch {
      /* expired allowlist suspends all future starts */
    }
    if (signature !== this.catalogSignature) this.refresh();
  }
  refresh(): void {
    for (const timer of this.timers.values()) timer.stop();
    this.timers.clear();
    let projects: SchedulerProject[] = [];
    try {
      projects = this.projects();
      this.catalogSignature = JSON.stringify(projects);
    } catch {
      this.catalogSignature = "";
    }
    const enabledProjects = new Set(projects.map((project) => project.id));
    for (const row of this.store.definitions()) {
      if (!row.definition.enabled || !enabledProjects.has(row.projectId))
        continue;
      const timer = new Cron(
        row.definition.cron,
        {
          timezone: row.definition.timezone,
          catch: (error) => console.error("[Scheduler]", String(error)),
        },
        () => {
          if (!this.closing) {
            try {
              this.start(row.projectId, row.taskId, "cron");
            } catch (error) {
              console.error("[Scheduler]", String(error));
            }
          }
        },
      );
      this.timers.set(row.projectId + ":" + row.taskId, timer);
    }
  }
  inventory() {
    return this.store.inventory(
      this.projects(),
      [...this.active.values()].map((item) => item.run),
      (projectId, taskId) =>
        this.timers
          .get(projectId + ":" + taskId)
          ?.nextRun()
          ?.toISOString() ?? null,
    );
  }
  load(
    projectIds: string[] | undefined,
    removeMissing: boolean,
    apply: boolean,
  ): SchedulerImport[] {
    const projects = this.projects();
    if (
      projectIds?.some((id) => !projects.some((project) => project.id === id))
    )
      throw new Error("项目不存在或已归档");
    const results: SchedulerImport[] = [];
    for (const project of projects.filter(
      (project) => !projectIds || projectIds.includes(project.id),
    )) {
      const result: SchedulerImport = {
        project,
        status: "valid",
        added: 0,
        updated: 0,
        removed: 0,
      };
      try {
        const root = fs.realpathSync(project.path);
        const file = path.join(root, ".cloudcli", "project-schedules.json");
        if (!fs.existsSync(file)) {
          result.status = "missing";
          results.push(result);
          continue;
        }
        if (
          !fs.realpathSync(file).startsWith(root + path.sep) ||
          fs.statSync(file).size > 1024 * 1024
        )
          throw new Error("配置文件必须位于项目内，且不能超过 1 MiB");
        const tasks = parseTasks(
          JSON.parse(fs.readFileSync(file, "utf8")),
          root,
          this.store.settings(),
        );
        const existing = this.store
          .definitions()
          .filter((row) => row.projectId === project.id);
        result.added = tasks.filter(
          (task) => !existing.some((row) => row.taskId === task.id),
        ).length;
        result.updated = tasks.filter((task) =>
          existing.some((row) => row.taskId === task.id),
        ).length;
        result.removed = removeMissing
          ? existing.filter(
              (row) => !tasks.some((task) => task.id === row.taskId),
            ).length
          : 0;
        if (apply) this.store.importProject(project.id, tasks, removeMissing);
      } catch (error) {
        result.status = "invalid";
        result.error = String(error);
      }
      results.push(result);
    }
    if (apply) this.refresh();
    return results;
  }
  setTaskEnabled(projectId: string, taskId: string, enabled: boolean): void {
    if (this.closing) throw new Error("调度器正在停止");
    if (!this.projects().some((project) => project.id === projectId))
      throw new Error("项目不存在或已归档");
    this.store.setTaskEnabled(projectId, taskId, enabled);
    this.refresh();
  }
  /** Used by the configuration editor; only a fresh host allowlist ID is accepted. */
  private configurationProject(projectId: string): SchedulerProject | undefined {
    if (typeof projectId !== "string" || !projectId.trim()) return undefined;
    return this.projects().find((project) => project.id === projectId);
  }
  /**
   * Reads the raw project JSON for the visual/JSON editor. An invalid document is returned
   * verbatim with an error so it can be repaired; a missing file stays a non-creating empty draft.
   */
  readConfiguration(projectId: string): SchedulerConfigurationDocument | undefined {
    const project = this.configurationProject(projectId);
    return project ? readProjectConfiguration(project) : undefined;
  }
  /** Validates a draft against the live settings and loaded definitions without writing anything. */
  previewConfiguration(
    projectId: string,
    text: string,
  ): SchedulerConfigurationPreview | undefined {
    const project = this.configurationProject(projectId);
    if (!project) return undefined;
    return previewProjectConfiguration(
      project,
      text,
      this.store.settings(),
      this.loadedTasks(projectId),
    );
  }
  /**
   * Saves and loads a validated draft. The file is replaced atomically first and the store is
   * imported afterwards, so a load failure still reports the written revision for a retry.
   */
  saveConfiguration(
    projectId: string,
    text: string,
    revision: string | null,
  ): SchedulerConfigurationSave | undefined {
    const project = this.configurationProject(projectId);
    if (!project) return undefined;
    if (this.closing)
      return {
        saved: false,
        loaded: false,
        revision: null,
        changes: { added: 0, updated: 0, removed: 0, reEnabled: 0 },
        error: "调度器正在停止",
      };
    return saveProjectConfiguration({
      project,
      text,
      revision,
      settings: this.store.settings(),
      loaded: this.loadedTasks(projectId),
      importProject: (tasks) => this.store.importProject(projectId, tasks, true),
      refresh: () => this.refresh(),
    });
  }
  private loadedTasks(projectId: string): SchedulerTask[] {
    return this.store
      .definitions()
      .filter((row) => row.projectId === projectId)
      .map((row) => row.definition);
  }
  start(
    projectId: string,
    taskId: string,
    trigger: "cron" | "manual",
  ): SchedulerRun {
    if (this.closing) throw new Error("调度器正在停止");
    const project = this.projects().find((project) => project.id === projectId);
    const task = this.store
      .definitions()
      .find(
        (task) => task.projectId === projectId && task.taskId === taskId,
      )?.definition;
    if (!project || !task) throw new Error("项目或任务不存在，或项目已归档");
    // A callback already queued before disabling must not start another automatic run.
    if (trigger === "cron" && !task.enabled) throw new Error("任务自动调度已关闭");
    const now = new Date().toISOString();
    const run: SchedulerRun = {
      id: randomUUID(),
      projectId,
      projectName: project.name,
      taskId,
      taskName: task.name,
      status: "running",
      trigger,
      scheduledAt: now,
      startedAt: now,
      endedAt: null,
      exitCode: null,
      reason: null,
      workerPid: null,
      alertStatus: "none",
      alertError: null,
      alertAttempts: 0,
    };
    const sameTask = [...this.active.values()].some(
      (item) => item.run.projectId === projectId && item.run.taskId === taskId,
    );
    if (!task.allowConcurrent && sameTask) {
      run.status = "skipped_overlap";
      run.reason = "上次运行尚未结束，本次已跳过";
    } else if (this.active.size >= this.store.settings().maxConcurrentRuns) {
      run.status = "skipped_capacity";
      run.reason = "全局并发数已满，本次已跳过";
    }
    if (run.status !== "running") {
      run.endedAt = now;
      this.store.saveRun(run);
      return run;
    }
    const item: ActiveRun = { run };
    this.active.set(run.id, item);
    this.store.saveRun(run);
    const directory = path.join(this.store.directory, "runs", run.id);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const root = fs.realpathSync(project.path),
        cwd = fs.realpathSync(task.cwd);
      if (cwd !== root && !cwd.startsWith(root + path.sep))
        throw new Error("任务目录已经移出项目");
      fs.writeFileSync(
        path.join(directory, "task.json"),
        JSON.stringify(task),
        { mode: 0o600 },
      );
      this.launch(item, task, directory);
    } catch (error) {
      this.complete(item, task, null, false, String(error));
    }
    return run;
  }
  private launch(
    item: ActiveRun,
    task: SchedulerTask,
    directory: string,
  ): void {
    // Precedence is process.env < settings.env < task.env; the worker applies task.env last.
    // Reading settings here keeps already-running workers on the values they started with.
    const env = {
      ...process.env,
      ...this.store.settings().env,
    };
    delete env.CLOUDCLI_PLUGIN_TOKEN;
    const worker = fork(
      fileURLToPath(new URL("../dist/worker.mjs", import.meta.url)),
      [],
      {
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execArgv: [],
      },
    );
    item.child = worker;
    item.run.workerPid = worker.pid ?? null;
    this.store.saveRun(item.run);
    let result:
      | { code: number | null; success: boolean; reason?: string }
      | undefined;
    let spawnError: string | undefined;
    worker.stdout?.on("data", (chunk: Buffer) => {
      try {
        appendLog(directory, "stdout", chunk);
      } catch (error) {
        spawnError = "日志写入失败：" + String(error);
        this.stop(item.run.id, true);
      }
    });
    worker.stderr?.on("data", (chunk: Buffer) => {
      try {
        appendLog(directory, "stderr", chunk);
      } catch (error) {
        spawnError = "日志写入失败：" + String(error);
        this.stop(item.run.id, true);
      }
    });
    worker.on(
      "message",
      (message: {
        type: string;
        pid?: number;
        code: number | null;
        success: boolean;
        reason?: string;
      }) => {
        if (message.type === "child") item.commandPid = message.pid;
        if (message.type === "result") result = message;
      },
    );
    worker.once("error", (error) => {
      spawnError = error.message;
    });
    worker.once("close", (code) => {
      this.complete(
        item,
        task,
        result?.code ?? code,
        Boolean(result?.success) && !spawnError,
        spawnError ??
          result?.reason ??
          (result ? undefined : "运行 worker 意外退出"),
      );
      item.finish?.();
    });
    worker.send({ type: "start", task, directory }, (error) => {
      if (error) {
        spawnError = error.message;
        this.stop(item.run.id, true);
      }
    });
    if (task.timeoutSeconds)
      item.timer = setTimeout(() => {
        item.stopped = "timed_out";
        this.stop(item.run.id, true);
      }, task.timeoutSeconds * 1000);
  }
  private complete(
    item: ActiveRun,
    task: SchedulerTask,
    code: number | null,
    success: boolean,
    reason?: string,
  ): void {
    // A worker may crash during its grace period; do not cancel the host fallback
    // until the remaining command group has also received the forced stop.
    if (item.stopped && item.commandPid) terminateTree(item.commandPid, true);
    clearTimeout(item.timer);
    clearTimeout(item.killTimer);
    this.active.delete(item.run.id);
    item.run.status = item.stopped ?? (success ? "success" : "failed");
    item.run.exitCode = code;
    item.run.endedAt = new Date().toISOString();
    item.run.reason =
      item.stopped === "timed_out"
        ? "超过任务执行超时"
        : item.stopped === "stopped"
          ? "用户或服务停止了本次运行"
          : (reason ?? (success ? null : "命令以非零状态退出"));
    if (!success && !item.stopped) {
      const stderr = path.join(
        this.store.directory,
        "runs",
        item.run.id,
        "stderr.log",
      );
      if (fs.existsSync(stderr)) {
        const fd = fs.openSync(stderr, "r");
        try {
          const size = fs.fstatSync(fd).size,
            buffer = Buffer.alloc(Math.min(size, 4096));
          fs.readSync(
            fd,
            buffer,
            0,
            buffer.length,
            Math.max(0, size - buffer.length),
          );
          const tail = buffer.toString("utf8").trim();
          if (tail) item.run.reason = (item.run.reason ?? "") + "\n" + tail;
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    if (
      task.notify &&
      ["failed", "timed_out"].includes(item.run.status) &&
      this.store.settings().telegram.enabled
    )
      item.run.alertStatus = "pending";
    this.store.saveRun(item.run);
    this.onFinished();
  }
  stop(id: string, preserveCause = false): void {
    const item = this.active.get(id);
    if (!item) throw new Error("任务未在运行");
    if (!item.child)
      throw new Error("上次中断的进程尚未确认退出，当前禁止启动重叠任务");
    if (!preserveCause) item.stopped = "stopped";
    if (item.child.connected) item.child.send({ type: "stop" }, () => {});
    // Let the worker establish its cleanup barrier before signalling the command.
    else if (item.commandPid) terminateTree(item.commandPid);
    item.killTimer ??= setTimeout(() => {
      if (item.commandPid) terminateTree(item.commandPid, true);
      item.child?.kill("SIGKILL");
    }, 2500);
  }
  log(id: string, stream: string, offset: number) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !this.store.run(id))
      throw new Error("运行记录不存在");
    return readLog(path.join(this.store.directory, "runs", id), stream, offset);
  }
  snapshot(id: string): { run: SchedulerRun; task: SchedulerTask | null } {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("无效运行 ID");
    const run = this.store.run(id);
    if (!run) throw new Error("运行记录不存在");
    const file = path.join(this.store.directory, "runs", id, "task.json");
    return {
      run,
      task: fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf8")) as SchedulerTask)
        : null,
    };
  }
  cleanup(): void {
    this.store.prune(this.store.settings().retentionDays, Date.now(), (id) =>
      fs.rmSync(path.join(this.store.directory, "runs", id), {
        recursive: true,
        force: true,
      }),
    );
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.timers.values()) timer.stop();
    const waits: Promise<void>[] = [];
    for (const item of this.active.values())
      if (item.child) {
        waits.push(
          new Promise((resolve) => {
            item.finish = resolve;
          }),
        );
        this.stop(item.run.id);
      }
    await Promise.all(waits);
  }
}
