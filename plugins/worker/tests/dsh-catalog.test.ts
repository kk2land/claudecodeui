import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createService, temporaryRoot } from "./helpers.js";

const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function patchPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.DSH_HOME!, "profiles", "headless", "cordis.patch.yml");
}

function writePatch(env: NodeJS.ProcessEnv, value: unknown): void {
  const file = patchPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

/** One `llm-pi-ai`-shaped entry whose `gateway` provider declares the given model ids. */
function modelsEntry(id: string, ids: string[]): Record<string, unknown> {
  return {
    id,
    name: "@deepseek-ai/dsh-llm-pi-ai",
    config: {
      providers: {
        gateway: { models: ids.map((model) => ({ id: model })) },
      },
    },
  };
}

const PATCH = `# profile patch layer
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      magpie:
        displayName: Magpie
        apiKeyEnv: MAGPIE_GATEWAY_KEY
        baseURL: http://127.0.0.1:3425/v1
        models:
          - id: auto/deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash · routing group
            reasoningEfforts:
              low: low
              high: high
              max: max
              ultracode: ultracode
          - id: auto/deepseek-v4-pro
            reasoningEfforts:
              "off": null
              high: high
          - id: plain
      # A provider that only overrides connection settings contributes no rows.
      magpie-only-connection:
        apiKeyEnv: MAGPIE_GATEWAY_KEY
- id: llm-disabled
  disabled: true
  config:
    providers:
      off:
        models:
          - id: hidden
- insert:
    - id: llm-inserted
      config:
        providers:
          inserted:
            models:
              - id: nested/one
                name: Inserted One
    - id: llm-group
      group: true
      config:
        - id: llm-child
          config:
            providers:
              child:
                models:
                  - id: sub
`;

test("DSH catalog projects static model routes without credentials or execution", async (t) => {
  const root = temporaryRoot("worker-dsh-catalog-");
  const marker = path.join(root, "command-ran");
  const { service, env } = createService(t, root);
  const before = service.settings();
  writePatch(env, PATCH);

  const catalog = await service.dshCatalog();
  assert.deepEqual(catalog, {
    models: [
      {
        route: "magpie/auto/deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash · routing group",
        efforts: ["low", "high", "max"],
      },
      {
        route: "magpie/auto/deepseek-v4-pro",
        label: "auto/deepseek-v4-pro",
        efforts: ["off", "high"],
      },
      { route: "magpie/plain", label: "plain", efforts: [] },
      { route: "inserted/nested/one", label: "Inserted One", efforts: [] },
      { route: "child/sub", label: "sub", efforts: [] },
    ],
    effortLevels: EFFORT_LEVELS,
  });
  const serialized = JSON.stringify(catalog);
  for (const secret of ["MAGPIE_GATEWAY_KEY", "127.0.0.1", "hidden"])
    assert.equal(serialized.includes(secret), false, secret);
  assert.equal(fs.existsSync(marker), false, "no command may run");
  assert.deepEqual(service.settings(), before);
});

test("a later same-id patch replaces the whole config instead of keeping old models", async (t) => {
  const root = temporaryRoot("worker-dsh-catalog-replace-");
  const { service, env } = createService(t, root);
  const routes = async () => (await service.dshCatalog()).models.map((model) => model.route);

  // Bundle-owned entries and entries inserted in this file share replacement semantics.
  const original = modelsEntry("llm-pi-ai", ["old"]);
  for (const first of [
    original,
    { insert: [original] },
  ]) {
    writePatch(env, [
      first,
      modelsEntry("llm-pi-ai", ["current"]),
      // `name` asserts identity, so a different plugin name cannot replace the entry.
      {
        ...modelsEntry("llm-pi-ai", ["wrong-plugin"]),
        name: "different-plugin",
      },
    ]);
    assert.deepEqual(await routes(), ["gateway/current"]);
  }

  // An empty replacement config removes every provider of that entry.
  writePatch(env, [original, { id: "llm-pi-ai", config: {} }]);
  assert.deepEqual(await routes(), []);
});

test("later disable and re-enable patches decide the entry state independently of config", async (t) => {
  const root = temporaryRoot("worker-dsh-catalog-disabled-");
  const { service, env } = createService(t, root);
  const routes = async () => (await service.dshCatalog()).models.map((model) => model.route);
  const patches: unknown[] = [
    modelsEntry("llm-pi-ai", ["original"]),
    { id: "llm-pi-ai", disabled: true },
    modelsEntry("llm-pi-ai", ["replacement"]),
  ];

  writePatch(env, patches);
  assert.deepEqual(await routes(), []);

  patches.push({ id: "llm-pi-ai", disabled: false });
  writePatch(env, patches);
  assert.deepEqual(await routes(), ["gateway/replacement"]);
});

test("nested group insertions and disabled ancestors follow the composed tree", async (t) => {
  const root = temporaryRoot("worker-dsh-catalog-groups-");
  const { service, env } = createService(t, root);
  const routes = async () => (await service.dshCatalog()).models.map((model) => model.route);
  const patches: unknown[] = [
    {
      insert: [
        {
          id: "outer",
          group: true,
          config: [
            {
              id: "inner",
              group: true,
              config: [modelsEntry("nested-llm", ["old"])],
            },
            {
              id: "hidden",
              group: true,
              disabled: true,
              config: [modelsEntry("hidden-llm", ["hidden"])],
            },
          ],
        },
      ],
    },
    { id: "inner", insert: [modelsEntry("inserted-llm", ["added"])] },
    modelsEntry("nested-llm", ["current"]),
    { id: "missing-group", insert: [modelsEntry("orphan-llm", ["orphan"])] },
    // An insert aimed at a non-group entry is not a declaration.
    { id: "nested-llm", insert: [modelsEntry("non-group-child", ["invalid"])] },
  ];

  writePatch(env, patches);
  assert.deepEqual(await routes(), ["gateway/current", "gateway/added"]);

  patches.push({ id: "outer", disabled: true });
  writePatch(env, patches);
  assert.deepEqual(await routes(), []);

  // Re-enabling the ancestor keeps the disabled descendant hidden on its own.
  patches.push({ id: "outer", disabled: false }, { id: "nested-llm", disabled: true });
  writePatch(env, patches);
  assert.deepEqual(await routes(), ["gateway/added"]);
});

test("DSH catalog ignores unresolved !!js tags without leaking their source", async (t) => {
  const root = temporaryRoot("worker-dsh-catalog-js-");
  const { service, env } = createService(t, root);
  writePatch(
    env,
    [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      magpie:",
      "        apiKeyEnv: !!js process.env.MAGPIE_GATEWAY_KEY",
      "        models:",
      "          - id: routed",
      "            name: Routed",
      "            reasoningEfforts:",
      "              high: !!js process.env.EFFORT",
      "              broken: !!js (",
      "",
    ].join("\n"),
  );

  const catalog = await service.dshCatalog();
  assert.deepEqual(catalog.models, [
    { route: "magpie/routed", label: "Routed", efforts: ["high"] },
  ]);
  const serialized = JSON.stringify(catalog);
  for (const secret of ["MAGPIE_GATEWAY_KEY", "process.env", "!!js"])
    assert.equal(serialized.includes(secret), false, secret);
});

test("DSH catalog is empty when the headless patch is absent", async (t) => {
  const root = temporaryRoot("worker-dsh-catalog-missing-");
  const { service, env } = createService(t, root);
  assert.equal(fs.existsSync(patchPath(env)), false);
  assert.deepEqual(await service.dshCatalog(), {
    models: [],
    effortLevels: EFFORT_LEVELS,
  });
});

test("DSH catalog distinguishes unreadable, invalid and non-array patches", async (t) => {
  const root = temporaryRoot("worker-dsh-catalog-broken-");
  const { service, env } = createService(t, root);
  const file = patchPath(env);

  writePatch(env, "- id: [unclosed\n");
  await assert.rejects(() => service.dshCatalog(), /不是有效 YAML/);

  writePatch(env, "id: not-a-list\n");
  await assert.rejects(() => service.dshCatalog(), /结构无效/);

  // An empty patch document is a normal empty directory, not a failure.
  writePatch(env, "# only a comment\n");
  assert.deepEqual((await service.dshCatalog()).models, []);

  fs.rmSync(file);
  fs.mkdirSync(file);
  await assert.rejects(() => service.dshCatalog(), /不可读取/);
});
