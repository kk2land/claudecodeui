import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseAgyCatalog, readAgyCatalog } from "../server/agy-catalog.js";
import { createService, temporaryRoot } from "./helpers.js";

/**
 * Real `agy 1.5.14` output: one `<native id>\t<display name>` row per model, with the progress
 * spinner on stderr and no separator on header lines.
 */
const REAL_OUTPUT = [
  "Fetching available models...",
  "gemini-4-neon-high\tGemini 4 Neon (High)",
  "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
  "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
  "gemini-4-neon-low\tGemini 4 Neon (Low)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  "gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)",
  "",
].join("\n");

test("agy catalog parses the real id/tab/label rows of `agy models`", () => {
  assert.deepEqual(parseAgyCatalog(REAL_OUTPUT), {
    models: [
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)" },
      { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)" },
      { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
      { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
      { id: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)" },
    ],
  });
  // Carriage returns, duplicate ids and a missing label never produce fake or duplicate rows.
  assert.deepEqual(
    parseAgyCatalog(
      "  Fetching available models...  \r\nalpha\tAlpha\r\nalpha\tAlpha again\r\nbeta\t\r\n",
    ).models,
    [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "beta" },
    ],
  );
  assert.deepEqual(parseAgyCatalog(""), { models: [] });
});

test("agy catalog rejects output that is not a model directory", () => {
  assert.throws(() => parseAgyCatalog("Fetching available models..."), /无法解析/);
  assert.throws(() => parseAgyCatalog("\tMissing id"), /结构无效/);
  assert.throws(() => parseAgyCatalog("two words\tLabel"), /结构无效/);
});

/** Writes an executable that prints a fixed directory and records its argv/env. */
function fakeAgy(
  root: string,
  body: string,
): { executable: string; capture: string } {
  const executable = path.join(root, "fake-agy.mjs");
  const capture = path.join(root, "agy-capture.json");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\n" +
      "import fs from 'node:fs';\n" +
      "fs.writeFileSync(" +
      JSON.stringify(capture) +
      ", JSON.stringify({ argv: process.argv.slice(2), HOME: process.env.HOME ?? null, TOKEN: process.env.CLOUDCLI_PLUGIN_TOKEN ?? null }));\n" +
      body,
    { mode: 0o755 },
  );
  return { executable, capture };
}

test("agy catalog runs `agy models` in the Worker environment instead of reading a file", async (t) => {
  const root = temporaryRoot("worker-agy-catalog-");
  const { executable, capture } = fakeAgy(
    root,
    "process.stdout.write(" + JSON.stringify(REAL_OUTPUT) + ");\n",
  );
  const { service, env } = createService(
    t,
    root,
    { CLOUDCLI_PLUGIN_TOKEN: "plugin-secret" },
    { executablePaths: { agy: executable } },
  );
  const before = service.settings();

  assert.deepEqual(await service.agyCatalog(), {
    models: [
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)" },
      { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)" },
      { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
      { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
      { id: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)" },
    ],
  });
  // The exact subcommand and the inherited HOME (the CLI's own credentials) are what a real
  // Worker run would see; plugin control tokens never reach the child.
  const seen = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.deepEqual(seen, { argv: ["models"], HOME: env.HOME, TOKEN: null });
  assert.deepEqual(service.settings(), before);
});

test("agy catalog reports a failing or unreadable CLI instead of an empty directory", async (t) => {
  const root = temporaryRoot("worker-agy-catalog-fail-");
  const failing = fakeAgy(
    root,
    "process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\n');\n" +
      "process.stderr.write('network unavailable\\n');\nprocess.exitCode = 1;\n",
  );
  const { service } = createService(t, root, {}, {
    executablePaths: { agy: failing.executable },
  });
  await assert.rejects(() => service.agyCatalog(), /agy models 执行失败/);

  const garbageRoot = temporaryRoot("worker-agy-catalog-garbage-");
  const garbage = fakeAgy(garbageRoot, "process.stdout.write('no rows here\\n');\n");
  const second = createService(t, garbageRoot, {}, {
    executablePaths: { agy: garbage.executable },
  });
  await assert.rejects(() => second.service.agyCatalog(), /无法解析/);

  const missingRoot = temporaryRoot("worker-agy-catalog-missing-");
  const third = createService(t, missingRoot, {}, {
    executablePaths: { agy: path.join(missingRoot, "missing-agy") },
  });
  await assert.rejects(() => third.service.agyCatalog(), /执行失败/);
});

test("readAgyCatalog keeps stderr out of its error", async () => {
  const root = temporaryRoot("worker-agy-catalog-stderr-");
  const { executable } = fakeAgy(
    root,
    "process.stderr.write('LEAKED-STDERR\\n');\nprocess.exitCode = 2;\n",
  );
  await assert.rejects(
    () => readAgyCatalog(executable, { PATH: process.env.PATH }),
    (error: Error) => {
      assert.match(error.message, /执行失败/);
      assert.equal(error.message.includes("LEAKED-STDERR"), false);
      return true;
    },
  );
});
