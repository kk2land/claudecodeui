import { execFile } from "node:child_process";
import type { AgyModelCatalog, AgyModelOption } from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";

/**
 * `agy models` fetches its directory over the network, so the request is bounded instead of
 * waiting indefinitely; the settings card reports the failure and can retry.
 */
export const AGY_CATALOG_TIMEOUT_MS = 20_000;

function unavailable(message: string): WorkerFailure {
  return new WorkerFailure("AGY_CATALOG_UNAVAILABLE", message);
}

/**
 * Parses the native `agy models` output: one `<id>\t<label>` row per model, with the progress
 * spinner on stderr and the occasional separator-free progress line on stdout. Only native ids
 * and display labels are read; no model capability is inferred beyond the id itself.
 */
export function parseAgyCatalog(stdout: string): AgyModelCatalog {
  const models: AgyModelOption[] = [];
  const seen = new Set<string>();
  let untabbed = 0;
  for (const raw of stdout.split(/\r?\n/)) {
    // Only the line break is removed so a trailing tab still separates an empty label; the id
    // and label themselves are trimmed, and any internal whitespace in the id is malformed.
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) {
      // A header such as "Fetching available models..." carries no model row.
      untabbed++;
      continue;
    }
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim() || id;
    if (!id || /\s/.test(id)) throw unavailable("agy 模型目录结构无效");
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  // Output that contains text but no row means the CLI's format changed or it printed an error
  // to stdout; reporting that as an empty directory would silently pretend there are no models.
  if (!models.length && untabbed) throw unavailable("agy 模型目录无法解析");
  return { models };
}

/**
 * Runs the already-resolved Antigravity executable's `models` subcommand in the Worker
 * environment and reads its real directory. No shell is involved, no credentials are copied,
 * and the CLI is neither installed nor logged in by the plugin. Spawn failures, non-zero exits,
 * timeouts, and unparseable output all raise `AGY_CATALOG_UNAVAILABLE`; stderr is never surfaced
 * because the CLI may echo local paths there.
 */
export function readAgyCatalog(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgyModelCatalog> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["models"],
      {
        env: environment,
        encoding: "utf8",
        timeout: AGY_CATALOG_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(
            unavailable(
              error.killed ? "agy models 读取超时" : "agy models 执行失败",
            ),
          );
          return;
        }
        try {
          resolve(parseAgyCatalog(stdout));
        } catch (failure) {
          reject(failure);
        }
      },
    );
  });
}
