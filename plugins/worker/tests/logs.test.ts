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
    const page: ReturnType<typeof readLogPage> = readLogPage(
      directory,
      "events",
      { cursor, limit: 1, done: true },
    );
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

test("terminal empty log reports null cursors", () => {
  const directory = temporaryRoot("worker-logs-empty-");
  fs.mkdirSync(directory, { recursive: true });
  const page = readLogPage(directory, "stderr", { limit: 10, done: true });
  assert.deepEqual(page, {
    text: "",
    prevCursor: null,
    nextCursor: null,
    done: true,
  });
  assert.equal(path.basename(directory).startsWith("worker-logs-"), true);
});

test("tail defaults to the last 4 KiB and its cursor reads newly appended output", () => {
  const directory = temporaryRoot("worker-logs-tail-");
  appendLog(directory, "events", Buffer.from("x".repeat(5000) + "末尾"));
  const page = readLogPage(directory, "events", { done: false, tail: true });
  assert.equal(Buffer.byteLength(page.text), 4096);
  assert.ok(page.text.endsWith("末尾"));
  assert.equal(page.nextCursor, "5006");
  appendLog(directory, "events", Buffer.from("新增"));
  const rest = readLogPage(directory, "events", {
    cursor: page.nextCursor!,
    limit: 4096,
    done: false,
    tail: true,
  });
  assert.equal(rest.text, "新增");
  assert.equal(rest.nextCursor, "5012");
});

test("a tail window that starts inside a multibyte character skips continuation bytes", () => {
  const directory = temporaryRoot("worker-logs-tail-utf8-");
  appendLog(directory, "events", Buffer.from("头".repeat(4) + "尾"));
  // A 14-byte window starts at byte 1 of the 15-byte log, inside the first 头.
  const page = readLogPage(directory, "events", {
    limit: 14,
    done: false,
    tail: true,
  });
  assert.ok(page.text.startsWith("头"));
  assert.doesNotMatch(page.text, /\uFFFD/);
  assert.ok(Buffer.byteLength(page.text) <= 14);
  assert.equal(page.nextCursor, "15");
});

test("before pages join the tail window backwards in log order", () => {
  const directory = temporaryRoot("worker-logs-before-");
  const lines = Array.from({ length: 40 }, (_, index) => `{"i":${index}}`);
  appendLog(directory, "events", Buffer.from(lines.join("\n") + "\n"));
  const tail = readLogPage(directory, "events", {
    limit: 64,
    done: true,
    tail: true,
  });
  assert.ok(tail.prevCursor, "a tail window that is not the whole log has a start");
  let collected = tail.text;
  let before: string | null = tail.prevCursor;
  let pages = 1;
  while (before !== null) {
    const page: ReturnType<typeof readLogPage> = readLogPage(directory, "events", {
      before,
      limit: 64,
      done: true,
    });
    collected = page.text + collected;
    before = page.prevCursor;
    pages++;
    assert.ok(pages < 100);
  }
  assert.equal(collected, lines.join("\n") + "\n");
});

test("a backward page starts at a complete character even across a page seam", () => {
  const directory = temporaryRoot("worker-logs-before-utf8-");
  appendLog(directory, "events", Buffer.from("中".repeat(10)));
  const tail = readLogPage(directory, "events", {
    limit: 7,
    done: true,
    tail: true,
  });
  const page = readLogPage(directory, "events", {
    before: tail.prevCursor!,
    limit: 7,
    done: true,
  });
  // Every page decodes cleanly on its own, so joining them cannot produce a replacement char.
  assert.doesNotMatch(tail.text + page.text, /\uFFFD/);
  assert.ok((tail.text + page.text).startsWith("中"));
});

test("an explicit cursor wins over tail", () => {
  const directory = temporaryRoot("worker-logs-wins-");
  appendLog(directory, "events", Buffer.from("abcdefghij"));
  const page = readLogPage(directory, "events", {
    cursor: "0",
    limit: 4,
    done: false,
    tail: true,
  });
  assert.equal(page.text, "abcd");
  assert.equal(page.prevCursor, null);
});
