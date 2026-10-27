import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SchedulerTokenUsage } from "../shared/contracts.js";

/**
 * Internal run directory for per-invocation usage sidecars. It is set by the worker after task
 * environment overrides, so a task can never redirect the scheduler's accounting.
 */
export const USAGE_DIRECTORY_ENV = "CLOUDCLI_SCHEDULER_USAGE_DIR";
/** One sidecar never needs to be large; a bigger file is damaged or not ours. */
const MAX_SIDECAR_BYTES = 64 * 1024;
const METRICS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

/**
 * A provider token counter is usable only when it is a finite, non-negative safe integer.
 * Anything else (strings, fractions, negative values, Infinity) is treated as unreported
 * instead of being coerced into a misleading number.
 */
export function tokenCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}
function add(left: number | null, right: number | null): number | null {
  if (right === null) return left;
  if (left === null) return right;
  // Saturate rather than cross into an unsafe integer; real runs never reach this bound.
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
/** Sum the metrics that are actually reported by both sides; unknown stays unknown. */
export function sumUsage(
  left: SchedulerTokenUsage | null | undefined,
  right: SchedulerTokenUsage | null | undefined,
): SchedulerTokenUsage | null {
  if (!left && !right) return null;
  const total = {} as SchedulerTokenUsage;
  for (const metric of METRICS)
    total[metric] = add(left?.[metric] ?? null, right?.[metric] ?? null);
  return METRICS.some((metric) => total[metric] !== null) ? total : null;
}
/** True when two snapshots carry identical reported metrics. */
export function sameUsage(
  left: SchedulerTokenUsage | null | undefined,
  right: SchedulerTokenUsage | null | undefined,
): boolean {
  return METRICS.every(
    (metric) => (left?.[metric] ?? null) === (right?.[metric] ?? null),
  );
}
/**
 * Accepts only metrics that pass `tokenCount`; unknown fields become null. Used for both sidecar
 * files and worker IPC so a malformed or foreign value can never enter a persisted run record.
 */
export function normalizeUsage(value: unknown): SchedulerTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const usage = {} as SchedulerTokenUsage;
  for (const metric of METRICS) usage[metric] = tokenCount(source[metric]);
  return METRICS.some((metric) => usage[metric] !== null) ? usage : null;
}

/**
 * Normalizes one provider stream into this invocation's totals. Codex reports one
 * `turn.completed.usage` per turn; DSH reports each finished step on `status/step_end`.
 * Terminal/summary events (`final`) are deliberately ignored so their cumulative figures are
 * not added on top of the already counted steps.
 */
export class UsageAccumulator {
  private readonly totals = {} as SchedulerTokenUsage;
  private readonly seen = new Set<string>();
  private anonymousSteps = 0;
  constructor() {
    for (const metric of METRICS) this.totals[metric] = null;
  }
  /** Codex `turn.completed.usage`; cached_input_tokens is a cache-read subset of input. */
  codex(event: Record<string, unknown>): boolean {
    if (event.type !== "turn.completed") return false;
    const raw = event.usage;
    if (!raw || typeof raw !== "object") return false;
    const source = raw as Record<string, unknown>;
    // A turn id makes a duplicate delivery idempotent; turns without an id are distinct turns.
    const id =
      typeof event.turn_id === "string"
        ? event.turn_id
        : typeof event.turnId === "string"
          ? event.turnId
          : undefined;
    if (id) {
      const key = "turn:" + id;
      if (this.seen.has(key)) return false;
      this.seen.add(key);
    }
    return this.merge({
      inputTokens: tokenCount(source.input_tokens),
      outputTokens: tokenCount(source.output_tokens),
      cacheReadTokens: tokenCount(source.cached_input_tokens),
      // Codex does not report cache writes; leaving null keeps "unknown" distinct from zero.
      cacheWriteTokens: null,
    });
  }
  /** DSH `status/step_end.usage`; inputTokens excludes cache read/write, which are separate. */
  dsh(event: Record<string, unknown>): boolean {
    if (event.type !== "status" || event.phase !== "step_end") return false;
    const raw = event.usage;
    if (!raw || typeof raw !== "object") return false;
    const source = raw as Record<string, unknown>;
    const turn =
      event.turnId ?? event.turn_id ?? event.turn ?? event.sessionId ?? "";
    const step =
      event.stepId ??
      event.step_id ??
      event.step ??
      event.id ??
      // Unidentified steps are still distinct reported steps; the ordinal keeps them unique.
      "anonymous-" + this.anonymousSteps++;
    const key = "step:" + String(turn) + ":" + String(step);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return this.merge({
      inputTokens: tokenCount(source.inputTokens ?? source.input_tokens),
      outputTokens: tokenCount(source.outputTokens ?? source.output_tokens),
      cacheReadTokens: tokenCount(
        source.cacheReadTokens ?? source.cache_read_tokens,
      ),
      cacheWriteTokens: tokenCount(
        source.cacheWriteTokens ?? source.cache_write_tokens,
      ),
    });
  }
  private merge(next: SchedulerTokenUsage): boolean {
    if (METRICS.every((metric) => next[metric] === null)) return false;
    for (const metric of METRICS)
      this.totals[metric] = add(this.totals[metric], next[metric]);
    return true;
  }
  /** Null until at least one metric was reported, so an agent without usage shows as unknown. */
  get usage(): SchedulerTokenUsage | null {
    return METRICS.some((metric) => this.totals[metric] !== null)
      ? { ...this.totals }
      : null;
  }
}

/**
 * A sidecar per invocation keeps concurrent `AGENT_EXEC` calls from losing updates: each process
 * writes only its own snapshot via rename, and the scheduler sums immutable files. A crash can
 * therefore under-report an unfinished invocation but can never double-count or corrupt another.
 */
export class UsageSidecar {
  private readonly file: string;
  constructor(directory: string, readonly id = randomUUID()) {
    this.file = path.join(directory, id + ".json");
  }
  write(usage: SchedulerTokenUsage | null): void {
    if (!usage) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(usage), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
/** Sidecar directory for a run; also the value exported to workers and their AGENT_EXEC calls. */
export function usageDirectory(runDirectory: string): string {
  return path.join(runDirectory, "usage");
}
/**
 * Sums every valid sidecar in a run's usage directory. Missing or damaged files are ignored,
 * so the run keeps whatever usage was actually observed. Null means no invocation reported any.
 */
export function readUsageDirectory(directory: string): SchedulerTokenUsage | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  let total: SchedulerTokenUsage | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    try {
      if (fs.statSync(file).size > MAX_SIDECAR_BYTES) continue;
      const parsed = normalizeUsage(JSON.parse(fs.readFileSync(file, "utf8")));
      total = sumUsage(total, parsed);
    } catch {
      /* a partially written or foreign file never fails the run */
    }
  }
  return total;
}
