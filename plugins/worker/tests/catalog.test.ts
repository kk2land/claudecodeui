import assert from "node:assert/strict";
import test from "node:test";
import {
  AGY_NO_FALLBACK_LABEL,
  agyFallbackModelOptions,
  agyModelOptions,
  codexModelOptions,
  effortOptionsFor,
  piModelOptions,
} from "../client/catalog.js";
import {
  agyEffortConflict,
  agyFixedModelEffort,
} from "../shared/agy.js";

const metadata = {
  DEFAULT: "gpt-6-astra",
  OPTIONS: [
    {
      value: "gpt-6-astra",
      label: "GPT-6 Astra",
      effort: { default: "high", values: [{ value: "high" }, { value: "max" }] },
    },
  ],
};

test("Codex service ids keep exact values while namespaced ids borrow host metadata", () => {
  const options = codexModelOptions(
    metadata,
    ["openai/gpt-6-astra", "unknown/model"],
    null,
    null,
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ["", "openai/gpt-6-astra", "unknown/model"],
  );
  assert.equal(options[1]!.label, "GPT-6 Astra");
  assert.deepEqual(options[1]!.effort, ["high", "max"]);
  assert.equal(options[2]!.label, "unknown/model");
  assert.deepEqual(options[2]!.effort, []);
});

test("an out-of-catalog stored Codex model stays selectable with its saved effort", () => {
  const options = codexModelOptions(metadata, [], "vendor/custom-model", "high");
  assert.deepEqual(options.at(-1), {
    value: "vendor/custom-model",
    label: "vendor/custom-model（当前已保存）",
    effort: ["high"],
  });
});

test("Pi's default model row offers the endpoint thinking levels", () => {
  const catalog = {
    models: [
      { provider: "anthropic", id: "sonnet", reasoning: true },
      { provider: "openrouter", id: "sonnet", reasoning: false },
    ],
    thinkingLevels: ["off", "low", "high"],
  };
  const options = piModelOptions(catalog, null, null);
  assert.deepEqual(options[0], {
    value: "",
    label: "使用默认值",
    effort: ["off", "low", "high"],
  });
  // Effort can be set with the default model and stays when the model remains null.
  assert.deepEqual(
    effortOptionsFor(options, null, null).map((option) => option.value),
    ["", "off", "low", "high"],
  );
  assert.deepEqual(
    effortOptionsFor(options, null, "high").map((option) => option.value),
    ["", "off", "low", "high"],
  );
});

test("Pi catalog failure keeps a saved default-model effort selectable", () => {
  const options = piModelOptions(null, null, "high");
  assert.deepEqual(options, [{ value: "", label: "使用默认值", effort: [] }]);
  const efforts = effortOptionsFor(options, null, "high");
  assert.deepEqual(
    efforts.map((option) => option.value),
    ["", "high"],
  );
  assert.equal(efforts[1]!.label, "high（当前已保存）");
});

test("agy rows persist native ids with model-owned effort and keep a saved id it lacks", () => {
  const catalog = {
    models: [
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
      { id: "custom/vendor-model", label: "Custom Vendor" },
    ],
  };
  const options = agyModelOptions(catalog, "gemini-3.8-flash-low");
  // A directory row outside the Gemini family is not offered as the config's preferred model;
  // a stored value from an older config still stays selectable below.
  assert.deepEqual(options, [
    { value: "", label: "默认（沿用执行器）", effort: [] },
    { value: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", effort: [] },
    { value: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", effort: [] },
  ]);
  // Every agy model owns its effort, so the editor exposes no selectable reasoning level.
  assert.deepEqual(
    effortOptionsFor(options, "gemini-3.8-flash-low", null).map(
      (option) => option.value,
    ),
    [""],
  );

  // The directory may be stale, so a stored id the CLI no longer lists stays selectable.
  const saved = agyModelOptions(catalog, "gemini-3.8-flash-medium");
  assert.deepEqual(saved.at(-1), {
    value: "gemini-3.8-flash-medium",
    label: "gemini-3.8-flash-medium（当前已保存）",
    effort: [],
  });
  // An unavailable catalog leaves only the runner default and the already stored id.
  assert.deepEqual(agyModelOptions(null, "custom/vendor-model"), [
    { value: "", label: "默认（沿用执行器）", effort: [] },
    {
      value: "custom/vendor-model",
      label: "custom/vendor-model（当前已保存）",
      effort: [],
    },
  ]);

  // The server-side compatibility check stays: explicit MCP effort is still validated.
  assert.equal(agyFixedModelEffort("gemini-4-neon-xhigh"), "xhigh");
  assert.equal(agyFixedModelEffort("gemini-3.8-flash-max"), null);
  assert.equal(agyEffortConflict("gemini-3.8-flash-low", "low"), null);
  assert.equal(agyEffortConflict("gemini-3.8-flash-low", null), null);
  assert.match(
    agyEffortConflict("gemini-3.8-flash-low", "high") ?? "",
    /gemini-3\.8-flash-low 固定使用 low reasoning/,
  );
  assert.equal(agyEffortConflict("custom/vendor-model", "high"), null);
});

test("agy model rows split into the Gemini select and the Claude-only fallback select", () => {
  const catalog = {
    models: [
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-pro-orchestrator-neon", label: "Gemini Pro Orchestrator" },
      { id: "claude-opus-4-1-high", label: "Claude Opus 4.1 (High)" },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "gpt-oss-120b-medium", label: "GPT OSS 120B (Medium)" },
      { id: "google/qwen3-coder-480b", label: "Qwen3 Coder 480B" },
    ],
  };
  // The preferred row holds the Gemini family only, so the Claude/GPT rows, Qwen, and the
  // runner default stay out even though Qwen shares the Gemini quota pool.
  assert.deepEqual(
    agyModelOptions(catalog, "gemini-4-neon-high").map((option) => option.value),
    ["", "gemini-4-neon-high", "gemini-pro-orchestrator-neon"],
  );
  assert.deepEqual(
    agyModelOptions(catalog, "google/qwen3-coder-480b").map((option) => option.value),
    ["", "gemini-4-neon-high", "gemini-pro-orchestrator-neon", "google/qwen3-coder-480b"],
  );
  // Neither row offers Qwen or GPT as a second model.
  assert.deepEqual(
    agyFallbackModelOptions(catalog, "qwen3-coder-480b").map((option) => option.value),
    ["", "claude-opus-4-1-high", "claude-sonnet-4-5", "qwen3-coder-480b"],
  );
  // GPT shares the Claude/GPT quota pool but is not offered as the second model.
  assert.deepEqual(
    agyFallbackModelOptions(catalog, "claude-sonnet-4-5").map((option) => option.value),
    ["", "claude-opus-4-1-high", "claude-sonnet-4-5"],
  );
  assert.equal(agyFallbackModelOptions(catalog, null)[0]?.label, AGY_NO_FALLBACK_LABEL);
  // A stored fallback the directory no longer lists stays selectable, like the Gemini model row.
  assert.deepEqual(agyFallbackModelOptions(catalog, "claude-haiku-4-5").at(-1), {
    value: "claude-haiku-4-5",
    label: "claude-haiku-4-5（当前已保存）",
    effort: [],
  });
  // With no directory the fallback select keeps only its empty row.
  assert.deepEqual(agyFallbackModelOptions(null, null), [
    { value: "", label: AGY_NO_FALLBACK_LABEL, effort: [] },
  ]);
});
