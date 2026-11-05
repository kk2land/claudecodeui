import fs from "node:fs";
import path from "node:path";
import type { PiModelCatalog, PiModelOption } from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";
import { PI_THINKING_LEVELS } from "./native.js";

/**
 * Reads the models configured in the Pi agent home's `models.json`. Used by
 * `WorkerService.piCatalog` for `GET /catalog/pi`.
 *
 * Only provider names and model `id`/`reasoning` values are extracted; credential values,
 * `!command`, base URLs, and other metadata are not interpreted or executed, and the native Pi
 * CLI is not started. A missing file is a normal empty directory; unreadable files, invalid JSON, or a
 * broken provider/model structure raise `PI_CATALOG_UNAVAILABLE`.
 */
export function readPiCatalog(agentHome: string): PiModelCatalog {
  let text: string;
  try {
    text = fs.readFileSync(path.join(agentHome, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { models: [], thinkingLevels: [...PI_THINKING_LEVELS] };
    throw new WorkerFailure("PI_CATALOG_UNAVAILABLE", "Pi 模型配置不可读取");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkerFailure("PI_CATALOG_UNAVAILABLE", "Pi 模型配置不是有效 JSON");
  }
  return {
    models: extractModels(parsed),
    thinkingLevels: [...PI_THINKING_LEVELS],
  };
}

/** Extracts `providers.*.models[].id` plus an explicit reasoning flag; other metadata is ignored. */
function extractModels(value: unknown): PiModelOption[] {
  if (!isRecord(value)) throw invalidStructure();
  const providers = value.providers;
  if (providers === undefined) return [];
  if (!isRecord(providers)) throw invalidStructure();
  const models: PiModelOption[] = [];
  const seen = new Set<string>();
  for (const [provider, config] of Object.entries(providers)) {
    if (!provider || !isRecord(config)) throw invalidStructure();
    const entries = config.models;
    // A provider that only overrides connection settings contributes no rows.
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw invalidStructure();
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id)
        throw invalidStructure();
      const key = provider + "\u0000" + entry.id;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({
        provider,
        id: entry.id,
        reasoning: entry.reasoning === true,
      });
    }
  }
  return models;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidStructure(): WorkerFailure {
  return new WorkerFailure("PI_CATALOG_UNAVAILABLE", "Pi 模型配置结构无效");
}
