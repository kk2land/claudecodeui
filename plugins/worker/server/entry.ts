import fs from "node:fs";
import express from "express";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WorkerService } from "./service.js";
import { createWorkerMcpServer, uiError } from "./mcp.js";
import type {
  WorkerIpcAction,
  WorkerIpcRequest,
  WorkerIpcResponse,
  WorkerIpcSuccessResponse,
  WorkerNotificationDelivery,
  WorkerOwner,
} from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";

const token = process.env.CLOUDCLI_PLUGIN_TOKEN;
const directory = process.env.CLOUDCLI_PLUGIN_DATA_DIR;
const hostRoot = process.env.CLOUDCLI_HOST_ROOT;
if (!token || !directory || !hostRoot)
  throw new Error("Worker 插件必须通过宿主启动");
if (!process.connected) throw new Error("宿主 IPC 通道未建立");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

const service = new WorkerService({ dataDirectory: directory });
service.recoverFromDisk();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function uiOnly(req: Request, res: Response, next: () => void): void {
  if (bearer(req) !== token) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "未授权" } });
    return;
  }
  next();
}

const route =
  (handler: (req: Request) => unknown | Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await handler(req));
    } catch (error) {
      const failure = uiError(error);
      res.status(failure.status).json(failure.body);
    }
  };

app.get(
  "/state",
  uiOnly,
  route((req) => {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const parentSessionId =
      typeof req.query.parentSessionId === "string"
        ? req.query.parentSessionId
        : undefined;
    return service.state({ projectId, parentSessionId });
  }),
);

app.get(
  "/workers/:workerId",
  uiOnly,
  route((req) => service.get(String(req.params.workerId))),
);

app.get(
  "/workers/:workerId/logs",
  uiOnly,
  route((req) =>
    service.logs(String(req.params.workerId), {
      runId:
        typeof req.query.runId === "string" ? req.query.runId : undefined,
      stream: req.query.stream === "stderr" ? "stderr" : "events",
      cursor:
        typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      limit:
        typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
    }),
  ),
);

app.post(
  "/cancel",
  uiOnly,
  route(async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return {
      workerIds: await service.cancel({
        workerIds: body.workerIds as string[] | undefined,
        all: body.all as boolean | undefined,
        parentSessionId: body.parentSessionId as string | undefined,
        projectId: body.projectId as string | undefined,
        pause: body.pause as boolean | undefined,
      }),
    };
  }),
);

app.put(
  "/settings",
  uiOnly,
  route((req) => {
    const body = (req.body ?? {}) as { concurrency?: { dsh: number; pi: number } };
    return service.updateSettings(body as { concurrency: { dsh: number; pi: number } });
  }),
);

app.post(
  "/recover",
  uiOnly,
  route((req) => service.recover(req.body)),
);

app.post(
  "/cleanup",
  uiOnly,
  route(async (req) => service.cleanup(req.body)),
);

app.post(
  "/notifications/retry",
  uiOnly,
  route((req) => service.retryNotifications(req.body?.eventIds)),
);

app.post("/api/worker-mcp", async (req, res) => {
  const owner = service.ownerForToken(bearer(req));
  if (!owner) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "未授权" } });
    return;
  }
  const server = createWorkerMcpServer(service, owner);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent)
      res.status(500).json({
        error: {
          code: "MCP_FAILED",
          message: error instanceof Error ? error.message : "MCP 调用失败",
        },
      });
  }
});
app.all("/api/worker-mcp", (_req, res) => {
  res.status(405).json({
    error: { code: "METHOD_NOT_ALLOWED", message: "MCP 仅支持 POST" },
  });
});

app.use(
  (
    error: Error,
    _req: Request,
    res: Response,
    _next: (error?: unknown) => void,
  ) => {
    if (res.headersSent) return;
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: error.message || "请求体无效",
      },
    });
  },
);

const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    process.stdout.write(
      JSON.stringify({ ready: true, port: address.port }) + "\n",
    );
});

const actions = new Set<WorkerIpcAction>([
  "registerOwner",
  "setOwnerPaused",
  "closeInstance",
  "closeAll",
  "listNotifications",
  "claimNotifications",
  "settleNotifications",
  "hasActiveWorkers",
]);

async function handleIpc(
  message: WorkerIpcRequest,
): Promise<unknown> {
  if (message.channel !== "cloudcli-workers" || message.kind !== "request")
    throw new WorkerFailure("INVALID_MESSAGE", "非法 IPC 消息");
  if (!actions.has(message.action))
    throw new WorkerFailure("UNKNOWN_ACTION", "未知 IPC 动作: " + message.action);
  const payload = message.payload as Record<string, unknown>;
  switch (message.action) {
    case "registerOwner":
      if (payload.token === token)
        throw new WorkerFailure(
          "TOKEN_CONFLICT",
          "MCP owner token 不能与 UI token 相同",
        );
      return service.registerOwner(
        payload.owner as WorkerOwner,
        payload.token as string,
      );
    case "setOwnerPaused":
      return service.setOwnerPaused(
        payload.ownerId as string,
        payload.paused as boolean,
        payload.reason as string | undefined,
      );
    case "closeInstance":
      return service.closeInstance(
        payload.appServerInstanceId as string,
        payload.reason as string,
      );
    case "closeAll":
      return service.closeAll(payload.reason as string);
    case "listNotifications":
      return service.notifications();
    case "claimNotifications":
      return service.claimNotifications(
        payload.ownerId as string,
        payload.eventIds as string[],
        payload.batchId as string,
      );
    case "settleNotifications":
      return service.settleNotifications(
        payload.batchId as string,
        payload.delivery as WorkerNotificationDelivery,
      );
    case "hasActiveWorkers":
      return service.hasActiveWorkers(payload.ownerId as string);
  }
}

process.on("message", (raw: unknown) => {
  const message = raw as WorkerIpcRequest | undefined;
  if (!message || typeof message !== "object" || message.kind !== "request") return;
  const id = String(message.id ?? "");
  void (async () => {
    let response: WorkerIpcResponse;
    try {
      response = {
        channel: "cloudcli-workers",
        id,
        kind: "response",
        ok: true,
        value: (await handleIpc(message)) as WorkerIpcSuccessResponse["value"],
      };
    } catch (error) {
      response = {
        channel: "cloudcli-workers",
        id,
        kind: "response",
        ok: false,
        error: {
          code: error instanceof WorkerFailure ? error.code : "INTERNAL",
          message: error instanceof Error ? error.message : "内部错误",
        },
      };
    }
    if (process.connected) process.send?.(response);
  })();
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  try {
    await service.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
process.on("disconnect", () => void close());
