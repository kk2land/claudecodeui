import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import { WorkerService } from "../server/service.js";
import type { WorkerServiceOptions } from "../server/service.js";
import type { WorkerOwner, WorkerStartInput } from "../shared/contracts.js";

export const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
export const dshFixture = path.join(pluginRoot, "tests/fixtures/fake-dsh.mjs");
export const piFixture = path.join(pluginRoot, "tests/fixtures/fake-pi.mjs");
export const guardianSource = path.join(pluginRoot, "server/guardian.ts");

export function temporaryRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function owner(projectPath: string): WorkerOwner {
  return {
    id: "owner-1",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath,
    userId: 7,
    appServerInstanceId: "app-1",
    paused: false,
  };
}

export function environment(
  root: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    HOME: path.join(root, "home"),
    DSH_HOME: path.join(root, "dsh-home"),
    PI_CODING_AGENT_DIR: path.join(root, "pi-home"),
    TEST_SESSION_ID: "session-fixture-1",
    ...extra,
  };
}

export function createService(
  t: TestContext,
  root: string,
  extraEnv: Record<string, string> = {},
  extraOptions: Partial<WorkerServiceOptions> = {},
): { service: WorkerService; project: string; data: string; env: NodeJS.ProcessEnv } {
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.mkdirSync(path.join(root, "dsh-home"), { recursive: true });
  fs.mkdirSync(path.join(root, "pi-home"), { recursive: true });
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const data = path.join(root, "data");
  const env = environment(root, extraEnv);
  const service = new WorkerService({
    dataDirectory: data,
    environment: env,
    executablePaths: { dsh: dshFixture, pi: piFixture },
    guardianCommand: [process.execPath, "--import", tsxLoader, guardianSource],
    dshPatch: path.join(pluginRoot, "patches/dsh-session.patch.yml"),
    ...extraOptions,
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  service.registerOwner(owner(project), "owner-token");
  return { service, project, data, env };
}

export function startInput(
  overrides: Partial<WorkerStartInput> = {},
): WorkerStartInput {
  return {
    taskName: "fixture task",
    type: "dsh",
    prompt: "do the fixture work",
    workspace: { mode: "existing" },
    writePaths: [],
    requestId: "request-" + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

export async function waitFor<T>(
  read: () => T,
  accept: (value: T) => boolean,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function waitStatus(
  service: WorkerService,
  workerId: string,
  statuses: string[],
  timeoutMs = 15000,
) {
  return waitFor(
    () => service.get(workerId).worker,
    (worker) =>
      worker.latestRun !== null && statuses.includes(worker.latestRun.status),
    timeoutMs,
  );
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
