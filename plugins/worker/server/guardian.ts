import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import { appendLog } from "./logs.js";
import type { GuardianEvidence } from "./shared/index.js";

/**
 * One guardian process per run. It owns the native CLI's process group, writes raw output,
 * reports progress lines to the plugin, and records final exit evidence before it exits.
 */
type Spec = {
  argv: string[];
  cwd: string;
  prompt: string;
  timeoutSeconds: number | null;
  runDirectory: string;
  executable: string;
};

const specPath = process.argv[2];
if (!specPath) throw new Error("guardian 缺少运行描述文件");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as Spec;
const startedAt = new Date().toISOString();
let child: ChildProcess | undefined;
let finished = false;
let stopping = false;
let stopReason: GuardianEvidence["reason"] = "cancelled";
let stopError: string | null = null;
let exitCode: number | null = null;
let signal: string | null = null;
let killTimer: NodeJS.Timeout | undefined;
let hardTimer: NodeJS.Timeout | undefined;
let outputRemainder = "";
const decoder = new StringDecoder("utf8");

function connected(): boolean {
  return process.connected;
}

function send(message: unknown): void {
  if (!connected()) return;
  try {
    // A pipe can close between the connected check and send; never let IPC kill cleanup.
    process.send?.(message, undefined, undefined, () => {});
  } catch {
    /* disconnect handling below owns cleanup */
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(-pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      send({ type: "guardian-error", error: String(error) });
  }
}

function evidence(reason: GuardianEvidence["reason"], groupExited: boolean): GuardianEvidence {
  return {
    reason,
    exitCode,
    signal,
    startedAt,
    finishedAt: new Date().toISOString(),
    groupExited,
    error: stopError,
  };
}

function writeEvidence(value: GuardianEvidence): void {
  const target = path.join(spec.runDirectory, "final.json");
  const temporary = target + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

async function waitForGroup(pid: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !groupAlive(pid);
}

async function finish(reason: GuardianEvidence["reason"]): Promise<void> {
  if (finished) return;
  finished = true;
  clearTimeout(hardTimer);
  clearTimeout(killTimer);
  let groupExited = true;
  if (child?.pid) {
    groupExited = !groupAlive(child.pid);
    if (!groupExited) {
      signalGroup(child.pid, "SIGKILL");
      groupExited = await waitForGroup(child.pid, Date.now() + 3000);
    }
  }
  const value = evidence(reason, groupExited);
  try {
    writeEvidence(value);
  } catch (error) {
    send({ type: "guardian-error", error: "写入 final 证据失败: " + String(error) });
  }
  send({ type: "exit", evidence: value });
  // Give the IPC message a tick to flush; the plugin also reads final.json on process exit.
  setImmediate(() => process.exit(0));
}

/** Graceful TERM, then a two-second SIGKILL escalation, and only then a terminal record. */
async function terminate(reason: GuardianEvidence["reason"], error?: string): Promise<void> {
  if (finished) return;
  if (!stopping) {
    stopping = true;
    stopReason = reason;
    if (error) stopError = error;
  }
  const pid = child?.pid;
  if (!pid) {
    await finish(stopReason);
    return;
  }
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + 10000;
  killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), 2000);
  const exited = await waitForGroup(pid, deadline);
  clearTimeout(killTimer);
  if (!exited) stopError = stopError || "无法确认进程组退出";
  await finish(stopReason);
}

function logFailure(error: unknown): void {
  void terminate("error", "日志写入失败: " + String(error));
}

function onStdout(chunk: Buffer): void {
  try {
    appendLog(spec.runDirectory, "events", chunk);
  } catch (error) {
    logFailure(error);
    return;
  }
  // StringDecoder keeps a multibyte character intact when a chunk boundary splits it.
  outputRemainder += decoder.write(chunk);
  const parts = outputRemainder.split("\n");
  outputRemainder = parts.pop() ?? "";
  for (const line of parts) if (line.trim()) send({ type: "line", line });
}

function onStderr(chunk: Buffer): void {
  try {
    appendLog(spec.runDirectory, "stderr", chunk);
  } catch (error) {
    logFailure(error);
  }
}

function start(): void {
  if (stopping) {
    void finish(stopReason);
    return;
  }
  const args =
    spec.argv[0] === spec.executable ? spec.argv.slice(1) : spec.argv;
  child = spawn(spec.executable, args, {
    cwd: spec.cwd,
    // Credentials stay in the guardian process environment only; spec.json never stores them.
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.once("error", (error) => {
    stopError = error.message;
    void terminate("error", error.message);
  });
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.once("exit", (code, value) => {
    exitCode = code;
    signal = value ?? null;
    // A descendant may inherit the pipes and keep them open forever. Give already-written
    // output a short bounded drain, then detach the pipes and reclaim the process group.
    setTimeout(() => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      outputRemainder += decoder.end();
      if (outputRemainder.trim()) {
        send({ type: "line", line: outputRemainder });
        outputRemainder = "";
      }
      if (!stopping) {
        stopping = true;
        stopReason = "exit";
        void (async () => {
          const pid = child?.pid;
          if (pid && groupAlive(pid)) {
            signalGroup(pid, "SIGTERM");
            killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), 2000);
            await waitForGroup(pid, Date.now() + 10000);
            clearTimeout(killTimer);
          }
          await finish("exit");
        })();
      }
    }, 100);
  });
  send({ type: "started", pid: child.pid ?? null, startedAt });
  if (!child.pid) {
    stopError = "无法启动原生执行器";
    void terminate("error", stopError);
    return;
  }
  child.stdin?.on("error", () => {
    /* the CLI may close stdin early; exit evidence is what matters */
  });
  child.stdin?.end(spec.prompt, "utf8");
  if (spec.timeoutSeconds && spec.timeoutSeconds > 0)
    hardTimer = setTimeout(
      () => void terminate("timeout", "超过硬超时 " + spec.timeoutSeconds + " 秒"),
      spec.timeoutSeconds * 1000,
    );
}

process.on("message", (message: { type?: string }) => {
  if (message?.type === "stop") void terminate("cancelled");
});
process.on("disconnect", () => void terminate("disconnect"));
process.on("error", () => void terminate("disconnect"));
process.on("SIGTERM", () => void terminate("cancelled"));
process.on("SIGINT", () => void terminate("cancelled"));

start();
