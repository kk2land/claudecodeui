import fs from "node:fs";
import path from "node:path";
import type { StreamName, WorkerLogPage } from "./shared/index.js";

const MAX_BYTES = 24 * 1024 * 1024;
const PAGE_BYTES = 64 * 1024;
const TAIL_BYTES = 4 * 1024;

/** Reads a JSON event log with line numbers, retaining malformed entries for validation. */
export function readEventLines(file: string): Array<{ value: unknown; number: number }> {
  const output: Array<{ value: unknown; number: number }> = [];
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

/** Appends raw output to a bounded run log; a marker records the first truncation. */
export function appendLog(
  directory: string,
  stream: StreamName,
  chunk: Buffer,
): void {
  const file = path.join(directory, stream + ".log");
  const current = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (current < MAX_BYTES)
    fs.appendFileSync(file, chunk.subarray(0, MAX_BYTES - current), {
      mode: 0o600,
    });
  const marker = path.join(directory, stream + ".truncated");
  if (current + chunk.length > MAX_BYTES && !fs.existsSync(marker))
    fs.writeFileSync(marker, "", { mode: 0o600 });
}

/**
 * One log read. `cursor` reads forward from that byte offset, `before` reads the window that ends
 * exactly at it, and `tail` reads the window at the end of the log when no cursor is given.
 */
export type LogRead = {
  cursor?: string;
  before?: string;
  limit?: number;
  /** The run reached terminal EOF, so a page that also reached the end reports `done`. */
  done: boolean;
  tail?: boolean;
};

function parseOffset(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw Object.assign(new Error("无效日志游标"), { code: "INVALID_CURSOR" });
  return parsed;
}

/**
 * Reads one UTF-8-safe page from a run log. Cursors are byte offsets, so a caller can page
 * incrementally in either direction while the run is still writing. `before` pages backwards:
 * the page ends exactly at the requested offset and `prevCursor` is where its text starts, so
 * consecutive pages join in order without a gap or a repeated byte. Without a cursor, `tail`
 * starts at the last bounded window (4 KiB by default) instead of the beginning, skipping any
 * leading partial character because no earlier page will be joined to it.
 */
export function readLogPage(
  directory: string,
  stream: StreamName,
  read: LogRead,
): WorkerLogPage {
  const start = parseOffset(read.cursor);
  const stop = parseOffset(read.before);
  const tail = read.tail === true && start === null && stop === null;
  const size = Number.isSafeInteger(read.limit)
    ? Math.max(1, Math.min(PAGE_BYTES * 4, read.limit!))
    : stop !== null || tail
      ? TAIL_BYTES
      : PAGE_BYTES;
  const file = path.join(directory, stream + ".log");
  if (!fs.existsSync(file))
    return {
      text: "",
      prevCursor: null,
      nextCursor: read.done ? null : "0",
      done: read.done,
    };
  const descriptor = fs.openSync(file, "r");
  try {
    const length = fs.fstatSync(descriptor).size;
    // A backward page ends at its own boundary and a tail page at the log end; both read the
    // window in front of that end. A forward page starts at its cursor and reads ahead.
    const boundary = stop !== null ? Math.min(stop, length) : tail ? length : null;
    const from =
      boundary === null ? Math.min(start ?? 0, length) : Math.max(0, boundary - size);
    // Read a few bytes before a backward window so a character split by the window start is
    // still complete here instead of being cut into this page's seam with the previous one.
    const readFrom = stop !== null ? Math.max(0, from - 3) : from;
    const to = boundary === null ? Math.min(length, from + size) : boundary;
    // Read a small lookahead so a limit that lands inside a multibyte character can still
    // include that complete character and advance the cursor.
    const buffer = Buffer.alloc(Math.min(size + 8, length - readFrom));
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, readFrom);
    let begin = from - readFrom;
    if (stop !== null) {
      // A backward page starts at the character that contains its window start.
      while (begin > 0 && (buffer[begin]! & 0xc0) === 0x80) begin--;
    } else {
      // A tail window can start inside a character; drop its continuation bytes.
      while (begin < count && (buffer[begin]! & 0xc0) === 0x80) begin++;
    }
    let end = Math.min(count, to - readFrom);
    // If the page boundary splits a UTF-8 sequence, extend to the end of that character.
    while (end < count && (buffer[end]! & 0xc0) === 0x80) end++;
    const text = buffer.subarray(begin, end).toString("utf8");
    const next = readFrom + end;
    const first = readFrom + begin;
    return {
      text,
      prevCursor: first > 0 ? String(first) : null,
      nextCursor: read.done && next >= length ? null : String(next),
      done: read.done && next >= length,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}
