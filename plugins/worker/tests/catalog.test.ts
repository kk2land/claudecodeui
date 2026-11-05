import assert from "node:assert/strict";
import test from "node:test";
import {
  codexModelOptions,
  effortOptionsFor,
  piModelOptions,
} from "../client/catalog.js";

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
