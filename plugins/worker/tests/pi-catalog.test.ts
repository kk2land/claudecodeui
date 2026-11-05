import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createService, temporaryRoot } from "./helpers.js";

const CATALOG_OUTPUT = [
  "Provider Model Context Max-out Thinking Images",
  "openrouter fast-1 200k 8k yes no",
  "local slow-2 100k 4k no yes",
  "local slow-2 100k 4k no yes",
  "Reading local model cache; using bundled diagnostics",
].join("\n");

function digest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("Pi catalog isolates the agent home and snapshots regular copies", async (t) => {
  const root = temporaryRoot("worker-pi-catalog-");
  const capture = path.join(root, "capture.json");
  const { service, env } = createService(t, root, {
    TEST_CAPTURE_FILE: capture,
    TEST_LIST_MODELS: CATALOG_OUTPUT,
    PI_MANAGED_INSTALL_ROOT: path.join(root, "managed"),
  });
  const source = env.PI_CODING_AGENT_DIR!;
  const outside = path.join(root, "outside-models.json");
  const outsideText = JSON.stringify({ providers: { linked: { models: ["fast-1"] } } });
  fs.writeFileSync(outside, outsideText);
  const models = path.join(source, "models.json");
  const auth = path.join(source, "auth.json");
  fs.writeFileSync(models, JSON.stringify({ providers: { local: { models: ["slow-2"] } } }));
  fs.writeFileSync(auth, JSON.stringify({ openrouter: { apiKey: "not-a-command" } }));
  // A configured symlink source is read through; only a regular copy enters the snapshot.
  fs.symlinkSync(outside, path.join(source, "models-store.json"));
  const before = { models: digest(models), auth: digest(auth), outside: digest(outside) };

  const catalog = await service.piCatalog();
  assert.deepEqual(catalog, {
    models: [
      { provider: "openrouter", id: "fast-1", reasoning: true },
      { provider: "local", id: "slow-2", reasoning: false },
    ],
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  });

  const observed = JSON.parse(fs.readFileSync(capture, "utf8")) as {
    args: string[];
    cwd: string;
    env: Record<string, string>;
    agentFiles: string[];
    agentModelsStore: { regular: boolean; text: string };
    agentAuth: { regular: boolean; text: string };
  };
  assert.deepEqual(observed.args, [
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--list-models",
  ]);
  assert.notEqual(observed.env.PI_CODING_AGENT_DIR, source);
  assert.equal(observed.env.PI_OFFLINE, "1");
  assert.equal(observed.env.NODE_DISABLE_COMPILE_CACHE, "1");
  assert.equal(observed.env.NO_COLOR, "1");
  assert.equal(observed.env.PI_MANAGED_INSTALL_ROOT, undefined);
  assert.equal(observed.env.HOME, env.HOME);
  assert.equal(observed.env.CODEX_HOME, env.CODEX_HOME);
  assert.deepEqual(observed.agentFiles, [
    "auth.json",
    "models-store.json",
    "models.json",
    "settings.json",
  ]);
  assert.equal(observed.agentModelsStore.regular, true);
  assert.equal(observed.agentModelsStore.text, outsideText);
  assert.equal(observed.agentAuth.regular, true);
  // The isolated agent home and cwd are removed after the listing.
  assert.equal(fs.existsSync(observed.cwd), false);
  assert.equal(fs.existsSync(observed.env.PI_CODING_AGENT_DIR!), false);
  assert.equal(fs.existsSync(path.join(observed.env.PI_CODING_AGENT_DIR!, "settings.json")), false);
  assert.deepEqual(
    { models: digest(models), auth: digest(auth), outside: digest(outside) },
    before,
  );
});

test("Pi catalog refuses shell-command credential values without running them", async (t) => {
  const root = temporaryRoot("worker-pi-catalog-command-");
  const capture = path.join(root, "capture.json");
  const marker = path.join(root, "command-ran");
  const { service, env } = createService(t, root, {
    TEST_CAPTURE_FILE: capture,
    TEST_LIST_MODELS: CATALOG_OUTPUT,
  });
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, "auth.json"),
    JSON.stringify({ openrouter: { apiKey: "!touch " + marker } }),
  );
  await assert.rejects(() => service.piCatalog(), /凭据|PI_CATALOG|模型目录/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(capture), false, "Pi must not be executed for a rejected catalog");
  // The rejection never changes execution settings.
  assert.equal(service.settings().defaultConfigId, "dsh-default");
});

test("Pi catalog stops its own timed-out listing and cleans the isolated directory", async (t) => {
  const root = temporaryRoot("worker-pi-catalog-timeout-");
  const capture = path.join(root, "capture.json");
  const { service } = createService(
    t,
    root,
    {
      TEST_CAPTURE_FILE: capture,
      TEST_LIST_MODELS: CATALOG_OUTPUT,
      TEST_LIST_MODELS_DELAY_MS: "2000",
    },
    { piCatalogTimeoutMs: 150 },
  );
  await assert.rejects(() => service.piCatalog(), /超时|模型目录不可用/);
  assert.equal(fs.existsSync(capture), true);
  const observed = JSON.parse(fs.readFileSync(capture, "utf8")) as {
    cwd: string;
    env: Record<string, string>;
  };
  assert.equal(fs.existsSync(observed.cwd), false);
  assert.equal(fs.existsSync(observed.env.PI_CODING_AGENT_DIR!), false);
});
