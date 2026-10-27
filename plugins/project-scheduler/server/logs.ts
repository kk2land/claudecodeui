import fs from "node:fs";
import path from "node:path";
import type { SchedulerLog } from "../shared/contracts.js";

const LIMIT = 16 * 1024 * 1024;
/** Used by workers and the scheduler to keep log writes bounded while continuing to drain pipes. */
export function appendLog(
  directory: string,
  stream: "stdout" | "stderr" | "events",
  chunk: Buffer,
): void {
  const file = path.join(directory, stream + ".log");
  const current = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (current < LIMIT)
    fs.appendFileSync(file, chunk.subarray(0, LIMIT - current), {
      mode: 0o600,
    });
  const marker = path.join(directory, stream + ".truncated");
  if (current + chunk.length > LIMIT && !fs.existsSync(marker))
    fs.writeFileSync(marker, "", { mode: 0o600 });
}

/** Used by HTTP logs endpoint; cursors never split a UTF-8 character or load an entire file into memory. */
export function readLog(
  directory: string,
  stream: string,
  offset: number,
): SchedulerLog {
  if (!["stdout", "stderr", "events"].includes(stream))
    throw new Error("无效日志流");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("无效日志偏移");
  const file = path.join(directory, stream + ".log");
  if (!fs.existsSync(directory))
    return {
      text: "",
      offset,
      hasMore: false,
      expired: true,
      truncated: false,
    };
  if (!fs.existsSync(file))
    return {
      text: "",
      offset: 0,
      hasMore: false,
      expired: false,
      truncated: false,
    };
  const descriptor = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const start = Math.min(offset, size);
    const buffer = Buffer.alloc(Math.min(65536, size - start));
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let end = count;
    if (end) {
      let lead = end - 1;
      while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
      if (lead >= 0) {
        const value = buffer[lead]!;
        const width =
          value < 0x80 ? 1 : value < 0xe0 ? 2 : value < 0xf0 ? 3 : 4;
        if (end - lead < width) end = lead;
      }
    }
    const truncated = fs.existsSync(
      path.join(directory, stream + ".truncated"),
    );
    const consumed = truncated && start + count >= size ? count : end;
    return {
      text: buffer.subarray(0, end).toString("utf8"),
      offset: start + consumed,
      hasMore: start + consumed < size,
      expired: false,
      truncated,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}
