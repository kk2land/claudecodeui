import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkerConfig } from "../shared/contracts.js";
import {
  createService,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

function agyConfig(): WorkerConfig {
  return {
    id: "agy-default",
    name: "agy#1",
    type: "agy",
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 120,
    model: null,
    effort: null,
  };
}

/**
 * Opt-in smoke against the installed Antigravity CLI and its existing login. It only runs when
 * `CLOUDCLI_AGY_TEST_BINARY` names a runnable `agy`; normal suites never start the real CLI.
 * The prompts forbid file changes, and the evidence file records argv plus final text only.
 */
test(
  "real agy starts and resumes the recorded conversation without changing files",
  { timeout: 180_000 },
  async (t) => {
    const executable = process.env.CLOUDCLI_AGY_TEST_BINARY?.trim();
    if (!executable) {
      t.skip("Set CLOUDCLI_AGY_TEST_BINARY to run the real agy smoke.");
      return;
    }
    let version: string;
    try {
      version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
    } catch {
      t.skip("The configured agy binary is not runnable.");
      return;
    }
    const root = temporaryRoot("worker-agy-cli-smoke-");
    const { service } = createService(t, root, {}, {
      // Use the operator's real HOME so the existing agy login and settings are inherited.
      environment: { ...process.env },
      executablePaths: { agy: executable },
    });
    service.updateSettings({
      configs: [...service.settings().configs, agyConfig()],
      defaultConfigId: "agy-default",
    });
    const started = await service.start(
      "owner-1",
      startInput({
        type: "agy",
        configId: "agy-default",
        prompt: "Reply with exactly AGY_SMOKE. Do not read, create, or modify any files.",
        requestId: "real-agy-smoke-start",
      }),
    );
    const first = await waitStatus(service, started.worker.id, ["completed"], 120_000);
    const firstRun = first.latestRun!;
    assert.match(firstRun.nativeSessionId ?? "", /^[0-9a-f-]{36}$/);
    assert.match(firstRun.finalText ?? "", /AGY_SMOKE/);
    assert.equal(firstRun.usage?.scope, "run");

    const resumed = await service.resume("owner-1", {
      workerId: first.id,
      prompt: "Reply with exactly AGY_RESUME. Do not read, create, or modify any files.",
      requestId: "real-agy-smoke-resume",
    });
    const second = await waitStatus(service, first.id, ["completed"], 120_000);
    const secondRun = second.latestRun!;
    assert.equal(secondRun.id, resumed.run.id);
    assert.notEqual(secondRun.id, firstRun.id);
    assert.equal(secondRun.nativeSessionId, firstRun.nativeSessionId);
    assert.match(secondRun.finalText ?? "", /AGY_RESUME/);

    const data = path.join(root, "data");
    const startSpec = JSON.parse(
      fs.readFileSync(
        path.join(data, "logs", first.id, firstRun.id, "spec.json"),
        "utf8",
      ),
    ) as { argv: string[] };
    const resumeSpec = JSON.parse(
      fs.readFileSync(
        path.join(data, "logs", first.id, secondRun.id, "spec.json"),
        "utf8",
      ),
    ) as { argv: string[] };
    assert.ok(startSpec.argv.some((arg) => arg.startsWith("--print=")));
    assert.ok(startSpec.argv.includes("--dangerously-skip-permissions"));
    assert.equal(startSpec.argv.includes("--conversation"), false);
    assert.deepEqual(
      resumeSpec.argv.slice(-2),
      ["--conversation", firstRun.nativeSessionId],
    );
    fs.writeFileSync(
      path.join(os.tmpdir(), "worker-agy-cli-smoke-evidence.json"),
      JSON.stringify(
        {
          cli: executable,
          version,
          conversationId: firstRun.nativeSessionId,
          finalTexts: [firstRun.finalText, secondRun.finalText],
          usage: [firstRun.usage, secondRun.usage],
          argv: { start: startSpec.argv, resume: resumeSpec.argv },
        },
        null,
        2,
      ),
    );
  },
);
