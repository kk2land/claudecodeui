import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  NativeExecution,
  NativeLaunch,
  WorkerCodexUsageBaseline,
  WorkerRun,
  WorkerTokenCounters,
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
  /** Current config service for a migrated run that had no reliable recorded provider. */
  codexLegacyProvider?: string | null;
  dshPatch: string;
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

/**
 * Merges user Codex env over the inherited environment, then removes plugin control tokens.
 * The caller fixes CODEX_HOME to the run's admitted home before spawning.
 */
export function codexEnvironment(
  base: NodeJS.ProcessEnv,
  settings: { env: Record<string, string> },
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
  const effort = nonBlank(input.run.effort);
  if (effort && !model)
    throw new WorkerFailure(
      "MODEL_REQUIRED",
      "DSH 设置 effort 前必须显式选择模型",
    );
  // Required Worker mechanisms: persistence patch, then the model route patch when selected.
  const patches: string[] = [];
  const sessionPatch = path.join(input.runDirectory, "dsh-session.patch.yml");
  fs.copyFileSync(input.dshPatch, sessionPatch);
  patches.push(sessionPatch);
  if (model) {
    let routeProvider = "deepseek-official";
    let routeModel = model;
    const slash = model.indexOf("/");
    if (slash > 0) {
      routeProvider = model.slice(0, slash);
      routeModel = model.slice(slash + 1);
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
  // The full native model identifier is passed through; the CLI resolves it.
  const model = nonBlank(input.run.model);
  const effort = nonBlank(input.run.effort);
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
  const provider =
    nonBlank(input.run.provider) ??
    (input.run.legacyCodexProvider === true
      ? nonBlank(input.codexLegacyProvider)
      : null);
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
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  samples: number;
  partial: boolean;
  totalUnknown: boolean;
};

function emptyBuckets(): UsageBuckets {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    samples: 0,
    partial: false,
    totalUnknown: false,
  };
}

/** Validates one native counter exactly once; a reported zero is kept. */
function counter(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function addCounter(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return current === null ? value : current + value;
}

/**
 * Adds one native sample per field. Missing fields mark the aggregate partial but never discard
 * the other known subtotals. Native total wins; the fallback sum is only used when the same
 * sample reports input, output, cache read, and cache write together.
 */
function addUsage(
  buckets: UsageBuckets,
  sample: unknown,
  keys: {
    input: string;
    output: string;
    cacheRead: string;
    cacheWrite: string;
    total: string;
  },
): void {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    buckets.partial = true;
    return;
  }
  const record = sample as Record<string, unknown>;
  const input = counter(record[keys.input]);
  const output = counter(record[keys.output]);
  const cacheRead = counter(record[keys.cacheRead]);
  const cacheWrite = counter(record[keys.cacheWrite]);
  const nativeTotal = counter(record[keys.total]);
  const reported = [input, output, cacheRead, cacheWrite, nativeTotal].filter(
    (value) => value !== null,
  ).length;
  if (!reported) {
    buckets.partial = true;
    return;
  }
  buckets.samples++;
  if (input === null || output === null || cacheRead === null || cacheWrite === null)
    buckets.partial = true;
  buckets.inputTokens = addCounter(buckets.inputTokens, input);
  buckets.outputTokens = addCounter(buckets.outputTokens, output);
  buckets.cacheReadTokens = addCounter(buckets.cacheReadTokens, cacheRead);
  buckets.cacheWriteTokens = addCounter(buckets.cacheWriteTokens, cacheWrite);
  if (nativeTotal !== null) {
    if (!buckets.totalUnknown)
      buckets.totalTokens = addCounter(buckets.totalTokens, nativeTotal);
  } else if (
    input !== null &&
    output !== null &&
    cacheRead !== null &&
    cacheWrite !== null
  ) {
    if (!buckets.totalUnknown)
      buckets.totalTokens = addCounter(
        buckets.totalTokens,
        input + output + cacheRead + cacheWrite,
      );
  } else {
    // A total that cannot be reconstructed from this same sample poisons the aggregate total;
    // later samples must not patch it with differently scoped subtotals.
    buckets.totalUnknown = true;
    buckets.totalTokens = null;
    buckets.partial = true;
  }
}

function toUsage(
  buckets: UsageBuckets,
  scope: WorkerUsage["scope"],
  partial = false,
): WorkerUsage | null {
  if (buckets.samples === 0) return null;
  return {
    inputTokens: buckets.inputTokens,
    outputTokens: buckets.outputTokens,
    cacheReadTokens: buckets.cacheReadTokens,
    cacheWriteTokens: buckets.cacheWriteTokens,
    totalTokens: buckets.totalTokens,
    scope,
    partial: buckets.partial || partial,
  };
}

function emptyCounters(): WorkerTokenCounters {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  };
}

/** Known all-zero baseline for a brand-new Codex thread. */
export function zeroCodexCounters(): WorkerTokenCounters {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function readCodexCounters(value: unknown): WorkerTokenCounters | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inputTokens = counter(record.input_tokens);
  const outputTokens = counter(record.output_tokens);
  const cacheReadTokens = counter(record.cached_input_tokens);
  const cacheWriteTokens = counter(record.cache_write_input_tokens);
  const nativeTotal = counter(record.total_tokens);
  if (
    inputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheWriteTokens === null &&
    nativeTotal === null
  )
    return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // Only a reported native total is kept here; fallback synthesis needs run-scope proof.
    totalTokens: nativeTotal,
  };
}

type CounterDiff = {
  counters: WorkerTokenCounters;
  comparable: number;
  negative: boolean;
};

/** Compares each field independently; unknown on either side stays unknown. */
function diffCounters(
  snapshot: WorkerTokenCounters,
  baseline: WorkerTokenCounters,
): CounterDiff {
  const counters = emptyCounters();
  let comparable = 0;
  let negative = false;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
  ] as const) {
    if (snapshot[key] === null || baseline[key] === null) continue;
    comparable++;
    const value = snapshot[key]! - baseline[key]!;
    if (value < 0) negative = true;
    else counters[key] = value;
  }
  return { counters, comparable, negative };
}

/**
 * Resolves final Codex usage. A trusted baseline yields per-field run diffs; a missing total is
 * derived from confirmed run-scope input + output. Session fallback derives only from its own
 * snapshot. Negative diffs and missing baselines remain explicitly non-run.
 */
function codexSnapshotUsage(
  snapshot: WorkerTokenCounters,
  baseline: WorkerCodexUsageBaseline | null,
  partial: boolean,
): WorkerUsage {
  if (baseline?.counters) {
    const diff = diffCounters(snapshot, baseline.counters);
    if (!diff.negative && diff.comparable > 0) {
      const counters = { ...diff.counters };
      if (
        counters.totalTokens === null &&
        counters.inputTokens !== null &&
        counters.outputTokens !== null
      )
        counters.totalTokens = counters.inputTokens + counters.outputTokens;
      return {
        ...counters,
        scope: "run",
        partial:
          partial ||
          counters.inputTokens === null ||
          counters.outputTokens === null ||
          counters.cacheReadTokens === null ||
          counters.cacheWriteTokens === null ||
          counters.totalTokens === null,
      };
    }
  }
  const counters = { ...snapshot };
  if (
    counters.totalTokens === null &&
    counters.inputTokens !== null &&
    counters.outputTokens !== null
  )
    counters.totalTokens = counters.inputTokens + counters.outputTokens;
  return {
    ...counters,
    scope: "session",
    partial:
      partial ||
      Boolean(baseline) ||
      counters.inputTokens === null ||
      counters.outputTokens === null ||
      counters.cacheReadTokens === null ||
      counters.cacheWriteTokens === null ||
      counters.totalTokens === null,
  };
}

type CodexRolloutReport = {
  lastTotal: WorkerTokenCounters | null;
  increments: WorkerTokenCounters | null;
  partial: boolean;
};

type CodexRolloutScan = CodexRolloutReport & { eof: number };

/**
 * Parses token_count reports at or after a byte offset from one buffer snapshot. The returned
 * EOF is the same snapshot's end, so baseline counters and their read position cannot diverge.
 */
function scanCodexRollout(
  file: string,
  offset: number,
  end?: number,
): CodexRolloutScan | null {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return null;
  }
  const eof = buffer.length;
  const limit = Math.min(eof, end ?? eof);
  if (limit <= offset)
    return { lastTotal: null, increments: null, partial: false, eof };
  const text = buffer.subarray(offset, limit).toString("utf8");
  let lastTotal: WorkerTokenCounters | null = null;
  let increments: WorkerTokenCounters | null = null;
  let incrementNativeTotal = 0;
  let allNativeTotal = true;
  let incrementIoTotal = 0;
  let allInputOutput = true;
  let incrementMissing = false;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const payload =
      record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : null;
    if (payload?.type !== "token_count" && record.type !== "token_count") continue;
    const info =
      payload?.info && typeof payload.info === "object" && !Array.isArray(payload.info)
        ? (payload.info as Record<string, unknown>)
        : record.info && typeof record.info === "object" && !Array.isArray(record.info)
          ? (record.info as Record<string, unknown>)
          : null;
    if (!info) continue;
    const total = readCodexCounters(info.total_token_usage);
    if (total) lastTotal = total;
    const last = readCodexCounters(info.last_token_usage);
    if (last) {
      if (!increments) increments = emptyCounters();
      if (last.totalTokens === null) allNativeTotal = false;
      else incrementNativeTotal += last.totalTokens;
      if (last.inputTokens === null || last.outputTokens === null)
        allInputOutput = false;
      else incrementIoTotal += last.inputTokens + last.outputTokens;
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
      ] as const) {
        if (last[key] === null) {
          incrementMissing = true;
          continue;
        }
        increments[key] =
          increments[key] === null ? last[key] : increments[key]! + last[key]!;
      }
    }
  }
  if (increments) {
    // Never mix native totals from some samples with derived totals from others.
    if (allNativeTotal) increments.totalTokens = incrementNativeTotal;
    else if (allInputOutput) increments.totalTokens = incrementIoTotal;
    else {
      increments.totalTokens = null;
      incrementMissing = true;
    }
  }
  return { lastTotal, increments, partial: incrementMissing, eof };
}

/**
 * Reads the last cumulative Codex snapshot at launch time and the rollout EOF offset. New
 * threads use an explicit zero baseline instead of this helper.
 */
export function codexBaseline(file: string | null): WorkerCodexUsageBaseline {
  if (!file) return { counters: null, offset: 0 };
  const scan = scanCodexRollout(file, 0);
  if (!scan) return { counters: null, offset: 0 };
  return { counters: scan.lastTotal, offset: scan.eof };
}

/** Finds the rollout file of a known Codex thread under its fixed sessions root. */
export function findCodexSessionFile(
  sessionsRoot: string,
  threadId: string | null,
): string | null {
  if (!threadId || path.basename(threadId) !== threadId) return null;
  const walk = (directory: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        if (entry.name.includes(threadId) && entry.name.endsWith(".jsonl"))
          return path.join(directory, entry.name);
        continue;
      }
      if (!entry.isDirectory() || depth >= 5) continue;
      const found = walk(path.join(directory, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(sessionsRoot, 0);
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
            cacheRead: "cacheReadTokens",
            cacheWrite: "cacheWriteTokens",
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
    usage: toUsage(buckets, "run", error !== null),
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
        // Pi reports the completed model call here; turn_end is emitted only after any tool
        // execution and would lose usage when a tool phase is cancelled.
        addUsage(buckets, record.usage, {
          input: "input",
          output: "output",
          cacheRead: "cacheRead",
          cacheWrite: "cacheWrite",
          total: "totalTokens",
        });
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
      case "turn_end":
        break;
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
    usage: toUsage(buckets, "run", error !== null),
    error,
  };
}

function codexRolloutUsage(
  file: string | null,
  baseline: WorkerCodexUsageBaseline | null,
): WorkerUsage | null {
  if (!file) return null;
  const report = scanCodexRollout(file, baseline?.offset ?? 0);
  if (!report) return null;
  if (report.lastTotal)
    return codexSnapshotUsage(report.lastTotal, baseline, true);
  if (report.increments)
    return { ...report.increments, scope: "run", partial: true };
  return null;
}

export type CodexUsageContext = {
  baseline: WorkerCodexUsageBaseline | null;
  sessionFile: string | null;
  sessionsRoot: string;
};

/** Parses Codex exec JSONL, keeping a validated thread id even when the turn later fails. */
export function parseCodex(
  file: string,
  expectedSessionId: string | null,
  usageContext: CodexUsageContext | null = null,
): NativeExecution {
  let threadId: string | null = null;
  let validatedSessionId: string | null = null;
  let threadEvents = 0;
  let finalText: string | null = null;
  let completed = false;
  let identityMismatch = false;
  let error: string | null = null;
  let recoverableError: string | null = null;
  let lastSnapshot: WorkerTokenCounters | null = null;
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
          if (expectedSessionId !== null && id !== expectedSessionId) {
            identityMismatch = true;
            fail("Codex resume 返回了不同 thread_id");
          } else validatedSessionId = id;
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
        // Cold resume reports a session-cumulative snapshot; only the last one is authoritative.
        const snapshot = readCodexCounters(event.usage);
        if (snapshot) lastSnapshot = snapshot;
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
  // A mismatched resume must never combine the requested thread's baseline with another
  // thread's rollout. At most the actual stdout snapshot survives, without run-scope diffing.
  const rolloutFile = identityMismatch
    ? null
    : usageContext?.sessionFile ??
      (threadId
        ? findCodexSessionFile(usageContext?.sessionsRoot ?? "", threadId)
        : null);
  let baseline = identityMismatch ? null : usageContext?.baseline ?? null;
  if (baseline?.counters && baseline.counters.totalTokens !== null) {
    const newThreadZero =
      baseline.offset === 0 &&
      baseline.counters.inputTokens === 0 &&
      baseline.counters.outputTokens === 0 &&
      baseline.counters.cacheReadTokens === 0 &&
      baseline.counters.cacheWriteTokens === 0 &&
      baseline.counters.totalTokens === 0;
    if (!newThreadZero) {
      // A persisted old baseline may have synthesized T. Only a raw rollout total before the
      // saved offset confirms that T as native.
      const evidence = rolloutFile
        ? scanCodexRollout(rolloutFile, 0, baseline.offset)
        : null;
      if (
        (evidence?.lastTotal?.totalTokens ?? null) !== baseline.counters.totalTokens
      )
        baseline = {
          ...baseline,
          counters: { ...baseline.counters, totalTokens: null },
        };
    }
  }
  if (
    !identityMismatch &&
    lastSnapshot !== null &&
    lastSnapshot.totalTokens === null &&
    baseline &&
    rolloutFile
  ) {
    const candidate = scanCodexRollout(rolloutFile, baseline.offset)?.lastTotal;
    const cacheCompatible =
      (candidate?.cacheReadTokens == null ||
        lastSnapshot.cacheReadTokens == null ||
        candidate.cacheReadTokens === lastSnapshot.cacheReadTokens) &&
      (candidate?.cacheWriteTokens == null ||
        lastSnapshot.cacheWriteTokens == null ||
        candidate.cacheWriteTokens === lastSnapshot.cacheWriteTokens);
    if (
      candidate?.totalTokens !== null &&
      candidate?.totalTokens !== undefined &&
      candidate.inputTokens !== null &&
      candidate.inputTokens === lastSnapshot.inputTokens &&
      candidate.outputTokens !== null &&
      candidate.outputTokens === lastSnapshot.outputTokens &&
      cacheCompatible
    )
      lastSnapshot = { ...lastSnapshot, totalTokens: candidate.totalTokens };
  }
  const usage = identityMismatch
    ? lastSnapshot !== null
      ? codexSnapshotUsage(lastSnapshot, null, error !== null)
      : null
    : lastSnapshot !== null
      ? codexSnapshotUsage(lastSnapshot, baseline, error !== null)
      : baseline
        ? codexRolloutUsage(rolloutFile, baseline)
        : null;
  return {
    success: error === null,
    nativeSessionId: validatedSessionId,
    nativeSessionFile: rolloutFile,
    finalText,
    usage,
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
