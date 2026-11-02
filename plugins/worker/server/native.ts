import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  NativeExecution,
  NativeLaunch,
  WorkerCodexSettings,
  WorkerRun,
  WorkerType,
  WorkerUsage,
} from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ModelSelection = {
  model: string | null;
  provider: string | null;
  effort: string | null;
};

type PrepareInput = {
  type: WorkerType;
  run: WorkerRun;
  cwd: string;
  prompt: string;
  previous: WorkerRun | null;
  dataDirectory: string;
  runDirectory: string;
  executable: string;
  baseEnvironment: NodeJS.ProcessEnv;
  /** Configured Codex exec extra args; Codex environment values are merged by the caller. */
  codexExtraArgs?: string[] | null;
  dshPatch: string;
  dshBin?: string;
};

/** Resolves an executable on PATH before any cwd change; explicit paths are made absolute. */
export function resolveExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (name.includes(path.sep)) return path.resolve(expandHome(name));
  const paths = (environment.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of paths) {
    // A relative PATH entry must be resolved before the CLI changes cwd.
    const candidate = path.resolve(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep scanning */
    }
  }
  throw new WorkerFailure(
    "EXECUTABLE_MISSING",
    "PATH 中找不到可执行文件: " + name,
  );
}

function nonBlank(value: string | undefined | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~" + path.sep))
    return path.join(os.homedir(), value.slice(2));
  return value;
}

function home(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const configured = nonBlank(environment[name]);
  return path.resolve(
    configured ? expandHome(configured) : path.join(os.homedir(), fallback),
  );
}

/** Mirrors the app's CLOUDCLI_DSH_PATCHES launch configuration without rewriting profiles. */
function dshLaunchPatches(environment: NodeJS.ProcessEnv): string[] {
  const raw = environment.CLOUDCLI_DSH_PATCHES;
  if (raw === undefined || !raw.trim()) return [];
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new WorkerFailure(
      "DSH_CONFIG_INVALID",
      "CLOUDCLI_DSH_PATCHES 必须是文件路径的 JSON 数组",
    );
  }
  if (
    !Array.isArray(values) ||
    !values.every((value) => typeof value === "string" && value.trim())
  )
    throw new WorkerFailure(
      "DSH_CONFIG_INVALID",
      "CLOUDCLI_DSH_PATCHES 必须包含非空文件路径",
    );
  return values.map((value: string) => path.resolve(value));
}

/**
 * Merges user Codex env over the inherited environment, then removes plugin control tokens.
 * The caller fixes CODEX_HOME to the run's admitted home before spawning.
 */
export function codexEnvironment(
  base: NodeJS.ProcessEnv,
  settings: WorkerCodexSettings,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, ...settings.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("CLOUDCLI_PLUGIN_")) delete environment[key];
  return environment;
}

/** Resolves the fixed home and session root used for a new worker (never re-read on resume). */
export function nativeHome(
  type: WorkerType,
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): { home: string; sessionsRoot: string } {
  if (type === "dsh")
    return {
      home: home(environment, "DSH_HOME", ".dsh"),
      sessionsRoot: path.join(dataDirectory, "sessions", "dsh"),
    };
  if (type === "codex") {
    const resolvedHome = home(environment, "CODEX_HOME", ".codex");
    return { home: resolvedHome, sessionsRoot: path.join(resolvedHome, "sessions") };
  }
  return {
    home: home(environment, "PI_CODING_AGENT_DIR", path.join(".pi", "agent")),
    sessionsRoot: path.join(dataDirectory, "sessions", "pi"),
  };
}

/** Builds the DSH headless launch and its run-level model patch. */
function prepareDsh(input: PrepareInput): NativeLaunch {
  const previous = input.previous;
  const defaults = nativeHome("dsh", input.dataDirectory, input.baseEnvironment);
  const resolvedHome = previous ? previous.home : defaults.home;
  const sessionsRoot = previous ? previous.sessionsRoot : defaults.sessionsRoot;
  const model = nonBlank(input.run.model);
  const provider = nonBlank(input.run.provider);
  const effort = nonBlank(input.run.effort);
  if (effort && !model)
    throw new WorkerFailure(
      "MODEL_REQUIRED",
      "DSH 设置 effort 前必须显式选择模型",
    );
  const patches = dshLaunchPatches(input.baseEnvironment);
  // The native proxy may allow the run directory while restricting the installation directory.
  const sessionPatch = path.join(input.runDirectory, "dsh-session.patch.yml");
  fs.copyFileSync(input.dshPatch, sessionPatch);
  patches.push(sessionPatch);
  if (model) {
    let routeProvider = provider;
    let routeModel = model;
    if (!routeProvider) {
      const slash = model.indexOf("/");
      if (slash > 0) {
        routeProvider = model.slice(0, slash);
        routeModel = model.slice(slash + 1);
      } else {
        routeProvider =
          nonBlank(input.baseEnvironment.CLOUDCLI_DSH_PROVIDER) ??
          "deepseek-official";
      }
    }
    const file = path.join(input.runDirectory, "model.patch.yml");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: "agent-default-model",
          config: {
            provider: routeProvider,
            model: routeModel,
            ...(effort ? { reasoningEffort: effort } : {}),
          },
        },
      ]),
      { mode: 0o600 },
    );
    patches.push(file);
  }
  const argv = [input.executable, "--profile", "headless"];
  for (const patch of patches) argv.push("--patch", patch);
  argv.push("--json");
  const sessionId = previous?.nativeSessionId ?? null;
  if (sessionId) argv.push("--session-id", sessionId);
  argv.push("-");
  return {
    argv,
    cwd: input.cwd,
    env: {
      ...input.baseEnvironment,
      DSH_HOME: resolvedHome,
      CODEX_DSH_SESSIONS_ROOT: sessionsRoot,
    },
    prompt: input.prompt,
    expectedSessionId: sessionId,
    sessionFile: previous?.nativeSessionFile ?? null,
  };
}

/** Builds the Pi print/JSON launch with explicit session-file continuation. */
function preparePi(input: PrepareInput): NativeLaunch {
  const previous = input.previous;
  const defaults = nativeHome("pi", input.dataDirectory, input.baseEnvironment);
  const resolvedHome = previous ? previous.home : defaults.home;
  const sessionsRoot = previous ? previous.sessionsRoot : defaults.sessionsRoot;
  // Admission resolved request > environment; resume uses recorded values only.
  const model = nonBlank(input.run.model);
  const provider = nonBlank(input.run.provider);
  const effort = nonBlank(input.run.effort);
  if (provider && !model)
    throw new WorkerFailure("MODEL_REQUIRED", "Pi provider 需要同时选择模型");
  if (effort && !(PI_THINKING_LEVELS as readonly string[]).includes(effort))
    throw new WorkerFailure("THINKING_INVALID", "不支持的 Pi thinking 级别");
  const sessionFile = previous
    ? previous.nativeSessionFile
    : path.join(sessionsRoot, input.run.id + ".jsonl");
  if (previous) {
    if (!previous.nativeSessionId || !sessionFile)
      throw new WorkerFailure("NATIVE_SESSION_UNKNOWN", "缺少已核实的 Pi 会话身份");
    const header = readPiHeader(sessionFile, input.cwd, previous.nativeSessionId);
    void header;
  }
  const argv = [
    input.executable,
    "--print",
    "--mode",
    "json",
    "--session-dir",
    sessionsRoot,
    "--session",
    sessionFile!,
  ];
  if (model) argv.push("--model", model);
  if (provider) argv.push("--provider", provider);
  if (effort) argv.push("--thinking", effort);
  return {
    argv,
    cwd: input.cwd,
    env: { ...input.baseEnvironment, PI_CODING_AGENT_DIR: resolvedHome },
    prompt: input.prompt,
    expectedSessionId: previous?.nativeSessionId ?? null,
    sessionFile,
  };
}

/**
 * Builds a Codex exec invocation. All exec-level options, including configured extra args, stay
 * before the resume subcommand; the thread id is the only positional before the stdin prompt.
 */
function prepareCodex(input: PrepareInput): NativeLaunch {
  const sessionId = input.previous?.nativeSessionId ?? null;
  const model = nonBlank(input.run.model);
  const configured = input.codexExtraArgs ?? [];
  const argv = [input.executable, "exec", "--json"];
  for (let index = 0; index < configured.length; index++) {
    const arg = configured[index]!;
    if (model && (arg === "--model" || arg === "-m")) {
      index++;
      continue;
    }
    if (
      model &&
      (arg.startsWith("--model=") || (arg.startsWith("-m") && arg.length > 2))
    )
      continue;
    argv.push(arg);
  }
  const provider = nonBlank(input.run.provider);
  const effort = nonBlank(input.run.effort);
  // Explicit selections come after configured args so they win over configured defaults.
  if (model) argv.push("--model", model);
  if (provider)
    argv.push("-c", "model_provider=" + JSON.stringify(provider));
  if (effort)
    argv.push("-c", "model_reasoning_effort=" + JSON.stringify(effort));
  if (sessionId) argv.push("resume", sessionId);
  argv.push("-");
  return {
    argv,
    cwd: input.cwd,
    env: { ...input.baseEnvironment, CODEX_HOME: input.run.home },
    prompt: input.prompt,
    expectedSessionId: sessionId,
    sessionFile: null,
  };
}

export function prepareLaunch(input: PrepareInput): NativeLaunch {
  if (input.type === "dsh") return prepareDsh(input);
  if (input.type === "codex") return prepareCodex(input);
  return preparePi(input);
}

function existsNonEmpty(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function readPiHeader(
  file: string,
  cwd: string,
  expectedId: string,
): { id: string; cwd: string } {
  if (!existsNonEmpty(file))
    throw new WorkerFailure("NATIVE_SESSION_MISSING", "Pi 会话文件不存在或为空");
  let header: unknown;
  try {
    header = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]!);
  } catch {
    throw new WorkerFailure("NATIVE_SESSION_INVALID", "Pi 会话文件头无效");
  }
  const value = header as Record<string, unknown>;
  if (value?.type !== "session" || value.id !== expectedId)
    throw new WorkerFailure("NATIVE_SESSION_MISMATCH", "Pi 会话身份不匹配");
  if (
    typeof value.cwd !== "string" ||
    path.resolve(value.cwd) !== path.resolve(cwd)
  )
    throw new WorkerFailure("NATIVE_SESSION_MISMATCH", "Pi 会话工作目录不匹配");
  return { id: expectedId, cwd: value.cwd };
}

type UsageBuckets = {
  input: number | null;
  output: number | null;
  total: number | null;
  samples: number;
};

function emptyBuckets(): UsageBuckets {
  return { input: null, output: null, total: null, samples: 0 };
}

/** Sums only fully valid samples; an unknown counter stays null rather than becoming zero. */
function addUsage(
  buckets: UsageBuckets,
  sample: unknown,
  keys: { input: string; output: string; total: string },
): void {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return;
  const record = sample as Record<string, unknown>;
  const input = record[keys.input];
  const output = record[keys.output];
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < 0 ||
    !Number.isSafeInteger(output) ||
    (output as number) < 0
  )
    return;
  const total = record[keys.total];
  const validTotal =
    Number.isSafeInteger(total) && (total as number) >= 0 ? (total as number) : null;
  if (buckets.samples === 0) {
    buckets.input = input as number;
    buckets.output = output as number;
    buckets.total = validTotal;
  } else {
    buckets.input =
      buckets.input === null ? null : buckets.input + (input as number);
    buckets.output =
      buckets.output === null ? null : buckets.output + (output as number);
    buckets.total =
      buckets.total === null || validTotal === null
        ? null
        : buckets.total + validTotal;
  }
  buckets.samples++;
}

function toUsage(buckets: UsageBuckets): WorkerUsage | null {
  if (buckets.samples === 0) return null;
  return {
    inputTokens: buckets.input,
    outputTokens: buckets.output,
    totalTokens: buckets.total,
  };
}

function lines(file: string): { value: unknown; number: number }[] {
  const output: { value: unknown; number: number }[] = [];
  const source = fs.readFileSync(file, "utf8");
  source.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      output.push({ value: JSON.parse(line), number: index + 1 });
    } catch {
      output.push({ value: undefined, number: index + 1 });
    }
  });
  return output;
}

function samePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/** Parses and validates the complete DSH headless event stream. */
export function parseDsh(
  file: string,
  expectedSessionId: string | null,
  expectedCwd: string,
  sessionsRoot: string,
): NativeExecution {
  let sessionId: string | null = null;
  let sessionEvents = 0;
  let validatedSessionId: string | null = null;
  let finalText: string | null = null;
  let finalSeen = false;
  let turnEnd: unknown = null;
  let error: string | null = null;
  const buckets = emptyBuckets();
  const fail = (message: string) => {
    if (error === null) error = message;
  };
  for (const { value, number } of lines(file)) {
    if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
      fail("无效 DSH 事件 (line " + number + ")");
      continue;
    }
    const event = value as Record<string, unknown>;
    if (typeof event.type !== "string") {
      fail("无效 DSH 事件 (line " + number + ")");
      continue;
    }
    if (finalSeen) fail("final 之后出现事件");
    switch (event.type) {
      case "session": {
        sessionEvents++;
        const id = event.sessionId;
        let identityValid = false;
        if (typeof id !== "string" || !id.trim())
          fail("session 事件缺少有效会话 ID");
        else if (sessionId !== null) fail("出现多个 session 事件");
        else {
          sessionId = id;
          if (expectedSessionId !== null && id !== expectedSessionId)
            fail("DSH resume 返回了不同会话 ID");
          else identityValid = true;
        }
        const cwdValid =
          typeof event.cwd === "string" &&
          path.isAbsolute(event.cwd) &&
          samePath(event.cwd, expectedCwd);
        if (!cwdValid) fail("DSH session 工作目录不匹配");
        // Only a session event matching both trusted id and cwd may replace identity.
        if (identityValid && cwdValid && sessionId !== null)
          validatedSessionId = sessionId;
        break;
      }
      case "status": {
        if (event.phase === "step_end")
          addUsage(buckets, event.usage, {
            input: "inputTokens",
            output: "outputTokens",
            total: "totalTokens",
          });
        else if (event.phase === "turn_end") turnEnd = event.reason;
        break;
      }
      case "final":
        finalSeen = true;
        if (typeof event.text !== "string") fail("final 事件缺少文本");
        else finalText = event.text;
        break;
      case "error":
        fail(
          typeof event.message === "string" && event.message
            ? event.message
            : "DSH 报告错误事件",
        );
        break;
      default:
        break;
    }
  }
  if (!sessionId) fail("缺少 session 事件");
  if (sessionEvents !== 1) validatedSessionId = null;
  if (!finalSeen) fail("缺少 final 事件");
  if (
    !turnEnd ||
    typeof turnEnd !== "object" ||
    (turnEnd as Record<string, unknown>).kind !== "completed"
  )
    fail("最终轮次未成功完成");
  return {
    success: error === null,
    nativeSessionId: validatedSessionId,
    nativeSessionFile: validatedSessionId
      ? findDshSessionFile(sessionsRoot, validatedSessionId)
      : null,
    finalText,
    usage: toUsage(buckets),
    error,
  };
}

function findDshSessionFile(root: string, sessionId: string): string | null {
  // DSH stores each transcript under a directory named exactly by the native session id.
  if (!sessionId || path.basename(sessionId) !== sessionId) return null;
  const candidates: string[] = [];
  const walk = (directory: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (path.basename(directory) === sessionId) {
      const logs = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(entry.name) &&
            existsNonEmpty(path.join(directory, entry.name)),
        )
        .sort(
          (left, right) =>
            Number(right.name.match(/\.v(\d+)/)?.[1] ?? 0) -
            Number(left.name.match(/\.v(\d+)/)?.[1] ?? 0),
        );
      if (logs[0]) candidates.push(path.join(directory, logs[0].name));
    }
    if (depth >= 2) return;
    for (const entry of entries)
      if (entry.isDirectory()) walk(path.join(directory, entry.name), depth + 1);
  };
  walk(root, 0);
  return candidates[0] ?? null;
}

/** Parses and validates the complete Pi JSON event stream, including retry/settle rules. */
export function parsePi(
  file: string,
  expectedSessionId: string | null,
  expectedCwd: string,
  sessionFile: string,
): NativeExecution {
  let sessionId: string | null = null;
  let finalText: string | null = null;
  let lastMessage: Record<string, unknown> | null = null;
  let ended = false;
  let willRetry: unknown = null;
  let settled = false;
  let aborted: unknown = null;
  let error: string | null = null;
  const buckets = emptyBuckets();
  const fail = (message: string) => {
    if (error === null) error = message;
  };
  for (const { value, number } of lines(file)) {
    if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
      fail("无效 Pi 事件 (line " + number + ")");
      continue;
    }
    const event = value as Record<string, unknown>;
    if (typeof event.type !== "string") {
      fail("无效 Pi 事件 (line " + number + ")");
      continue;
    }
    switch (event.type) {
      case "session": {
        if (sessionId !== null) fail("出现多个 Pi session 头");
        else {
          try {
            sessionId = piIdentity(event, expectedCwd, expectedSessionId);
          } catch (failure) {
            fail((failure as Error).message);
          }
        }
        break;
      }
      case "agent_start":
        ended = false;
        settled = false;
        lastMessage = null;
        finalText = null;
        break;
      case "turn_start":
        settled = false;
        break;
      case "message_end": {
        const message = event.message;
        if (!message || typeof message !== "object") {
          fail("message_end 缺少 message 对象");
          break;
        }
        const record = message as Record<string, unknown>;
        if (record.role !== "assistant") break;
        lastMessage = record;
        if (!Array.isArray(record.content)) {
          fail("assistant 内容无效");
          break;
        }
        const blocks: string[] = [];
        let invalid = false;
        for (const item of record.content as unknown[]) {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            invalid = true;
            break;
          }
          const block = item as Record<string, unknown>;
          if (block.type !== "text") continue;
          if (typeof block.text !== "string") {
            invalid = true;
            break;
          }
          blocks.push(block.text);
        }
        if (invalid) {
          fail("assistant 文本块无效");
          break;
        }
        finalText = blocks.join("\n");
        break;
      }
      case "turn_end": {
        const message = event.message;
        const sample =
          message && typeof message === "object"
            ? (message as Record<string, unknown>).usage
            : null;
        addUsage(buckets, sample, {
          input: "input",
          output: "output",
          total: "totalTokens",
        });
        break;
      }
      case "agent_end":
        ended = true;
        willRetry = event.willRetry;
        break;
      case "agent_settled":
        settled = true;
        aborted = event.aborted;
        break;
      case "error":
        fail(
          typeof event.message === "string" && event.message
            ? event.message
            : "Pi 报告错误事件",
        );
        break;
      default:
        break;
    }
  }
  if (!sessionId) fail("缺少有效的 Pi session 头");
  if (!lastMessage) fail("缺少已完成的 assistant 消息");
  else if (lastMessage.stopReason !== "stop")
    fail(
      typeof lastMessage.errorMessage === "string"
        ? lastMessage.errorMessage
        : "Pi assistant 未完成: " + String(lastMessage.stopReason),
    );
  if (!ended || willRetry !== false) fail("缺少最终且不重试的 agent_end");
  if (!settled || aborted !== false) fail("缺少成功的 agent_settled");
  return {
    success: error === null,
    nativeSessionId: sessionId,
    nativeSessionFile: sessionId ? sessionFile : null,
    finalText,
    usage: toUsage(buckets),
    error,
  };
}

/** Parses Codex exec JSONL, keeping a validated thread id even when the turn later fails. */
export function parseCodex(
  file: string,
  expectedSessionId: string | null,
): NativeExecution {
  let threadId: string | null = null;
  let validatedSessionId: string | null = null;
  let threadEvents = 0;
  let finalText: string | null = null;
  let completed = false;
  let error: string | null = null;
  let recoverableError: string | null = null;
  const buckets = emptyBuckets();
  const fail = (message: string) => {
    if (error === null) error = message;
  };
  for (const { value, number } of lines(file)) {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
      fail("无效 Codex 事件 (line " + number + ")");
      continue;
    }
    const event = value as Record<string, unknown>;
    if (typeof event.type !== "string") {
      fail("无效 Codex 事件 (line " + number + ")");
      continue;
    }
    switch (event.type) {
      case "thread.started": {
        threadEvents++;
        const id = event.thread_id;
        if (typeof id !== "string" || !id.trim())
          fail("thread.started 缺少有效 thread_id");
        else if (threadId !== null) fail("出现多个 thread.started 事件");
        else {
          threadId = id;
          if (expectedSessionId !== null && id !== expectedSessionId)
            fail("Codex resume 返回了不同 thread_id");
          else validatedSessionId = id;
        }
        break;
      }
      case "item.completed": {
        const item = event.item;
        if (!item || typeof item !== "object" || Array.isArray(item)) break;
        const record = item as Record<string, unknown>;
        if (record.type !== "agent_message") break;
        if (typeof record.text !== "string") fail("agent_message 缺少文本");
        else finalText = record.text;
        break;
      }
      case "turn.completed": {
        completed = true;
        // The CLI reports session-cumulative usage on cold resume; keep the event value.
        const usage = event.usage;
        if (usage && typeof usage === "object" && !Array.isArray(usage)) {
          const record = usage as Record<string, unknown>;
          const input = record.input_tokens;
          const output = record.output_tokens;
          if (
            Number.isSafeInteger(input) &&
            (input as number) >= 0 &&
            Number.isSafeInteger(output) &&
            (output as number) >= 0
          ) {
            const total = (input as number) + (output as number);
            if (buckets.samples === 0) {
              buckets.input = input as number;
              buckets.output = output as number;
              buckets.total = total;
            } else {
              buckets.input =
                buckets.input === null ? null : buckets.input + (input as number);
              buckets.output =
                buckets.output === null ? null : buckets.output + (output as number);
              buckets.total =
                buckets.total === null ? null : buckets.total + total;
            }
            buckets.samples++;
          }
        }
        break;
      }
      case "turn.failed": {
        const failure = event.error;
        const message =
          failure && typeof failure === "object" && !Array.isArray(failure)
            ? (failure as Record<string, unknown>).message
            : null;
        fail(
          typeof message === "string" && message
            ? message
            : "Codex 报告 turn.failed",
        );
        break;
      }
      case "error":
        // Codex emits top-level error lines for reconnectable stream failures; a later
        // turn.completed is authoritative, while missing completion still reports this message.
        recoverableError =
          typeof event.message === "string" && event.message
            ? event.message
            : "Codex 报告错误事件";
        break;
      default:
        break;
    }
  }
  if (threadEvents !== 1) validatedSessionId = null;
  if (!threadId) fail("缺少 thread.started 事件");
  if (!completed)
    fail(recoverableError ?? "缺少成功的 turn.completed 事件");
  return {
    success: error === null,
    nativeSessionId: validatedSessionId,
    nativeSessionFile: null,
    finalText,
    usage: toUsage(buckets),
    error,
  };
}

function piIdentity(
  header: Record<string, unknown>,
  expectedCwd: string,
  expectedId: string | null,
): string {
  if (header.type !== "session") throw new Error("缺少 Pi session 头");
  const id = header.id;
  if (typeof id !== "string" || !id.trim())
    throw new Error("Pi session 头缺少有效 ID");
  if (expectedId !== null && id !== expectedId)
    throw new Error("Pi resume 返回了不同会话 ID");
  if (
    typeof header.cwd !== "string" ||
    !path.isAbsolute(header.cwd) ||
    !samePath(header.cwd, expectedCwd)
  )
    throw new Error("Pi session 工作目录不匹配");
  return id;
}

export type ProgressTracker = {
  steps: number;
  phase: string | null;
  currentTool: string | null;
  active: Map<string, string | null>;
};

export function newProgress(): ProgressTracker {
  return { steps: 0, phase: null, currentTool: null, active: new Map() };
}

/** Applies one parsed event to live progress; unknown shapes are ignored, never guessed. */
export function trackProgress(
  type: WorkerType,
  event: unknown,
  progress: ProgressTracker,
): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const value = event as Record<string, unknown>;
  const kind = value.type;
  if (typeof kind !== "string") return;
  if (type === "dsh") {
    if (kind === "session") progress.phase = "session";
    else if (kind === "status" && typeof value.phase === "string") {
      progress.phase = value.phase;
      if (value.phase === "step_end") progress.steps++;
      if (value.phase === "turn_end") {
        progress.active.clear();
        progress.currentTool = null;
      }
    } else if (kind === "tool_call") {
      progress.phase = "tool_call";
      const tool = typeof value.tool === "string" && value.tool ? value.tool : null;
      if (typeof value.callId === "string" && value.callId) {
        progress.active.set(value.callId, tool);
        if (progress.active.size > 64)
          progress.active.delete(progress.active.keys().next().value!);
      }
      progress.currentTool = tool;
    } else if (kind === "tool_result") {
      progress.phase = "tool_result";
      if (typeof value.callId === "string") progress.active.delete(value.callId);
      progress.currentTool =
        [...progress.active.values()].reverse().find((tool) => tool) ?? null;
    } else if (kind === "final") {
      progress.phase = "final";
      progress.active.clear();
      progress.currentTool = null;
    } else if (kind === "error") {
      progress.phase = "error";
      progress.active.clear();
      progress.currentTool = null;
    }
  } else if (type === "codex") {
    progress.phase = kind;
    const item =
      value.item && typeof value.item === "object" && !Array.isArray(value.item)
        ? (value.item as Record<string, unknown>)
        : null;
    if (kind === "item.started") {
      progress.currentTool =
        typeof item?.type === "string" && item.type ? item.type : null;
    } else if (kind === "item.completed") {
      progress.steps++;
      progress.currentTool = null;
    } else if (kind === "turn.completed" || kind === "turn.failed" || kind === "error") {
      progress.active.clear();
      progress.currentTool = null;
    }
  } else {
    progress.phase = kind;
    if (kind === "turn_end") progress.steps++;
    else if (kind === "tool_execution_start") {
      if (typeof value.toolCallId === "string")
        progress.active.set(
          value.toolCallId,
          typeof value.toolName === "string" ? value.toolName : null,
        );
      progress.currentTool =
        typeof value.toolName === "string" ? value.toolName : null;
    } else if (kind === "tool_execution_end") {
      if (typeof value.toolCallId === "string") progress.active.delete(value.toolCallId);
      progress.currentTool =
        [...progress.active.values()].reverse().find((tool) => tool) ?? null;
    } else if (["agent_end", "agent_settled", "error"].includes(kind)) {
      progress.active.clear();
      progress.currentTool = null;
    }
  }
}
