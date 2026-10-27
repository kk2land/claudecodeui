import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import { parseTasks } from "./configuration.js";
import type {
  SchedulerConfigurationChanges,
  SchedulerConfigurationDocument,
  SchedulerConfigurationPreview,
  SchedulerConfigurationSave,
  SchedulerProject,
  SchedulerSettings,
  SchedulerTask,
} from "../shared/contracts.js";

const CONFIGURATION_DIRECTORY = ".cloudcli";
const CONFIGURATION_FILE = "project-schedules.json";
const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const MAX_PREVIEW_RUNS = 5;
const EMPTY_CONFIGURATION = JSON.stringify({ version: 1, tasks: [] }, null, 2);

function emptyChanges(): SchedulerConfigurationChanges {
  return { added: 0, updated: 0, removed: 0, reEnabled: 0 };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function insideProject(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}
function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortedValue(entry)]),
    );
  return value;
}
function canonical(task: SchedulerTask): string {
  return JSON.stringify(sortedValue(task));
}
/** The same enabled state is compared for a database-only disable so a re-enable is not an update. */
function compareDefinitions(
  loaded: SchedulerTask[],
  tasks: SchedulerTask[],
): SchedulerConfigurationChanges {
  const changes = emptyChanges();
  const previous = new Map(loaded.map((task) => [task.id, task]));
  const next = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    const before = previous.get(task.id);
    if (!before) {
      changes.added += 1;
      continue;
    }
    if (task.enabled && !before.enabled) changes.reEnabled += 1;
    const baseline = task.enabled && !before.enabled
      ? { ...before, enabled: true }
      : before;
    if (canonical(task) !== canonical(baseline)) changes.updated += 1;
  }
  for (const task of loaded)
    if (!next.has(task.id)) changes.removed += 1;
  return changes;
}

type ConfigurationLocation = {
  root: string;
  directory: string;
  file: string;
  exists: boolean;
};
/**
 * Resolves the project root and `.cloudcli/project-schedules.json` without following a symlink
 * outside the project. The configured directory itself may not exist yet; its real parent is the
 * project root, so a later write cannot escape. A symlinked directory or file is accepted only
 * when its resolved target remains inside the project.
 */
function locateConfiguration(project: SchedulerProject): ConfigurationLocation {
  let root: string;
  try {
    root = fs.realpathSync(project.path);
  } catch {
    throw new Error("项目目录不可用");
  }
  if (!fs.statSync(root).isDirectory()) throw new Error("项目目录不可用");
  const configured = path.join(root, CONFIGURATION_DIRECTORY);
  const directoryEntry = fs.lstatSync(configured, { throwIfNoEntry: false });
  let directory = configured;
  if (directoryEntry) {
    if (directoryEntry.isSymbolicLink()) {
      const resolved = fs.realpathSync(configured);
      if (!insideProject(resolved, root))
        throw new Error("配置目录不能指向项目外");
      directory = resolved;
    } else if (!directoryEntry.isDirectory()) {
      throw new Error(".cloudcli 必须是目录");
    }
  }
  const file = path.join(directory, CONFIGURATION_FILE);
  const fileEntry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!fileEntry) return { root, directory, file, exists: false };
  let resolved = file;
  if (fileEntry.isSymbolicLink()) {
    resolved = fs.realpathSync(file);
    if (!insideProject(resolved, root))
      throw new Error("配置文件不能指向项目外");
  }
  if (!fs.statSync(resolved).isFile())
    throw new Error("配置文件必须是普通文件");
  return { root, directory, file: resolved, exists: true };
}
function readBoundedFile(file: string): { text: string; revision: string } {
  const descriptor = fs.openSync(file, "r");
  try {
    if (fs.fstatSync(descriptor).size > MAX_CONFIGURATION_BYTES)
      throw new Error("配置文件不能超过 1 MiB");
    const content = fs.readFileSync(descriptor);
    if (content.length > MAX_CONFIGURATION_BYTES)
      throw new Error("配置文件不能超过 1 MiB");
    return { text: content.toString("utf8"), revision: hashContent(content) };
  } finally {
    fs.closeSync(descriptor);
  }
}
/**
 * Reads the file hash used for optimistic concurrency. A missing file yields null; a symlink is
 * resolved and must stay inside the project. Throws for oversized or non-regular targets so a
 * save never overwrites content it could not inspect.
 */
function revisionIfPresent(file: string, root: string): string | null {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return null;
  let resolved = file;
  if (entry.isSymbolicLink()) {
    resolved = fs.realpathSync(file);
    if (!insideProject(resolved, root))
      throw new Error("配置文件不能指向项目外");
  }
  if (!fs.statSync(resolved).isFile())
    throw new Error("配置文件必须是普通文件");
  return readBoundedFile(resolved).revision;
}
/** Used by the configuration service to expose the unmodified JSON draft and its revision. */
export function readProjectConfiguration(
  project: SchedulerProject,
): SchedulerConfigurationDocument {
  let location: ConfigurationLocation;
  try {
    location = locateConfiguration(project);
  } catch (error) {
    // An unsafe or unreadable location is reported as a document error, never as an empty file.
    return {
      project,
      text: "",
      revision: null,
      exists: false,
      error: errorMessage(error),
    };
  }
  if (!location.exists)
    return {
      project,
      text: EMPTY_CONFIGURATION,
      revision: null,
      exists: false,
    };
  let content: { text: string; revision: string };
  try {
    content = readBoundedFile(location.file);
  } catch (error) {
    // Keep the document shape so the editor can show the transport/storage problem.
    return {
      project,
      text: "",
      revision: null,
      exists: true,
      error: errorMessage(error),
    };
  }
  let error: string | undefined;
  try {
    JSON.parse(content.text);
  } catch (parseError) {
    error = "JSON 无效：" + errorMessage(parseError);
  }
  return {
    project,
    text: content.text,
    revision: content.revision,
    exists: true,
    ...(error === undefined ? {} : { error }),
  };
}
type ValidatedConfiguration = { tasks: SchedulerTask[] };
function validateConfiguration(
  project: SchedulerProject,
  text: string,
  settings: SchedulerSettings,
): ValidatedConfiguration {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIGURATION_BYTES)
    throw new Error("配置内容不能超过 1 MiB");
  const location = locateConfiguration(project);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("JSON 无效：" + errorMessage(error));
  }
  return {
    tasks: parseTasks(parsed, location.root, settings),
  };
}
function upcomingRuns(task: SchedulerTask): string[] {
  if (!task.enabled) return [];
  const schedule = new Cron(task.cron, {
    timezone: task.timezone,
    paused: true,
  });
  try {
    return schedule
      .nextRuns(MAX_PREVIEW_RUNS)
      .map((date) => date.toISOString());
  } finally {
    schedule.stop();
  }
}
/** Used by the configuration service to validate a visual/JSON draft without writing anything. */
export function previewProjectConfiguration(
  project: SchedulerProject,
  text: string,
  settings: SchedulerSettings,
  loaded: SchedulerTask[],
): SchedulerConfigurationPreview {
  let validated: ValidatedConfiguration;
  try {
    validated = validateConfiguration(project, text, settings);
  } catch (error) {
    return {
      valid: false,
      errors: [errorMessage(error)],
      tasks: [],
      changes: emptyChanges(),
    };
  }
  return {
    valid: true,
    tasks: validated.tasks.map((task) => ({
      taskId: task.id,
      nextRuns: upcomingRuns(task),
    })),
    changes: compareDefinitions(loaded, validated.tasks),
  };
}
/** Input assembled by ProjectScheduler so the editor neither owns the store nor reloads timers. */
export type SaveProjectConfigurationInput = {
  project: SchedulerProject;
  text: string;
  revision: string | null;
  settings: SchedulerSettings;
  loaded: SchedulerTask[];
  importProject: (tasks: SchedulerTask[]) => void;
  refresh: () => void;
};
function saveFailure(error: string): SchedulerConfigurationSave {
  return {
    saved: false,
    loaded: false,
    revision: null,
    changes: emptyChanges(),
    error,
  };
}
/**
 * Reports a conflict without writing. `revision` must be the freshly read file hash so it agrees
 * with `latest.revision`; the document read is only a fallback when the caller had none.
 */
function conflictResult(
  project: SchedulerProject,
  revision: string | null,
  changes: SchedulerConfigurationChanges,
): SchedulerConfigurationSave {
  let latest: SchedulerConfigurationDocument | undefined;
  try {
    latest = readProjectConfiguration(project);
  } catch {
    // The concurrent state may itself be unsafe to expose; the conflict still blocks the write.
  }
  return {
    saved: false,
    loaded: false,
    revision: revision ?? latest?.revision ?? null,
    changes,
    conflict: true,
    ...(latest === undefined ? {} : { latest }),
  };
}
/**
 * Used by the configuration service to validate, atomically replace, and load one project file.
 * The old hash is rechecked immediately before rename; every business failure is returned as
 * data so the RPC layer can keep a 200 response. A successful write whose import fails reports
 * saved=true with the new revision so the same revision can be retried.
 */
export function saveProjectConfiguration(
  input: SaveProjectConfigurationInput,
): SchedulerConfigurationSave {
  const { project, text, revision, settings, loaded } = input;
  let validated: ValidatedConfiguration;
  try {
    validated = validateConfiguration(project, text, settings);
  } catch (error) {
    return saveFailure(errorMessage(error));
  }
  const changes = compareDefinitions(loaded, validated.tasks);
  let location: ConfigurationLocation;
  try {
    location = locateConfiguration(project);
  } catch (error) {
    return saveFailure(errorMessage(error));
  }
  let currentRevision: string | null;
  try {
    currentRevision = location.exists
      ? revisionIfPresent(location.file, location.root)
      : null;
  } catch (error) {
    return saveFailure("无法读取当前配置：" + errorMessage(error));
  }
  if (currentRevision !== revision)
    return conflictResult(project, currentRevision, changes);
  let target: string;
  let directory: string;
  try {
    if (location.exists) {
      target = location.file;
      directory = path.dirname(target);
      const realDirectory = fs.realpathSync(directory);
      if (!insideProject(realDirectory, location.root))
        throw new Error("配置目录不能指向项目外");
    } else {
      fs.mkdirSync(location.directory, { recursive: true, mode: 0o700 });
      const realDirectory = fs.realpathSync(location.directory);
      if (!insideProject(realDirectory, location.root))
        throw new Error("配置目录不能指向项目外");
      directory = realDirectory;
      target = path.join(realDirectory, CONFIGURATION_FILE);
    }
  } catch (error) {
    return saveFailure("无法准备配置目录：" + errorMessage(error));
  }
  const temporary = path.join(
    directory,
    "." + CONFIGURATION_FILE + "." + randomBytes(8).toString("hex") + ".tmp",
  );
  let pending: string | null = temporary;
  try {
    fs.writeFileSync(temporary, text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // Recheck immediately before rename to narrow the window where another writer wins. The
    // fresh hash is also what a conflict reports, so `revision` and `latest.revision` agree.
    const latestRevision = revisionIfPresent(target, location.root);
    if (latestRevision !== revision)
      return conflictResult(project, latestRevision, changes);
    fs.renameSync(temporary, target);
    pending = null;
  } catch (error) {
    return saveFailure("写入配置失败：" + errorMessage(error));
  } finally {
    if (pending) {
      try {
        fs.unlinkSync(pending);
      } catch {
        // The temporary file may never have been created; the write already failed.
      }
    }
  }
  const newRevision = hashContent(Buffer.from(text, "utf8"));
  try {
    input.importProject(validated.tasks);
    input.refresh();
  } catch (error) {
    return {
      saved: true,
      loaded: false,
      revision: newRevision,
      changes,
      error: "配置已保存，但装载失败：" + errorMessage(error),
    };
  }
  return { saved: true, loaded: true, revision: newRevision, changes };
}
