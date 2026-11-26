import fs from "node:fs";
import path from "node:path";
import type { NativeExecution, WorkerUsage } from "./shared/index.js";
import { parseAcpEvents } from "./acp.js";
import { readEventLines } from "./logs.js";

/**
 * Reads Pi session files and reconciles persisted ACP runs during recovery.
 * Older Pi ACP runs recorded usage and model errors in the session file.
 */

type PiTranscriptResolution =
  | { status: "ok"; file: string }
  | { status: "missing"; reason: string }
  | { status: "ambiguous"; files: string[]; reason: string }
  | { status: "invalid"; file: string; reason: string };

type HistoricalPiAcpContext = {
  sessionsRoot: string;
  sessionFile: string | null;
  /** Byte offset captured at launch (0 for a brand-new session, prior EOF for a resume). */
  transcriptOffset: number | null;
  /** User HOME directory used only as a strictly validated fallback lookup for session-map.json. */
  userHome?: string | null;
  /** Expected session action (`"new"` or `"resume"`), or `null` during handle-less recovery. */
  expectedAction?: "new" | "resume" | null;
};

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

function counter(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function addCounter(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return current === null ? value : current + value;
}

function addPiUsage(buckets: UsageBuckets, sample: unknown): void {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    buckets.partial = true;
    return;
  }
  const record = sample as Record<string, unknown>;
  const input = counter(record.input);
  const output = counter(record.output);
  const cacheRead = counter(record.cacheRead);
  const cacheWrite = counter(record.cacheWrite);
  const nativeTotal = counter(record.totalTokens);
  const reported = [input, output, cacheRead, cacheWrite, nativeTotal].filter(
    (value) => value !== null,
  ).length;
  if (!reported) {
    buckets.partial = true;
    return;
  }
  buckets.samples++;
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    buckets.partial = true;
  }
  buckets.inputTokens = addCounter(buckets.inputTokens, input);
  buckets.outputTokens = addCounter(buckets.outputTokens, output);
  buckets.cacheReadTokens = addCounter(buckets.cacheReadTokens, cacheRead);
  buckets.cacheWriteTokens = addCounter(buckets.cacheWriteTokens, cacheWrite);
  if (nativeTotal !== null) {
    if (!buckets.totalUnknown) {
      buckets.totalTokens = addCounter(buckets.totalTokens, nativeTotal);
    }
  } else if (
    input !== null &&
    output !== null &&
    cacheRead !== null &&
    cacheWrite !== null
  ) {
    if (!buckets.totalUnknown) {
      buckets.totalTokens = addCounter(
        buckets.totalTokens,
        input + output + cacheRead + cacheWrite,
      );
    }
  } else {
    buckets.totalUnknown = true;
    buckets.totalTokens = null;
    buckets.partial = true;
  }
}

function toUsage(buckets: UsageBuckets, partial: boolean): WorkerUsage | null {
  if (buckets.samples === 0) return null;
  return {
    inputTokens: buckets.inputTokens,
    outputTokens: buckets.outputTokens,
    cacheReadTokens: buckets.cacheReadTokens,
    cacheWriteTokens: buckets.cacheWriteTokens,
    totalTokens: buckets.totalTokens,
    scope: "run",
    partial: buckets.partial || partial,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function realPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function samePath(left: string, right: string): boolean {
  return realPath(left) === realPath(right);
}

function isInsideRoot(file: string, root: string): boolean {
  const resolvedRoot = realPath(root);
  const resolvedFile = realPath(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function existsNonEmptyFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Validates line 1 of a Pi JSONL transcript against the expected session id and cwd. */
function validatePiTranscriptHeader(
  file: string,
  expectedSessionId: string,
  expectedCwd: string,
): { ok: true } | { ok: false; reason: string } {
  if (!existsNonEmptyFile(file)) {
    return { ok: false, reason: "Pi transcript 文件不存在或为空" };
  }
  let raw: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(16 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      raw = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, reason: "Pi transcript 文件不可读取" };
  }
  const firstLine = raw.split("\n", 1)[0]?.trim() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return { ok: false, reason: "Pi transcript 会话头不是有效 JSON" };
  }
  const header = asRecord(parsed);
  if (!header || header.type !== "session" || header.id !== expectedSessionId) {
    return { ok: false, reason: "Pi transcript 会话身份不匹配" };
  }
  if (
    typeof header.cwd !== "string" ||
    !path.isAbsolute(header.cwd) ||
    !samePath(header.cwd, expectedCwd)
  ) {
    return { ok: false, reason: "Pi transcript 工作目录不匹配" };
  }
  return { ok: true };
}

function collectJsonlFiles(root: string, maxDepth = 2): string[] {
  const results: string[] = [];
  const walk = (directory: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isFile()) {
        if (entry.name.endsWith(".jsonl")) results.push(full);
        continue;
      }
      if (entry.isDirectory() && depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };
  walk(path.resolve(root), 0);
  return results;
}

function dedupeMatches(files: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const file of files) {
    const key = realPath(file);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path.resolve(file));
  }
  return unique;
}

function lookupSessionMap(
  userHome: string,
  sessionsRoot: string,
  sessionId: string,
  expectedCwd: string,
): string | null {
  const mapFile = path.join(userHome, ".pi", "pi-acp", "session-map.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const sessions = root ? asRecord(root.sessions) : null;
  const entry = sessions ? asRecord(sessions[sessionId]) : null;
  if (!entry) return null;
  if (entry.sessionId !== sessionId) return null;
  if (
    typeof entry.cwd !== "string" ||
    !path.isAbsolute(entry.cwd) ||
    !samePath(entry.cwd, expectedCwd)
  ) {
    return null;
  }
  if (typeof entry.sessionFile !== "string" || !path.isAbsolute(entry.sessionFile)) {
    return null;
  }
  const candidate = path.resolve(entry.sessionFile);
  if (!isInsideRoot(candidate, sessionsRoot)) return null;
  if (!validatePiTranscriptHeader(candidate, sessionId, expectedCwd).ok) return null;
  return candidate;
}

/**
 * Reliably locates the single Pi transcript file for `(sessionsRoot, sessionId, expectedCwd)`.
 * Immune to concurrent `session-map.json` races because it scans `$PI_CODING_AGENT_DIR/sessions`
 * directly by session id and validates every candidate's session header.
 */
export function resolvePiTranscriptFile(
  sessionsRoot: string,
  sessionId: string,
  expectedCwd: string,
  pinnedFile: string | null = null,
  userHome: string | null = null,
): PiTranscriptResolution {
  if (!sessionId || path.basename(sessionId) !== sessionId) {
    return { status: "missing", reason: "Pi 会话 ID 无效，无法定位 transcript" };
  }
  if (pinnedFile) {
    const resolvedPinned = path.resolve(pinnedFile);
    if (!existsNonEmptyFile(resolvedPinned)) {
      return {
        status: "missing",
        reason: "已记录的 Pi transcript 文件不存在或为空",
      };
    }
    const check = validatePiTranscriptHeader(resolvedPinned, sessionId, expectedCwd);
    if (!check.ok) {
      return { status: "invalid", file: resolvedPinned, reason: check.reason };
    }
    // A pinned file is not proof of uniqueness: a duplicate copy can appear after the run
    // pinned its path. Re-scan before reporting a confirmed transcript.
    const duplicates = collectJsonlFiles(sessionsRoot, 2).filter(
      (file) =>
        realPath(file) !== realPath(resolvedPinned) &&
        validatePiTranscriptHeader(file, sessionId, expectedCwd).ok,
    );
    if (duplicates.length > 0) {
      return {
        status: "ambiguous",
        files: dedupeMatches([resolvedPinned, ...duplicates]),
        reason: "找到多个匹配的 Pi transcript 文件，无法唯一确认路径",
      };
    }
    return { status: "ok", file: resolvedPinned };
  }

  const allJsonl = collectJsonlFiles(sessionsRoot, 2);
  const suffix = `_${sessionId}.jsonl`;
  const exact = `${sessionId}.jsonl`;
  const nameCandidates = allJsonl.filter((file) => {
    const base = path.basename(file);
    return base.endsWith(suffix) || base === exact;
  });
  const namedMatches = dedupeMatches(
    nameCandidates.filter(
      (file) => validatePiTranscriptHeader(file, sessionId, expectedCwd).ok,
    ),
  );
  if (namedMatches.length === 1) {
    return { status: "ok", file: namedMatches[0]! };
  }
  if (namedMatches.length > 1) {
    return {
      status: "ambiguous",
      files: namedMatches,
      reason: "找到多个匹配的 Pi transcript 文件，无法唯一确认路径",
    };
  }

  if (userHome) {
    const mapped = lookupSessionMap(userHome, sessionsRoot, sessionId, expectedCwd);
    if (mapped) return { status: "ok", file: mapped };
  }

  // Fallback header scan for non-standard filenames under the same sessionsRoot.
  const headerMatches = dedupeMatches(
    allJsonl.filter(
      (file) => validatePiTranscriptHeader(file, sessionId, expectedCwd).ok,
    ),
  );
  if (headerMatches.length === 1) {
    return { status: "ok", file: headerMatches[0]! };
  }
  if (headerMatches.length > 1) {
    return {
      status: "ambiguous",
      files: headerMatches,
      reason: "找到多个匹配的 Pi transcript 文件，无法唯一确认路径",
    };
  }
  return {
    status: "missing",
    reason: "找不到可核实的 Pi transcript 文件，无法确认本轮状态与 usage",
  };
}

type TranscriptCheck = {
  ok: boolean;
  finalText: string | null;
  usage: WorkerUsage | null;
  error: string | null;
  errorCode: string | null;
};

/**
 * Audits the slice appended to a Pi transcript starting at `offset` to confirm:
 * 1. A user message for this turn was written.
 * 2. Every assistant message's usage is summed once.
 * 3. The final assistant message settled with `stopReason === "stop"` (catching swallowed
 *    model errors where `pi-acp` still returned `stopReason: "end_turn"`) and was not
 *    removed by a trailing `context_edit`.
 */
function auditPiTranscriptTurn(
  file: string,
  offset: number,
  expectedSessionId: string,
  expectedCwd: string,
  priorFailed: boolean,
  headerValidated = false,
): TranscriptCheck {
  if (!headerValidated) {
    const headerCheck = validatePiTranscriptHeader(file, expectedSessionId, expectedCwd);
    if (!headerCheck.ok) {
      return {
        ok: false,
        finalText: null,
        usage: null,
        error: headerCheck.reason,
        errorCode: "PI_TRANSCRIPT_UNCONFIRMED",
      };
    }
  }
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return {
      ok: false,
      finalText: null,
      usage: null,
      error: "无法读取 Pi transcript 文件",
      errorCode: "PI_TRANSCRIPT_UNCONFIRMED",
    };
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || buffer.length < offset) {
    return {
      ok: false,
      finalText: null,
      usage: null,
      error: "Pi transcript 偏移无效或文件已被截断，无法可靠核对本轮状态",
      errorCode: "PI_TRANSCRIPT_UNCONFIRMED",
    };
  }

  const slice = buffer.subarray(offset).toString("utf8");
  const buckets = emptyBuckets();
  let userMessageSeen = false;
  let malformedError: string | null = null;
  const assistantEntries: Array<{
    id: string | null;
    message: Record<string, unknown>;
    removed: boolean;
  }> = [];

  const rawLines = slice.split("\n");
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]!;
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (malformedError === null) {
        malformedError = `Pi transcript 包含无效 JSON 行 (slice line ${index + 1})`;
      }
      continue;
    }
    const entry = asRecord(parsed);
    if (!entry || typeof entry.type !== "string") {
      if (malformedError === null) {
        malformedError = `Pi transcript 包含无效记录 (slice line ${index + 1})`;
      }
      continue;
    }
    if (entry.type === "context_edit") {
      if (entry.replacement === null && typeof entry.targetId === "string") {
        for (const item of assistantEntries) {
          if (item.id === entry.targetId) item.removed = true;
        }
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message) continue;
    if (message.role === "user") {
      userMessageSeen = true;
      continue;
    }
    if (message.role !== "assistant") continue;
    addPiUsage(buckets, message.usage);
    assistantEntries.push({
      id: typeof entry.id === "string" ? entry.id : null,
      message,
      removed: false,
    });
  }

  let error: string | null = null;
  let errorCode: string | null = null;
  let finalText: string | null = null;

  if (malformedError !== null) {
    error = malformedError;
    errorCode = "PI_TRANSCRIPT_UNCONFIRMED";
  } else if (!userMessageSeen) {
    error = "Pi transcript 缺少本轮用户消息记录，无法确认本轮状态";
    errorCode = "PI_TRANSCRIPT_UNCONFIRMED";
  } else if (assistantEntries.length === 0) {
    error = "Pi transcript 缺少本轮 assistant 消息，无法确认执行结果";
    errorCode = "PI_TRANSCRIPT_UNCONFIRMED";
  } else {
    const last = assistantEntries[assistantEntries.length - 1]!;
    if (last.message.stopReason !== "stop") {
      error =
        typeof last.message.errorMessage === "string" && last.message.errorMessage.trim()
          ? last.message.errorMessage.trim()
          : `Pi assistant 未完成: ${String(last.message.stopReason)}`;
      errorCode = "NATIVE_FAILED";
    } else if (last.removed) {
      error = "Pi transcript 中本轮最终 assistant 消息已被移除，无法确认执行结果";
      errorCode = "PI_TRANSCRIPT_UNCONFIRMED";
    } else if (!Array.isArray(last.message.content)) {
      error = "Pi transcript assistant 内容无效";
      errorCode = "PI_TRANSCRIPT_UNCONFIRMED";
    } else {
      const blocks: string[] = [];
      let invalid = false;
      for (const item of last.message.content as unknown[]) {
        const block = asRecord(item);
        if (!block) {
          invalid = true;
          break;
        }
        if (block.type !== "text") continue;
        if (typeof block.text !== "string") {
          invalid = true;
          break;
        }
        blocks.push(block.text);
      }
      if (invalid) {
        error = "Pi transcript assistant 文本块无效";
        errorCode = "PI_TRANSCRIPT_UNCONFIRMED";
      } else {
        finalText = blocks.join("\n");
      }
    }
  }

  const ok = error === null;
  return {
    ok,
    finalText,
    usage: toUsage(buckets, priorFailed || !ok),
    error,
    errorCode,
  };
}

/** Recovers a historical ACP run with both its event log and the original transcript. */
export function parseHistoricalPiAcp(
  eventsFile: string,
  expectedSessionId: string | null,
  expectedCwd: string,
  context: HistoricalPiAcpContext,
): NativeExecution {
  const acp = parseAcpEvents(readEventLines(eventsFile), expectedSessionId, expectedCwd, {
    expectedAction: context.expectedAction,
  });
  let error = acp.error;
  let errorCode = acp.errorCode;
  let finalText: string | null = null;
  let usage: WorkerUsage | null = null;
  let resolvedFile: string | null = context.sessionFile;

  const fail = (message: string, code: string): void => {
    if (error === null) {
      error = message;
      errorCode = code;
    }
  };

  if (acp.validatedSessionId && !acp.identityMismatch) {
    const pinned = context.sessionFile;
    const resolution = resolvePiTranscriptFile(
      context.sessionsRoot,
      acp.validatedSessionId,
      expectedCwd,
      pinned,
      context.userHome ?? null,
    );
    if (resolution.status !== "ok") {
      fail(resolution.reason, "PI_TRANSCRIPT_UNCONFIRMED");
    } else {
      resolvedFile = resolution.file;
      if (acp.action === "resume" && context.transcriptOffset === null) {
        fail(
          "缺少 Pi transcript 起始偏移，无法可靠核对本轮状态与 usage",
          "PI_TRANSCRIPT_UNCONFIRMED",
        );
      } else {
        const offset = context.transcriptOffset ?? 0;
        const audit = auditPiTranscriptTurn(
          resolution.file,
          offset,
          acp.validatedSessionId,
          expectedCwd,
          error !== null,
          true,
        );
        usage = audit.usage;
        if (audit.ok) {
          finalText = audit.finalText;
        } else if (audit.error) {
          fail(audit.error, audit.errorCode ?? "PI_TRANSCRIPT_UNCONFIRMED");
        }
      }
    }
  } else if (acp.identityMismatch) {
    resolvedFile = null;
  }

  return {
    success: error === null,
    nativeSessionId: acp.validatedSessionId,
    nativeSessionFile: acp.validatedSessionId ? resolvedFile : null,
    finalText,
    usage,
    error,
    errorCode: error === null ? null : errorCode,
  };
}
