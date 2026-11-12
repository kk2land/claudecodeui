import { randomUUID } from "node:crypto";
import type {
  ResidentBindingView,
  ResidentContinueResponse,
  ResidentIpcEvent,
  ResidentRemoveResult,
  ResidentTaskDetail,
  ResidentTaskListResponse,
  ResidentTaskRow,
  ResidentTaskStatus,
  ResidentTerminal,
  SchedulerRun,
} from "../shared/contracts.js";
import type { ResidentStore } from "./resident-store.js";
import { ResidentHostError, type ResidentHost } from "./resident-ipc.js";
import type { SchedulerStore } from "./store.js";

const ACTIVE_STATUSES: ResidentTaskStatus[] = ["running", "stopping"];

/**
 * Plugin-side resident task owner. The host is the only runtime authority: this class creates the
 * plugin-owned metadata row, forwards every control action over the `cloudcli-scheduler-resident`
 * IPC channel, and records each finished episode as one `source: "resident"` run row. Used by the
 * plugin HTTP routes (entry) and the host IPC events.
 */
export class ResidentTasks {
  private readonly bindings = new Map<string, ResidentBindingView>();
  constructor(
    private readonly store: SchedulerStore,
    private readonly host: ResidentHost,
    /** Called after a newly recorded terminal so the Telegram outbox can flush immediately. */
    private readonly onTerminal: () => void = () => {},
    /** Resolves a project name from the host catalog; null when the catalog is unavailable. */
    private readonly projectName: (projectId: string) => string | null = () => null,
  ) {
    this.host.onEvent((event) => {
      void this.receive(event).catch((error) =>
        console.error("[Resident]", String(error)),
      );
    });
  }
  private get resident(): ResidentStore {
    return this.store.resident;
  }
  /** Plugin startup reconciliation: the host snapshot only, never a continue or host restart. */
  async ready(): Promise<void> {
    const { bindings } = await this.host.request("status", {});
    this.reconcile(bindings);
  }
  async list(): Promise<ResidentTaskListResponse> {
    const { bindings } = await this.host.request("status", {});
    this.reconcile(bindings);
    return {
      tasks: bindings
        .map((binding) => this.row(binding))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    };
  }
  async detail(taskId: string): Promise<ResidentTaskDetail> {
    const binding = await this.binding(taskId);
    return { ...this.row(binding), runs: this.resident.runs(taskId) };
  }
  /**
   * Binds a running foreground session. The host validates runtime state, provider and duplicate
   * bindings; only this plugin generates the task id. A metadata write failure unbinds again so a
   * task without a metadata row cannot linger.
   */
  async create(sessionId: string): Promise<ResidentTaskRow> {
    const taskId = randomUUID();
    const { binding } = await this.host.request("adopt", { taskId, sessionId });
    try {
      this.resident.ensureTask({
        taskId: binding.taskId,
        sessionId: binding.sessionId,
        notify: true,
        lastProcessedTerminalId: null,
        createdAt: binding.createdAt,
      });
    } catch (error) {
      await this.host.request("remove", { taskId }).catch(() => {});
      throw error;
    }
    this.remember(binding);
    return this.row(binding);
  }
  /** PATCH only exposes the two independent switches; the host applies each one. */
  async update(
    taskId: string,
    patch: { enabled?: boolean; visible?: boolean },
  ): Promise<ResidentTaskRow> {
    let binding: ResidentBindingView | null = null;
    if (patch.enabled !== undefined)
      binding = (
        await this.host.request("setEnabled", {
          taskId,
          enabled: patch.enabled,
        })
      ).binding;
    if (patch.visible !== undefined)
      binding = (
        await this.host.request("setVisible", {
          taskId,
          visible: patch.visible,
        })
      ).binding;
    return this.row(binding ?? (await this.binding(taskId)));
  }
  async stop(taskId: string): Promise<ResidentTaskRow> {
    const { binding } = await this.host.request("stop", { taskId });
    this.remember(binding);
    return this.row(binding);
  }
  /** Accepts at most one turn in the original native session and returns without waiting for it. */
  async resume(taskId: string): Promise<ResidentContinueResponse> {
    const { result, binding } = await this.host.request("continue", { taskId });
    this.remember(binding);
    return { task: this.row(binding), result };
  }
  /**
   * Removes a task: a still-active execution must be stopped successfully first, then the host is
   * asked to unbind, and only then is the metadata row deleted. The session itself is kept, and a
   * failed stop leaves the task, its protection and its metadata untouched.
   */
  async remove(taskId: string): Promise<ResidentRemoveResult> {
    const binding = await this.binding(taskId);
    if (ACTIVE_STATUSES.includes(binding.status))
      await this.host.request("stop", { taskId });
    const result = await this.host.request("remove", { taskId });
    this.resident.deleteTask(taskId);
    this.bindings.delete(taskId);
    return result;
  }
  private async binding(taskId: string): Promise<ResidentBindingView> {
    const { bindings } = await this.host.request("status", { taskId });
    const binding = bindings.find((candidate) => candidate.taskId === taskId);
    if (!binding)
      throw new ResidentHostError("not_found", "宿主没有该常驻任务");
    this.remember(binding);
    return binding;
  }
  private remember(binding: ResidentBindingView): void {
    this.bindings.set(binding.taskId, binding);
  }
  private row(binding: ResidentBindingView): ResidentTaskRow {
    return {
      ...binding,
      notify: this.resident.task(binding.taskId)?.notify ?? true,
    };
  }
  /**
   * Adds metadata for the host's bindings and records terminals the plugin missed while it was
   * down. It never deletes metadata: this plugin dataset is the only owner of that row, so a
   * snapshot that happens to lack a task (for example one captured just before an adopt returned)
   * must not remove it. Metadata is dropped only by an explicit, already-stopped removal.
   */
  private reconcile(bindings: ResidentBindingView[]): void {
    for (const binding of bindings) {
      this.remember(binding);
      this.resident.ensureTask({
        taskId: binding.taskId,
        sessionId: binding.sessionId,
        notify: this.resident.task(binding.taskId)?.notify ?? true,
        lastProcessedTerminalId:
          this.resident.task(binding.taskId)?.lastProcessedTerminalId ?? null,
        createdAt: binding.createdAt,
      });
      if (binding.terminal) this.recordTerminal(binding.terminal);
    }
  }
  private async receive(event: ResidentIpcEvent): Promise<void> {
    if (event.event === "sync") {
      this.reconcile(event.value.bindings);
      return;
    }
    if (event.event === "terminal") {
      await this.terminal(event.value);
      return;
    }
    // `changed` is a cheap invalidation: HTTP readers always query the host, so nothing is stored.
  }
  private async terminal(terminal: ResidentTerminal): Promise<void> {
    const meta = this.resident.task(terminal.taskId);
    if (meta?.lastProcessedTerminalId === terminal.id) return;
    const binding =
      this.bindings.get(terminal.taskId) ??
      (await this.binding(terminal.taskId).catch(() => null));
    this.recordTerminal(terminal, binding ?? undefined);
  }
  private recordTerminal(
    terminal: ResidentTerminal,
    binding = this.bindings.get(terminal.taskId),
  ): void {
    const meta = this.resident.task(terminal.taskId);
    if (meta?.lastProcessedTerminalId === terminal.id) return;
    // The metadata row is normally created at adoption; recreate it if the host still owns the
    // binding so the delivery cursor survives.
    this.resident.ensureTask({
      taskId: terminal.taskId,
      sessionId: terminal.sessionId,
      notify: meta?.notify ?? true,
      lastProcessedTerminalId: meta?.lastProcessedTerminalId ?? null,
      createdAt: meta?.createdAt ?? terminal.endedAt,
    });
    const telegram = this.store.settings().telegram.enabled;
    const run: SchedulerRun = {
      id: terminal.id,
      projectId: binding?.projectId ?? "",
      projectName:
        binding ? (this.projectName(binding.projectId) ?? binding.projectId) : "",
      taskId: terminal.taskId,
      taskName: binding?.name ?? "常驻任务",
      status: terminal.status,
      trigger: "resident",
      // The host reports only the terminal boundary for a resident episode.
      scheduledAt: terminal.endedAt,
      startedAt: terminal.endedAt,
      endedAt: terminal.endedAt,
      exitCode: null,
      reason: terminal.reason,
      workerPid: null,
      usage: terminal.usage ?? null,
      alertStatus:
        terminal.alert && (meta?.notify ?? true) && telegram ? "pending" : "none",
      alertError: null,
      alertAttempts: 0,
      source: "resident",
      residentTaskId: terminal.taskId,
      sessionId: terminal.sessionId,
      executionId: terminal.executionId,
    };
    if (this.resident.recordTerminal(run)) this.onTerminal();
  }
}
