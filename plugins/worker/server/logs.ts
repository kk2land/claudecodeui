import fs from "node:fs";
import path from "node:path";
import type { StreamName, WorkerLogPage } from "./shared/index.js";

const MAX_BYTES = 24 * 1024 * 1024;
const PAGE_BYTES = 64 * 1024;

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
 * Reads one UTF-8-safe page from a run log. Cursors are byte offsets, so a caller can page
 * incrementally while the run is still writing.
 */
export function readLogPage(
  directory: string,
  stream: StreamName,
  cursor: string | undefined,
  limit: number | undefined,
  done: boolean,
): WorkerLogPage {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0)
    throw Object.assign(new Error("无效日志游标"), { code: "INVALID_CURSOR" });
  const size = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(PAGE_BYTES * 4, limit!))
    : PAGE_BYTES;
  const file = path.join(directory, stream + ".log");
  if (!fs.existsSync(file))
    return { text: "", nextCursor: done ? null : "0", done };
  const descriptor = fs.openSync(file, "r");
  try {
    const length = fs.fstatSync(descriptor).size;
    const from = Math.min(start, length);
    // Read a small lookahead so a limit that lands inside a multibyte character can still
    // include that complete character and advance the cursor.
    const buffer = Buffer.alloc(Math.min(size + 4, length - from));
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, from);
    let end = Math.min(count, size);
    // If the page boundary splits a UTF-8 sequence, extend to the end of that character.
    while (end < count && (buffer[end]! & 0xc0) === 0x80) end++;
    const text = buffer.subarray(0, end).toString("utf8");
    const next = from + end;
    return {
      text,
      nextCursor: done && next >= length ? null : String(next),
      done: done && next >= length,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}
