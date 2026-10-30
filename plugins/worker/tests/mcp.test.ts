import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createWorkerMcpServer } from "../server/mcp.js";
import type { WorkerService } from "../server/service.js";
import { createService, startInput, temporaryRoot } from "./helpers.js";

function text(result: unknown): unknown {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const value = content?.find((item) => item.type === "text")?.text ?? "";
  return JSON.parse(value);
}

async function mcpServer(
  service: WorkerService,
  token: string,
): Promise<{ url: URL; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.post("/api/worker-mcp", async (req, res) => {
    const header = req.headers.authorization;
    const supplied = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const owner = service.ownerForToken(supplied);
    if (!owner) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "no" } });
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
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/api/worker-mcp", (_req, res) => res.status(405).end());
  const http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no port");
  void token;
  return {
    url: new URL("http://127.0.0.1:" + address.port + "/api/worker-mcp"),
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

test("real MCP handshake exposes 11 tools and executes worker tools", async (t) => {
  const { service, project } = createService(t, temporaryRoot("worker-mcp-"));
  const owner = service.registerOwner(
    {
      id: "mcp-owner",
      parentSessionId: "mcp-parent",
      projectId: "mcp-project",
      projectPath: project,
      userId: null,
      appServerInstanceId: "mcp-app",
      paused: false,
    },
    "mcp-token",
  );
  const host = await mcpServer(service, "mcp-token");
  t.after(host.close);
  const client = new Client({ name: "worker-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(host.url, {
    requestInit: { headers: { authorization: "Bearer mcp-token" } },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "worker_ack",
      "worker_cancel",
      "worker_cleanup",
      "worker_context",
      "worker_get",
      "worker_list",
      "worker_logs",
      "worker_recover",
      "worker_resume",
      "worker_start",
      "worker_wait",
    ],
  );
  const context = text(await client.callTool({ name: "worker_context", arguments: {} }));
  assert.equal((context as { owner: { id: string } }).owner.id, "mcp-owner");
  const started = text(
    await client.callTool({
      name: "worker_start",
      arguments: startInput({
        requestId: "mcp-start",
        taskName: "mcp task",
      }),
    }),
  ) as { worker: { id: string }; run: { id: string } };
  assert.ok(started.worker.id);
  const waited = text(
    await client.callTool({
      name: "worker_wait",
      arguments: { workerId: started.worker.id, timeoutSeconds: 10 },
    }),
  ) as {
    run: { status: string };
    notifications: { id: string; delivery: string }[];
  };
  assert.equal(waited.run.status, "completed");
  assert.ok(waited.notifications.length >= 1);
  const fetched = text(
    await client.callTool({
      name: "worker_get",
      arguments: { workerId: started.worker.id },
    }),
  ) as { notifications: { id: string }[] };
  assert.deepEqual(
    fetched.notifications.map((item) => item.id),
    waited.notifications.map((item) => item.id),
  );
  const afterCompletion = text(
    await client.callTool({ name: "worker_context", arguments: {} }),
  ) as { notifications: { id: string }[] };
  assert.deepEqual(
    afterCompletion.notifications.map((item) => item.id),
    waited.notifications.map((item) => item.id),
  );
  const acked = text(
    await client.callTool({
      name: "worker_ack",
      arguments: { eventIds: waited.notifications.map((item) => item.id) },
    }),
  ) as { acknowledged: number };
  assert.equal(acked.acknowledged, waited.notifications.length);
  assert.equal(
    service.claimNotifications("mcp-owner", [], "after-ack").notifications.length,
    0,
  );
  const logs = text(
    await client.callTool({
      name: "worker_logs",
      arguments: { workerId: started.worker.id },
    }),
  ) as { text: string; done: boolean };
  assert.match(logs.text, /session/);
  assert.equal(logs.done, true);

  const intruder = service.registerOwner(
    {
      id: "mcp-other",
      parentSessionId: "other-parent",
      projectId: "mcp-project",
      projectPath: owner.projectPath,
      userId: null,
      appServerInstanceId: "other-app",
      paused: false,
    },
    "other-token",
  );
  assert.equal(intruder.id, "mcp-other");
  const other = new Client({ name: "worker-other", version: "1.0.0" });
  const otherTransport = new StreamableHTTPClientTransport(host.url, {
    requestInit: { headers: { authorization: "Bearer other-token" } },
  });
  await other.connect(otherTransport);
  const denied = await other.callTool({
    name: "worker_get",
    arguments: { workerId: started.worker.id },
  });
  assert.equal(denied.isError, true);
  await other.close();

  const unauthorized = new Client({ name: "worker-bad", version: "1.0.0" });
  const badTransport = new StreamableHTTPClientTransport(host.url, {
    requestInit: { headers: { authorization: "Bearer ui-token" } },
  });
  await assert.rejects(unauthorized.connect(badTransport));
});
