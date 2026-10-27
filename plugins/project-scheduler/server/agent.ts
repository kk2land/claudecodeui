import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import type { SchedulerAgent, SchedulerTokenUsage } from "../shared/contracts.js";
import { USAGE_DIRECTORY_ENV, UsageAccumulator, UsageSidecar } from "./usage.js";

/** Used by prompt workers and AGENT_EXEC; resolves the host dependency rather than a global CLI. */
export function resolveCodexBinary(
  hostRoot: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : "";
  const suffix =
    platform === "darwin"
      ? "apple-darwin"
      : platform === "win32"
        ? "pc-windows-msvc"
        : platform === "linux"
          ? "unknown-linux-musl"
          : "";
  if (!cpu || !suffix) throw new Error("当前平台没有支持的 Codex 二进制");
  const require = createRequire(path.join(hostRoot, "package.json"));
  const roots: string[] = [];
  try {
    roots.push(
      path.dirname(
        require.resolve(
          "@openai/codex-" + platform + "-" + arch + "/package.json",
        ),
      ),
    );
  } catch {
    /* bundled fallback below */
  }
  try {
    const codexPackage = require.resolve("@openai/codex/package.json");
    // pnpm keeps the optional platform package under Codex's own dependency graph.
    const codexRequire = createRequire(codexPackage);
    try {
      roots.unshift(
        path.dirname(
          codexRequire.resolve(
            "@openai/codex-" + platform + "-" + arch + "/package.json",
          ),
        ),
      );
    } catch {
      /* legacy packages can carry vendor directly */
    }
    roots.push(path.dirname(codexPackage));
  } catch {
    /* report one actionable error */
  }
  for (const root of roots)
    for (const directory of ["bin", "codex"]) {
      const candidate = path.join(
        root,
        "vendor",
        cpu + "-" + suffix,
        directory,
        platform === "win32" ? "codex.exe" : "codex",
      );
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {
        /* next package layout */
      }
    }
  throw new Error(
    "未找到 claudecodeui 依赖中的 Codex 原生二进制，请检查平台可选依赖是否已安装",
  );
}

/**
 * Used by both execution entrypoints to normalize streamed provider output and decide the run
 * result from the process exit status. Events are output and failure diagnostics only; they must
 * not turn a normal zero exit into a failure.
 */
export async function runAgent(
  agent: SchedulerAgent,
  prompt: string,
  cwd: string,
  output: {
    stdout(text: string): void;
    stderr(text: string): void;
    event(text: string): void;
    child(child: ChildProcess): void;
    /** Called with the invocation totals whenever more provider usage has been observed. */
    usage?(usage: SchedulerTokenUsage | null): void;
  },
  isolated = true,
): Promise<{
  code: number | null;
  success: boolean;
  reason?: string;
  usage: SchedulerTokenUsage | null;
}> {
  const accumulator = new UsageAccumulator();
  // AGENT_EXEC inherits this directory from the worker, so every invocation gets its own sidecar.
  const usageRoot = process.env[USAGE_DIRECTORY_ENV];
  const sidecar =
    usageRoot && path.isAbsolute(usageRoot)
      ? new UsageSidecar(usageRoot)
      : undefined;
  let reported: SchedulerTokenUsage | null = null;
  const publish = () => {
    const usage = accumulator.usage;
    if (!usage) return;
    reported = usage;
    try {
      sidecar?.write(usage);
    } catch {
      // Accounting is best-effort; it must never fail an otherwise valid run.
    }
    output.usage?.(usage);
  };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudcli-cron-agent-"),
  );
  try {
    const env = { ...process.env };
    delete env.CLOUDCLI_PLUGIN_TOKEN;
    let command: string, args: string[];
    if (agent.provider === "codex") {
      command = resolveCodexBinary(env.CLOUDCLI_HOST_ROOT ?? process.cwd());
      args = [
        "exec",
        "--ephemeral",
        "--json",
        ...(agent.model === "default" ? [] : ["--model", agent.model]),
        // Passed as one argv item so a configured effort can never be parsed as extra CLI flags.
        ...(agent.effort && agent.effort !== "default"
          ? ["-c", "model_reasoning_effort=" + JSON.stringify(agent.effort)]
          : []),
        "-",
      ];
    } else {
      command = env.CLOUDCLI_DSH_BIN || "dsh";
      const inherited: unknown = JSON.parse(env.CLOUDCLI_DSH_PATCHES || "[]");
      if (
        !Array.isArray(inherited) ||
        !inherited.every((value) => typeof value === "string" && value)
      )
        throw new Error("CLOUDCLI_DSH_PATCHES 必须是文件路径数组");
      const patch: unknown[] = [
        { id: "session-persistence-jsonl", disabled: true },
        // The checkpoint policy requires sessionPersistence, which is disabled above.
        { id: "session-checkpoint-policy", disabled: true },
      ];
      const effort =
        agent.effort && agent.effort !== "default" ? agent.effort : undefined;
      if (effort && agent.model === "default")
        throw new Error(
          "DSH 非默认 effort 需要显式 agent.model（provider/model）",
        );
      if (agent.model !== "default") {
        const slash = agent.model.indexOf("/");
        patch.push({
          id: "agent-default-model",
          config: {
            provider:
              slash < 0
                ? env.CLOUDCLI_DSH_PROVIDER || "deepseek-official"
                : agent.model.slice(0, slash),
            model: slash < 0 ? agent.model : agent.model.slice(slash + 1),
            // Headless effort only exists together with an explicit model route.
            ...(effort ? { reasoningEffort: effort } : {}),
          },
        });
      }
      const patchFile = path.join(directory, "ephemeral.patch.json");
      fs.writeFileSync(patchFile, JSON.stringify(patch), { mode: 0o600 });
      args = [
        "--profile",
        "headless",
        ...inherited.flatMap((file) => ["--patch", path.resolve(file)]),
        "--patch",
        patchFile,
        "--json",
        "-",
      ];
    }
    const child = spawn(command, args, {
      cwd,
      env,
      detached: isolated && process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    output.child(child);
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    // A spawn failure or an intentionally aborted oversized event must stay a failure even if the
    // process happens to exit zero. Event errors are diagnostics for non-zero exits only.
    let internalFault: string | undefined,
      eventReason: string | undefined,
      buffer = "",
      lastDshText = "";
    const printed = new Map<string, { length: number; digest: string }>();
    const digest = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const emitCodexText = (item: Record<string, unknown>) => {
      if (item.type !== "agent_message" || typeof item.text !== "string")
        return;
      const id = String(item.id ?? "assistant"),
        previous = printed.get(id);
      const text = item.text;
      if (!previous) output.stdout(text);
      else if (
        text.length >= previous.length &&
        digest(text.slice(0, previous.length)) === previous.digest
      )
        output.stdout(text.slice(previous.length));
      else output.stdout("\n" + text);
      if (printed.size > 1000) printed.clear();
      printed.set(id, { length: text.length, digest: digest(text) });
    };
    const line = (raw: string) => {
      if (!raw.trim()) return;
      output.event(raw + "\n");
      try {
        const event = JSON.parse(raw) as Record<string, any>;
        // Usage is read from provider terminal accounting events only, never from stdout text.
        if (
          agent.provider === "codex"
            ? accumulator.codex(event)
            : accumulator.dsh(event)
        )
          publish();
        if (agent.provider === "codex") {
          if (event.item) {
            emitCodexText(event.item as Record<string, unknown>);
            if (
              event.type === "item.completed" &&
              event.item.type === "agent_message"
            )
              output.stdout("\n");
            if (
              event.type === "item.started" &&
              event.item.type === "command_execution"
            )
              output.stdout("\n$ " + String(event.item.command ?? "") + "\n");
            if (
              event.type === "item.completed" &&
              event.item.type === "command_execution" &&
              typeof event.item.aggregated_output === "string"
            )
              output.stdout(event.item.aggregated_output + "\n");
          }
          if (event.type === "turn.failed" || event.type === "error")
            eventReason = String(
              event.error?.message ?? event.message ?? "Codex 执行失败",
            );
        } else {
          if (event.type === "text" && typeof event.text === "string") {
            output.stdout(event.text + "\n");
            lastDshText = event.text;
          }
          if (event.type === "thinking" && typeof event.text === "string")
            output.stdout("[thinking] " + event.text + "\n");
          if (event.type === "tool_call" || event.type === "tool_result")
            output.stdout(
              "[" + event.type + "] " + JSON.stringify(event) + "\n",
            );
          if (event.type === "final") {
            if (typeof event.text === "string" && event.text !== lastDshText)
              output.stdout(
                (lastDshText && event.text.startsWith(lastDshText)
                  ? event.text.slice(lastDshText.length)
                  : event.text) + "\n",
              );
            if (event.reason?.kind !== "completed")
              eventReason = String(
                event.reason?.kind ?? "DSH 缺少成功结束原因",
              );
          }
          if (event.type === "error")
            eventReason = String(event.message ?? "DSH 执行失败");
        }
      } catch {
        eventReason = "Agent 输出了无效 JSON 事件";
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 32 * 1024 * 1024) {
        internalFault = "Agent 单条事件超过 32 MiB";
        buffer = "";
        child.kill("SIGTERM");
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) =>
      output.stderr(stderrDecoder.write(chunk)),
    );
    child.stdin?.on("error", () => {
      /* close/error below determines the run result */
    });
    child.stdin?.end(prompt);
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        internalFault = error.message;
      });
      child.once("close", (code) => resolve(code));
    });
    const tail = buffer + decoder.end();
    if (tail) line(tail);
    const stderrTail = stderrDecoder.end();
    if (stderrTail) output.stderr(stderrTail);
    // The exit status is authoritative: a normal zero exit succeeds even without a terminal
    // event, while null or non-zero exits fail with the streamed event reason when available.
    if (internalFault) return { code, success: false, reason: internalFault, usage: reported };
    if (code === 0) return { code, success: true, usage: reported };
    return {
      code,
      success: false,
      reason: eventReason ?? "Agent 进程未以退出码 0 结束",
      usage: reported,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
