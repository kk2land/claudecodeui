import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createService, startInput, temporaryRoot, waitStatus } from "./helpers.js";

const require = createRequire(import.meta.url);

/** Uses the pinned local Codex CLI and a localhost Responses endpoint; no account or paid model. */
test("real Codex exec starts, reconnects, resumes the same thread, and honors explicit selection", { timeout: 60_000 }, async (t) => {
  let executable: string;
  try {
    executable = process.env.CLOUDCLI_CODEX_TEST_BINARY?.trim() || require.resolve("@openai/codex/bin/codex.js");
  } catch {
    t.skip("The pinned Codex CLI package is not installed.");
    return;
  }
  let version: string;
  try {
    version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    t.skip("The pinned Codex CLI binary is not runnable.");
    return;
  }
  if (!version.includes("0.165.0")) {
    t.skip("The pinned Codex CLI 0.165.0 is not available: " + version);
    return;
  }

  const root = temporaryRoot("worker-codex-cli-smoke-");
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (!request.url?.endsWith("/responses")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push({ url: request.url, body });
    requestCount++;
    if (requestCount === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "response-start-attempt" },
        })}\n\n`,
      );
      setTimeout(() => response.destroy(new Error("local smoke stream reset")), 20);
      return;
    }
    const text = requestCount === 2 ? "real start answer" : "real resume answer";
    const usage =
      requestCount === 2
        ? { input_tokens: 11, output_tokens: 5, total_tokens: 16 }
        : { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
    const item = {
      id: "message-" + requestCount,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, data: Record<string, unknown>) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("response.created", { response: { id: "response-" + requestCount } });
    emit("response.output_item.added", { output_index: 0, item });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        id: "response-" + requestCount,
        status: "completed",
        output: [item],
        usage,
      },
    });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const { service, data } = createService(
    t,
    root,
    { TEST_SCENARIO: "ok" },
    { executablePaths: { codex: executable } },
  );
  const provider = (name: string) =>
    `[model_providers.${name}]\nname="${name}"\nbase_url="http://127.0.0.1:${address.port}/${name}"\nwire_api="responses"\nrequires_openai_auth=false\n`;
  fs.writeFileSync(
    path.join(root, "codex-home", "config.toml"),
    `model="config-model"\nmodel_provider="first"\n${provider("first")}${provider("second")}`,
  );
  service.updateSettings({
    concurrency: { dsh: 3, pi: 3, codex: 1 },
    codex: {
      env: { CODEX_PROXY_BYPASS: "1" },
      extraArgs: [
        "--skip-git-repo-check",
        "--model",
        "configured-model",
        "-c",
        "model_provider=first",
        "-c",
        "model_reasoning_effort=low",
      ],
    },
  });

  const started = await service.start(
    "owner-1",
    startInput({
      type: "codex",
      model: "explicit-model",
      provider: "second",
      effort: "high",
      prompt: "start the real local smoke",
      requestId: "real-codex-start",
    }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"], 45_000);
  const firstRun = first.latestRun!;
  assert.match(firstRun.nativeSessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(firstRun.finalText, "real start answer");
  assert.deepEqual(firstRun.usage, {
    inputTokens: 11,
    outputTokens: 5,
    totalTokens: 16,
  });
  assert.equal(requests.length, 2, "the first stream reset is retried once");
  assert.match(requests[1]!.url, /\/second\/responses$/);
  assert.equal(requests[1]!.body.model, "explicit-model");
  assert.deepEqual(
    (requests[1]!.body.reasoning as { effort?: string }).effort,
    "high",
  );
  const events = fs.readFileSync(
    path.join(data, "logs", first.id, firstRun.id, "events.log"),
    "utf8",
  );
  assert.match(events, /"type":"error"/);
  assert.match(events, /Reconnecting/);
  assert.match(events, /"type":"turn.completed"/);
  const startSpec = JSON.parse(
    fs.readFileSync(path.join(data, "logs", first.id, firstRun.id, "spec.json"), "utf8"),
  ) as { argv: string[] };
  assert.equal(startSpec.argv.filter((arg) => arg === "--model").length, 1);
  assert.equal(startSpec.argv.includes("configured-model"), false);
  assert.equal(startSpec.argv.includes("resume"), false);

  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "resume the real local smoke",
    requestId: "real-codex-resume",
  });
  const resumed = await waitStatus(service, first.id, ["completed"], 45_000);
  const resumedRun = resumed.latestRun!;
  assert.equal(resumedRun.nativeSessionId, firstRun.nativeSessionId);
  assert.equal(resumedRun.finalText, "real resume answer");
  // The 0.165 CLI reports session-cumulative usage on a cold resume (start 11/5 + resume 7/3).
  assert.deepEqual(resumedRun.usage, {
    inputTokens: 18,
    outputTokens: 8,
    totalTokens: 26,
  });
  assert.equal(requests.length, 3);
  assert.match(requests[2]!.url, /\/second\/responses$/);
  assert.equal(requests[2]!.body.model, "explicit-model");
  assert.deepEqual(
    (requests[2]!.body.reasoning as { effort?: string }).effort,
    "high",
  );
  const resumeSpec = JSON.parse(
    fs.readFileSync(path.join(data, "logs", first.id, resumedRun.id, "spec.json"), "utf8"),
  ) as { argv: string[] };
  assert.deepEqual(resumeSpec.argv.slice(-3), [
    "resume",
    firstRun.nativeSessionId,
    "-",
  ]);
  fs.writeFileSync(
    path.join(os.tmpdir(), "worker-codex-cli-smoke-evidence.json"),
    JSON.stringify(
      {
        cli: executable,
        threadId: firstRun.nativeSessionId,
        finalTexts: [firstRun.finalText, resumedRun.finalText],
        usage: [firstRun.usage, resumedRun.usage],
        requests: requests.map((item, index) => ({
          index,
          url: item.url,
          model: item.body.model,
          effort: (item.body.reasoning as { effort?: string } | undefined)?.effort,
        })),
        argv: { start: startSpec.argv, resume: resumeSpec.argv },
      },
      null,
      2,
    ),
  );
});
