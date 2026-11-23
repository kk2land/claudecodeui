import assert from "node:assert/strict";
import test from "node:test";
import {
  changeTaskType,
  effectiveAgentProvider,
  parseConfigDocument,
  type ConfigTask,
} from "../client/configurationDraft.js";

/**
 * Type changes are the one place the editor must rewrite an agent: a prompt needs Codex because
 * the host only gives Codex prompt tasks a native session, while a script may keep DSH for its
 * own AGENT_EXEC. These tests pin the narrow conversion and the fields it must leave alone.
 */

const DEFAULTS_DSH = { agent: { provider: "dsh", model: "gateway/default", effort: "high" } };

function document(tasks: ConfigTask[], defaults: unknown = DEFAULTS_DSH): string {
  return JSON.stringify({ version: 1, defaults, tasks }, null, 2);
}
function tasksOf(text: string): ConfigTask[] {
  const parsed = parseConfigDocument(text);
  assert.equal(parsed.ok, true);
  return parsed.ok ? parsed.document.tasks : [];
}

test("effectiveAgentProvider prefers the task value and falls back to the project default", () => {
  assert.equal(
    effectiveAgentProvider({ agent: { provider: "codex" } }, "dsh"),
    "codex",
  );
  assert.equal(effectiveAgentProvider({}, "dsh"), "dsh");
  assert.equal(effectiveAgentProvider({ agent: { provider: "dsh" } }, undefined), "dsh");
  assert.equal(effectiveAgentProvider({}), "codex");
});

test("script to prompt converts an inherited DSH agent without touching other tasks", () => {
  const tasks: ConfigTask[] = [
    { id: "script", type: "script", cron: "0 0 9 * * *", command: "bash" },
    {
      id: "explicit",
      type: "script",
      cron: "0 0 9 * * *",
      command: "bash",
      agent: { provider: "dsh", model: "gateway/other", effort: "high", extra: "keep" },
      unknownTaskField: { keep: true },
    },
    { id: "prompt", type: "prompt", cron: "0 0 9 * * *", prompt: "unchanged" },
  ];
  const converted = changeTaskType(document(tasks), 0, "prompt", "dsh");
  assert.equal("error" in converted, false);
  if ("error" in converted) return;
  assert.equal(converted.converted, true);
  const [first, second] = tasksOf(converted.text);
  assert.deepEqual(first, { ...tasks[0], type: "prompt", agent: { provider: "codex" } });
  assert.deepEqual(second, tasks[1]);
  assert.deepEqual(tasksOf(converted.text)[2], tasks[2]);
  assert.deepEqual(
    (JSON.parse(converted.text) as { defaults: unknown }).defaults,
    DEFAULTS_DSH,
  );

  const explicit = changeTaskType(converted.text, 1, "prompt", "dsh");
  assert.equal("error" in explicit, false);
  if ("error" in explicit) return;
  assert.equal(explicit.converted, true);
  const convertedExplicit = tasksOf(explicit.text)[1]!;
  // Only the DSH-only model/effort are removed; unknown agent and task fields survive.
  assert.deepEqual(convertedExplicit.agent, { provider: "codex", extra: "keep" });
  assert.deepEqual(convertedExplicit.unknownTaskField, { keep: true });
  assert.deepEqual(
    (JSON.parse(explicit.text) as { defaults: unknown }).defaults,
    DEFAULTS_DSH,
  );
});

test("Codex tasks and prompt to script keep their agent untouched", () => {
  const tasks: ConfigTask[] = [
    {
      id: "codex",
      type: "script",
      cron: "0 0 9 * * *",
      command: "bash",
      agent: { provider: "codex", model: "gpt-6-sol", effort: "high" },
    },
    {
      id: "prompt",
      type: "prompt",
      cron: "0 0 9 * * *",
      prompt: "legacy",
      reuseSession: true,
      agent: { provider: "dsh", model: "gateway/other", effort: "high" },
    },
  ];
  const toPrompt = changeTaskType(document(tasks), 0, "prompt", "dsh");
  assert.equal("error" in toPrompt, false);
  if ("error" in toPrompt) return;
  assert.equal(toPrompt.converted, false);
  assert.deepEqual(tasksOf(toPrompt.text)[0]!.agent, tasks[0]!.agent);

  // A script may still call DSH through AGENT_EXEC, so the reverse switch preserves it.
  const toScript = changeTaskType(document(tasks), 1, "script", "codex");
  assert.equal("error" in toScript, false);
  if ("error" in toScript) return;
  assert.equal(toScript.converted, false);
  const script = tasksOf(toScript.text)[1]!;
  assert.deepEqual(script.agent, tasks[1]!.agent);
  assert.equal(script.reuseSession, undefined);
});

test("invalid drafts and missing task indexes report an error instead of rewriting", () => {
  const invalid = changeTaskType("{", 0, "prompt", "dsh");
  assert.equal("error" in invalid, true);
  if ("error" in invalid) assert.match(invalid.error, /JSON 语法错误/);
  const missing = changeTaskType(document([]), 3, "prompt", "dsh");
  assert.equal("error" in missing, true);
  if ("error" in missing) assert.match(missing.error, /任务不存在/);
});
