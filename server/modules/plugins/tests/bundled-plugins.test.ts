import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectsDb } from "@/modules/database/index.js";

import {
  bundledPluginEnvironment,
  bundledPluginHeaders,
  getBundledPlugin,
  getBundledPluginDirectory,
} from "../bundled-plugins.service.js";
import { createPluginsService } from "../plugins.service.js";

test("bundled metadata is public but launch context and project allowlist are private", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-cron-"));
  const previousDatabase = process.env.DATABASE_PATH,
    previousCodex = process.env.CODEX_HOME;
  process.env.DATABASE_PATH = path.join(directory, "auth.db");
  process.env.CODEX_HOME = path.join(directory, "codex");
  t.mock.method(projectsDb, "getProjectPaths", () => [
    {
      project_id: "p",
      project_path: directory,
      custom_project_name: "registered",
      isArchived: 0,
      isStarred: 0,
    },
  ]);
  t.after(() => {
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabase;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const manifest = getBundledPlugin();
  assert.equal(manifest?.name, "project-scheduler");
  assert.equal(manifest?.builtin, true);
  assert.equal(JSON.stringify(manifest).includes("TOKEN"), false);
  assert.ok(
    getBundledPluginDirectory("project-scheduler")?.endsWith(
      "plugins/project-scheduler",
    ),
  );
  assert.equal(getBundledPluginDirectory("unrelated"), null);
  const env = bundledPluginEnvironment("project-scheduler");
  assert.equal(env.CODEX_HOME, process.env.CODEX_HOME);
  assert.ok(env.CLOUDCLI_PLUGIN_TOKEN);
  const catalog = JSON.parse(
    fs.readFileSync(env.CLOUDCLI_PROJECTS_FILE!, "utf8"),
  ) as { projects: { id: string; name: string; path: string }[] };
  assert.deepEqual(catalog.projects, [
    { id: "p", name: "registered", path: directory },
  ]);
  assert.equal(
    bundledPluginHeaders("project-scheduler").authorization,
    "Bearer " + env.CLOUDCLI_PLUGIN_TOKEN,
  );
  assert.deepEqual(bundledPluginEnvironment("unrelated"), {});
  assert.deepEqual(bundledPluginHeaders("unrelated"), {});
  process.env.DATABASE_PATH = path.join(directory, "second-auth.db");
  assert.notEqual(
    bundledPluginEnvironment("project-scheduler").CLOUDCLI_PLUGIN_DATA_DIR,
    env.CLOUDCLI_PLUGIN_DATA_DIR,
  );
});

test("bundled update/uninstall are rejected before stopping the managed server", async () => {
  let stopped = false;
  const dependencies = {
    scanPlugins: () => [
      {
        name: "project-scheduler",
        builtin: true,
        enabled: true,
        server: "dist/server.mjs",
      },
    ],
    stopServer: async () => {
      stopped = true;
    },
  } as unknown as Parameters<typeof createPluginsService>[0];
  const service = createPluginsService(dependencies);
  await assert.rejects(
    service.update("project-scheduler"),
    /updated with CloudCLI/,
  );
  await assert.rejects(
    service.uninstall("project-scheduler"),
    /disabled, not uninstalled/,
  );
  assert.equal(stopped, false);
});
