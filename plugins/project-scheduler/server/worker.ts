import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { runAgent } from "./agent.js";
import { terminateTree } from "./process-tree.js";
import { appendLog } from "./logs.js";
import type { SchedulerTask } from "../shared/contracts.js";

let child: ChildProcess | undefined,
  killTimer: NodeJS.Timeout | undefined,
  stopping = false;
function stop(): void {
  stopping = true;
  if (child?.pid) {
    terminateTree(child.pid);
    killTimer ??= setTimeout(() => {
      if (child?.pid) terminateTree(child.pid, true);
    }, 1500);
  }
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on(
  "message",
  async (message: {
    type: string;
    task?: SchedulerTask;
    directory?: string;
  }) => {
    if (message.type === "stop") {
      stop();
      return;
    }
    if (
      message.type !== "start" ||
      !message.task ||
      !message.directory ||
      child
    )
      return;
    const task = message.task;
    try {
      if (stopping) throw new Error("运行在启动前已被取消");
      const env = { ...process.env, ...task.env };
      delete env.CLOUDCLI_PLUGIN_TOKEN;
      Object.assign(process.env, env);
      process.env.CLOUDCLI_SCHEDULER_AGENT = JSON.stringify(task.agent);
      const wrapper = path.join(
        message.directory,
        process.platform === "win32" ? "agent-exec.cmd" : "agent-exec",
      );
      const entry = fileURLToPath(new URL("./agent-exec.mjs", import.meta.url));
      const quote = (value: string) =>
        "'" + value.replaceAll("'", "'\\''") + "'";
      fs.writeFileSync(
        wrapper,
        process.platform === "win32"
          ? '@echo off\r\n"' + process.execPath + '" "' + entry + '" %*\r\n'
          : "#!/bin/sh\nexec " +
              quote(process.execPath) +
              " " +
              quote(entry) +
              ' "$@"\n',
        { mode: 0o700 },
      );
      process.env.AGENT_EXEC = wrapper;
      const written = { stdout: 0, stderr: 0 };
      const projectOutput = (stream: "stdout" | "stderr", text: string) => {
        const buffer = Buffer.from(text),
          remaining = Math.max(0, 16 * 1024 * 1024 - written[stream]);
        if (remaining) process[stream].write(buffer.subarray(0, remaining));
        written[stream] += Math.min(buffer.length, remaining);
        const marker = path.join(message.directory!, stream + ".truncated");
        if (buffer.length > remaining && !fs.existsSync(marker))
          fs.writeFileSync(marker, "", { mode: 0o600 });
      };
      const onChild = (value: ChildProcess) => {
        child = value;
        if (process.connected)
          process.send?.({ type: "child", pid: child.pid });
        if (stopping) stop();
      };
      let result: { code: number | null; success: boolean; reason?: string };
      if (task.type === "prompt")
        result = await runAgent(task.agent, task.prompt!, task.cwd, {
          stdout: (text) => projectOutput("stdout", text),
          stderr: (text) => projectOutput("stderr", text),
          event: (text) => {
            appendLog(message.directory!, "events", Buffer.from(text));
          },
          child: onChild,
        });
      else {
        onChild(
          spawn(task.command!, task.args, {
            cwd: task.cwd,
            env: process.env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
        let errorMessage: string | undefined;
        child!.stdout?.pipe(process.stdout);
        child!.stderr?.pipe(process.stderr);
        const code = await new Promise<number | null>((resolve) => {
          child!.once("error", (error) => {
            errorMessage = error.message;
          });
          child!.once("close", resolve);
        });
        result = {
          code,
          success: code === 0 && !errorMessage,
          reason: errorMessage,
        };
      }
      clearTimeout(killTimer);
      if (process.connected) process.send?.({ type: "result", ...result });
      process.exitCode = result.success ? 0 : 1;
    } catch (error) {
      clearTimeout(killTimer);
      process.stderr.write(String(error) + "\n");
      if (process.connected)
        process.send?.({
          type: "result",
          code: null,
          success: false,
          reason: String(error),
        });
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  },
);
