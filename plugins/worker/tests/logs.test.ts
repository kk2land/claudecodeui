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
