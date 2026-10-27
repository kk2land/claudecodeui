import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { projectsDb } from "@/modules/database/index.js";

function hostRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (path.dirname(current) !== current) {
    const file = path.join(current, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      if (
        pkg.name === "@cloudcli-ai/cloudcli" ||
        (pkg.dependencies?.["@openai/codex"] &&
          fs.existsSync(
            path.join(current, "plugins/project-scheduler/manifest.json"),
          ))
      )
        return current;
    } catch {
      /* ascend through source/build directories */
    }
    current = path.dirname(current);
  }
  // A deployment without packaged plugins must not prevent the host itself from booting.
  return process.cwd();
}

const root = hostRoot();
const bundledDirectory = path.join(root, "plugins", "project-scheduler");
const runtimeToken = randomBytes(32).toString("hex");

/** Used by the registry to expose the packaged scheduler without copying code into a user's plugin directory. */
export function getBundledPlugin():
  | (Record<string, unknown> & { name: string; dirName: string; builtin: true })
  | null {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(bundledDirectory, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    return {
      ...manifest,
      name: "project-scheduler",
      builtin: true,
      dirName: "project-scheduler",
      repoUrl: null,
    };
  } catch {
    return null;
  }
}

/** Used by loader/process adapters; a reserved bundled name never resolves into a writable git checkout. */
export function getBundledPluginDirectory(name: string): string | null {
  return name === "project-scheduler" && getBundledPlugin()
    ? bundledDirectory
    : null;
}

function dataDirectory(): string {
  const database = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(os.homedir(), ".cloudcli", "auth.db");
  let identity = database;
  try {
    identity = fs.realpathSync(database);
  } catch {
    /* a new instance may not have created its database yet */
  }
  const namespace = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    path.dirname(database),
    "plugins",
    "project-scheduler",
    namespace,
  );
}

/** Used on startup and heartbeat to publish a private, atomically replaced project allowlist. */
export function syncBundledPluginContext(name: string): void {
  if (name !== "project-scheduler") return;
  const directory = dataDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const projects = projectsDb.getProjectPaths().map((project) => ({
    id: project.project_id,
    name: project.custom_project_name || path.basename(project.project_path),
    path: project.project_path,
  }));
  const file = path.join(directory, "projects.json");
  const temporary = file + "." + process.pid + ".tmp";
  fs.writeFileSync(
    temporary,
    JSON.stringify({ generatedAt: Date.now(), projects }),
    { mode: 0o600 },
  );
  fs.renameSync(temporary, file);
}

/** Used only for bundled scheduler launches; arbitrary installed plugins retain the minimal host environment. */
export function bundledPluginEnvironment(name: string): NodeJS.ProcessEnv {
  if (name !== "project-scheduler") return {};
  syncBundledPluginContext(name);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(CODEX_|DSH_|CLOUDCLI_DSH_|DEEPSEEK_|OPENAI_)/.test(key) ||
      [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
      ].includes(key)
    )
      env[key] = value;
  }
  return {
    ...env,
    CLOUDCLI_HOST_ROOT: root,
    CLOUDCLI_PLUGIN_TOKEN: runtimeToken,
    CLOUDCLI_PLUGIN_DATA_DIR: dataDirectory(),
    CLOUDCLI_PROJECTS_FILE: path.join(dataDirectory(), "projects.json"),
  };
}

/** Used by the authenticated host proxy; clients cannot inject the internal bearer token. */
export function bundledPluginHeaders(name: string): Record<string, string> {
  return name === "project-scheduler"
    ? { authorization: "Bearer " + runtimeToken }
    : {};
}
