import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { PiModelCatalog, PiModelOption } from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";
import { PI_THINKING_LEVELS } from "./native.js";

const CATALOG_FILES = ["models.json", "models-store.json", "auth.json"];
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

export type PiCatalogOptions = {
  /** Agent home that would be used for an actual Pi run (`PI_CODING_AGENT_DIR` or default). */
  sourceHome: string;
  executable: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
};

/**
 * Reads the configured Pi model directory in an isolated throwaway agent home. The real agent
 * home is only read for regular model/auth files; no extension, skill, theme, or context file is
 * loaded, and no `!command` credential value is executed or copied. Because the listing uses the
 * native static directory, models contributed by extensions are intentionally not included.
 */
export async function readPiCatalog(
  options: PiCatalogOptions,
): Promise<PiModelCatalog> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudcli-pi-catalog-"));
  try {
    fs.chmodSync(root, 0o700);
    const agent = path.join(root, "agent");
    const cwd = path.join(root, "cwd");
    fs.mkdirSync(agent, { mode: 0o700 });
    fs.mkdirSync(cwd, { mode: 0o700 });
    copyCatalogFiles(options.sourceHome, agent);
    fs.writeFileSync(path.join(agent, "settings.json"), "{}", { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = { ...options.environment };
    delete environment.PI_MANAGED_INSTALL_ROOT;
    environment.NODE_DISABLE_COMPILE_CACHE = "1";
    environment.PI_OFFLINE = "1";
    environment.PI_CODING_AGENT_DIR = agent;
    environment.NO_COLOR = "1";
    const stdout = await runListModels(
      options.executable,
      cwd,
      environment,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    );
    return {
      models: parseListModels(stdout),
      thinkingLevels: [...PI_THINKING_LEVELS],
    };
  } catch (error) {
    if (error instanceof WorkerFailure) throw error;
    throw new WorkerFailure(
      "PI_CATALOG_UNAVAILABLE",
      "Pi 模型目录不可用，现有配置仍可执行",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function copyCatalogFiles(sourceHome: string, target: string): void {
  for (const name of CATALOG_FILES) {
    const source = path.join(sourceHome, name);
    let stat: fs.Stats;
    try {
      // Follow a configured symlink source; only its regular copy enters the snapshot.
      stat = fs.statSync(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new WorkerFailure("PI_CATALOG_UNAVAILABLE", "Pi 模型配置不可读取");
    }
    if (!stat.isFile())
      throw new WorkerFailure("PI_CATALOG_UNAVAILABLE", "Pi 模型配置不是普通文件");
    let text: string;
    try {
      text = fs.readFileSync(source, "utf8");
    } catch {
      throw new WorkerFailure("PI_CATALOG_UNAVAILABLE", "Pi 模型配置不可读取");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WorkerFailure("PI_CATALOG_UNAVAILABLE", "Pi 模型配置不是有效 JSON");
    }
    assertNoCommandValues(parsed);
    fs.writeFileSync(path.join(target, name), text, { mode: 0o600 });
  }
}

/** Rejects shell-command credential/configuration values instead of executing or faking them. */
function assertNoCommandValues(value: unknown): void {
  if (typeof value === "string") {
    if (value.trim().startsWith("!"))
      throw new WorkerFailure(
        "PI_CATALOG_UNAVAILABLE",
        "Pi 凭据包含可执行命令，拒绝读取模型目录",
      );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoCommandValues(item);
    return;
  }
  if (value && typeof value === "object")
    for (const item of Object.values(value)) assertNoCommandValues(item);
}

function runListModels(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
  maxBuffer: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--list-models",
      ],
      { cwd, env: environment, timeout, maxBuffer, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(
            new WorkerFailure(
              "PI_CATALOG_UNAVAILABLE",
              error.killed
                ? "Pi 模型目录查询超时"
                : "Pi 模型目录查询失败，现有配置仍可执行",
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Parses the native six-column listing: provider, model, context, max output, thinking, images.
 * Only rows whose thinking column is an actual yes/no value are models; headers, diagnostics,
 * and any other prose are skipped instead of becoming fake models.
 */
export function parseListModels(output: string): PiModelOption[] {
  const models: PiModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    if (columns.length < 6) continue;
    const thinking = columns[4]!.toLowerCase();
    if (thinking !== "yes" && thinking !== "no") continue;
    const provider = columns[0]!;
    const id = columns[1]!;
    const key = provider + "\u0000" + id;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, id, reasoning: thinking === "yes" });
  }
  return models;
}
