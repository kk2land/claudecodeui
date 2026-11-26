import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { WorkerRecord, WorkerRun } from "../shared/contracts.js";
import { createService, owner, startInput, temporaryRoot, waitFor, waitStatus } from "./helpers.js";

test("starting, resuming and cancelling Pi B leaves Pi A running", { timeout: 45_000 }, async (t) => {
  const root = temporaryRoot("worker-pi-parallel-");
  const release = path.join(root, "release-a");
  const pidAPath = path.join(root, "a.pid");
  const { service, data, env } = createService(t, root, {
    TEST_SCENARIO: "hold",
    TEST_SESSION_ID: "",
    TEST_RELEASE_FILE: release,
    TEST_CLI_PID_FILE: pidAPath,
  });
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectB);
  service.registerOwner({
    ...owner(projectB),
    id: "owner-b",
    parentSessionId: "parent-b",
    projectId: "project-b",
  }, "token-b");

  const a = await service.start("owner-1", startInput({ taskName: "Pi A" }));
  const aEvents = path.join(data, "logs", a.worker.id, a.run.id, "events.log");
  const aOutput = () => fs.existsSync(aEvents)
    ? fs.readFileSync(aEvents, "utf8").match(/"type":"tool_execution_update"/g)?.length ?? 0
    : 0;
  let observedAOutput = await waitFor(aOutput, (count) => count > 0);

  env.TEST_SCENARIO = "ok";
  const pidBPath = path.join(root, "b.pid");
  env.TEST_CLI_PID_FILE = pidBPath;
  const b = await service.start("owner-b", startInput({ taskName: "Pi B" }));
  const firstB = (await waitStatus(service, b.worker.id, ["completed"])).latestRun!;
  assert.notEqual(fs.readFileSync(pidAPath, "utf8"), fs.readFileSync(pidBPath, "utf8"));
  observedAOutput = await waitFor(aOutput, (count) => count > observedAOutput);

  env.TEST_SCENARIO = "hang";
  const resumed = await service.resume("owner-b", {
    workerId: b.worker.id,
    prompt: "Continue B",
    requestId: "resume-b",
  });
  const bEvents = path.join(data, "logs", b.worker.id, resumed.run.id, "events.log");
  await waitFor(
    () => fs.existsSync(bEvents) && fs.readFileSync(bEvents, "utf8").includes('"type":"tool_execution_start"'),
    Boolean,
  );
  observedAOutput = await waitFor(aOutput, (count) => count > observedAOutput);

  await service.cancel({ workerIds: [b.worker.id] }, "ui", "owner-b");
  const cancelledB = (await waitStatus(service, b.worker.id, ["cancelled"])).latestRun!;
  assert.equal(cancelledB.id, resumed.run.id);
  assert.equal(cancelledB.nativeSessionId, firstB.nativeSessionId);
  assert.equal(cancelledB.nativeSessionFile, firstB.nativeSessionFile);
  await waitFor(aOutput, (count) => count > observedAOutput);

  fs.writeFileSync(release, "");
  const finishedA = (await waitStatus(service, a.worker.id, ["completed"])).latestRun!;
  assert.equal(finishedA.id, a.run.id);
  assert.equal(finishedA.nativeProtocol, undefined);
  assert.equal(finishedA.error, null);
  assert.ok(finishedA.finalText);
});

for (const savedFile of [true, false]) {
  test(`a historical ACP session resumes in Pi CLI ${savedFile ? "with its saved file" : "after restoring its file in the configured directory"}`, async (t) => {
    const root = temporaryRoot("worker-resume-pi-history-");
    const { service, data, project, env } = createService(t, root, { TEST_SESSION_ID: "" });
    const home = env.PI_CODING_AGENT_DIR!;
    const configuredDir = path.join(home, "custom-sessions");
    fs.mkdirSync(configuredDir);
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ sessionDir: "custom-sessions" }));
    const sessionId = "historical-pi";
    const file = path.join(configuredDir, `2026-11-25_${sessionId}.jsonl`);
    const original = [
      { type: "session", id: sessionId, cwd: project },
      { type: "message", message: { role: "assistant", usage: { input: 100, output: 200 } } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const now = new Date().toISOString();
    const worker: WorkerRecord = {
      id: "worker-historical-pi",
      type: "pi",
      configId: "pi-default",
      configName: "pi default",
      taskName: "Old Pi ACP run",
      ownerId: "owner-1",
      parentSessionId: "parent-1",
      projectId: "project-1",
      projectPath: project,
      writePaths: [],
      workspace: { mode: "existing", path: project },
      cwd: project,
      createdAt: now,
      latestRun: null,
    };
    const requestId = "historical-start";
    const previous: WorkerRun = {
      id: "historical-run",
      workerId: worker.id,
      requestId,
      status: "completed",
      startedAt: now,
      finishedAt: now,
      model: "provider/model",
      provider: null,
      effort: "high",
      timeoutSeconds: 600,
      home,
      sessionsRoot: path.join(home, "sessions"),
      nativeSessionId: sessionId,
      nativeSessionFile: savedFile ? file : null,
      nativeProtocol: "acp",
      piTranscriptOffset: 0,
      exitCode: 0,
      finalText: "Old Pi result",
      error: null,
      usage: null,
      progress: {
        steps: 1,
        phase: "completed",
        currentTool: null,
        lastEventAt: null,
        softReminderSentAt: null,
        hardTimeoutAt: null,
      },
    };
    service.store.createWorker(worker, previous, "parent-1\u0000project-1", requestId, "start", "old-fingerprint");

    if (!savedFile) {
      await service.resume("owner-1", {
        workerId: worker.id,
        prompt: "Continue while the original file is missing",
        requestId: "missing-historical-pi",
      });
      const failed = (await waitStatus(service, worker.id, ["failed"])).latestRun!;
      assert.equal(failed.error?.code, "NATIVE_SESSION_MISSING");
      assert.equal(failed.nativeSessionId, sessionId);
      assert.equal(failed.nativeSessionFile, null);
    }
    fs.writeFileSync(file, original);
    await service.resume("owner-1", {
      workerId: worker.id,
      prompt: "Continue the original session",
      requestId: "resume-historical-pi",
    });
    const current = (await waitStatus(service, worker.id, ["completed"])).latestRun!;
    assert.equal(current.nativeProtocol, undefined);
    assert.equal(current.nativeSessionId, sessionId);
    assert.equal(current.nativeSessionFile, file);
    assert.equal(current.usage?.inputTokens, 12);
    assert.equal(current.usage?.outputTokens, 5);
    const transcript = fs.readFileSync(file, "utf8");
    assert.ok(transcript.startsWith(original));
    assert.ok(transcript.slice(original.length).includes("pi answer " + sessionId));
    assert.deepEqual(service.get(worker.id).runs.find((run) => run.id === previous.id), previous);
    const spec = JSON.parse(fs.readFileSync(path.join(data, "logs", worker.id, current.id, "spec.json"), "utf8"));
    assert.deepEqual(spec.argv.slice(1, 4), ["--print", "--mode", "json"]);
    assert.equal(spec.argv[spec.argv.indexOf("--session") + 1], file);
  });
}
