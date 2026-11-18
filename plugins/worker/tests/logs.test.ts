import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { appendLog, readLogPage } from "../server/logs.js";
import { temporaryRoot } from "./helpers.js";

test("small log pages always advance across multibyte UTF-8", () => {
  const directory = temporaryRoot("worker-logs-");
  const text = "a中文😀z末";
  appendLog(directory, "events", Buffer.from(text));
  let cursor: string | undefined;
  let collected = "";
  let pages = 0;
  for (;;) {
    const page = readLogPage(directory, "events", cursor, 1, true);
    assert.ok(page.text.length > 0, "each accepted page must advance");
    collected += page.text;
    pages++;
    if (page.done) {
      assert.equal(page.nextCursor, null);
      break;
    }
    assert.notEqual(page.nextCursor, cursor);
    cursor = page.nextCursor ?? undefined;
    assert.ok(pages < 100);
  }
  assert.equal(collected, text);
});

test("terminal empty log reports a null cursor", () => {
  const directory = temporaryRoot("worker-logs-empty-");
  fs.mkdirSync(directory, { recursive: true });
  const page = readLogPage(directory, "stderr", undefined, 10, true);
  assert.deepEqual(page, { text: "", nextCursor: null, done: true });
  assert.equal(path.basename(directory).startsWith("worker-logs-"), true);
});

test("tail defaults to the last 4 KiB and its cursor reads newly appended output", () => {
  const directory = temporaryRoot("worker-logs-tail-");
  appendLog(directory, "events", Buffer.from("x".repeat(5000) + "末尾"));
  const page = readLogPage(directory, "events", undefined, undefined, false, true);
  assert.equal(Buffer.byteLength(page.text), 4096);
  assert.ok(page.text.endsWith("末尾"));
  assert.equal(page.nextCursor, "5006");
  appendLog(directory, "events", Buffer.from("新增"));
  const rest = readLogPage(directory, "events", page.nextCursor!, 4096, false, true);
  assert.equal(rest.text, "新增");
  assert.equal(rest.nextCursor, "5012");
});

test("a tail window that starts inside a multibyte character skips continuation bytes", () => {
  const directory = temporaryRoot("worker-logs-tail-utf8-");
  appendLog(directory, "events", Buffer.from("头".repeat(4) + "尾"));
  // A 14-byte window starts at byte 1 of the 15-byte log, inside the first 头.
  const page = readLogPage(directory, "events", undefined, 14, false, true);
  assert.ok(page.text.startsWith("头"));
  assert.doesNotMatch(page.text, /\uFFFD/);
  assert.ok(Buffer.byteLength(page.text) <= 14);
  assert.equal(page.nextCursor, "15");
});
