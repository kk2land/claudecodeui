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

function raw(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.find((item) => item.type === "text")?.text ?? "";
}

function text(result: unknown): unknown {
  return JSON.parse(raw(result));
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
  const startSchema = tools.tools.find((tool) => tool.name === "worker_start")
    ?.inputSchema as { properties?: { type?: { enum?: string[] } } } | undefined;
  assert.ok(startSchema?.properties?.type?.enum?.includes("agy"));
  const toolsJson = JSON.stringify(tools);
  t.diagnostic(`tools/list json: ${Buffer.byteLength(toolsJson, "utf8")}B`);
  const codexEnvSecret = "{{SECRET_xk2p9vqa}}";
  const codexArgSecret = "{{SECRET_hs8m4trc}}";
  const codex = {
    env: { SECRET_TOKEN: codexEnvSecret, CODEX_PROXY_BYPASS: "1" },
    extraArgs: ["-c", "model_provider=magpie", "--token", codexArgSecret],
  };
  service.updateSettings({
    concurrency: { pi: 3 },
    defaultWorkerType: "pi",
    enabled: { pi: true, codex: true },
    roles: { pi: ["code_review"], codex: [] },
    defaults: {
      pi: { model: "mcp-default-model", effort: "medium" },
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
    "pi",
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
  assert.deepEqual(contextSettings.concurrency, { dsh: 1, pi: 3, codex: 3, agy: 1 });
  assert.deepEqual(contextSettings.defaults, {
    dsh: { model: null, effort: null },
    pi: { model: "mcp-default-model", effort: "medium" },
    codex: { model: null, effort: null },
    agy: { model: null, effort: null },
  });
  assert.deepEqual(contextSettings.enabled, { dsh: false, pi: true, codex: true, agy: false });
  assert.deepEqual(contextSettings.roles, {
    dsh: [],
    pi: ["code_review"],
    codex: [],
    agy: [],
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
  assert.equal(service.get(started.worker.id).worker.type, "pi");
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

  const tailed = text(
    await client.callTool({
      name: "worker_logs",
      arguments: { workerId: started.worker.id, tail: true, limit: 8 },
    }),
  ) as { text: string; nextCursor: string | null; done: boolean };
  assert.ok(logs.text.endsWith(tailed.text), "tail returns the end of the raw log");
  assert.equal(tailed.nextCursor, null);
  assert.equal(tailed.done, true);
  const fromHead = text(
    await client.callTool({
      name: "worker_logs",
      arguments: { workerId: started.worker.id, cursor: "0", tail: true, limit: 8 },
    }),
  ) as { text: string };
  assert.ok(logs.text.startsWith(fromHead.text), "an explicit cursor wins over tail");
  assert.notEqual(fromHead.text, tailed.text);

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
  assert.equal(service.get(defaulted.worker.id).worker.type, "pi");

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

for (const type of ["pi", "codex"] as const) test(`MCP corrects a slow ${type} task by cancelling and resuming its original session`, async (t) => {
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

test("compact view is opt-in, scoped, and keeps only the current run", async (t) => {
  const { service, project } = createService(t, temporaryRoot("worker-mcp-view-"), {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "1500",
  });
  const host = await mcpServer(service, "owner-token");
  t.after(host.close);
  const client = new Client({ name: "worker-view", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(host.url, {
    requestInit: { headers: { authorization: "Bearer owner-token" } },
  }));
  t.after(() => client.close());

  const content = "# 计划\n\n- W1：实现接口与测试\n- W2：依赖 W1，等待产物交接\n- 验收：目标测试通过并记录证据\n";
  const savedCompact = text(
    await client.callTool({ name: "worker_plan_save", arguments: { content, view: "compact" } }),
  ) as { updatedAt: string };
  assert.deepEqual(Object.keys(savedCompact), ["updatedAt"]);
  assert.equal(
    service.context("owner-1").plan?.content,
    content,
    "compact save still stores and validates the whole plan",
  );
  const blankPlan = await client.callTool({
    name: "worker_plan_save",
    arguments: { content: " \n\t", view: "compact" },
  });
  assert.equal(blankPlan.isError, true);
  assert.equal(service.context("owner-1").plan?.updatedAt, savedCompact.updatedAt);
  const fullPlan = text(
    await client.callTool({ name: "worker_plan_save", arguments: { content } }),
  ) as { content: string; updatedAt: string };
  assert.equal(fullPlan.content, content, "omitting view keeps the full plan shape");

  const started = text(
    await client.callTool({
      name: "worker_start",
      arguments: { ...startInput({ requestId: "view-start" }), view: "compact" },
    }),
  ) as { workerId: string; runId: string; status: string; cwd: string };
  assert.deepEqual(Object.keys(started).sort(), ["cwd", "runId", "status", "workerId"]);
  assert.equal(started.cwd, project);
  const accepted = service.get(started.workerId);
  assert.equal(accepted.worker.latestRun?.id, started.runId);
  assert.ok(["queued", "starting", "running"].includes(started.status));

  // Compact context while the run is active: no settings/counts, locating worker fields only.
  const activeContext = text(
    await client.callTool({ name: "worker_context", arguments: { view: "compact" } }),
  ) as { activeWorkers: Record<string, unknown>[]; plan: { updatedAt: string }; owner: { id: string } };
  assert.deepEqual(Object.keys(activeContext).sort(), [
    "activeWorkers",
    "notifications",
    "owner",
    "plan",
  ]);
  assert.equal(activeContext.owner.id, "owner-1");
  assert.deepEqual(activeContext.plan, { updatedAt: fullPlan.updatedAt });
  assert.equal(activeContext.activeWorkers.length, 1);
  assert.deepEqual(Object.keys(activeContext.activeWorkers[0] ?? {}).sort(), [
    "cwd",
    "id",
    "latestRun",
    "taskName",
  ]);
  const activeRun = activeContext.activeWorkers[0]?.latestRun as Record<string, unknown>;
  assert.deepEqual(Object.keys(activeRun).sort(), ["id", "status"]);
  assert.equal(activeRun.id, started.runId);

  const waited = text(
    await client.callTool({
      name: "worker_wait",
      arguments: { workerId: started.workerId, timeoutSeconds: 10 },
    }),
  ) as { worker: WorkerRecord; run: WorkerRun };
  assert.equal(waited.run.status, "completed");

  const fullContextRaw = raw(
    await client.callTool({ name: "worker_context", arguments: {} }),
  );
  const fullContext = JSON.parse(fullContextRaw) as {
    counts: unknown;
    settings: unknown;
    plan: WorkerPlan;
    notifications: WorkerNotification[];
  };
  assert.equal(fullContext.plan.content, content);
  assert.ok(fullContext.settings && fullContext.counts, "omitted view keeps the full context");
  assert.equal(fullContext.notifications.length, 1);
  const compactContextRaw = raw(
    await client.callTool({ name: "worker_context", arguments: { view: "compact" } }),
  );
  const compactContext = JSON.parse(compactContextRaw) as {
    activeWorkers: unknown[];
    notifications: { id: string; delivery: string }[];
  };
  assert.deepEqual(compactContext.activeWorkers, []);
  assert.deepEqual(
    compactContext.notifications.map((item) => [item.id, item.delivery]),
    [[fullContext.notifications[0]?.id, "pending"]],
  );

  const fullGetRaw = raw(
    await client.callTool({ name: "worker_get", arguments: { workerId: started.workerId } }),
  );
  const fullGet = JSON.parse(fullGetRaw) as {
    worker: WorkerRecord;
    runs: WorkerRun[];
    notifications: WorkerNotification[];
  };
  assert.deepEqual(Object.keys(fullGet).sort(), ["notifications", "runs", "worker"]);
  assert.equal(fullGet.runs.length, 1);
  assert.match(fullGet.worker.latestRun?.finalText ?? "", /pi answer/);
  assert.equal(fullGet.notifications.length, 1);

  const compactGetRaw = raw(
    await client.callTool({
      name: "worker_get",
      arguments: { workerId: started.workerId, view: "compact" },
    }),
  );
  const compactGet = JSON.parse(compactGetRaw) as {
    worker: WorkerRecord;
    notifications: { id: string; workerId: string; runId: string; status: string; delivery: string; summary: string }[];
  };
  assert.deepEqual(Object.keys(compactGet).sort(), ["notifications", "worker"]);
  assert.equal("runs" in compactGet, false, "compact get omits the run history");
  assert.deepEqual(
    compactGet.worker,
    fullGet.worker,
    "compact get carries the same current worker, including its run body",
  );
  assert.equal(compactGet.worker.latestRun?.id, started.runId);
  assert.equal(
    JSON.stringify(compactGet.worker).match(/pi answer/g)?.length,
    1,
    "the terminal text is carried once, in the current run only",
  );
  assert.deepEqual(Object.keys(compactGet.notifications[0] ?? {}).sort(), [
    "delivery",
    "id",
    "runId",
    "status",
    "summary",
    "workerId",
  ]);
  const terminal = compactGet.notifications[0]!;
  assert.equal(terminal.workerId, started.workerId);
  assert.equal(terminal.runId, waited.run.id);
  assert.equal(terminal.delivery, "pending");

  const fullListRaw = raw(
    await client.callTool({ name: "worker_list", arguments: { status: "completed" } }),
  );
  const fullList = JSON.parse(fullListRaw) as { workers: WorkerRecord[]; notifications: unknown[] };
  assert.deepEqual(fullList.workers.map((worker) => worker.id), [started.workerId]);
  assert.equal(typeof fullList.workers[0]?.latestRun?.finalText, "string");
  assert.equal(fullList.notifications.length, 1);
  const compactListRaw = raw(
    await client.callTool({
      name: "worker_list",
      arguments: { status: "completed", view: "compact" },
    }),
  );
  const compactList = JSON.parse(compactListRaw) as { workers: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(compactList.workers[0] ?? {}).sort(), [
    "cwd",
    "id",
    "latestRun",
    "taskName",
  ]);
  assert.equal(compactList.workers[0]?.taskName, fullList.workers[0]?.taskName);
  assert.deepEqual(
    compactList.workers[0]?.latestRun,
    { id: waited.run.id, status: "completed" },
    "compact list workers carry only run locators",
  );
  assert.equal(
    JSON.stringify(compactList.workers).includes("pi answer"),
    false,
    "compact list workers carry no terminal text",
  );
  assert.deepEqual(
    (
      text(
        await client.callTool({
          name: "worker_list",
          arguments: { status: "failed", view: "compact" },
        }),
      ) as { workers: unknown[] }
    ).workers,
    [],
    "compact list keeps the status filter",
  );

  // Delivered notifications are consumed; a host Stop/unknown settlement stays visible.
  await client.callTool({ name: "worker_ack", arguments: { eventIds: [terminal.id] } });
  const afterAck = text(
    await client.callTool({
      name: "worker_get",
      arguments: { workerId: started.workerId, view: "compact" },
    }),
  ) as { notifications: unknown[] };
  assert.deepEqual(afterAck.notifications, []);
  const listAfterAck = text(
    await client.callTool({ name: "worker_list", arguments: { view: "compact" } }),
  ) as { notifications: unknown[]; workers: unknown[] };
  assert.deepEqual(listAfterAck.notifications, [], "compact list drops delivered notifications");
  assert.equal(listAfterAck.workers.length, 1);
  const contextAfterAck = text(
    await client.callTool({ name: "worker_context", arguments: { view: "compact" } }),
  ) as { notifications: unknown[] };
  assert.deepEqual(contextAfterAck.notifications, [], "compact context drops delivered notifications");
  const afterAckFull = text(
    await client.callTool({ name: "worker_get", arguments: { workerId: started.workerId } }),
  ) as { notifications: WorkerNotification[] };
  assert.deepEqual(
    afterAckFull.notifications.map((item) => [item.id, item.delivery]),
    [[terminal.id, "delivered"]],
    "omitting view still returns delivered notifications",
  );
  service.retryNotifications([terminal.id]);
  service.claimNotifications("owner-1", [terminal.id], "view-stop-batch");
  service.settleNotifications("view-stop-batch", "unknown");
  const stopped = text(
    await client.callTool({
      name: "worker_get",
      arguments: { workerId: started.workerId, view: "compact" },
    }),
  ) as { notifications: { id: string; delivery: string; workerId: string; runId: string }[] };
  assert.deepEqual(
    stopped.notifications.map((item) => [item.id, item.delivery, item.workerId, item.runId]),
    [[terminal.id, "unknown", started.workerId, waited.run.id]],
  );

  t.diagnostic(
    `view fixture: dsh run complete, 1 worker, plan ${Buffer.byteLength(content, "utf8")}B, session session-fixture-1`,
  );
  for (const [name, full, compact] of [
    ["context", fullContextRaw, compactContextRaw],
    ["list", fullListRaw, compactListRaw],
    ["get", fullGetRaw, compactGetRaw],
  ] as const) {
    const fullBytes = Buffer.byteLength(full, "utf8");
    const compactBytes = Buffer.byteLength(compact, "utf8");
    t.diagnostic(`view ${name}: full ${fullBytes}B, compact ${compactBytes}B`);
    assert.ok(compactBytes < fullBytes, `${name} compact view must be smaller`);
  }

  service.registerOwner(
    {
      id: "view-other",
      parentSessionId: "view-other-parent",
      projectId: "project-1",
      projectPath: project,
      userId: null,
      appServerInstanceId: "view-other-app",
      paused: false,
    },
    "view-other-token",
  );
  const otherClient = new Client({ name: "worker-view-other", version: "1.0.0" });
  await otherClient.connect(new StreamableHTTPClientTransport(host.url, {
    requestInit: { headers: { authorization: "Bearer view-other-token" } },
  }));
  t.after(() => otherClient.close());
  const otherContext = text(
    await otherClient.callTool({ name: "worker_context", arguments: { view: "compact" } }),
  ) as { plan: null; activeWorkers: unknown[]; notifications: unknown[] };
  assert.equal(otherContext.plan, null);
  assert.deepEqual(otherContext.activeWorkers, []);
  assert.deepEqual(otherContext.notifications, []);
  const otherList = text(
    await otherClient.callTool({ name: "worker_list", arguments: { view: "compact" } }),
  ) as unknown;
  assert.deepEqual(otherList, { workers: [], notifications: [] });
  const deniedCompact = await otherClient.callTool({
    name: "worker_get",
    arguments: { workerId: started.workerId, view: "compact" },
  });
  assert.equal(deniedCompact.isError, true, "compact view does not widen ownership");
});

test("compact start and resume receipts replay the accepted run across views", async (t) => {
  const { service } = createService(t, temporaryRoot("worker-mcp-view-replay-"));
  const host = await mcpServer(service, "owner-token");
  t.after(host.close);
  const client = new Client({ name: "worker-view-replay", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(host.url, {
    requestInit: { headers: { authorization: "Bearer owner-token" } },
  }));
  t.after(() => client.close());

  const payload = startInput({ requestId: "view-replay-start", taskRole: "testing" });
  const receipt = text(
    await client.callTool({
      name: "worker_start",
      arguments: { ...payload, view: "compact" },
    }),
  ) as { workerId: string; runId: string; status: string; cwd: string };
  assert.deepEqual(Object.keys(receipt).sort(), ["cwd", "runId", "status", "workerId"]);
  const accepted = service.get(receipt.workerId);
  assert.equal(accepted.worker.latestRun?.id, receipt.runId);
  assert.ok(["queued", "starting", "running", "completed"].includes(receipt.status));
  assert.equal(receipt.cwd, accepted.worker.cwd);

  // The same requestId without the view still replays that accepted run instead of conflicting.
  const replayed = text(
    await client.callTool({
      name: "worker_start",
      arguments: { ...payload },
    }),
  ) as { worker: WorkerRecord; run: WorkerRun };
  assert.equal(replayed.worker.id, receipt.workerId);
  assert.equal(replayed.run.id, receipt.runId);
  assert.equal(service.get(receipt.workerId).runs.length, 1);
  const conflict = await client.callTool({
    name: "worker_start",
    arguments: { ...payload, prompt: "a different payload", view: "compact" },
  });
  assert.equal(conflict.isError, true, "view is not part of the replayed request id");
  assert.equal(service.get(receipt.workerId).runs.length, 1);

  const finished = text(
    await client.callTool({
      name: "worker_wait",
      arguments: { workerId: receipt.workerId, timeoutSeconds: 10 },
    }),
  ) as { run: WorkerRun };
  assert.equal(finished.run.status, "completed");
  const feedback = {
    workerId: receipt.workerId,
    prompt: "Resume with the same session and return the fixture result.",
    requestId: "view-replay-resume",
  };
  // Repeated reads of the same requestId never spawn a second native invocation.
  const resumed = text(
    await client.callTool({ name: "worker_resume", arguments: { ...feedback, view: "compact" } }),
  ) as { workerId: string; runId: string; status: string; cwd: string };
  assert.deepEqual(Object.keys(resumed).sort(), ["cwd", "runId", "status", "workerId"]);
  assert.equal(resumed.workerId, receipt.workerId);
  assert.notEqual(resumed.runId, receipt.runId);
  const acceptedResume = service.get(receipt.workerId);
  assert.equal(acceptedResume.runs.at(-1)?.id, resumed.runId);
  assert.ok(
    ["queued", "starting", "running", "completed"].includes(resumed.status),
  );
  assert.equal(resumed.cwd, acceptedResume.worker.cwd);
  const replayedResume = text(
    await client.callTool({ name: "worker_resume", arguments: { ...feedback } }),
  ) as { worker: WorkerRecord; run: WorkerRun };
  assert.equal(replayedResume.worker.id, resumed.workerId);
  assert.equal(replayedResume.run.id, resumed.runId);
  assert.equal(service.get(receipt.workerId).runs.length, 2);
  const resumeConflict = await client.callTool({
    name: "worker_resume",
    arguments: { ...feedback, prompt: "a different resume", view: "compact" },
  });
  assert.equal(resumeConflict.isError, true);
  assert.equal(service.get(receipt.workerId).runs.length, 2);
});

test("MCP worker_start accepts an agy config and runs it end to end", async (t) => {
  const { service } = createService(t, temporaryRoot("worker-mcp-agy-"));
  service.updateSettings({
    configs: [
      ...service.settings().configs,
      {
        id: "agy-default",
        name: "agy#1",
        type: "agy",
        enabled: true,
        roles: [],
        concurrency: 3,
        hardTimeoutSeconds: 60,
        model: "gemini-3.8-flash-low",
        effort: "low",
      },
    ],
    defaultConfigId: "agy-default",
  });
  const host = await mcpServer(service, "owner-token");
  t.after(host.close);
  const client = new Client({ name: "worker-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(host.url, {
    requestInit: { headers: { authorization: "Bearer owner-token" } },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const receipt = text(
    await client.callTool({
      name: "worker_start",
      arguments: {
        taskName: "agy over MCP",
        type: "agy",
        prompt: "reply over mcp",
        workspace: { mode: "existing" },
        writePaths: [],
        requestId: "mcp-agy-start",
      },
    }),
  ) as { worker: { id: string; type: string }; run: { id: string } };
  assert.equal(receipt.worker.type, "agy");
  const done = await service.wait(receipt.worker.id, 10);
  assert.equal(done.run.id, receipt.run.id);
  assert.equal(done.run.status, "completed");
  assert.match(done.run.finalText ?? "", /agy answer/);
  assert.equal(done.run.model, "gemini-3.8-flash-low");
  assert.equal(done.run.effort, "low");
});
