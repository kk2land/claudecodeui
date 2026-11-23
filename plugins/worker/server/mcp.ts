import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkerService } from "./service.js";
import type {
  WorkerNotification,
  WorkerOwner,
  WorkerRecord,
  WorkerRun,
  WorkerStartInput,
} from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";
import { WORKER_TASK_ROLES } from "../shared/task-roles.js";
import type { WorkerTaskRole } from "../shared/task-roles.js";

const timeoutSeconds = z.number().int().positive().nullable().optional().describe(
  "start/resume 默认省略，使用所选配置的硬超时。仅当用户明确指定本轮硬超时时传秒数。用户明确要求本轮取消硬超时时传 null",
);
const viewField = z
  .enum(["compact"])
  .optional()
  .describe('省略返回完整形状；"compact" 只返回定位与验收所需字段');
const taskRoleValues = WORKER_TASK_ROLES.map((role) => role.value) as [
  WorkerTaskRole,
  ...WorkerTaskRole[],
];

const startShape = {
  taskName: z.string(),
  // Omitted routes among enabled configs: a role takes the first match in list order, otherwise
  // the default config wins.
  configId: z
    .string()
    .optional()
    .describe("指定配置 id，须存在且启用；省略时按已启用配置路由"),
  type: z.enum(["dsh", "pi", "codex", "agy"]).optional(),
  taskRole: z
    .enum(taskRoleValues)
    .optional()
    .describe("按主要交付物选一个角色；用于配置路由，并在新建时前置内置职责与回报要求"),
  prompt: z.string(),
  workspace: z.object({
    mode: z.enum(["worktree", "existing"]),
    cwd: z.string().optional(),
    baseRef: z.string().optional(),
    allowDirtySource: z.boolean().optional(),
  }),
  writePaths: z.array(z.string()),
  model: z.string().optional(),
  provider: z.string().optional().describe("独立模型服务，仅 Codex 支持；Pi/DSH/agy 请使用完整 model"),
  effort: z.string().optional(),
  timeoutSeconds,
  requestId: z.string(),
  view: viewField,
};

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

//----------------- MCP VIEW PROJECTION ----------------

/**
 * Locating projection reused by compact context active workers and compact list workers. The
 * current run only locates the worker; history, final text, error, and usage need the omitted
 * `view` request.
 */
function compactWorker(worker: WorkerRecord) {
  const run = worker.latestRun;
  return {
    id: worker.id,
    taskName: worker.taskName,
    cwd: worker.cwd,
    latestRun: run ? { id: run.id, status: run.status } : null,
  };
}

/**
 * Compact outbox view. Delivered notifications are already consumed by the parent session, so
 * they are dropped; held, pending, and unknown deliveries stay visible with their owner scope.
 */
function compactNotifications(notifications: WorkerNotification[]) {
  return notifications
    .filter((item) => item.delivery !== "delivered")
    .map((item) => ({
      id: item.id,
      workerId: item.workerId,
      runId: item.runId,
      status: item.status,
      delivery: item.delivery,
      summary: item.summary,
    }));
}

/** Compact start/resume receipt: these ids belong to the run the service actually accepted. */
function compactReceipt(worker: WorkerRecord, run: WorkerRun) {
  return {
    workerId: worker.id,
    runId: run.id,
    status: run.status,
    cwd: worker.cwd,
  };
}

/**
 * Creates one stateless MCP server bound to a token-authenticated owner. The owner fields are
 * never accepted from tool arguments, so a worker cannot claim another parent or project.
 */
export function createWorkerMcpServer(
  service: WorkerService,
  owner: WorkerOwner,
): McpServer {
  const server = new McpServer({ name: "cloudcli-workers", version: "0.1.0" });
  const ownerId = owner.id;

  server.registerTool(
    "worker_context",
    {
      description: "获取 owner、计划、配置与并发设置、活动任务与待确认通知；配置不含凭据。计划须结合实际 Worker 状态核对，派发后由提醒或终态唤醒再检查进展或验收",
      inputSchema: { view: viewField },
    },
    async ({ view }) => {
      try {
        const context = service.context(ownerId);
        if (view !== "compact") return result(context);
        return result({
          owner: context.owner,
          plan: context.plan ? { updatedAt: context.plan.updatedAt } : null,
          activeWorkers: context.activeWorkers.map(compactWorker),
          notifications: compactNotifications(context.notifications),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_plan_save",
    {
      description: "保存当前父会话与项目的完整 Markdown 计划并替换原内容，记录任务、依赖、Worker/Run 关联与验收进度；只记录，不派发任务或自动验收",
      inputSchema: {
        content: z.string().refine((content) => content.trim().length > 0, "计划内容不能为空"),
        view: viewField,
      },
    },
    async ({ content, view }) => {
      try {
        const plan = service.savePlan(ownerId, content);
        return result(view === "compact" ? { updatedAt: plan.updatedAt } : plan);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_list",
    {
      description: "列出当前 owner 的 worker 与待确认通知，可按状态过滤；这不是等待或保活机制，不要用它反复轮询",
      inputSchema: {
        status: z
          .enum([
            "queued",
            "starting",
            "running",
            "stopping",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
            "unknown",
          ])
          .optional(),
        view: viewField,
      },
    },
    async ({ status, view }) => {
      try {
        const snapshot = service.state({
          projectId: owner.projectId,
          parentSessionId: owner.parentSessionId,
        });
        const workers = snapshot.workers.filter(
          (worker) =>
            worker.parentSessionId === owner.parentSessionId &&
            worker.projectId === owner.projectId &&
            (!status || worker.latestRun?.status === status),
        );
        const notifications = service.notificationsForScope(ownerId);
        return result(
          view === "compact"
            ? {
                workers: workers.map(compactWorker),
                notifications: compactNotifications(notifications),
              }
            : { workers, notifications },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_start",
    {
      description: "异步启动一个 DSH、Pi、Codex 或 Antigravity (agy) 子任务，必须显式选择 worktree 或 existing 工作区。接受后立即返回（可能仍在排队），运行提醒与终态通过 Worker outbox 自动通知父会话，不要轮询保活",
      inputSchema: startShape,
    },
    async ({ view, ...input }) => {
      try {
        const accepted = await service.start(ownerId, input as WorkerStartInput);
        return result(
          view === "compact" ? compactReceipt(accepted.worker, accepted.run) : accepted,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_resume",
    {
      description: "异步续接已确认停止的 worker 原生会话，cwd、home 和原生身份保持不变；纠偏时用同一 workerId 和说明具体偏差、下一步交付物的新 prompt。接受后立即返回，运行提醒和终态自动通知，交还父回合而非轮询",
      inputSchema: {
        workerId: z.string(),
        prompt: z.string(),
        model: z.string().optional(),
        provider: z.string().optional().describe("独立模型服务，仅 Codex 支持；Pi/DSH/agy 请使用完整 model"),
        effort: z.string().optional(),
        timeoutSeconds,
        requestId: z.string(),
        view: viewField,
      },
    },
    async ({ view, ...input }) => {
      try {
        const accepted = await service.resume(ownerId, input);
        return result(
          view === "compact" ? compactReceipt(accepted.worker, accepted.run) : accepted,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_get",
    {
      description: "读取一个 worker 及其运行记录与待确认通知；收到运行提醒先核对当前 run 与实际进展，收到终态检查 diff 与测试证据，不要反复轮询",
      inputSchema: { workerId: z.string(), view: viewField },
    },
    async ({ workerId, view }) => {
      try {
        const detail = service.get(workerId, ownerId);
        const notifications = service.notificationsForWorker(workerId, ownerId);
        return result(
          view === "compact"
            ? { worker: detail.worker, notifications: compactNotifications(notifications) }
            : { ...detail, notifications },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_logs",
    {
      description: "分页读取一次运行的原始事件或 stderr；无 cursor 时可传 tail 读末尾小窗口，用返回的 nextCursor 继续",
      inputSchema: {
        workerId: z.string(),
        runId: z.string().optional(),
        stream: z.enum(["events", "stderr"]).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(262144).optional(),
        tail: z
          .boolean()
          .optional()
          .describe("无 cursor 时从末尾读取小窗口；省略时从头读取，cursor 优先"),
      },
    },
    async ({ workerId, runId, stream, cursor, limit, tail }) => {
      try {
        return result(
          service.logs(
            workerId,
            { runId, stream: stream ?? "events", cursor, limit, tail },
            ownerId,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_wait",
    {
      description: "等待 Worker 进入终态，最长 25 秒。只在用户明确要求当前回合同步等待时调用一次。",
      inputSchema: {
        workerId: z.string(),
        timeoutSeconds: z.number().int().positive().max(25).optional(),
      },
    },
    async ({ workerId, timeoutSeconds: seconds }) => {
      try {
        return result({
          ...(await service.wait(workerId, seconds ?? 25, ownerId)),
          notifications: service.notificationsForWorker(workerId, ownerId),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_ack",
    {
      description: "确认已收到运行提醒或终态通知；仅表示收到，不代表验收",
      inputSchema: { eventIds: z.array(z.string()) },
    },
    async ({ eventIds }) => {
      try {
        return result(service.ack(ownerId, eventIds));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_cancel",
    {
      description: "取消当前 owner 的排队或活动运行并等待停止确认；纠偏时指定 workerIds、pause: false，确认停止后再用新提示词 resume。pause: true 会暂停 owner 的新任务与自动唤醒",
      inputSchema: {
        workerIds: z.array(z.string()).optional(),
        all: z.boolean().optional(),
        projectId: z.string().optional(),
        pause: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const workerIds = await service.cancel(
          { ...input, parentSessionId: owner.parentSessionId },
          "ui",
          ownerId,
        );
        return result({ workerIds });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_recover",
    {
      description: "在已核实原生会话停止后，将 unknown 运行恢复为 interrupted",
      inputSchema: {
        workerId: z.string(),
        notes: z.string(),
        confirmedStopped: z.literal(true),
      },
    },
    async (input) => {
      try {
        service.get(input.workerId, ownerId);
        return result(service.recover(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_cleanup",
    {
      description: "清理插件创建、干净且已停止的 worktree；保留分支、会话和日志",
      inputSchema: { workerId: z.string() },
    },
    async ({ workerId }) => {
      try {
        service.get(workerId, ownerId);
        return result(await service.cleanup({ workerId }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export function uiError(error: unknown): { status: number; body: unknown } {
  if (error instanceof WorkerFailure)
    return { status: 400, body: { error: { code: error.code, message: error.message } } };
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL",
        message: error instanceof Error ? error.message : "内部错误",
      },
    },
  };
}
