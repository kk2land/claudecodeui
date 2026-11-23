import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type {
  DshModelCatalog,
  DshModelOption,
} from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";

/** Reasoning levels a DSH model may declare; the selected runtime validates the final choice. */
export const DSH_EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type Entry = Record<string, unknown>;

function record(value: unknown): Entry | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Entry)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Applies this file's static entry patches before collecting models, mirroring the loader's own
 * order: an `insert` list adds new entries, and an id-targeted patch replaces the target's
 * `config`/`disabled`/`group` wholesale instead of merging with it. `name` asserts identity, so a
 * patch naming a different entry is skipped, and ids the file never declares are projected as
 * bundle-owned roots whose baseline is unknown. Disabled state is therefore decided by the last
 * patch, independently of earlier or later `config` replacements.
 */
function composeEntries(patches: unknown[]): Entry[] {
  const roots: Entry[] = [];
  const entriesById = new Map<string, Entry>();
  const declaredIds = new Set<string>();
  const indexEntries = (rows: unknown[], collectIdsOnly = false): void => {
    for (const row of rows) {
      const entry = record(row);
      if (!entry) continue;
      const id = text(entry.id);
      if (id) {
        if (collectIdsOnly) declaredIds.add(id);
        else entriesById.set(id, entry);
      }
      if (entry.group === true && Array.isArray(entry.config))
        indexEntries(entry.config, collectIdsOnly);
    }
  };
  // First pass: ids declared in inserts or in replacement group configs are local declarations.
  for (const patch of patches) {
    const entry = record(patch);
    if (Array.isArray(entry?.insert)) indexEntries(entry.insert, true);
    if (Array.isArray(entry?.config)) indexEntries(entry.config, true);
  }
  for (const patch of patches) {
    const entry = record(patch);
    const id = text(entry?.id);
    if (!entry || Array.isArray(entry.insert) || !id || declaredIds.has(id)) continue;
    if (entriesById.has(id)) continue;
    const root: Entry = { id, name: entry.name };
    roots.push(root);
    entriesById.set(id, root);
  }

  for (const patch of patches) {
    const entry = record(patch);
    if (!entry) continue;
    const id = text(entry.id);
    if (Array.isArray(entry.insert)) {
      let destination = roots;
      if (id) {
        const group = entriesById.get(id);
        if (!group || group.group !== true) continue;
        if (!Array.isArray(group.config)) group.config = [];
        destination = group.config as Entry[];
      }
      const inserted = entry.insert
        .map(record)
        .filter((row): row is Entry => row !== null);
      destination.push(...inserted);
      indexEntries(inserted);
      continue;
    }
    if (!id) continue;
    const target = entriesById.get(id);
    if (!target) continue;
    // An asserted name must match; a projected bundle root can acquire that assertion here.
    if (
      entry.name &&
      entry.name !== target.name &&
      (declaredIds.has(id) || target.name !== undefined)
    )
      continue;
    target.name ??= entry.name;
    for (const key of ["config", "disabled", "group"] as const) {
      if (Object.hasOwn(entry, key)) target[key] = entry[key];
    }
  }
  return roots;
}

/**
 * Declared effort names only. Values are adapter wire mappings (`high: high`, `off: none`) and
 * must never become selectable levels, so only the keys are projected and then filtered against
 * the levels the DSH runner accepts.
 */
function readEfforts(value: unknown): string[] {
  const declared = record(value);
  if (!declared) return [];
  return DSH_EFFORT_LEVELS.filter((level) => {
    const wire = declared[level];
    // `off: null` is the one declared-but-unmapped level DSH accepts.
    if (wire === null) return level === "off";
    return typeof wire === "string" && wire.trim().length > 0;
  });
}

/**
 * Projects `providers.*.models[]` declarations from the composed entries. Only ids, labels and
 * declared level names are read: credential env names, base URLs and every other provider field
 * are ignored, and no expression or command is evaluated.
 */
function readDeclaredModels(entries: unknown[]): DshModelOption[] {
  const models = new Map<string, DshModelOption>();
  const visit = (rows: unknown[]): void => {
    for (const row of rows) {
      const entry = record(row);
      if (!entry || (entry.disabled !== undefined && entry.disabled !== false)) continue;
      if (entry.group === true) {
        if (Array.isArray(entry.config)) visit(entry.config);
        continue;
      }
      for (const [provider, value] of Object.entries(
        record(record(entry.config)?.providers) ?? {},
      )) {
        const declared = record(value)?.models;
        if (!provider || !Array.isArray(declared)) continue;
        for (const candidate of declared) {
          const model = record(candidate);
          const id = text(model?.id);
          if (!id) continue;
          const route = provider + "/" + id;
          models.set(route, {
            route,
            label: text(model?.name) ?? id,
            efforts: readEfforts(model?.reasoningEfforts),
          });
        }
      }
    }
  };
  visit(entries);
  return [...models.values()];
}

function emptyCatalog(): DshModelCatalog {
  return { models: [], effortLevels: [...DSH_EFFORT_LEVELS] };
}

/**
 * Reads the models declared by the DSH headless profile's static patch layer for
 * `WorkerService.dshCatalog` (`GET /catalog/dsh`). It never starts the native CLI and never
 * copies models into the app database, so a profile edit appears on the next refresh.
 *
 * A missing patch file is a normal empty directory: the editor keeps its default row and any
 * already saved route. Unreadable files or broken YAML raise `DSH_CATALOG_UNAVAILABLE`; invalid
 * YAML diagnostics are never surfaced or logged because they can quote source excerpts, including
 * credential names.
 */
export function readDshCatalog(home: string): DshModelCatalog {
  const file = path.join(home, "profiles", "headless", "cordis.patch.yml");
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCatalog();
    throw new WorkerFailure("DSH_CATALOG_UNAVAILABLE", "DSH 模型配置不可读取");
  }
  const document = parseDocument(source);
  if (document.errors.length)
    throw new WorkerFailure("DSH_CATALOG_UNAVAILABLE", "DSH 模型配置不是有效 YAML");
  const entries: unknown = document.toJS();
  if (entries === null) return emptyCatalog();
  // `!!js` expressions are legal in this layer and resolve to warnings only; their values are
  // never interpreted here, so only a non-array document is a structural failure.
  if (!Array.isArray(entries))
    throw new WorkerFailure("DSH_CATALOG_UNAVAILABLE", "DSH 模型配置结构无效");
  return {
    models: readDeclaredModels(composeEntries(entries)),
    effortLevels: [...DSH_EFFORT_LEVELS],
  };
}
