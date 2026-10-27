import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

// jsdom ships no types in this repository; createRequire avoids the missing @types/jsdom import.
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: { url?: string },
  ) => {
    window: Window & typeof globalThis;
  };
};

// --------------------------- Draft helpers ---------------------------

/** A baseline document with unknown fields, an inherited default, and two tasks. */
const BASELINE = {
  version: 1,
  timezone: "Asia/Shanghai",
  unknownTopLevel: { keep: ["me", 1, true] },
  defaults: { timeoutSeconds: 900, allowConcurrent: true },
  tasks: [
    {
      id: "alpha",
      name: "Alpha",
      type: "script",
      cron: "*/30 * * * * *",
      command: "bash",
      args: ["-lc", "echo one"],
      unknownTaskField: "keep-me",
    },
    {
      id: "beta",
      name: "Beta",
      type: "prompt",
      cron: "0 0 9 * * *",
      prompt: "报告状态",
      enabled: false,
    },
  ],
};

async function draft() {
  return import("../client/configurationDraft.js");
}
function parsedTasks(text: string): Array<Record<string, unknown>> {
  return (JSON.parse(text) as { tasks: Array<Record<string, unknown>> }).tasks;
}

test("draft parsing keeps unknown fields and preserves untouched values", async () => {
  const { parseConfigDocument, updateConfigText, stringifyConfigDocument } =
    await draft();
  const text = JSON.stringify(BASELINE);
  const parsed = parseConfigDocument(text);
  assert.equal(parsed.ok, true);
  const result = updateConfigText(text, (value) => {
    const tasks = value.tasks as Array<Record<string, unknown>>;
    tasks[0]!.name = "Alpha 改名";
  });
  assert.ok("text" in result);
  const output = JSON.parse(result.text) as Record<string, unknown>;
  assert.deepEqual(output.unknownTopLevel, BASELINE.unknownTopLevel);
  assert.equal(
    (output.tasks as Array<Record<string, unknown>>)[0]!.unknownTaskField,
    "keep-me",
  );
  // The untouched task keeps semantic identity even though the file is re-serialized.
  assert.deepEqual(
    (output.tasks as Array<Record<string, unknown>>)[1],
    BASELINE.tasks[1],
  );
  assert.equal(stringifyConfigDocument(output).endsWith("\n"), true);
});

test("draft parsing rejects invalid JSON and non-object documents", async () => {
  const { parseConfigDocument } = await draft();
  assert.equal(parseConfigDocument("{not json").ok, false);
  assert.equal(parseConfigDocument("[]").ok, false);
  assert.equal(parseConfigDocument('{"version":1}').ok, false);
  assert.equal(parseConfigDocument('{"tasks":[1]}').ok, false);
  assert.equal(parseConfigDocument('{"tasks":[]}').ok, true);
});

test("adding, copying, removing, and restoring tasks round-trips", async () => {
  const {
    addDraftTask,
    copyDraftTask,
    createTaskDraft,
    nextTaskId,
    removeDraftTask,
    restoreDraftTask,
    summarizeDraft,
    parseConfigDocument,
    updateConfigText,
  } = await draft();
  const text = JSON.stringify(BASELINE);
  const added = addDraftTask(text, createTaskDraft("gamma", "prompt"));
  assert.ok("text" in added);
  assert.equal(added.index, 2);
  assert.equal(parsedTasks(added.text).length, 3);

  const copied = copyDraftTask(added.text, 0);
  assert.ok("text" in copied);
  const copy = parsedTasks(copied.text)[1]!;
  assert.equal(copy.id, "alpha-copy");
  assert.equal(copy.unknownTaskField, "keep-me");
  assert.equal(copy.name, "Alpha（副本）");

  // Remove "beta" (index 2 after the inserted copy) and restore it at its original slot.
  const removed = removeDraftTask(copied.text, 2);
  assert.ok("text" in removed);
  assert.equal(parsedTasks(removed.text).length, 3);

  const restored = restoreDraftTask(removed.text, BASELINE.tasks[1]!, 2);
  assert.ok("text" in restored);
  assert.deepEqual(parsedTasks(restored.text)[2], BASELINE.tasks[1]);

  const parsed = parseConfigDocument(restored.text);
  assert.ok(parsed.ok);
  // Final draft: alpha, alpha-copy, beta (restored), gamma.
  assert.deepEqual(
    parsed.document.tasks.map((task) => task.id),
    ["alpha", "alpha-copy", "beta", "gamma"],
  );
  const summary = summarizeDraft(BASELINE.tasks, parsed.document.tasks);
  assert.deepEqual(summary.statuses, ["unchanged", "new", "unchanged", "new"]);
  assert.equal(summary.added, 2);
  assert.equal(summary.modified, 0);
  assert.equal(summary.removedCount, 0);

  // A genuine property change is reported as modified; a removed task as a restore candidate.
  const renamed = updateConfigText(restored.text, (value) => {
    (value.tasks as Array<Record<string, unknown>>)[0]!.name = "Alpha 改名";
  });
  assert.ok("text" in renamed);
  const afterRename = parseConfigDocument(renamed.text);
  assert.ok(afterRename.ok);
  assert.equal(
    summarizeDraft(BASELINE.tasks, afterRename.document.tasks).statuses[0],
    "modified",
  );
  const fewer = removeDraftTask(restored.text, 2);
  assert.ok("text" in fewer);
  const afterRemove = parseConfigDocument(fewer.text);
  assert.ok(afterRemove.ok);
  const removedSummary = summarizeDraft(BASELINE.tasks, afterRemove.document.tasks);
  assert.deepEqual(
    removedSummary.removed.map((entry) => entry.task.id),
    ["beta"],
  );
  assert.equal(removedSummary.removedCount, 1);
  // A duplicated id must never be produced, even when the base already ends with -copy.
  assert.equal(nextTaskId(["task-copy", "task-copy-2"], "task-copy"), "task-copy-3");
});

test("nextTaskId always returns a server-valid, unique id up to 128 characters", async () => {
  const { nextTaskId, MAX_TASK_ID_LENGTH } = await draft();
  const long = "a".repeat(MAX_TASK_ID_LENGTH);
  const copy = nextTaskId([long], long + "-copy");
  assert.equal(copy.length <= MAX_TASK_ID_LENGTH, true);
  assert.notEqual(copy, long);
  assert.match(copy, /^[A-Za-z0-9_-]{1,128}$/);
  // Suffix collisions at the length limit still yield a fresh, bounded id.
  const taken = [long, copy];
  const third = nextTaskId(taken, long);
  assert.equal(third.length <= MAX_TASK_ID_LENGTH, true);
  assert.equal(taken.includes(third), false);
  assert.match(third, /^[A-Za-z0-9_-]{1,128}$/);
  // Invalid characters never leak into a generated id.
  assert.equal(nextTaskId([], "任务 名称/with.punct"), "with-punct");
});

test("default inheritance is cleared by deleting the raw key only", async () => {
  const { deleteConfigValue, getConfigValue, updateConfigText } = await draft();
  const text = JSON.stringify(BASELINE);
  const result = updateConfigText(text, (value) => {
    const tasks = value.tasks as Array<Record<string, unknown>>;
    delete tasks[0]!.timeoutSeconds;
    // Simulate clearing an explicit task timeout so the project default applies again.
    (value.defaults as Record<string, unknown>).timeoutSeconds = undefined;
    delete (value.defaults as Record<string, unknown>).timeoutSeconds;
  });
  assert.ok("text" in result);
  const output = JSON.parse(result.text) as Record<string, unknown>;
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      (output.tasks as Array<Record<string, unknown>>)[0]!,
      "timeoutSeconds",
    ),
    false,
  );
  assert.equal(
    getConfigValue(output, ["defaults", "allowConcurrent"]),
    true,
  );
  const cleared = deleteConfigValue(output, ["defaults", "allowConcurrent"]);
  assert.equal(getConfigValue(cleared, ["defaults", "allowConcurrent"]), undefined);
  assert.equal(getConfigValue(cleared, ["defaults", "timeoutSeconds"]), undefined);
});

test("cron templates generate correct five and six field expressions", async () => {
  const { cronFromTemplate, cronTemplateOf, describeCron } = await draft();
  const cases: Array<[Parameters<typeof cronFromTemplate>[0], string]> = [
    [{ kind: "seconds", every: 1 }, "* * * * * *"],
    [{ kind: "seconds", every: 30 }, "*/30 * * * * *"],
    [{ kind: "minutes", every: 1 }, "0 * * * * *"],
    [{ kind: "minutes", every: 15 }, "0 */15 * * * *"],
    [{ kind: "daily", hour: 9, minute: 5 }, "0 5 9 * * *"],
    [{ kind: "weekly", days: [1, 3], hour: 18, minute: 0 }, "0 0 18 * * 1,3"],
  ];
  for (const [template, expected] of cases) {
    const generated = cronFromTemplate(template);
    assert.ok("cron" in generated, JSON.stringify(template));
    assert.equal(generated.cron, expected);
    // fromTemplate -> templateOf -> describeCron must round-trip and stay a template.
    const recognized = cronTemplateOf(generated.cron);
    assert.notEqual(recognized.kind, "custom", generated.cron);
    assert.equal(describeCron(generated.cron).includes("自定义"), false);
  }
  // Five-field "* * * * *" is the unmodified "every minute" baseline, not a custom schedule.
  assert.deepEqual(cronTemplateOf("* * * * *"), { kind: "minutes", every: 1 });
  assert.equal(describeCron("* * * * *"), "每 1 分钟");
  assert.equal(describeCron("* * * * * *"), "每 1 秒");
});

test("non-template cron keeps its exact text and is never rewritten", async () => {
  const { cronTemplateOf, cronFromTemplate, updateConfigText } = await draft();
  const custom = "15 3 * * 1-5";
  assert.deepEqual(cronTemplateOf(custom), { kind: "custom", cron: custom });
  const passthrough = cronFromTemplate({ kind: "custom", cron: custom });
  assert.ok("cron" in passthrough);
  assert.equal(passthrough.cron, custom);
  // Re-serializing a draft without touching cron preserves the original expression.
  const result = updateConfigText(JSON.stringify(BASELINE), (value) => {
    (value.tasks as Array<Record<string, unknown>>)[0]!.name = "Renamed";
  });
  assert.ok("text" in result);
  assert.equal(parsedTasks(result.text)[0]!.cron, "*/30 * * * * *");
});

test("raw field validation rejects invalid args and env without dropping input", async () => {
  const { parseConfigDocument } = await draft();
  // The editor module owns textual arg/env parsing; invalid JSON never reaches the draft.
  assert.equal(parseConfigDocument("{bad").ok, false);
  assert.equal(
    parseConfigDocument('{"tasks":[{"id":"x","type":"prompt","cron":"0 0 9 * * *"}]}').ok,
    true,
  );
});

// --------------------------- DOM regression ---------------------------

type Mounted = {
  container: HTMLElement;
  calls: Array<{ method: string; path: string; body: unknown }>;
  emit(context: unknown): void;
  unmount(): void;
  dom: { window: Window & typeof globalThis };
};
type HostModule = {
  mount(container: HTMLElement, host: unknown): void;
  unmount(container: HTMLElement): void;
};

/** Installs the browser globals React expects, before the bundle is imported. */
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>", {
    url: "http://localhost/",
  });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  for (const name of [
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "Node",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "SubmitEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ])
    globals[name] = (
      dom.window as unknown as Record<string, unknown>
    )[name];
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

/** Waits until `check` holds, driving real timers instead of guessing request counts. */
async function waitFor(
  check: () => boolean,
  label: string,
  timeout = 4000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待超时：" + label);
}
function textOf(node: Element | null | undefined): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ");
}
function findButton(
  root: ParentNode,
  label: string,
): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((item) =>
    textOf(item).includes(label),
  );
}
function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = findButton(root, label);
  assert.ok(found, "找不到按钮：" + label);
  return found;
}
function byLabel(root: ParentNode, label: string): HTMLElement | null {
  return root.querySelector<HTMLElement>('[aria-label="' + label + '"]');
}
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  )!.set!;
  setter.call(input, value);
  const view = input.ownerDocument.defaultView as unknown as {
    Event: new (type: string, init?: { bubbles?: boolean }) => Event;
  };
  input.dispatchEvent(new view.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Model catalogs used by DOM tests; effort levels mirror real provider shapes. */
const DEFAULT_CATALOGS = {
  codex: {
    DEFAULT: "gpt-6-sol",
    OPTIONS: [
      {
        value: "gpt-6-sol",
        label: "GPT-6 Sol",
        effort: {
          default: "medium",
          values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        },
      },
      {
        value: "gpt-6-luna",
        label: "GPT-6 Luna",
        effort: { values: [{ value: "low" }, { value: "medium" }] },
      },
    ],
  },
  dsh: {
    DEFAULT: "default",
    OPTIONS: [
      { value: "default", label: "default" },
      {
        value: "magpie/flash",
        label: "Flash",
        description: "magpie",
        effort: { values: [{ value: "off" }, { value: "high" }] },
      },
    ],
  },
} as const;

const CONFIG = JSON.stringify(
  {
    version: 1,
    timezone: "Asia/Shanghai",
    defaults: { timeoutSeconds: 900 },
    alerts: { telegram: "default" },
    tasks: [
      {
        id: "alpha",
        name: "Alpha",
        type: "script",
        cron: "*/30 * * * * *",
        command: "bash",
        args: ["-lc", "echo one"],
      },
      {
        id: "beta",
        name: "Beta",
        type: "prompt",
        cron: "0 0 9 * * *",
        prompt: "报告状态",
      },
    ],
  },
  null,
  2,
);

type RpcMode = {
  /** Save responses, consumed in order; defaults to a successful save+load. */
  save?: Array<Record<string, unknown>>;
  /** Delay in ms applied to configuration/save responses. */
  saveDelay?: number;
  preview?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** Inventory rows returned by GET /tasks. */
  tasks?: Array<Record<string, unknown>>;
  /** Projects returned by GET /projects. */
  projects?: Array<Record<string, unknown>>;
  /**
   * Host catalog responses keyed by provider; a promise defers or rejects the lookup and a
   * function runs on every request, which lets a test fail once and succeed on retry.
   */
  models?: Partial<
    Record<"codex" | "dsh", unknown | Promise<unknown> | (() => Promise<unknown>)>
  >;
  /** Omits host.models entirely to emulate an older host. */
  withoutModels?: boolean;
  /** Per-run records returned by GET /runs; omitted means no run history. */
  runs?: Array<Record<string, unknown>>;
};

async function mountPlugin(mode: RpcMode = {}) {
  const dom = installDom();
  // The bundle is imported only after the DOM globals exist; TS7016 is avoided by URL import.
  const module = (await import(
    new URL("../dist/client.js", import.meta.url).href
  )) as HostModule;
  const container = dom.window.document.getElementById("host")!;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const listeners = new Set<(context: unknown) => void>();
  let context: { theme: "light"; project: { name: string; path: string } | null } = {
    theme: "light",
    project: { name: "project-a", path: "/tmp/project-a" },
  };
  const pendingSaves: Array<Record<string, unknown>> = [...(mode.save ?? [])];
  const host = {
    get context() {
      return context;
    },
    onContextChange(callback: (value: unknown) => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    ...(mode.withoutModels
      ? {}
      : {
          models(provider: "codex" | "dsh") {
            const reply = mode.models?.[provider];
            if (reply === undefined) return Promise.resolve(DEFAULT_CATALOGS[provider]);
            if (typeof reply === "function") return reply();
            return Promise.resolve(reply);
          },
        }),
    async rpc(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (path === "/settings")
        return {
          retentionDays: 30,
          timeoutSeconds: 3600,
          maxConcurrentRuns: 4,
          timezone: "Asia/Shanghai",
          env: {},
          telegram: { enabled: false, chatId: "", proxy: "", botTokenConfigured: false },
        };
      if (path === "/tasks") return { tasks: mode.tasks ?? [] };
      if (path.startsWith("/runs?"))
        return { runs: mode.runs ?? [] };
      if (path === "/projects")
        return {
          projects: mode.projects ?? [
            { id: "project-a", name: "项目 A", path: "/tmp/project-a" },
            { id: "project-b", name: "项目 B", path: "/tmp/project-b" },
          ],
        };
      if (path.startsWith("/configuration?")) {
        if (mode.config) return mode.config;
        // Mirror the real endpoint: return the identity of the requested project.
        const id = decodeURIComponent(path.split("projectId=")[1] ?? "project-a");
        return {
          project:
            id === "project-b"
              ? { id: "project-b", name: "项目 B", path: "/tmp/project-b" }
              : { id: "project-a", name: "项目 A", path: "/tmp/project-a" },
          text: CONFIG,
          revision: "rev-1",
          exists: true,
        };
      }
      if (path === "/configuration/preview") {
        if (mode.saveDelay) await new Promise((r) => setTimeout(r, mode.saveDelay));
        return (
          mode.preview ?? {
            valid: true,
            tasks: [{ taskId: "alpha", nextRuns: ["2025-01-01T00:00:00.000Z"] }],
            changes: { added: 0, updated: 1, removed: 0, reEnabled: 1 },
          }
        );
      }
      if (path === "/configuration/save") {
        if (mode.saveDelay) await new Promise((r) => setTimeout(r, mode.saveDelay));
        return (
          pendingSaves.shift() ?? {
            saved: true,
            loaded: true,
            revision: "rev-2",
            changes: { added: 0, updated: 1, removed: 0, reEnabled: 1 },
          }
        );
      }
      return {};
    },
  };
  module.mount(container, host);
  const mounted: Mounted = {
    container,
    calls,
    emit(next) {
      context = next as typeof context;
      for (const listener of listeners) listener(context);
    },
    unmount() {
      module.unmount(container);
      dom.window.close();
    },
    dom,
  };
  return mounted;
}
function callsTo(mounted: Mounted, path: string) {
  return mounted.calls.filter((call) => call.path === path);
}
/** Matches endpoints whose path carries a query string (for example /configuration?projectId=…). */
function callsToPrefix(mounted: Mounted, prefix: string) {
  return mounted.calls.filter((call) => call.path.startsWith(prefix));
}

test("DOM: editing a draft never saves and one click sends the exact project/text/revision", async () => {
  const mounted = await mountPlugin();
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => Boolean(byLabel(root, "任务名称")), "编辑器打开");
    assert.equal(textOf(root).includes("项目 A"), true);
    // Editing must not hit the immediate toggle endpoint or the file.
    assert.equal(callsTo(mounted, "/tasks/enabled").length, 0);
    assert.equal(callsTo(mounted, "/configuration/save").length, 0);

    await typeInto(byLabel(root, "任务名称") as HTMLInputElement, "Alpha 改名");
    await waitFor(
      () => callsTo(mounted, "/configuration/preview").length > 0,
      "预览请求",
    );
    await waitFor(
      () => textOf(button(root, "保存并装载")).includes("保存并装载") &&
        !button(root, "保存并装载").disabled,
      "保存可用",
    );
    // The same project ID is pinned even if host context is null.
    assert.equal(callsTo(mounted, "/configuration/save").length, 0);

    button(root, "保存并装载").click();
    await waitFor(
      () => callsTo(mounted, "/configuration/save").length === 1,
      "一次保存请求",
    );
    const save = callsTo(mounted, "/configuration/save")[0]!;
    const payload = save.body as {
      projectId: string;
      text: string;
      revision: string;
    };
    assert.equal(save.method, "POST");
    assert.equal(payload.projectId, "project-a");
    assert.equal(payload.revision, "rev-1");
    assert.equal(JSON.parse(payload.text).tasks[0].name, "Alpha 改名");
    assert.equal(callsTo(mounted, "/configuration/save").length, 1);

    // A loaded save returns to the refreshed task list.
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "回到列表");
    await waitFor(
      () => textOf(mounted.container).includes("配置已保存并装载"),
      "成功提示",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: failed save keeps the draft, and a conflict offers the latest file", async () => {
  const mounted = await mountPlugin({
    save: [
      { saved: false, loaded: false, revision: "rev-1", error: "磁盘只读", changes: { added: 0, updated: 0, removed: 0, reEnabled: 0 } },
      {
        saved: false,
        loaded: false,
        revision: "rev-1",
        conflict: true,
        changes: { added: 0, updated: 0, removed: 0, reEnabled: 0 },
        latest: {
          project: { id: "project-a", name: "项目 A", path: "/tmp/project-a" },
          text: '{"version":1,"tasks":[]}',
          revision: "rev-9",
          exists: true,
        },
      },
    ],
  });
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => Boolean(byLabel(root, "任务名称")), "编辑器打开");
    await typeInto(byLabel(root, "任务名称") as HTMLInputElement, "草稿保留");
    await waitFor(() => !button(root, "保存并装载").disabled, "保存可用");
    button(root, "保存并装载").click();
    await waitFor(
      () => textOf(root).includes("磁盘只读"),
      "失败提示",
    );
    // The draft is still present and editable after a business failure.
    assert.equal((byLabel(root, "任务名称") as HTMLInputElement).value, "草稿保留");

    button(root, "保存并装载").click();
    await waitFor(
      () => textOf(root).includes("放弃草稿并读取最新文件"),
      "冲突提示",
    );
    assert.equal(textOf(root).includes('"tasks":[]'), true);
    assert.equal((byLabel(root, "任务名称") as HTMLInputElement).value, "草稿保留");
    // Nothing was overwritten automatically.
    assert.equal(
      (callsTo(mounted, "/configuration/save").at(-1)!.body as { text: string }).text.includes(
        "草稿保留",
      ),
      true,
    );
    button(root, "放弃草稿并读取最新文件").click();
    // The latest file (no tasks) replaces the draft; the unsent edit is gone from the editor.
    await waitFor(
      () => textOf(root).includes("草稿中还没有任务"),
      "读取最新文件",
    );
    assert.equal(byLabel(root, "任务名称"), null);
    assert.equal(textOf(root).includes("草稿保留"), false);
    // Reading the latest file never writes back to it.
    assert.equal(callsTo(mounted, "/configuration/save").length, 2);
    assert.equal(callsTo(mounted, "/tasks/enabled").length, 0);
  } finally {
    mounted.unmount();
  }
});

test("DOM: temporary scheduling toggles never write configuration", async () => {
  const mounted = await mountPlugin({
    tasks: [
      {
        projectId: "project-a",
        projectName: "项目 A",
        projectPath: "/tmp/project-a",
        taskId: "alpha",
        definition: {
          id: "alpha",
          name: "Alpha",
          type: "script",
          enabled: true,
          cron: "*/30 * * * * *",
          timezone: "Asia/Shanghai",
          allowConcurrent: false,
          timeoutSeconds: 900,
          cwd: "/tmp/project-a",
          env: {},
          agent: { provider: "codex", model: "default" },
          command: "bash",
          args: [],
          notify: true,
        },
        updatedAt: new Date().toISOString(),
        nextRun: null,
        activeRuns: [],
        lastRun: null,
      },
    ],
  });
  try {
    const root = mounted.container;
    await waitFor(
      () => Boolean(byLabel(root, "项目 A / Alpha 临时自动调度")),
      "临时开关",
    );
    const toggle = byLabel(root, "项目 A / Alpha 临时自动调度")!;
    toggle.click();
    await waitFor(() => callsTo(mounted, "/tasks/enabled").length === 1, "开关请求");
    assert.equal(callsTo(mounted, "/configuration/save").length, 0);
    assert.equal(textOf(root).includes("临时自动调度"), true);
  } finally {
    mounted.unmount();
  }
});

test("DOM: an invalid args value blocks saving and cancel keeps the draft", async () => {
  const mounted = await mountPlugin();
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => Boolean(byLabel(root, "脚本 args JSON")), "编辑器打开");
    await typeInto(byLabel(root, "脚本 args JSON") as HTMLTextAreaElement, '["broken"');
    await waitFor(
      () => textOf(root).includes("args / env 中存在无效 JSON"),
      "无效提示",
    );
    assert.equal(button(root, "保存并装载").disabled, true);
    button(root, "取消编辑").click();
    await waitFor(
      () => textOf(root).includes("确定放弃并退出编辑"),
      "离开提醒",
    );
    button(root, "继续编辑").click();
    await waitFor(
      () => (byLabel(root, "脚本 args JSON") as HTMLTextAreaElement).value === '["broken"',
      "继续编辑保留输入",
    );
    // The invalid input is still visible and fixable rather than silently dropped.
    await typeInto(byLabel(root, "脚本 args JSON") as HTMLTextAreaElement, '["fixed"]');
    await waitFor(() => !button(root, "保存并装载").disabled, "修复后可保存");
    assert.equal(callsTo(mounted, "/configuration/save").length, 0);
  } finally {
    mounted.unmount();
  }
});

test("DOM: host context changes warn without discarding the pinned project", async () => {
  const mounted = await mountPlugin();
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => Boolean(byLabel(root, "任务名称")), "编辑器打开");
    await typeInto(byLabel(root, "任务名称") as HTMLInputElement, "保留草稿");
    mounted.emit({
      theme: "light",
      project: { name: "project-b", path: "/tmp/project-b" },
    });
    await waitFor(
      () => textOf(root).includes("宿主已切换到其他项目"),
      "离开提醒",
    );
    assert.equal((byLabel(root, "任务名称") as HTMLInputElement).value, "保留草稿");
    button(root, "继续编辑本项目").click();
    await waitFor(
      () => !textOf(root).includes("宿主已切换到其他项目"),
      "确认继续",
    );
    // A further host change still warns after the first acknowledgement.
    mounted.emit({
      theme: "light",
      project: { name: "project-a", path: "/tmp/project-a" },
    });
    await waitFor(
      () => !textOf(root).includes("宿主已切换到其他项目"),
      "同项目不提醒",
    );
    // Let React commit the intermediate context before emitting the next change.
    await new Promise((resolve) => setTimeout(resolve, 50));
    mounted.emit({
      theme: "light",
      project: { name: "project-b", path: "/tmp/project-b" },
    });
    await waitFor(
      () => textOf(root).includes("宿主已切换到其他项目"),
      "再次提醒",
    );
    assert.equal(callsTo(mounted, "/configuration/save").length, 0);
  } finally {
    mounted.unmount();
  }
});

test("DOM: saving with no draft change still writes to restore temporary state", async () => {
  const mounted = await mountPlugin();
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => Boolean(byLabel(root, "任务名称")), "编辑器打开");
    await waitFor(() => !button(root, "保存并装载").disabled, "校验通过");
    assert.equal(textOf(root).includes("临时关闭将被重新启用 1 项"), true);
    assert.equal(textOf(root).includes("装载效果：新增 0 · 更新 1 · 删除 0"), true);
    button(root, "保存并装载").click();
    await waitFor(
      () => callsTo(mounted, "/configuration/save").length === 1,
      "允许无变化保存",
    );
    const payload = callsTo(mounted, "/configuration/save")[0]!.body as {
      text: string;
    };
    // The unchanged text is sent verbatim, still carrying the unknown defaults.
    assert.equal(payload.text, CONFIG);
  } finally {
    mounted.unmount();
  }
});

test("DOM: a written-but-not-loaded save keeps the editor and its revision", async () => {
  const mounted = await mountPlugin({
    save: [
      {
        saved: true,
        loaded: false,
        revision: "rev-3",
        error: "任务校验失败",
        changes: { added: 0, updated: 1, removed: 0, reEnabled: 0 },
      },
    ],
  });
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => Boolean(byLabel(root, "任务名称")), "编辑器打开");
    await waitFor(() => !button(root, "保存并装载").disabled, "校验通过");
    button(root, "保存并装载").click();
    await waitFor(
      () => textOf(root).includes("文件已写入，但装载失败"),
      "装载失败提示",
    );
    assert.equal(Boolean(byLabel(root, "任务名称")), true);
    assert.equal(textOf(root).includes("重试装载"), true);
    // Retry must not discard local invalid input, even though the persisted JSON is valid.
    await typeInto(byLabel(root, "脚本 args JSON") as HTMLTextAreaElement, '["unfinished"');
    assert.equal(button(root, "重试装载").disabled, true);
    button(root, "重试装载").click();
    assert.equal(callsTo(mounted, "/configuration/save").length, 1);
    button(root, "放弃 args / env 输入").click();
    await waitFor(() => !button(root, "重试装载").disabled, "放弃无效输入后允许重试");
    // Retrying reuses the new revision returned by the write.
    button(root, "重试装载").click();
    await waitFor(
      () => callsTo(mounted, "/configuration/save").length === 2,
      "重试请求",
    );
    assert.equal(
      (callsTo(mounted, "/configuration/save")[1]!.body as { revision: string })
        .revision,
      "rev-3",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: a slow save locks the editor and only closes the draft it was sent", async () => {
  const mounted = await mountPlugin({ saveDelay: 700 });
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => Boolean(byLabel(root, "任务名称")), "编辑器打开");
    await typeInto(byLabel(root, "任务名称") as HTMLInputElement, "发送时的草稿");
    await waitFor(() => !button(root, "保存并装载").disabled, "保存可用");
    button(root, "保存并装载").click();
    // While the request is in flight every input and exit path is locked.
    await waitFor(
      () => textOf(findButton(root, "保存")).includes("保存中"),
      "保存进行中",
    );
    // Every editable control sits inside the disabled fieldset while the request is in flight.
    const locked = root.querySelector("fieldset.cron-editor-content") as HTMLFieldSetElement;
    assert.equal(locked.disabled, true);
    assert.equal(locked.contains(byLabel(root, "任务名称")), true);
    assert.equal(button(root, "取消编辑").disabled, true);
    assert.equal(
      (byLabel(root, "退出编辑") as HTMLButtonElement).disabled,
      true,
    );
    const jsonToggle = findButton(root, "JSON")!;
    assert.equal(jsonToggle.disabled, true);
    // A click on the locked cancel button must not exit the editor.
    button(root, "取消编辑").click();
    assert.equal(Boolean(byLabel(root, "任务名称")), true);
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "保存成功后回到列表");
    const saves = callsTo(mounted, "/configuration/save");
    assert.equal(saves.length, 1);
    assert.equal(
      JSON.parse((saves[0]!.body as { text: string }).text).tasks[0].name,
      "发送时的草稿",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: renaming a task keeps invalid args visible and fixable", async () => {
  const mounted = await mountPlugin();
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => Boolean(byLabel(root, "脚本 args JSON")), "编辑器打开");
    await typeInto(byLabel(root, "脚本 args JSON") as HTMLTextAreaElement, '["oops"');
    await waitFor(
      () => textOf(root).includes("args / env 中存在无效 JSON"),
      "无效提示",
    );
    // Rename the task: the invalid input must stay attached to the same draft slot.
    await typeInto(byLabel(root, "任务 ID") as HTMLInputElement, "alpha-renamed");
    await waitFor(
      () => (byLabel(root, "任务 ID") as HTMLInputElement).value === "alpha-renamed",
      "改名生效",
    );
    assert.equal(
      (byLabel(root, "脚本 args JSON") as HTMLTextAreaElement).value,
      '["oops"',
    );
    assert.equal(textOf(root).includes("args / env 中存在无效 JSON"), true);
    // Fixing it clears the block and commits into the draft.
    await typeInto(byLabel(root, "脚本 args JSON") as HTMLTextAreaElement, '["ok","two"]');
    await waitFor(() => !button(root, "保存并装载").disabled, "修复后可保存");
    assert.equal(textOf(root).includes("args / env 中存在无效 JSON"), false);
    // The corrected args reach the save payload under the renamed id.
    button(root, "保存并装载").click();
    await waitFor(() => callsTo(mounted, "/configuration/save").length === 1, "保存请求");
    const payload = JSON.parse(
      (callsTo(mounted, "/configuration/save")[0]!.body as { text: string }).text,
    ) as { tasks: Array<{ id: string; args: string[] }> };
    assert.equal(payload.tasks[0]!.id, "alpha-renamed");
    assert.deepEqual(payload.tasks[0]!.args, ["ok", "two"]);
  } finally {
    mounted.unmount();
  }
});

test("DOM: 'all projects' requires an explicit project choice before editing", async () => {
  const mounted = await mountPlugin();
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "全部项目").click();
    await waitFor(
      () => Boolean(findButton(root, "全部项目")),
      "全部项目视图",
    );
    button(root, "编辑任务").click();
    await waitFor(
      () => Boolean(byLabel(root, "选择要编辑的项目")),
      "项目选择器",
    );
    button(root, "项目 B").click();
    await waitFor(() => Boolean(byLabel(root, "任务名称")), "编辑器打开");
    // The pinned project is the chosen one, not the host's current project.
    const configurationCall = callsToPrefix(mounted, "/configuration?").at(-1)!;
    assert.equal(configurationCall.path.includes("projectId=project-b"), true);
    // The editor header keeps showing the chosen project name.
    assert.equal(
      textOf(root.querySelector('[aria-label="编辑任务配置 · 项目 B"]')).length > 0,
      true,
    );
    assert.equal(textOf(root).includes("宿主已切换到其他项目"), false);

    // Saving a non-current project keeps a scope that still shows the refreshed row.
    await waitFor(() => !button(root, "保存并装载").disabled, "校验通过");
    button(root, "保存并装载").click();
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "回到列表");
    assert.equal(
      button(root, "全部项目").getAttribute("aria-pressed"),
      "true",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: without a host project the list still shows every project's tasks", async () => {
  const mounted = await mountPlugin({
    tasks: [
      {
        projectId: "project-b",
        projectName: "项目 B",
        projectPath: "/tmp/project-b",
        taskId: "beta",
        definition: {
          id: "beta",
          name: "Beta",
          type: "prompt",
          enabled: true,
          cron: "0 0 9 * * *",
          timezone: "Asia/Shanghai",
          allowConcurrent: false,
          timeoutSeconds: 900,
          cwd: "/tmp/project-b",
          env: {},
          agent: { provider: "codex", model: "default" },
          args: [],
          prompt: "p",
          notify: true,
        },
        updatedAt: new Date().toISOString(),
        nextRun: null,
        activeRuns: [],
        lastRun: null,
      },
    ],
  });
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    mounted.emit({ theme: "light", project: null });
    await waitFor(
      () => button(root, "全部项目").getAttribute("aria-pressed") === "true",
      "无项目时选中全部",
    );
    // The row from the non-current project is visible rather than filtered out.
    await waitFor(() => textOf(root).includes("项目 B · beta"), "显示全部项目任务");
    assert.equal(textOf(root).includes("0 项任务"), false);
  } finally {
    mounted.unmount();
  }
});

// --------------------------- Agent provider/model/effort ---------------------------

/** Selects one option by its visible value and dispatches the same change event React expects. */
async function selectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(select),
    "value",
  )!.set!;
  setter.call(select, value);
  const view = select.ownerDocument.defaultView as unknown as {
    Event: new (type: string, init?: { bubbles?: boolean }) => Event;
  };
  select.dispatchEvent(new view.Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const AGENT_CONFIG = JSON.stringify(
  {
    version: 1,
    defaults: {
      agent: { provider: "codex", model: "gpt-6-sol", effort: "high" },
    },
    tasks: [
      {
        id: "prompt-task",
        type: "prompt",
        cron: "0 0 9 * * *",
        prompt: "状态",
      },
      {
        id: "pinned",
        type: "prompt",
        cron: "0 0 9 * * *",
        prompt: "固定",
        agent: { provider: "codex", model: "gpt-legacy", effort: "legacy-level" },
      },
    ],
  },
  null,
  2,
);

async function openEditor(config = AGENT_CONFIG) {
  const mounted = await mountPlugin({
    config: {
      project: { id: "project-a", name: "项目 A", path: "/tmp/project-a" },
      text: config,
      revision: "rev-1",
      exists: true,
    },
  });
  const root = mounted.container;
  await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
  button(root, "编辑任务").click();
  await waitFor(() => Boolean(byLabel(root, "默认 agent provider")), "编辑器打开");
  await waitFor(
    () => [...(byLabel(root, "默认 agent model") as HTMLSelectElement).options]
      .some((option) => option.value === "gpt-6-luna"),
    "模型目录加载完成",
  );
  return { mounted, root };
}
function savedAgent(mounted: Mounted, taskIndex = 0): Record<string, unknown> {
  const save = callsTo(mounted, "/configuration/save").at(-1)!;
  const parsed = JSON.parse((save.body as { text: string }).text) as {
    defaults?: { agent?: Record<string, unknown> };
    tasks: Array<{ agent?: Record<string, unknown> }>;
  };
  return taskIndex < 0
    ? parsed.defaults?.agent ?? {}
    : parsed.tasks[taskIndex]?.agent ?? {};
}

test("DOM: task model/effort inherit the project agent until the provider changes", async () => {
  const { mounted, root } = await openEditor();
  try {
    await waitFor(
      () => (byLabel(root, "任务 provider") as HTMLSelectElement)?.value === "",
      "任务 provider 继承",
    );
    const model = byLabel(root, "任务 model") as HTMLSelectElement;
    const effort = byLabel(root, "任务 effort") as HTMLSelectElement;
    // Inheriting task shows the project's model and effort, including the inherited labels.
    assert.equal(model.value, "");
    assert.equal(textOf(model.options[0]!), "继承项目默认（GPT-6 Sol）");
    assert.equal(effort.value, "");
    assert.match(textOf(effort.options[0]!), /high/);
    // Real effort levels come from the selected model's catalog entry.
    assert.deepEqual(
      [...effort.options].map((option) => option.value),
      ["", "default", "low", "medium", "high"],
    );

    await selectValue(byLabel(root, "任务 provider") as HTMLSelectElement, "dsh");
    await waitFor(() => !button(root, "保存并装载").disabled, "校验完成");
    // A provider switch writes an explicit provider and resets model/effort inheritance safely.
    button(root, "保存并装载").click();
    await waitFor(() => callsTo(mounted, "/configuration/save").length === 1, "保存");
    assert.deepEqual(savedAgent(mounted), {
      provider: "dsh",
      effort: "default",
    });
  } finally {
    mounted.unmount();
  }
});

test("DOM: choosing a model resets effort and offers only that model's levels", async () => {
  const { mounted, root } = await openEditor();
  try {
    await waitFor(() => Boolean(byLabel(root, "默认 agent model")), "目录加载");
    const effort = byLabel(root, "默认 agent effort") as HTMLSelectElement;
    await waitFor(
      () => [...effort.options].some((option) => option.value === "high"),
      "effort 选项",
    );
    const model = byLabel(root, "默认 agent model") as HTMLSelectElement;
    await selectValue(model, "gpt-6-luna");
    await waitFor(
      () =>
        ![...(byLabel(root, "默认 agent effort") as HTMLSelectElement).options].some(
          (option) => option.value === "high",
        ),
      "切换模型后 effort 收窄",
    );
    await waitFor(() => !button(root, "保存并装载").disabled, "校验完成");
    button(root, "保存并装载").click();
    await waitFor(() => callsTo(mounted, "/configuration/save").length === 1, "保存");
    // The old explicit "high" belonged to the previous model and must not leak into the new one.
    assert.deepEqual(savedAgent(mounted, -1), {
      provider: "codex",
      model: "gpt-6-luna",
      effort: "default",
    });
  } finally {
    mounted.unmount();
  }
});

test("DOM: effort select sends the chosen level", async () => {
  const { mounted, root } = await openEditor();
  try {
    await waitFor(
      () => Boolean((byLabel(root, "默认 agent effort") as HTMLSelectElement)?.options.length),
      "effort 目录",
    );
    await selectValue(byLabel(root, "默认 agent effort") as HTMLSelectElement, "medium");
    // Wait until the draft (not just the select) carries the new level before saving.
    await waitFor(
      () =>
        callsTo(mounted, "/configuration/preview").some((call) =>
          ((call.body as { text?: string }).text ?? "").includes('"effort": "medium"'),
        ),
      "草稿写入 effort",
    );
    await waitFor(() => !button(root, "保存并装载").disabled, "校验完成");
    button(root, "保存并装载").click();
    await waitFor(() => callsTo(mounted, "/configuration/save").length === 1, "保存");
    assert.equal(savedAgent(mounted, -1).effort, "medium");
  } finally {
    mounted.unmount();
  }
});

test("DOM: explicit default uses the provider model rather than the project model", async () => {
  const config = JSON.parse(AGENT_CONFIG);
  config.defaults.agent.model = "gpt-6-luna";
  const { mounted, root } = await openEditor(JSON.stringify(config));
  try {
    await waitFor(
      () => [...(byLabel(root, "任务 model") as HTMLSelectElement).options]
        .some((option) => option.value === "gpt-6-luna"),
      "模型目录",
    );
    const inheritedEffort = byLabel(root, "任务 effort") as HTMLSelectElement;
    assert.equal([...inheritedEffort.options].some((option) => option.value === "high"), false);
    const model = byLabel(root, "任务 model") as HTMLSelectElement;
    assert.ok([...model.options].some((option) => option.value === "default"));
    await selectValue(model, "default");
    await waitFor(
      () => [...(byLabel(root, "任务 effort") as HTMLSelectElement).options]
        .some((option) => option.value === "high"),
      "provider 默认模型的 effort",
    );
    await waitFor(() => !button(root, "保存并装载").disabled, "校验完成");
    button(root, "保存并装载").click();
    await waitFor(() => callsTo(mounted, "/configuration/save").length === 1, "保存");
    assert.deepEqual(savedAgent(mounted), { model: "default", effort: "default" });
  } finally {
    mounted.unmount();
  }
});

test("DOM: an unknown authored model and effort stay selectable and are never rewritten", async () => {
  const { mounted, root } = await openEditor();
  try {
    // Pick the pinned task with a model/effort that the catalog does not know.
    button(root, "pinned").click();
    await waitFor(() => Boolean(byLabel(root, "任务 model")), "任务表单");
    await waitFor(
      () => textOf(root).includes("当前模型 “gpt-legacy” 不在目录中"),
      "未知模型提示",
    );
    assert.match(textOf(root), /不在目录中/);
    const model = byLabel(root, "任务 model") as HTMLSelectElement;
    const effort = byLabel(root, "任务 effort") as HTMLSelectElement;
    assert.equal(model.value, "gpt-legacy");
    assert.equal(effort.value, "legacy-level");
    assert.ok(
      [...effort.options].some((option) => option.value === "legacy-level"),
      "未知 effort 仍需作为可见选项保留",
    );
    await waitFor(() => !button(root, "保存并装载").disabled, "校验完成");
    button(root, "保存并装载").click();
    await waitFor(() => callsTo(mounted, "/configuration/save").length === 1, "保存");
    assert.deepEqual(savedAgent(mounted, 1), {
      provider: "codex",
      model: "gpt-legacy",
      effort: "legacy-level",
    });
  } finally {
    mounted.unmount();
  }
});

test("DOM: a host without models keeps values and explains why lists are unavailable", async () => {
  const mounted = await mountPlugin({
    withoutModels: true,
    config: {
      project: { id: "project-a", name: "项目 A", path: "/tmp/project-a" },
      text: AGENT_CONFIG,
      revision: "rev-1",
      exists: true,
    },
  });
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(
      () => textOf(root).includes("当前宿主未提供模型目录接口"),
      "旧宿主提示",
    );
    // Authored values are preserved verbatim in the JSON draft, not reset to a default.
    const defaults = JSON.parse(AGENT_CONFIG).defaults.agent as Record<string, string>;
    assert.equal(defaults.model, "gpt-6-sol");
    assert.equal(defaults.effort, "high");
    assert.equal(callsTo(mounted, "/configuration/save").length, 0);
  } finally {
    mounted.unmount();
  }
});

test("DOM: catalog failures keep the draft and a retry loads fresh levels", async () => {
  let attempts = 0;
  const mounted = await mountPlugin({
    models: {
      codex: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error("catalog offline"))
          : Promise.resolve(DEFAULT_CATALOGS.codex);
      },
    },
    config: {
      project: { id: "project-a", name: "项目 A", path: "/tmp/project-a" },
      text: AGENT_CONFIG,
      revision: "rev-1",
      exists: true,
    },
  });
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "编辑任务")), "任务列表");
    button(root, "编辑任务").click();
    await waitFor(() => textOf(root).includes("模型目录加载失败"), "失败提示");
    // The authored default stays visible/selected while the catalog is unavailable.
    assert.equal((byLabel(root, "默认 agent model") as HTMLSelectElement).value, "gpt-6-sol");
    assert.equal(callsTo(mounted, "/configuration/save").length, 0);
    button(root, "重试加载").click();
    await waitFor(
      () => [...(byLabel(root, "默认 agent effort") as HTMLSelectElement).options].some(
        (option) => option.value === "high",
      ),
      "重试后加载真实级别",
    );
    assert.equal(attempts, 2);
    assert.equal(callsTo(mounted, "/configuration/save").length, 0);
  } finally {
    mounted.unmount();
  }
});

// --------------------------- Run token usage ---------------------------

/** One prompt task whose detail view is opened directly from the inventory row. */
const USAGE_TASK = {
  projectId: "project-a",
  projectName: "项目 A",
  projectPath: "/tmp/project-a",
  taskId: "usage",
  definition: {
    id: "usage",
    name: "Usage",
    type: "prompt",
    enabled: true,
    cron: "0 0 9 * * *",
    timezone: "Asia/Shanghai",
    allowConcurrent: false,
    timeoutSeconds: 900,
    cwd: "/tmp/project-a",
    env: {},
    agent: { provider: "codex", model: "default" },
    args: [],
    prompt: "p",
    notify: false,
  },
  updatedAt: new Date().toISOString(),
  nextRun: null,
  activeRuns: [],
  lastRun: null,
};

function usageRun(usage: unknown, id = "run-usage") {
  const now = new Date().toISOString();
  return {
    id,
    projectId: "project-a",
    projectName: "项目 A",
    taskId: "usage",
    taskName: "Usage",
    status: "success",
    trigger: "manual",
    scheduledAt: now,
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    reason: null,
    workerPid: null,
    alertStatus: "none",
    alertError: null,
    alertAttempts: 0,
    ...(usage === undefined ? {} : { usage }),
  };
}

test("DOM: status bar shows per-run token totals with separators and provider semantics", async () => {
  const mounted = await mountPlugin({
    tasks: [USAGE_TASK],
    runs: [
      usageRun({
        inputTokens: 1234567,
        outputTokens: 8901,
        cacheReadTokens: 4321,
        cacheWriteTokens: null,
      }),
    ],
  });
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "Usage")), "任务列表");
    button(root, "Usage").click();
    await waitFor(
      () => Boolean(byLabel(root, "本次运行 Token")),
      "token 状态栏",
    );
    const tokens = byLabel(root, "本次运行 Token")!;
    assert.equal(textOf(tokens).includes("输入 1,234,567"), true);
    assert.equal(textOf(tokens).includes("输出 8,901"), true);
    assert.equal(textOf(tokens).includes("缓存 4,321"), true);
    // A missing cache-write metric is not shown as zero, and the partial sum is flagged.
    assert.equal(textOf(tokens).includes("缓存 4,321*"), true);
    const title = tokens.getAttribute("title") ?? "";
    assert.equal(title.includes("Codex 的缓存 token 已包含在输入中"), true);
    assert.equal(title.includes("DSH 的输入不含缓存读写"), true);
    assert.equal(title.includes("不代表 0"), true);
    // The tokens sit in the same status bar row as the run results and exit code.
    const meta = root.querySelector(".cron-meta")!;
    assert.equal(meta.contains(tokens), true);
    assert.equal(textOf(meta).includes("退出码 0"), true);
  } finally {
    mounted.unmount();
  }
});

test("DOM: missing usage renders dashes instead of a fabricated zero", async () => {
  const mounted = await mountPlugin({
    tasks: [USAGE_TASK],
    // A legacy run has no usage field at all; an empty aggregate must also stay unknown.
    runs: [usageRun(undefined, "legacy"), usageRun(null, "empty")],
  });
  try {
    const root = mounted.container;
    await waitFor(() => Boolean(findButton(root, "Usage")), "任务列表");
    button(root, "Usage").click();
    await waitFor(
      () => Boolean(byLabel(root, "本次运行 Token")),
      "token 状态栏",
    );
    const tokens = textOf(byLabel(root, "本次运行 Token"));
    assert.equal(tokens.includes("输入 —"), true);
    assert.equal(tokens.includes("输出 —"), true);
    assert.equal(tokens.includes("缓存 —"), true);
    assert.equal(tokens.includes("0"), false);
  } finally {
    mounted.unmount();
  }
});
