import assert from "node:assert/strict";
import test from "node:test";
import {
  agyModelOptions,
  codexModelOptions,
  dshEffortLevels,
  dshModelOptions,
  effortOptionsFor,
  piModelOptions,
} from "../client/catalog.js";
import {
  AGY_EFFORT_LEVELS,
  agyCompatibleEfforts,
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

test("DSH rows persist the exact provider/model route with its declared levels", () => {
  const catalog = {
    models: [
      {
        route: "magpie/auto/deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash",
        efforts: ["low", "high"],
      },
      {
        route: "magpie-responses/openai/gpt-6-astra",
        label: "GPT-6 Astra",
        efforts: [],
      },
    ],
    effortLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  };
  const options = dshModelOptions(catalog, null, null);
  assert.deepEqual(
    options.map((option) => option.value),
    ["", "magpie/auto/deepseek-v4.1-flash", "magpie-responses/openai/gpt-6-astra"],
  );
  // DSH applies reasoning only to an explicit model, so the default row has no levels.
  assert.deepEqual(options[0], { value: "", label: "使用默认值", effort: [] });
  assert.deepEqual(
    effortOptionsFor(options, "magpie/auto/deepseek-v4.1-flash", null).map(
      (option) => option.value,
    ),
    ["", "low", "high"],
  );
  assert.deepEqual(
    effortOptionsFor(options, "magpie-responses/openai/gpt-6-astra", null).map(
      (option) => option.value,
    ),
    [""],
  );
  // A listed route uses only the levels its declaration names.
  assert.deepEqual(dshEffortLevels(catalog, "magpie/auto/deepseek-v4.1-flash"), [
    "low",
    "high",
  ]);
  assert.deepEqual(
    dshEffortLevels(catalog, "magpie-responses/openai/gpt-6-astra"),
    [],
  );
});

test("a typed DSH route falls back to the engine levels and is kept when saving", () => {
  const catalog = {
    models: [
      {
        route: "magpie/listed",
        label: "Listed",
        efforts: ["high"],
      },
    ],
    effortLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  };
  // A route outside the static directory cannot claim declared levels but is still settable.
  assert.deepEqual(dshEffortLevels(catalog, "magpie/typed"), catalog.effortLevels);
  assert.deepEqual(dshEffortLevels(null, "magpie/typed"), []);
  // DSH applies reasoning only to an explicit model.
  assert.deepEqual(dshEffortLevels(catalog, null), []);
  assert.deepEqual(dshModelOptions(catalog, "magpie/typed", "xhigh"), [
    { value: "", label: "使用默认值", effort: [] },
    { value: "magpie/listed", label: "Listed", effort: ["high"] },
    {
      value: "magpie/typed",
      label: "magpie/typed（当前已保存）",
      effort: ["xhigh"],
    },
  ]);
  assert.deepEqual(dshModelOptions(null, "magpie/legacy", "high"), [
    { value: "", label: "使用默认值", effort: [] },
    {
      value: "magpie/legacy",
      label: "magpie/legacy（当前已保存）",
      effort: ["high"],
    },
  ]);
});

test("agy offers only a model's fixed effort while leaving unsuffixed ids unrestricted", () => {
  const fixed = agyModelOptions("gemini-3.8-flash-low");
  assert.deepEqual(fixed, [
    {
      value: "",
      label: "使用默认值",
      effort: [...AGY_EFFORT_LEVELS],
    },
    {
      value: "gemini-3.8-flash-low",
      label: "gemini-3.8-flash-low（当前已保存）",
      effort: ["low"],
    },
  ]);
  assert.deepEqual(
    effortOptionsFor(fixed, "gemini-3.8-flash-low", null).map(
      (option) => option.value,
    ),
    ["", "low"],
  );

  // A bare/custom id cannot be inferred from its name; keep every documented level available.
  const bare = agyModelOptions("custom/vendor-model");
  assert.deepEqual(bare.at(-1)?.effort, [...AGY_EFFORT_LEVELS]);
  assert.deepEqual(
    effortOptionsFor(bare, "custom/vendor-model", null).map((option) => option.value),
    ["", ...AGY_EFFORT_LEVELS],
  );

  assert.equal(agyFixedModelEffort("gemini-4-neon-xhigh"), "xhigh");
  assert.equal(agyFixedModelEffort("gemini-3.8-flash-max"), null);
  assert.deepEqual(agyCompatibleEfforts("gemini-3.8-flash-low"), ["low"]);
  assert.deepEqual(agyCompatibleEfforts("custom/vendor-model"), [
    ...AGY_EFFORT_LEVELS,
  ]);
  assert.equal(agyEffortConflict("gemini-3.8-flash-low", "low"), null);
  assert.equal(agyEffortConflict("gemini-3.8-flash-low", null), null);
  assert.match(
    agyEffortConflict("gemini-3.8-flash-low", "high") ?? "",
    /gemini-3\.8-flash-low 固定使用 low reasoning/,
  );
  assert.equal(agyEffortConflict("custom/vendor-model", "high"), null);
});
