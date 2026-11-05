import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createWorkerMcpServer } from "../server/mcp.js";
import type { WorkerService } from "../server/service.js";
import type { WorkerNotification, WorkerPlan, WorkerRecord, WorkerRun } from "../shared/contracts.js";
import { createService, startInput, temporaryRoot, waitFor } from "./helpers.js";

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

test("real MCP handshake exposes 12 tools and executes worker tools", async (t) => {
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
      "worker_plan_save",
      "worker_recover",
      "worker_resume",
      "worker_start",
      "worker_wait",
    ],
  );
  const codexEnvSecret = "{{SECRET_xk2p9vqa}}";
  const codexArgSecret = "{{SECRET_hs8m4trc}}";
  const codex = {
    env: { SECRET_TOKEN: codexEnvSecret, CODEX_PROXY_BYPASS: "1" },
    extraArgs: ["-c", "model_provider=magpie", "--token", codexArgSecret],
  };
  service.updateSettings({
    concurrency: { dsh: 3, pi: 3 },
    defaultWorkerType: "dsh",
    enabled: { dsh: true, pi: true, codex: true },
    roles: { dsh: [], pi: ["code_review"], codex: [] },
    defaults: {
      dsh: { model: "mcp-default-model", effort: "medium" },
      pi: { model: null, effort: null },
    },
    codex,
  });
  const context = text(await client.callTool({ name: "worker_context", arguments: {} }));
  assert.equal((context as { owner: { id: string } }).owner.id, "mcp-owner");
  assert.equal((context as { plan: WorkerPlan | null }).plan, null);
  const content = "# 协作计划\n\n- W1：执行后待主会话验收\n- W2：依赖 W1，等待产物交接\n";
  const plan = text(await client.callTool({ name: "worker_plan_save", arguments: { content } })) as WorkerPlan;
  assert.equal(plan.content, content);
  assert.ok(Number.isFinite(Date.parse(plan.updatedAt)));
  assert.deepEqual(service.state().workers, []);
  assert.deepEqual(service.notifications(), []);
  for (const invalid of [{}, { content: 42 }, { content: " \n\t" }]) {
    const rejected = await client.callTool({ name: "worker_plan_save", arguments: invalid });
    assert.equal(rejected.isError, true);
    assert.deepEqual(service.context(owner.id).plan, plan);
  }
  assert.deepEqual(
    (context as { settings: { defaultWorkerType: string; defaults: unknown } })
      .settings.defaultWorkerType,
    "dsh",
  );
  const contextSettings = (context as {
    settings: {
      concurrency: unknown;
      defaults: unknown;
      enabled: unknown;
      roles: unknown;
      codex?: unknown;
    };
  }).settings;
  assert.deepEqual(contextSettings.concurrency, { dsh: 3, pi: 3, codex: 3 });
  assert.deepEqual(contextSettings.defaults, {
    dsh: { model: "mcp-default-model", effort: "medium" },
    pi: { model: null, effort: null },
    codex: { model: null, effort: null },
  });
  assert.deepEqual(contextSettings.enabled, { dsh: true, pi: true, codex: true });
  assert.deepEqual(contextSettings.roles, {
    dsh: [],
    pi: ["code_review"],
    codex: [],
  });
  assert.equal("codex" in contextSettings, false);
  const mcpConfigs = (context as {
    settings: { configs: Array<{ type: string; codex?: unknown }> };
  }).settings.configs;
  assert.deepEqual(
    mcpConfigs.find((config) => config.type === "codex")?.codex,
    { modelProvider: "magpie" },
  );
  const serializedContext = JSON.stringify(context);
  assert.equal(serializedContext.includes(codexEnvSecret), false);
  assert.equal(serializedContext.includes(codexArgSecret), false);
  assert.deepEqual(service.context(owner.id).settings, contextSettings);
  // The legacy projection keeps the service as a valid argv pair, but canonical state no
  // longer stores it inside the extra args.
  const projectedCodex = {
    env: codex.env,
    extraArgs: ["--token", codexArgSecret, "-c", "model_provider=magpie"],
  };
  assert.deepEqual(service.state().settings.codex, projectedCodex);
  assert.deepEqual(service.settings().codex, projectedCodex);
  const { type: _omittedType, ...omitted } = startInput({
    requestId: "mcp-start",
    taskName: "mcp task",
    model: "mcp-explicit-model",
    effort: "low",
  });
  const started = text(
    await client.callTool({
      name: "worker_start",
      arguments: omitted,
    }),
  ) as { worker: { id: string }; run: { id: string } };
  assert.ok(started.worker.id);
  assert.equal(service.get(started.worker.id).worker.type, "dsh");
  assert.equal(service.get(started.worker.id).worker.latestRun?.model, "mcp-explicit-model");
  assert.equal(service.get(started.worker.id).worker.latestRun?.effort, "low");
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
  ) as { notifications: { id: string }[]; plan: WorkerPlan };
  assert.deepEqual(afterCompletion.plan, plan, "completion does not accept or rewrite the saved plan");
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

  const { type: _defaultOmittedType, ...defaultOmitted } = startInput({
    requestId: "mcp-default-start",
    taskName: "mcp default task",
  });
  const defaulted = text(
    await client.callTool({
      name: "worker_start",
      arguments: defaultOmitted,
    }),
  ) as { worker: { id: string }; run: { id: string } };
  const defaultWaited = text(
    await client.callTool({
      name: "worker_wait",
      arguments: { workerId: defaulted.worker.id, timeoutSeconds: 10 },
    }),
  ) as { run: { status: string; model: string | null; effort: string | null } };
  assert.equal(defaultWaited.run.status, "completed");
  assert.equal(defaultWaited.run.model, "mcp-default-model");
  assert.equal(defaultWaited.run.effort, "medium");
  assert.equal(service.get(defaulted.worker.id).worker.type, "dsh");

  const roleStarted = text(
    await client.callTool({
      name: "worker_start",
      arguments: {
        ...omitted,
        taskRole: "code_review",
        requestId: "mcp-role-start",
      },
    }),
  ) as { worker: { id: string; type: string; taskRole?: string } };
  assert.equal(roleStarted.worker.type, "pi");
  assert.equal(roleStarted.worker.taskRole, "code_review");
  const roleWaited = text(
    await client.callTool({
      name: "worker_wait",
      arguments: { workerId: roleStarted.worker.id, timeoutSeconds: 10 },
    }),
  ) as { run: { status: string } };
  assert.equal(roleWaited.run.status, "completed");
  const rejectedRole = await client.callTool({
    name: "worker_start",
    arguments: {
      ...omitted,
      taskRole: "architecture",
      requestId: "mcp-invalid-role",
    },
  });
  assert.equal(rejectedRole.isError, true);
  assert.equal(service.state().workers.length, 3);

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
  const otherContext = text(await other.callTool({ name: "worker_context", arguments: {} })) as { plan: WorkerPlan | null };
  assert.equal(otherContext.plan, null);
  await other.callTool({ name: "worker_plan_save", arguments: { content: "# Other parent's plan" } });
  const originalContext = text(await client.callTool({ name: "worker_context", arguments: {} })) as { plan: WorkerPlan };
  assert.deepEqual(originalContext.plan, plan);
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

for (const type of ["dsh", "pi", "codex"] as const) test(`MCP corrects a slow ${type} task by cancelling and resuming its original session`, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = Date.now();
  const { service, env, data } = createService(t, temporaryRoot("worker-mcp-correction-"), {
    TEST_SCENARIO: "sleep", TEST_DELAY_MS: "60000",
  }, { now: () => now });
  const host = await mcpServer(service, "owner-token");
  t.after(host.close);
  const client = new Client({ name: "worker-correction", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(host.url, {
    requestInit: { headers: { authorization: "Bearer owner-token" } },
  }));
  t.after(() => client.close());

  const started = text(await client.callTool({ name: "worker_start", arguments: startInput({ type }) })) as { worker: WorkerRecord; run: WorkerRun };
  await waitFor(() => service.get(started.worker.id).worker.latestRun?.status, (status) => status === "running");
  now += 600_000;
  t.mock.timers.tick(1000);
  const observed = text(await client.callTool({ name: "worker_get", arguments: { workerId: started.worker.id } })) as { worker: WorkerRecord; notifications: WorkerNotification[] };
  assert.equal(observed.worker.latestRun?.status, "running");
  assert.equal(observed.notifications.length, 1);
  assert.equal(observed.notifications[0]?.status, "running");
  await client.callTool({ name: "worker_ack", arguments: { eventIds: observed.notifications.map((item) => item.id) } });
  const feedback = { workerId: started.worker.id, prompt: "Preserve the existing edits. Implement the missing check, run the targeted test, and return its result.", requestId: "correction-1" };
  const premature = await client.callTool({ name: "worker_resume", arguments: feedback });
  assert.equal(premature.isError, true, "a budget warning is not permission to overlap the same session");
  const cancelled = await client.callTool({ name: "worker_cancel", arguments: { workerIds: [started.worker.id], pause: false } });
  assert.notEqual(cancelled.isError, true);
  const stopped = service.get(started.worker.id).worker.latestRun!;
  assert.equal(stopped.status, "cancelled");
  assert.ok(stopped.nativeSessionId);
  assert.equal(service.store.owner("owner-1")?.paused, false);

  env.TEST_DELAY_MS = "1";
  const resumed = text(await client.callTool({ name: "worker_resume", arguments: feedback })) as { worker: WorkerRecord; run: WorkerRun };
  assert.equal(resumed.worker.id, started.worker.id);
  assert.notEqual(resumed.run.id, started.run.id);
  const finished = text(await client.callTool({ name: "worker_wait", arguments: { workerId: started.worker.id, timeoutSeconds: 5 } })) as { worker: WorkerRecord; run: WorkerRun };
  assert.equal(finished.run.status, "completed");
  assert.equal(finished.run.nativeSessionId, stopped.nativeSessionId);
  assert.equal(finished.run.home, observed.worker.latestRun?.home);
  assert.equal(finished.worker.cwd, observed.worker.cwd);
  assert.equal(finished.run.progress.softReminderSentAt, null, "a new run has its own soft budget");
  assert.match(fs.readFileSync(path.join(data, "logs", started.worker.id, resumed.run.id, "prompt.md"), "utf8"), /Preserve the existing edits/);
  assert.deepEqual(service.notifications().map((item) => item.status), ["running", "cancelled", "completed"]);
});
