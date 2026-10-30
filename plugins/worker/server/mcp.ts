import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkerService } from "./service.js";
import type { WorkerOwner, WorkerStartInput } from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";

const timeoutSeconds = z.number().int().positive().nullable().optional();

const startShape = {
  taskName: z.string(),
  // Omitted selects the plugin's configured defaultWorkerType; explicit dsh/pi always wins.
  type: z.enum(["dsh", "pi"]).optional(),
  prompt: z.string(),
  workspace: z.object({
    mode: z.enum(["worktree", "existing"]),
    cwd: z.string().optional(),
    baseRef: z.string().optional(),
    allowDirtySource: z.boolean().optional(),
  }),
  writePaths: z.array(z.string()),
  model: z.string().optional(),
  provider: z.string().optional(),
  effort: z.string().optional(),
  timeoutSeconds,
  requestId: z.string(),
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
      description: "获取当前父会话的 owner、并发设置、活动任务与待确认通知摘要；派发后通常交还回合，由终态通知唤醒后再验收",
      inputSchema: {},
    },
    async () => {
      try {
        return result(service.context(ownerId));
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
      },
    },
    async ({ status }) => {
      try {
        const snapshot = service.state({
          projectId: owner.projectId,
          parentSessionId: owner.parentSessionId,
        });
        return result({
          workers: snapshot.workers.filter(
            (worker) =>
              worker.parentSessionId === owner.parentSessionId &&
              worker.projectId === owner.projectId &&
              (!status || worker.latestRun?.status === status),
          ),
          notifications: service.notificationsForScope(ownerId),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_start",
    {
      description: "异步启动一个 DSH 或 Pi 子任务；省略 type 使用插件默认类型，必须显式选择 worktree 或 existing 工作区。接受后立即返回（可能仍在排队），终态通过 Worker outbox 自动通知父会话；正常下一步是交还父回合或处理独立工作，不要轮询保活",
      inputSchema: startShape,
    },
    async (input) => {
      try {
        return result(await service.start(ownerId, input as WorkerStartInput));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_resume",
    {
      description: "异步续接已有 worker 的原生会话，cwd、home 和原生身份保持不变；接受后立即返回，终态自动通知，正常下一步是交还父回合而非轮询",
      inputSchema: {
        workerId: z.string(),
        prompt: z.string(),
        model: z.string().optional(),
        provider: z.string().optional(),
        effort: z.string().optional(),
        timeoutSeconds,
        requestId: z.string(),
      },
    },
    async (input) => {
      try {
        return result(await service.resume(ownerId, input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_get",
    {
      description: "读取一个 worker 及其全部运行记录与待确认通知；收到终态后应检查实际 diff 与测试证据，不要反复轮询",
      inputSchema: { workerId: z.string() },
    },
    async ({ workerId }) => {
      try {
        return result({
          ...service.get(workerId, ownerId),
          notifications: service.notificationsForWorker(workerId, ownerId),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "worker_logs",
    {
      description: "分页读取一次运行的原始事件或 stderr",
      inputSchema: {
        workerId: z.string(),
        runId: z.string().optional(),
        stream: z.enum(["events", "stderr"]).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(262144).optional(),
      },
    },
    async ({ workerId, runId, stream, cursor, limit }) => {
      try {
        return result(
          service.logs(
            workerId,
            { runId, stream: stream ?? "events", cursor, limit },
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
      description: "等待 worker 进入终态，最多 25 秒；仅供用户明确要求等待或必要的短检查，不要循环调用以维持父回合 Processing",
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
      description: "确认已收到终态通知；仅表示收到，不代表验收",
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
      description: "取消当前 owner 的排队或活动运行，并可暂停新任务",
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
