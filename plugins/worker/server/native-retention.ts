import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerType } from "./shared/index.js";

/** Native session transcripts are independent of the one-day terminal history retention. */
const NATIVE_SESSION_RETENTION_MS = 3 * 86_400_000;

const DSH_SESSION_FILE = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/;
const PI_SESSION_FILE = /\.jsonl$/;

type NativeSessionRoot = {
  directory: string;
  type: WorkerType;
  label: string;
};

export type ActiveNativeSession = {
  type: WorkerType;
  sessionsRoot: string;
  nativeSessionId: string | null;
  nativeSessionFile: string | null;
};

type NativeSessionSweep = {
  dataDirectory: string;
  environment: NodeJS.ProcessEnv;
  now: number;
  activeRuns: ActiveNativeSession[];
  log?: (message: string) => void;
};

type NativeSessionSweepSummary = {
  roots: number;
  deleted: number;
  skipped: number;
  failed: number;
};

/** Every root the Worker plugin creates or reads native sessions from, without duplicates. */
export function nativeSessionRoots(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
): NativeSessionRoot[] {
  const home =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    os.homedir();
  const configured = environment.CODEX_DSH_SESSIONS_ROOT?.trim();
  const roots: NativeSessionRoot[] = [];
  if (configured)
    roots.push({
      directory: path.resolve(configured),
      type: "dsh",
      label: "CODEX_DSH_SESSIONS_ROOT",
    });
  else
    roots.push({
      directory: path.resolve(path.join(home, "tmp", "codex-dsh-sessions")),
      type: "dsh",
      label: "DSH default",
    });
  roots.push({
    directory: path.resolve(path.join(home, ".pi", "agent", "sessions")),
    type: "pi",
    label: "Pi default",
  });
  roots.push({
    directory: path.resolve(path.join(dataDirectory, "sessions", "dsh")),
    type: "dsh",
    label: "Worker DSH",
  });
  roots.push({
    directory: path.resolve(path.join(dataDirectory, "sessions", "pi")),
    type: "pi",
    label: "Worker Pi",
  });
  const seen = new Set<string>();
  return roots.filter((root) => {
    if (seen.has(root.directory)) return false;
    seen.add(root.directory);
    return true;
  });
}

/** Deletes native transcripts older than three days while retaining referenced active sessions. */
export function sweepNativeSessions(
  options: NativeSessionSweep,
): NativeSessionSweepSummary {
  const roots = nativeSessionRoots(options.dataDirectory, options.environment);
  const protectedFiles = new Set<string>();
  const protectedDirectories = new Set<string>();
  const protectedRoots = new Set<string>();
  const protectedDshIds = new Map<string, Set<string>>();
  for (const run of options.activeRuns) {
    let located = false;
    if (run.nativeSessionFile) {
      const file = path.resolve(run.nativeSessionFile);
      protectedFiles.add(file);
      // DSH generations and compressed siblings share the session-id directory.
      if (run.type === "dsh") protectedDirectories.add(path.dirname(file));
      located = true;
    }
    if (run.type === "dsh" && run.nativeSessionId && path.basename(run.nativeSessionId) === run.nativeSessionId) {
      const directory = path.resolve(run.sessionsRoot);
      let ids = protectedDshIds.get(directory);
      if (!ids) protectedDshIds.set(directory, ids = new Set());
      ids.add(run.nativeSessionId);
      located = true;
    }
    // A recovered run without a usable identity must keep its own native root intact.
    if (!located) protectedRoots.add(path.resolve(run.sessionsRoot));
  }
  const summary: NativeSessionSweepSummary = {
    roots: roots.length,
    deleted: 0,
    skipped: 0,
    failed: 0,
  };
  const cutoff = options.now - NATIVE_SESSION_RETENTION_MS;
  const log = options.log ?? (() => {});
  for (const root of roots) {
    if (protectedRoots.has(root.directory)) continue;
    try {
      const stats = fs.lstatSync(root.directory);
      if (stats.isSymbolicLink()) continue;
      if (!stats.isDirectory()) {
        summary.failed++;
        log(
          `native session cleanup root is not a directory: ${root.label} ${root.directory}`,
        );
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      summary.failed++;
      log(
        `native session cleanup root failed: ${root.label} ${root.directory}: ${message(error)}`,
      );
      continue;
    }
    sweepDirectory(root, root.directory, false);
  }
  log(
    `native session cleanup deleted=${summary.deleted} skipped=${summary.skipped} failed=${summary.failed}`,
  );
  return summary;

  function sweepDirectory(
    root: NativeSessionRoot,
    directory: string,
    inheritedProtection: boolean,
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      summary.failed++;
      log(
        `native session cleanup directory failed: ${root.label} ${directory}: ${message(error)}`,
      );
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      // Never traverse links, even when a linked entry names a session file.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // DSH stores sessions directly under the root or below an encoded cwd.
        const protectedDshId = root.type === "dsh" && (
          protectedDshIds.get(directory)?.has(entry.name) ||
          protectedDshIds.get(path.dirname(directory))?.has(entry.name)
        );
        sweepDirectory(
          root,
          file,
          inheritedProtection ||
            protectedDirectories.has(file) ||
            protectedRoots.has(file) ||
            Boolean(protectedDshId),
        );
        continue;
      }
      const pattern = root.type === "dsh" ? DSH_SESSION_FILE : PI_SESSION_FILE;
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      if (inheritedProtection || protectedFiles.has(file)) {
        summary.skipped++;
        continue;
      }
      try {
        if (fs.lstatSync(file).mtimeMs >= cutoff) {
          summary.skipped++;
          continue;
        }
        fs.unlinkSync(file);
        summary.deleted++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        summary.failed++;
        log(
          `native session cleanup file failed: ${root.label} ${file}: ${message(error)}`,
        );
      }
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
