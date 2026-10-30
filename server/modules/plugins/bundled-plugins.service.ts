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

/**
 * Bundled plugins are read from the packaged tree instead of a user plugin
 * directory. The Worker plugin is trusted to reach the host IPC channel; the
 * scheduler keeps its existing project allowlist context.
 */
const BUNDLED_PLUGINS = [
  { name: "project-scheduler", directory: path.join(root, "plugins", "project-scheduler") },
  { name: "worker", directory: path.join(root, "plugins", "worker") },
] as const;

type BundledManifest = Record<string, unknown> & {
  name: string;
  builtin: true;
  dirName: string;
};

function readBundledManifest(name: string, directory: string): BundledManifest | null {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    return {
      ...manifest,
      name,
      builtin: true,
      dirName: name,
      repoUrl: null,
    };
  } catch {
    return null;
  }
}

/** Used by the registry to expose every packaged builtin without copying code into a user's plugin directory. */
export function getBundledPlugins(): BundledManifest[] {
  return BUNDLED_PLUGINS.flatMap((entry) => readBundledManifest(entry.name, entry.directory) ?? []);
}

/** Retained for the scheduler-specific API; callers that list builtins use `getBundledPlugins`. */
export function getBundledPlugin(): BundledManifest | null {
  return getBundledPlugins().find((plugin) => plugin.name === "project-scheduler") ?? null;
}

/** Used by loader/process adapters to resolve a packaged builtin without a writable checkout. */
export function getBundledPluginDirectory(name: string): string | null {
  const bundled = BUNDLED_PLUGINS.find((entry) => entry.name === name);
  return bundled && readBundledManifest(name, bundled.directory) ? bundled.directory : null;
}

/** Used by the process adapter to decide whether a crashed server is a managed builtin that may restart. */
export function isBundledPlugin(name: string): boolean {
  return getBundledPluginDirectory(name) !== null;
}

function databaseFile(): string {
  return process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(os.homedir(), ".cloudcli", "auth.db");
}

function dataDirectory(name: string): string {
  const database = databaseFile();
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
  return path.join(path.dirname(database), "plugins", name, namespace);
}

/** Used by the scheduler and Worker plugin to keep instance-scoped data next to the instance database. */
export function bundledPluginDataDirectory(name: string): string | null {
  return getBundledPluginDirectory(name) ? dataDirectory(name) : null;
}

/** Used on startup and heartbeat to publish a private, atomically replaced project allowlist. */
export function syncBundledPluginContext(name: string): void {
  if (name !== "project-scheduler") return;
  const directory = dataDirectory(name);
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

const PROXY_AND_LOCALE_KEYS = [
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
] as const;

/**
 * The trusted Worker plugin launches native Pi/Codex/DSH runners, which
 * inherit arbitrary provider credentials and custom variables. Matching the
 * reference Pi runner means handing this bundled plugin a copy of the host
 * environment; arbitrary third-party plugins still receive only `{}`.
 * Internal plugin controls are overwritten below with this instance's values.
 */
function workerEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/** Used only for bundled launches; arbitrary installed plugins retain the minimal host environment. */
export function bundledPluginEnvironment(name: string): NodeJS.ProcessEnv {
  if (!getBundledPluginDirectory(name)) return {};
  if (name === "project-scheduler") syncBundledPluginContext(name);
  if (name === "worker") fs.mkdirSync(dataDirectory(name), { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = name === "worker"
    ? workerEnvironment()
    : Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(CODEX_|DSH_|CLOUDCLI_DSH_|DEEPSEEK_|OPENAI_)/.test(key)
      || (PROXY_AND_LOCALE_KEYS as readonly string[]).includes(key)));
  return {
    ...env,
    CLOUDCLI_HOST_ROOT: root,
    CLOUDCLI_PLUGIN_TOKEN: runtimeToken(name),
    CLOUDCLI_PLUGIN_DATA_DIR: dataDirectory(name),
    ...(name === "project-scheduler"
      ? { CLOUDCLI_PROJECTS_FILE: path.join(dataDirectory(name), "projects.json") }
      : {}),
  };
}

const runtimeTokens = new Map<string, string>();

/** Shared by the process environment and the authenticated proxy; never exposed to clients. */
function runtimeToken(name: string): string {
  let token = runtimeTokens.get(name);
  if (!token) {
    token = randomBytes(32).toString("hex");
    runtimeTokens.set(name, token);
  }
  return token;
}

/** Used by the authenticated host proxy; clients cannot inject the internal bearer token. */
export function bundledPluginHeaders(name: string): Record<string, string> {
  return getBundledPluginDirectory(name)
    ? { authorization: "Bearer " + runtimeToken(name) }
    : {};
}
