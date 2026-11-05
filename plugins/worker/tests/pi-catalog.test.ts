import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createService, temporaryRoot } from "./helpers.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function writeModels(env: NodeJS.ProcessEnv, value: unknown): void {
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, "models.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

test("Pi catalog reads configured models without the native CLI or credentials", async (t) => {
  const root = temporaryRoot("worker-pi-catalog-");
  const marker = path.join(root, "command-ran");
  const { service, env } = createService(t, root, {}, {
    // The native Pi program is absent; the configured model file alone supplies the directory.
    executablePaths: { pi: path.join(root, "missing-pi") },
  });
  const before = service.settings();
  writeModels(env, {
    version: 1,
    providers: {
      first: {
        api: "openai-completions",
        apiKey: "!touch " + marker,
        baseUrl: "http://127.0.0.1:9/v1",
        models: [
          { id: "alpha", reasoning: true, apiKey: "!touch " + marker },
          { id: "org/beta", reasoning: false },
          { id: "alpha", reasoning: false },
          { id: "gamma" },
          { id: "deep/nested/model", reasoning: true },
        ],
      },
      // A provider that only overrides connection settings contributes no rows.
      connectionOnly: { apiKey: "!touch " + marker, baseUrl: "http://127.0.0.1:9/v1" },
    },
    unrelated: { note: "ignored metadata" },
  });

  assert.deepEqual(await service.piCatalog(), {
    models: [
      { provider: "first", id: "alpha", reasoning: true },
      { provider: "first", id: "org/beta", reasoning: false },
      { provider: "first", id: "gamma", reasoning: false },
      { provider: "first", id: "deep/nested/model", reasoning: true },
    ],
    thinkingLevels: THINKING_LEVELS,
  });
  assert.equal(fs.existsSync(marker), false, "credential commands must never run");
  assert.deepEqual(service.settings(), before);
});

test("Pi catalog is empty when models.json is absent", async (t) => {
  const root = temporaryRoot("worker-pi-catalog-missing-");
  const { service, env } = createService(t, root);
  assert.equal(fs.existsSync(path.join(env.PI_CODING_AGENT_DIR!, "models.json")), false);
  assert.deepEqual(await service.piCatalog(), {
    models: [],
    thinkingLevels: THINKING_LEVELS,
  });
});

test("Pi catalog distinguishes invalid JSON from an unreadable file", async (t) => {
  const root = temporaryRoot("worker-pi-catalog-broken-");
  const { service, env } = createService(t, root);
  writeModels(env, "{ not json");
  await assert.rejects(() => service.piCatalog(), /JSON/);

  const file = path.join(env.PI_CODING_AGENT_DIR!, "models.json");
  fs.rmSync(file);
  fs.mkdirSync(file);
  await assert.rejects(() => service.piCatalog(), /不可读取/);
});

test("Pi catalog rejects a broken provider or model structure", async (t) => {
  const root = temporaryRoot("worker-pi-catalog-structure-");
  const { service, env } = createService(t, root);
  writeModels(env, { providers: { first: { models: [{ reasoning: true }] } } });
  await assert.rejects(() => service.piCatalog(), /结构无效/);

  writeModels(env, { providers: { first: { models: "alpha" } } });
  await assert.rejects(() => service.piCatalog(), /结构无效/);
});
