import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// jsdom ships no types in this repository; createRequire keeps this import type-free.
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: { url?: string },
  ) => { window: Window & typeof globalThis };
};

type WorkerHostModule = {
  mount(container: HTMLElement, host: unknown): void;
  unmount(container: HTMLElement): void;
};
type Mounted = {
  container: HTMLElement;
  calls: Array<{ method: string; path: string; body: unknown }>;
  listeners: Set<(context: unknown) => void>;
  emit(context: unknown): void;
  unmount(): void;
  dom: { window: Window & typeof globalThis };
};

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
let bundlePromise: Promise<string> | null = null;
let tempDirectory: string | null = null;

/** Builds the real browser bundle once; tests never import the TSX source or CSS directly. */
function bundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      tempDirectory = await mkdtemp(path.join(tmpdir(), "cloudcli-worker-ui-"));
      const outfile = path.join(tempDirectory, "client.js");
      await build({
        entryPoints: [path.join(pluginRoot, "client/index.tsx")],
        outfile,
        bundle: true,
        platform: "browser",
        target: "es2020",
        format: "esm",
        loader: { ".css": "text" },
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        logLevel: "silent",
      });
      return pathToFileURL(outfile).href;
    })();
  }
  return bundlePromise;
}

after(async () => {
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

/** Installs browser globals React expects before the bundle is imported. */
function installDom() {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='host'></div></body></html>",
    { url: "http://localhost/" },
  );
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
    globals[name] = (dom.window as unknown as Record<string, unknown>)[name];
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

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
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
async function typeInto(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  )!.set!;
  setter.call(input, value);
  const view = input.ownerDocument.defaultView as unknown as {
    Event: new (type: string, init?: { bubbles?: boolean }) => Event;
  };
  input.dispatchEvent(new view.Event("input", { bubbles: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
  await delay(0);
}

type TestContext = {
  theme: "light" | "dark";
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};
const DEFAULT_CONTEXT: TestContext = {
  theme: "light",
  project: { name: "project-a", path: "/tmp/project-a" },
  session: { id: "session-1", title: "主会话" },
};

type RunOverrides = Partial<Record<string, unknown>>;
function run(overrides: RunOverrides = {}) {
  return {
    id: "run-1",
    workerId: "worker-1",
    requestId: "request-1",
    status: "running",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: null,
    model: "deepseek-v4",
    provider: "deepseek",
    effort: "high",
    timeoutSeconds: null,
    home: "/tmp/home",
    sessionsRoot: "/tmp/home/sessions/dsh",
    nativeSessionId: "native-session-1",
    nativeSessionFile: "/tmp/home/sessions/dsh/native-session-1.jsonl",
    exitCode: null,
    finalText: null,
    error: null,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: null },
    progress: {
      steps: 3,
      phase: "working",
      currentTool: "bash",
      lastEventAt: new Date().toISOString(),
      softReminderSentAt: null,
      hardTimeoutAt: null,
    },
    ...overrides,
  };
}
const CONFIG_DEFAULTS = {
  DSH: {
    id: "dsh-default",
    name: "DSH default",
    type: "dsh",
    enabled: true,
    roles: [],
    concurrency: 3,
    model: null,
    effort: null,
  },
  PI: {
    id: "pi-default",
    name: "Pi default",
    type: "pi",
    enabled: true,
    roles: [],
    concurrency: 3,
    model: null,
    effort: null,
  },
  CODEX: {
    id: "codex-default",
    name: "Codex default",
    type: "codex",
    enabled: true,
    roles: [],
    concurrency: 3,
    model: null,
    effort: null,
    codex: {
      modelProvider: null,
      env: { CODEX_PROXY_BYPASS: "1" },
      legacyExtraArgs: ["-c", "model_provider=magpie"],
    },
  },
};

function configDefaults() {
  return structuredClone([
    CONFIG_DEFAULTS.DSH,
    CONFIG_DEFAULTS.PI,
    CONFIG_DEFAULTS.CODEX,
  ]);
}

function worker(overrides: Record<string, unknown> = {}) {
  return {
    id: "worker-1",
    type: "dsh",
    configId: "dsh-default",
    configName: "DSH default",
    taskName: "任务一",
    ownerId: "owner-1",
    parentSessionId: "session-1",
    projectId: "project-a",
    projectPath: "/tmp/project-a",
    writePaths: ["plugins/worker/client/"],
    workspace: {
      mode: "existing",
      path: "/tmp/project-a",
      createdByPlugin: false,
    },
    cwd: "/tmp/project-a",
    createdAt: new Date().toISOString(),
    latestRun: run(),
    ...overrides,
  };
}
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    workers: [worker()],
    counts: {
      dsh: counts({ running: 1 }),
      pi: counts(),
      codex: counts(),
      total: counts({ running: 1 }),
    },
    settings: {
      schemaVersion: 2,
      configs: configDefaults(),
      defaultConfigId: "dsh-default",
      concurrency: { dsh: 3, pi: 3, codex: 3 },
      defaultWorkerType: "dsh",
      enabled: { dsh: true, pi: true, codex: true },
      roles: { dsh: [], pi: [], codex: [] },
      defaults: {
        dsh: { model: null, effort: null },
        pi: { model: null, effort: null },
        codex: { model: null, effort: null },
      },
      codex: {
        env: { CODEX_PROXY_BYPASS: "1" },
        extraArgs: ["-c", "model_provider=magpie"],
      },
      softReminderSeconds: 600,
      softReminderSteps: 20,
      hardTimeoutSeconds: null,
      retentionDays: 1,
    },
    configUsage: {},
    notifications: [],
    ...overrides,
  };
}
function counts(overrides: Record<string, number> = {}) {
  return {
    queued: 0,
    starting: 0,
    running: 0,
    stopping: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    unknown: 0,
    ...overrides,
  };
}

type Mode = {
  context?: TestContext;
  state?: (path: string) => Promise<unknown> | unknown;
  detail?: (workerId: string) => unknown;
  logs?: (workerId: string, path: string) => unknown;
  settings?: (body: unknown) => unknown;
  models?: (provider: "codex" | "dsh") => Promise<unknown>;
  codexProviders?: () => Promise<unknown>;
  codexProviderModels?: (modelProvider: string) => Promise<unknown>;
  piCatalog?: () => Promise<unknown>;
};

const DSH_MODELS = {
  DEFAULT: "deepseek-v4",
  OPTIONS: [
    { value: "default", label: "执行器默认" },
    { value: "deepseek-v4", label: "DeepSeek V4" },
    {
      value: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      effort: { default: "low", values: [{ value: "low" }, { value: "high" }] },
    },
  ],
};
const CODEX_MODELS = {
  DEFAULT: "gpt-6-sol",
  OPTIONS: [
    {
      value: "gpt-6-sol",
      label: "GPT-6 Sol",
      effort: { default: "medium", values: [{ value: "low" }, { value: "high" }] },
    },
    { value: "gpt-6-mini", label: "GPT-6 Mini" },
  ],
};
const CODEX_DIRECTORY = {
  defaultProvider: "magpie",
  providers: [
    { id: "openai", name: "OpenAI" },
    { id: "magpie", name: "Magpie" },
  ],
  hasCustomProviders: true,
};
// Service catalogs deliberately differ from the host model metadata: metadata only labels ids.
const CODEX_SERVICE_MODELS: Record<string, string[]> = {
  magpie: ["magpie-1", "magpie-fast"],
  openai: ["gpt-6-sol", "gpt-6-mini"],
};
const PI_CATALOG = {
  models: [
    { provider: "anthropic", id: "claude-sonnet", reasoning: true },
    { provider: "openrouter", id: "claude-sonnet", reasoning: false },
  ],
  thinkingLevels: ["off", "low", "high"],
};

async function mountPlugin(mode: Mode = {}): Promise<Mounted> {
  const dom = installDom();
  const module = (await import(await bundle())) as WorkerHostModule;
  const container = dom.window.document.getElementById("host")!;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const listeners = new Set<(context: unknown) => void>();
  let context = mode.context ?? DEFAULT_CONTEXT;
  const host = {
    models: mode.models ?? (async (provider: "codex" | "dsh") =>
      provider === "codex" ? CODEX_MODELS : DSH_MODELS),
    codexModelProviders: mode.codexProviders ?? (async () => CODEX_DIRECTORY),
    codexModelProviderModels:
      mode.codexProviderModels ??
      (async (modelProvider: string) => ({
        modelProvider,
        models: CODEX_SERVICE_MODELS[modelProvider] ?? ["svc-" + modelProvider],
      })),
    get context() {
      return context;
    },
    onContextChange(callback: (value: unknown) => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async rpc(method: string, pathAndQuery: string, body?: unknown) {
      calls.push({ method, path: pathAndQuery, body });
      if (pathAndQuery.startsWith("/state")) {
        if (mode.state) return mode.state(pathAndQuery);
        return snapshot();
      }
      const workerMatch = /^\/workers\/([^/?]+)$/.exec(pathAndQuery);
      if (workerMatch) {
        if (mode.detail) return mode.detail(workerMatch[1]!);
        return { worker: worker(), runs: [run()] };
      }
      if (/\/workers\/[^/]+\/logs/.test(pathAndQuery)) {
        if (mode.logs) return mode.logs("worker-1", pathAndQuery);
        return { text: "", nextCursor: null, done: true };
      }
      if (pathAndQuery === "/cancel") return { workerIds: ["worker-1"] };
      if (pathAndQuery === "/catalog/pi") {
        if (mode.piCatalog) return mode.piCatalog();
        return PI_CATALOG;
      }
      if (pathAndQuery === "/settings") {
        if (mode.settings) return mode.settings(body);
        const input = body as Record<string, unknown>;
        return {
          ...input,
          schemaVersion: 2,
          softReminderSeconds: 600,
          softReminderSteps: 20,
          hardTimeoutSeconds: null,
        };
      }
      if (pathAndQuery === "/recover" || pathAndQuery === "/cleanup")
        return { ok: true };
      if (pathAndQuery === "/notifications/retry")
        return { notifications: [] };
      throw new Error("unexpected RPC " + method + " " + pathAndQuery);
    },
  };
  module.mount(container, host);
  return {
    container,
    calls,
    listeners,
    dom,
    emit(next) {
      context = next as TestContext;
      for (const listener of [...listeners]) listener(context);
    },
    unmount() {
      module.unmount(container);
    },
  };
}

function callsTo(mounted: Mounted, path: string) {
  return mounted.calls.filter((call) => call.path === path);
}
function stateCalls(mounted: Mounted) {
  return mounted.calls.filter((call) => call.path.startsWith("/state"));
}

test("DOM: switching context drops the old in-flight state response", async () => {
  const waiting = new Map<string, (value: unknown) => void>();
  const mounted = await mountPlugin({
    state: (path) =>
      new Promise((resolve) => {
        waiting.set(path, resolve);
      }),
  });
  try {
    await waitFor(() => waiting.size === 1, "首个 state 请求");
    const firstPath = [...waiting.keys()][0]!;
    assert.equal(
      firstPath,
      "/state?projectId=project-a&parentSessionId=session-1",
    );
    mounted.emit({
      theme: "light",
      project: { name: "project-b", path: "/tmp/project-b" },
      session: { id: "session-2", title: "另一个会话" },
    });
    await waitFor(() => waiting.size === 2, "新上下文的 state 请求");
    const secondPath = [...waiting.keys()][1]!;
    assert.equal(
      secondPath,
      "/state?projectId=project-b&parentSessionId=session-2",
    );
    // The new context resolves first; the superseded response must never overwrite it.
    waiting.get(secondPath)!(
      snapshot({
        workers: [
          worker({
            id: "worker-b",
            taskName: "任务 B",
            projectId: "project-b",
            parentSessionId: "session-2",
            latestRun: run({
              id: "run-b",
              workerId: "worker-b",
              nativeSessionId: "native-b",
            }),
          }),
        ],
      }),
    );
    await waitFor(() => textOf(mounted.container).includes("任务 B"), "新任务");
    waiting.get(firstPath)!(
      snapshot({
        workers: [
          worker({ id: "worker-a", taskName: "任务 A" }),
        ],
      }),
    );
    await delay(80);
    assert.equal(textOf(mounted.container).includes("任务 A"), false);
    assert.equal(textOf(mounted.container).includes("任务 B"), true);
  } finally {
    mounted.unmount();
  }
});

test("DOM: unavailable scopes are disabled and scope switches change the query", async () => {
  const mounted = await mountPlugin({
    context: { theme: "light", project: null, session: null },
  });
  try {
    await waitFor(() => stateCalls(mounted).length === 1, "全部视图请求");
    assert.equal(stateCalls(mounted)[0]!.path, "/state");
    assert.equal((byLabel(mounted.container, "范围：当前会话") as HTMLButtonElement).disabled, true);
    assert.equal((byLabel(mounted.container, "范围：当前项目") as HTMLButtonElement).disabled, true);
    assert.equal(
      byLabel(mounted.container, "范围：全部")!.getAttribute("aria-pressed"),
      "true",
    );
    mounted.emit({
      theme: "light",
      project: { name: "project-a", path: "/tmp/project-a" },
      session: null,
    });
    await waitFor(
      () =>
        !(byLabel(mounted.container, "范围：当前项目") as HTMLButtonElement)
          .disabled,
      "项目可用",
    );
    assert.equal(
      (byLabel(mounted.container, "范围：当前会话") as HTMLButtonElement).disabled,
      true,
    );
    (byLabel(mounted.container, "范围：当前项目") as HTMLButtonElement).click();
    await waitFor(
      () => stateCalls(mounted).at(-1)?.path === "/state?projectId=project-a",
      "项目查询",
    );
    (byLabel(mounted.container, "范围：全部") as HTMLButtonElement).click();
    await waitFor(
      () => stateCalls(mounted).at(-1)?.path === "/state",
      "全部查询",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: unmount clears polling and the host context callback", async () => {
  const mounted = await mountPlugin();
  try {
    await waitFor(() => stateCalls(mounted).length === 1, "初始 state 请求");
    await waitFor(
      () => textOf(mounted.container).includes("任务一"),
      "初始状态",
    );
    assert.equal(mounted.listeners.size, 1);
    mounted.unmount();
    assert.equal(mounted.listeners.size, 0);
    await delay(2200);
    assert.equal(stateCalls(mounted).length, 1);
  } finally {
    mounted.unmount();
  }
});

test("DOM: current-session stop pauses auto wake for exactly that owner key", async () => {
  const mounted = await mountPlugin();
  try {
    await waitFor(
      () => Boolean(findButton(mounted.container, "停止本会话全部")),
      "列表",
    );
    button(mounted.container, "停止本会话全部").click();
    await waitFor(() => callsTo(mounted, "/cancel").length === 1, "取消请求");
    assert.deepEqual(callsTo(mounted, "/cancel")[0]!.body, {
      all: true,
      parentSessionId: "session-1",
      projectId: "project-a",
      pause: true,
    });
  } finally {
    mounted.unmount();
  }
});

test("DOM: per-worker cancel sends only that worker id", async () => {
  const mounted = await mountPlugin();
  try {
    await waitFor(() => Boolean(byLabel(mounted.container, "取消 任务一")), "取消按钮");
    (byLabel(mounted.container, "取消 任务一") as HTMLButtonElement).click();
    await waitFor(() => callsTo(mounted, "/cancel").length === 1, "取消请求");
    assert.deepEqual(callsTo(mounted, "/cancel")[0]!.body, {
      workerIds: ["worker-1"],
    });
  } finally {
    mounted.unmount();
  }
});

/** Clicks every visible "重试" button, used by the catalog failure tests. */
function retryButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter(
    (item) => textOf(item).includes("重试"),
  );
}

function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value);
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => textOf(option));
}

async function openSettings(mounted: Mounted) {
  await waitFor(() => {
    const entry = findButton(mounted.container, "Worker 设置");
    return entry !== undefined && !entry.disabled;
  }, "设置入口");
  button(mounted.container, "Worker 设置").click();
  await waitFor(
    () => Boolean(byLabel(mounted.container, "新增 DSH 配置")),
    "配置编辑器",
  );
}

test("DOM: configs can be added, cloned with hidden Codex values, deleted before save and saved whole", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);

    // A not-yet-saved config can always be deleted again without touching the server.
    (byLabel(mounted.container, "新增 DSH 配置") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 4 名称")), "新增配置");
    assert.equal(
      (byLabel(mounted.container, "配置 4 名称") as HTMLInputElement).value,
      "DSH 配置",
    );
    await typeInto(
      byLabel(mounted.container, "配置 4 名称") as HTMLInputElement,
      "临时配置",
    );
    (byLabel(mounted.container, "配置 4 删除") as HTMLButtonElement).click();
    await waitFor(() => !byLabel(mounted.container, "配置 4 名称"), "删除未保存配置");
    assert.equal(callsTo(mounted, "/settings").length, 0);

    // Duplicating copies env and legacy extra args but assigns a fresh id and name.
    (byLabel(mounted.container, "新增 Pi 配置") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 4 名称")), "新增 Pi 配置");
    await typeInto(
      byLabel(mounted.container, "配置 4 名称") as HTMLInputElement,
      "后备 Pi",
    );
    (byLabel(mounted.container, "配置 3 复制") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 5 名称")), "复制 Codex 配置");
    assert.equal(
      (byLabel(mounted.container, "配置 5 名称") as HTMLInputElement).value,
      "Codex default 副本",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 5 Codex 环境变量") as HTMLTextAreaElement).value,
      "CODEX_PROXY_BYPASS=1",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 5 模型") as HTMLSelectElement).value,
      "",
    );

    // The copy becomes the explicit default and the whole document is saved atomically.
    (byLabel(mounted.container, "配置 5 设为默认") as HTMLButtonElement).click();
    const defaultSelect = byLabel(
      mounted.container,
      "默认 Worker 配置",
    ) as HTMLSelectElement;
    await waitFor(
      () =>
        [...defaultSelect.options]
          .find((option) => option.value === defaultSelect.value)
          ?.textContent?.includes("Codex default 副本") === true,
      "复制配置设为默认",
    );
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存请求");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
      defaultConfigId: string;
      retentionDays: number;
    };
    assert.equal(body.retentionDays, 1);
    assert.deepEqual(
      body.configs.map((config) => config.name),
      ["DSH default", "Pi default", "Codex default", "后备 Pi", "Codex default 副本"],
    );
    assert.equal(new Set(body.configs.map((config) => config.id)).size, 5);
    const copied = body.configs[4]!;
    assert.notEqual(copied.id, "codex-default");
    assert.equal(body.defaultConfigId, copied.id);
    assert.deepEqual(copied.codex, {
      modelProvider: null,
      env: { CODEX_PROXY_BYPASS: "1" },
      legacyExtraArgs: ["-c", "model_provider=magpie"],
    });
    const added = body.configs[3]!;
    assert.deepEqual(
      { ...added, id: undefined },
      {
        id: undefined,
        name: "后备 Pi",
        type: "pi",
        enabled: true,
        roles: [],
        concurrency: 3,
        model: null,
        effort: null,
      },
    );

    // Saving twice keeps every config id and the hidden Codex values stable.
    await waitFor(() => {
      const saveButton = findButton(mounted.container, "保存设置");
      return saveButton !== undefined && !saveButton.disabled;
    }, "首次保存完成");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 2, "第二次保存");
    const second = callsTo(mounted, "/settings")[1]!.body as typeof body;
    assert.deepEqual(
      second.configs.map((config) => config.id),
      body.configs.map((config) => config.id),
    );
    assert.equal(second.defaultConfigId, body.defaultConfigId);
    assert.deepEqual(second.configs[4]!.codex, copied.codex);
    assert.equal(second.configs[4]!.model, null);
  } finally {
    mounted.unmount();
  }
});

test("DOM: usage locks the engine, active runs block deletion, and disabling the default moves it", async () => {
  const usage = {
    "codex-default": { referenced: true, activeRuns: 1 },
    "pi-default": { referenced: true, activeRuns: 0 },
  };
  const mounted = await mountPlugin({
    state: () => snapshot({ configUsage: usage }),
  });
  try {
    await openSettings(mounted);

    assert.equal(
      (byLabel(mounted.container, "配置 3 执行引擎") as HTMLSelectElement).disabled,
      true,
    );
    assert.equal(
      (byLabel(mounted.container, "配置 3 删除") as HTMLButtonElement).disabled,
      true,
    );
    assert.equal(
      (byLabel(mounted.container, "配置 1 执行引擎") as HTMLSelectElement).disabled,
      false,
    );
    // A referenced config without active runs can still be deleted; history is kept.
    assert.equal(
      (byLabel(mounted.container, "配置 2 删除") as HTMLButtonElement).disabled,
      false,
    );
    assert.ok(textOf(mounted.container).includes("删除只移除配置"));
    (byLabel(mounted.container, "配置 2 删除") as HTMLButtonElement).click();
    await waitFor(() => !byLabel(mounted.container, "配置 3 名称"), "删除 Pi 配置");

    // Disabling the default selects the next enabled config as the new default.
    (byLabel(mounted.container, "配置 1 启用") as HTMLInputElement).click();
    await waitFor(
      () =>
        (byLabel(mounted.container, "默认 Worker 配置") as HTMLSelectElement).value ===
        "codex-default",
      "默认自动切换",
    );
    // Active runs do not prevent disabling; they only prevent deletion.
    (byLabel(mounted.container, "配置 2 启用") as HTMLInputElement).click();
    await waitFor(
      () => textOf(mounted.container).includes("至少需要启用一个 Worker 配置"),
      "全部停用错误",
    );
    assert.equal(button(mounted.container, "保存设置").disabled, true);
    (byLabel(mounted.container, "配置 1 启用") as HTMLInputElement).click();
    await waitFor(
      () => (byLabel(mounted.container, "配置 1 启用") as HTMLInputElement).checked,
      "恢复启用",
    );
    (byLabel(mounted.container, "配置 1 设为默认") as HTMLButtonElement).click();
    await waitFor(
      () => (byLabel(mounted.container, "默认 Worker 配置") as HTMLSelectElement).value === "dsh-default",
      "默认切回 DSH",
    );
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "停用后保存");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<{ id: string; enabled: boolean }>;
      defaultConfigId: string;
    };
    assert.deepEqual(
      body.configs.map((config) => config.id),
      ["dsh-default", "codex-default"],
    );
    assert.deepEqual(
      body.configs.map((config) => [config.id, config.enabled]),
      [
        ["dsh-default", true],
        ["codex-default", false],
      ],
    );
    assert.equal(body.defaultConfigId, "dsh-default");
  } finally {
    mounted.unmount();
  }
});

test("DOM: default Codex service resolves defaultProvider while explicit services use their own ids", async () => {
  const requested: string[] = [];
  const mounted = await mountPlugin({
    codexProviderModels: async (id) => {
      requested.push(id);
      return { modelProvider: id, models: CODEX_SERVICE_MODELS[id] ?? ["svc-" + id] };
    },
  });
  try {
    await openSettings(mounted);
    const codexProvider = byLabel(
      mounted.container,
      "配置 3 Codex 模型服务",
    ) as HTMLSelectElement;
    const codexModel = byLabel(mounted.container, "配置 3 模型") as HTMLSelectElement;
    const codexReasoning = byLabel(
      mounted.container,
      "配置 3 reasoning",
    ) as HTMLSelectElement;
    assert.equal(codexProvider.value, "");
    assert.equal(codexProvider.options[0]!.textContent, "使用默认模型服务");
    // "Use the default service" means the directory's magpie id, not the host metadata list.
    await waitFor(
      () => optionValues(codexModel).includes("magpie-fast"),
      "默认模型服务解析为 magpie",
    );
    assert.deepEqual(requested, ["magpie"]);
    assert.deepEqual(optionValues(codexModel), ["", "magpie-1", "magpie-fast"]);
    assert.deepEqual(optionValues(codexReasoning), [""]);
    await typeInto(codexModel, "magpie-fast");
    assert.equal(codexReasoning.value, "");

    // An explicit service switches id, clears model/effort and loads its own model list.
    await typeInto(codexProvider, "openai");
    await waitFor(
      () => optionValues(codexModel).includes("gpt-6-sol"),
      "显式服务模型",
    );
    assert.equal(codexProvider.value, "openai");
    assert.equal(codexModel.value, "");
    assert.equal(codexReasoning.value, "");
    assert.deepEqual(optionValues(codexModel), ["", "gpt-6-sol", "gpt-6-mini"]);
    assert.equal(
      optionLabels(codexModel)[optionValues(codexModel).indexOf("gpt-6-sol")],
      "GPT-6 Sol",
    );
    await typeInto(codexModel, "gpt-6-sol");
    await waitFor(
      () => optionValues(codexReasoning).includes("high"),
      "metadata reasoning",
    );
    await typeInto(codexReasoning, "high");

    // Returning to the default service clears model/effort again and reuses the cached magpie id.
    await typeInto(codexProvider, "");
    await waitFor(
      () => optionValues(codexModel).includes("magpie-1"),
      "切回默认服务",
    );
    assert.equal(codexModel.value, "");
    assert.equal(codexReasoning.value, "");
    assert.deepEqual(optionValues(codexModel), ["", "magpie-1", "magpie-fast"]);
    await typeInto(codexModel, "magpie-1");
    assert.deepEqual(optionValues(codexReasoning), [""]);
    assert.deepEqual(requested, ["magpie", "openai"]);

    // DSH maps the catalog's `default` sentinel to null and keeps real effort levels.
    const dshModel = byLabel(mounted.container, "配置 1 模型") as HTMLSelectElement;
    const dshReasoning = byLabel(
      mounted.container,
      "配置 1 reasoning",
    ) as HTMLSelectElement;
    assert.deepEqual(optionValues(dshModel), [
      "",
      "deepseek-v4",
      "deepseek-v4-flash",
    ]);
    assert.equal(dshModel.options[0]!.textContent, "使用默认值");
    await typeInto(dshModel, "deepseek-v4-flash");
    await waitFor(
      () => optionValues(dshReasoning).includes("high"),
      "DSH reasoning",
    );
    await typeInto(dshReasoning, "high");

    // Pi keeps provider/model identity; a non-reasoning model does not claim thinking levels.
    const piModel = byLabel(mounted.container, "配置 2 模型") as HTMLSelectElement;
    const piReasoning = byLabel(
      mounted.container,
      "配置 2 reasoning",
    ) as HTMLSelectElement;
    assert.deepEqual(optionValues(piModel), [
      "",
      "anthropic/claude-sonnet",
      "openrouter/claude-sonnet",
    ]);
    await typeInto(piModel, "anthropic/claude-sonnet");
    await waitFor(
      () => optionValues(piReasoning).includes("high"),
      "Pi reasoning",
    );
    await typeInto(piReasoning, "high");
    await typeInto(piModel, "openrouter/claude-sonnet");
    await waitFor(
      () => !optionValues(piReasoning).includes("high"),
      "非 reasoning 模型",
    );
    assert.deepEqual(optionValues(piReasoning), ["", "off"]);
    assert.equal(piReasoning.value, "");
    assert.equal(callsTo(mounted, "/catalog/pi").length, 1);

    await waitFor(() => !button(mounted.container, "保存设置").disabled, "可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存联动结果");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
    };
    const byName = Object.fromEntries(
      body.configs.map((config) => [config.name, config]),
    );
    assert.equal(byName["Codex default"].model, "magpie-1");
    assert.equal(byName["Codex default"].effort, null);
    assert.equal(byName["Codex default"].codex.modelProvider, null);
    assert.equal(byName["DSH default"].model, "deepseek-v4-flash");
    assert.equal(byName["DSH default"].effort, "high");
    assert.equal(byName["Pi default"].model, "openrouter/claude-sonnet");
    assert.equal(byName["Pi default"].effort, null);
  } finally {
    mounted.unmount();
  }
});

test("DOM: Codex service errors stay on their own card and late responses never refill another menu", async () => {
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const requested: string[] = [];
  let openaiCalls = 0;
  const settings = snapshot().settings as Record<string, unknown> & {
    configs: Array<Record<string, any>>;
  };
  settings.configs = [
    ...configDefaults(),
    {
      id: "codex-alt",
      name: "Codex alt",
      type: "codex",
      enabled: true,
      roles: [],
      concurrency: 2,
      model: null,
      effort: null,
      codex: { modelProvider: "openai", env: {}, legacyExtraArgs: [] },
    },
  ];
  const mounted = await mountPlugin({
    state: () => snapshot({ settings }),
    codexProviderModels: (id) => {
      requested.push(id);
      if (id === "magpie") {
        return new Promise((resolve, reject) => {
          pending.set("magpie", { resolve, reject });
        });
      }
      openaiCalls += 1;
      if (openaiCalls === 1) {
        return new Promise((resolve, reject) => {
          pending.set("openai", { resolve, reject });
        });
      }
      return Promise.resolve({ modelProvider: "openai", models: ["openai-ok"] });
    },
  });
  try {
    await openSettings(mounted);
    const card3 = byLabel(
      mounted.container,
      "配置 3 Codex 模型服务",
    )!.closest("details")!;
    const card4 = byLabel(
      mounted.container,
      "配置 4 Codex 模型服务",
    )!.closest("details")!;
    const model3 = byLabel(mounted.container, "配置 3 模型") as HTMLSelectElement;
    const model4 = byLabel(mounted.container, "配置 4 模型") as HTMLSelectElement;

    // The default-service card resolves magpie; the explicit openai card is still pending.
    pending.get("magpie")!.resolve({ modelProvider: "magpie", models: ["magpie-1"] });
    await waitFor(() => optionValues(model3).includes("magpie-1"), "默认服务就绪");
    assert.equal(textOf(card3).includes("读取失败"), false);
    assert.equal(textOf(card4).includes("读取失败"), false);
    assert.deepEqual(optionValues(model4), [""]);

    // Leaving the pending openai service shows the cached magpie menu with no error.
    await typeInto(
      byLabel(mounted.container, "配置 4 Codex 模型服务") as HTMLSelectElement,
      "",
    );
    await waitFor(() => optionValues(model4).includes("magpie-1"), "切回默认服务");
    assert.equal(textOf(card4).includes("读取失败"), false);

    // The late openai rejection stays cached under openai and cannot leak into this menu.
    pending.get("openai")!.reject(new Error("openai down"));
    await delay(30);
    assert.equal(textOf(mounted.container).includes("openai down"), false);
    assert.deepEqual(optionValues(model4), ["", "magpie-1"]);

    // Re-entering openai shows only that card's cached failure; retry recovers it.
    await typeInto(
      byLabel(mounted.container, "配置 4 Codex 模型服务") as HTMLSelectElement,
      "openai",
    );
    await waitFor(() => textOf(card4).includes("openai down"), "当前服务错误");
    assert.equal(textOf(card3).includes("openai down"), false);
    findButton(card4, "重试")!.click();
    await waitFor(
      () => optionValues(model4).includes("openai-ok"),
      "重试恢复当前服务",
    );
    assert.equal(textOf(card4).includes("读取失败"), false);
    assert.equal(openaiCalls, 2);

    // Repeatedly switching to an already-loaded id does not request it again.
    await typeInto(
      byLabel(mounted.container, "配置 4 Codex 模型服务") as HTMLSelectElement,
      "",
    );
    await typeInto(
      byLabel(mounted.container, "配置 4 Codex 模型服务") as HTMLSelectElement,
      "openai",
    );
    await waitFor(() => optionValues(model4).includes("openai-ok"), "缓存复用");
    assert.equal(openaiCalls, 2);
    assert.equal(requested.filter((id) => id === "magpie").length, 1);

    await waitFor(() => !button(mounted.container, "保存设置").disabled, "可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存服务选择");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
    };
    assert.equal(body.configs[2]!.codex.modelProvider, null);
    assert.equal(body.configs[3]!.codex.modelProvider, "openai");
  } finally {
    mounted.unmount();
  }
});

test("DOM: catalog failures stay local, keep stored values and retry in place", async () => {
  let modelsFail = true;
  let piFail = true;
  const settings = snapshot().settings as Record<string, any>;
  settings.configs = configDefaults();
  settings.configs[0] = {
    ...settings.configs[0],
    model: "dsh-legacy",
    effort: "high",
  };
  settings.configs[2] = {
    ...settings.configs[2],
    model: "legacy-codex",
    effort: "ultra",
    codex: {
      modelProvider: "magpie",
      env: { CODEX_PROXY_BYPASS: "1" },
      legacyExtraArgs: ["-c", "model_provider=magpie"],
    },
  };
  settings.configs[1] = {
    ...settings.configs[1],
    model: "anthropic/legacy-model",
    effort: "low",
  };
  const mounted = await mountPlugin({
    state: () => snapshot({ settings }),
    models: async (provider) => {
      if (modelsFail) throw new Error("catalog down " + provider);
      return provider === "codex" ? CODEX_MODELS : DSH_MODELS;
    },
    piCatalog: async () => {
      if (piFail) throw new Error("pi catalog down");
      return PI_CATALOG;
    },
    codexProviders: async () => {
      throw new Error("directory down");
    },
  });
  try {
    await openSettings(mounted);
    await waitFor(
      () =>
        [...mounted.container.querySelectorAll('[role="alert"]')].some((node) =>
          textOf(node).includes("模型目录读取失败，已保留当前配置值"),
        ),
      "目录错误",
    );
    // Stored values are still selected and only saving edits must not drop them.
    assert.equal(
      (byLabel(mounted.container, "配置 3 模型") as HTMLSelectElement).value,
      "legacy-codex",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 3 reasoning") as HTMLSelectElement).value,
      "ultra",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 1 模型") as HTMLSelectElement).value,
      "dsh-legacy",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 2 模型") as HTMLSelectElement).value,
      "anthropic/legacy-model",
    );
    await typeInto(
      byLabel(mounted.container, "配置 1 名称") as HTMLInputElement,
      "DSH 改名",
    );
    await waitFor(() => !button(mounted.container, "保存设置").disabled, "目录失败仍可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "目录失败保存");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
    };
    assert.equal(body.configs[0]!.model, "dsh-legacy");
    assert.equal(body.configs[0]!.effort, "high");
    assert.equal(body.configs[2]!.model, "legacy-codex");
    assert.equal(body.configs[2]!.effort, "ultra");
    assert.equal(body.configs[2]!.codex.modelProvider, "magpie");
    assert.equal(body.configs[1]!.model, "anthropic/legacy-model");

    // Retrying recovers the catalogs without clearing any stored selection.
    modelsFail = false;
    piFail = false;
    const retries = retryButtons(mounted.container);
    assert.ok(retries.length >= 3);
    for (const retry of retries) retry.click();
    await waitFor(
      () =>
        optionLabels(byLabel(mounted.container, "配置 1 模型") as HTMLSelectElement).includes(
          "DeepSeek V4",
        ),
      "DSH 目录恢复",
    );
    assert.ok(
      optionLabels(byLabel(mounted.container, "配置 2 模型") as HTMLSelectElement).includes(
        "anthropic/legacy-model（当前已保存）",
      ),
    );
    await waitFor(
      () =>
        retryButtons(mounted.container).length === 0 ||
        optionLabels(byLabel(mounted.container, "配置 2 模型") as HTMLSelectElement).includes(
          "anthropic/claude-sonnet",
        ),
      "Pi 目录恢复",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 1 模型") as HTMLSelectElement).value,
      "dsh-legacy",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: an older service without configs shows an upgrade notice and recovers on refresh", async () => {
  const oldSnapshot = snapshot();
  const oldSettings = oldSnapshot.settings as Record<string, unknown>;
  delete oldSettings.configs;
  delete oldSettings.schemaVersion;
  const newSnapshot = snapshot();
  let upgraded = false;
  const mounted = await mountPlugin({
    state: () => (upgraded ? newSnapshot : oldSnapshot),
  });
  try {
    await waitFor(() => textOf(mounted.container).includes("任务一"), "旧版列表");
    button(mounted.container, "Worker 设置").click();
    await waitFor(
      () =>
        textOf(mounted.container).includes(
          "Worker 插件服务版本较旧，暂不支持 Worker 配置管理",
        ),
      "旧版设置提示",
    );
    assert.equal(byLabel(mounted.container, "新增 DSH 配置"), null);
    assert.equal(findButton(mounted.container, "保存设置"), undefined);
    assert.equal(callsTo(mounted, "/settings").length, 0);

    // The old service still supports the existing list and detail flows.
    button(mounted.container, "返回列表").click();
    await waitFor(() => textOf(mounted.container).includes("任务一"), "返回旧版列表");
    (byLabel(mounted.container, "查看 任务一") as HTMLButtonElement).click();
    await waitFor(() => textOf(mounted.container).includes("本次运行"), "旧版任务详情");
    button(mounted.container, "返回列表").click();
    await waitFor(() => Boolean(byLabel(mounted.container, "查看 任务一")), "退出旧版详情");

    // A later state response with configs enables the new editor.
    button(mounted.container, "Worker 设置").click();
    await waitFor(() => Boolean(findButton(mounted.container, "返回列表")), "再次打开旧版设置");
    upgraded = true;
    await waitFor(
      () => Boolean(byLabel(mounted.container, "新增 DSH 配置")),
      "新版设置恢复",
      5000,
    );
    assert.ok(findButton(mounted.container, "保存设置"));
    await waitFor(() => !button(mounted.container, "保存设置").disabled, "新版设置可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "新版设置保存");
    const saved = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<{ id: string }>;
      defaultConfigId: string;
    };
    assert.deepEqual(
      saved.configs.map((config) => config.id),
      ["dsh-default", "pi-default", "codex-default"],
    );
    assert.equal(saved.defaultConfigId, "dsh-default");
  } finally {
    mounted.unmount();
  }
});

test("DOM: list and detail show recorded task roles and handle legacy records without a role", async () => {
  const ui = worker({ taskRole: "ui_design", taskName: "界面任务" });
  const legacy = worker({ id: "worker-legacy", taskName: "历史任务" });
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: [ui, legacy],
        counts: {
          dsh: counts({ running: 2 }),
          pi: counts(),
          codex: counts(),
          total: counts({ running: 2 }),
        },
      }),
    detail: (workerId) =>
      workerId === "worker-legacy"
        ? {
            worker: legacy,
            runs: [run({ workerId: "worker-legacy" })],
          }
        : { worker: ui, runs: [run()] },
  });
  try {
    await waitFor(
      () => textOf(mounted.container).includes("界面任务"),
      "列表角色",
    );
    const headings = [...mounted.container.querySelectorAll(".worker-table th")];
    const roleColumn = headings.findIndex((heading) => textOf(heading) === "任务角色");
    assert.notEqual(roleColumn, -1);
    const rows = mounted.container.querySelectorAll(".worker-table tbody tr");
    assert.equal(textOf(rows[0]!.children[roleColumn]), "UI设计");
    assert.equal(textOf(rows[1]!.children[roleColumn]), "未指定");
    (byLabel(mounted.container, "查看 界面任务") as HTMLButtonElement).click();
    await waitFor(
      () => Boolean(mounted.container.querySelector(".worker-detail-grid")),
      "角色详情",
    );
    assert.ok(
      textOf(mounted.container.querySelector(".worker-detail-grid")).includes(
        "UI设计",
      ),
    );
    const detailText = textOf(mounted.container.querySelector(".worker-detail-grid"));
    assert.ok(detailText.includes("Worker 配置"));
    assert.ok(detailText.includes("DSH default"));
    button(mounted.container, "返回列表").click();
    await waitFor(
      () => Boolean(byLabel(mounted.container, "查看 历史任务")),
      "返回列表",
    );
    (byLabel(mounted.container, "查看 历史任务") as HTMLButtonElement).click();
    await waitFor(
      () => Boolean(mounted.container.querySelector(".worker-detail-grid")),
      "历史任务详情",
    );
    assert.ok(textOf(mounted.container.querySelector(".worker-detail-grid")).includes("未指定"));
  } finally {
    mounted.unmount();
  }
});

test("DOM: all three worker types have distinct labels and aggregate counts", async () => {
  const records = [
    worker({ id: "worker-dsh", type: "dsh", taskName: "DSH 任务" }),
    worker({
      id: "worker-pi",
      type: "pi",
      taskName: "Pi 任务",
      latestRun: run({ id: "run-pi", workerId: "worker-pi", status: "queued" }),
    }),
    worker({
      id: "worker-codex",
      type: "codex",
      taskName: "Codex 任务",
      latestRun: run({
        id: "run-codex",
        workerId: "worker-codex",
        status: "completed",
        finishedAt: new Date().toISOString(),
        exitCode: 0,
      }),
    }),
  ];
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: records,
        counts: {
          dsh: counts({ running: 1 }),
          pi: counts({ queued: 1 }),
          codex: counts({ completed: 1 }),
          total: counts({ running: 1, queued: 1, completed: 1 }),
        },
      }),
  });
  try {
    await waitFor(() => textOf(mounted.container).includes("Codex 任务"), "三类型列表");
    const summary = mounted.container.querySelector(
      '[aria-label="按类型统计"]',
    );
    assert.ok(summary);
    assert.ok(textOf(summary).includes("1DSH 执行中"));
    assert.ok(textOf(summary).includes("0Pi 执行中"));
    assert.ok(textOf(summary).includes("0Codex 执行中"));
    assert.ok(textOf(summary).includes("1全部 执行中"));
    assert.equal(
      textOf(mounted.container.querySelector(".worker-type-codex")),
      "Codex",
    );
    assert.ok(
      textOf(mounted.container).includes(
        "DSH default 3 / Pi default 3 / Codex default 3",
      ),
    );
    assert.ok(textOf(mounted.container).includes("配置 DSH default"));
    assert.ok(textOf(mounted.container).includes("3 个 worker · 3 个状态记录"));
  } finally {
    mounted.unmount();
  }
});

test("DOM: recovery needs verified-stop evidence and sends the explicit confirmation", async () => {
  const unknownRun = run({ status: "unknown", finishedAt: null });
  const record = worker({
    latestRun: unknownRun,
    workspace: {
      mode: "worktree",
      path: "/tmp/worktree-1",
      sourcePath: "/tmp/project-a",
      createdByPlugin: true,
      baseCommit: "abc123",
      branch: "worker/task",
    },
  });
  const mounted = await mountPlugin({
    detail: () => ({ worker: record, runs: [unknownRun] }),
  });
  try {
    await waitFor(() => Boolean(byLabel(mounted.container, "查看 任务一")), "列表");
    (byLabel(mounted.container, "查看 任务一") as HTMLButtonElement).click();
    await waitFor(
      () => Boolean(byLabel(mounted.container, "已核实停止的说明")),
      "恢复表单",
    );
    const submit = button(mounted.container, "确认停止并恢复");
    assert.equal(submit.disabled, true);
    await typeInto(
      byLabel(mounted.container, "已核实停止的说明") as HTMLTextAreaElement,
      "ps 未发现 dsh 进程；原生会话最后事件为 turn_end/cancelled",
    );
    (byLabel(mounted.container, "已核实原生会话已停止") as HTMLInputElement).click();
    await waitFor(() => !button(mounted.container, "确认停止并恢复").disabled, "可提交");
    button(mounted.container, "确认停止并恢复").click();
    await waitFor(() => callsTo(mounted, "/recover").length === 1, "恢复请求");
    assert.deepEqual(callsTo(mounted, "/recover")[0]!.body, {
      workerId: "worker-1",
      notes: "ps 未发现 dsh 进程；原生会话最后事件为 turn_end/cancelled",
      confirmedStopped: true,
    });
    // A still-unknown run holds a slot, so its worktree is not offered for cleanup.
    assert.equal(findButton(mounted.container, "清理 worktree"), undefined);
  } finally {
    mounted.unmount();
  }
});

test("DOM: cleanup is offered only for a stopped plugin-created worktree", async () => {
  const completed = run({ status: "completed", finishedAt: new Date().toISOString(), exitCode: 0 });
  const record = worker({
    latestRun: completed,
    workspace: {
      mode: "worktree",
      path: "/tmp/worktree-2",
      sourcePath: "/tmp/project-a",
      createdByPlugin: true,
      baseCommit: "def456",
      branch: "worker/clean-me",
    },
  });
  const mounted = await mountPlugin({
    detail: () => ({ worker: record, runs: [completed] }),
  });
  try {
    await waitFor(() => Boolean(byLabel(mounted.container, "查看 任务一")), "列表");
    (byLabel(mounted.container, "查看 任务一") as HTMLButtonElement).click();
    await waitFor(
      () => Boolean(findButton(mounted.container, "清理 worktree")),
      "清理按钮",
    );
    button(mounted.container, "清理 worktree").click();
    await waitFor(() => callsTo(mounted, "/cleanup").length === 1, "清理请求");
    assert.deepEqual(callsTo(mounted, "/cleanup")[0]!.body, {
      workerId: "worker-1",
    });
  } finally {
    mounted.unmount();
  }
});

test("DOM: queued runs show the configured timeout before its deadline starts", async () => {
  const queued = run({ status: "queued", startedAt: null, timeoutSeconds: 120 });
  const record = worker({ latestRun: queued });
  const mounted = await mountPlugin({
    state: () => snapshot({ workers: [record] }),
    detail: () => ({ worker: record, runs: [queued] }),
  });
  try {
    await waitFor(() => Boolean(byLabel(mounted.container, "查看 任务一")), "列表");
    (byLabel(mounted.container, "查看 任务一") as HTMLButtonElement).click();
    await waitFor(() => textOf(mounted.container).includes("进度与预算"), "运行预算");
    assert.ok(textOf(mounted.container).includes("硬超时 120 秒"));
    assert.equal(textOf(mounted.container).includes("未设置硬超时"), false);
  } finally {
    mounted.unmount();
  }
});

test("DOM: log pagination requests the next cursor and appends the page", async () => {
  const mounted = await mountPlugin({
    logs: (_id, pathAndQuery) => {
      if (pathAndQuery.includes("cursor=next-1"))
        return { text: "第二页", nextCursor: null, done: true };
      return { text: "第一页", nextCursor: "next-1", done: false };
    },
  });
  try {
    await waitFor(() => Boolean(byLabel(mounted.container, "查看 任务一")), "列表");
    (byLabel(mounted.container, "查看 任务一") as HTMLButtonElement).click();
    await waitFor(
      () => textOf(byLabel(mounted.container, "原始事件日志")).includes("第一页"),
      "首屏日志",
    );
    assert.ok(textOf(mounted.container).includes("每页 64 KiB"));
    const more = button(mounted.container, "加载更多");
    assert.equal(more.disabled, false);
    more.click();
    await waitFor(
      () => textOf(byLabel(mounted.container, "原始事件日志")).includes("第二页"),
      "下一页日志",
    );
    const logCalls = mounted.calls.filter((call) => call.path.includes("/logs?"));
    assert.equal(logCalls.length, 2);
    assert.equal(
      logCalls[1]!.path,
      "/workers/worker-1/logs?stream=events&limit=65536&runId=run-1&cursor=next-1",
    );
    // The initial page never carries a cursor, and the second request forwards the server's.
    assert.equal(logCalls[0]!.path.includes("cursor="), false);
  } finally {
    mounted.unmount();
  }
});

test("DOM: retry notification sends only the selected event id", async () => {
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        notifications: [
          {
            id: "event-1",
            ownerId: "owner-1",
            workerId: "worker-1",
            runId: "run-1",
            summary: "任务一已完成",
            status: "completed",
            createdAt: new Date().toISOString(),
            delivery: "pending",
            batchId: null,
          },
          {
            id: "event-2",
            ownerId: "owner-1",
            workerId: "worker-1",
            runId: "run-1",
            summary: "已送达的通知",
            status: "completed",
            createdAt: new Date().toISOString(),
            delivery: "delivered",
            batchId: "batch-1",
          },
        ],
      }),
  });
  try {
    await waitFor(
      () => Boolean(byLabel(mounted.container, "重试通知 event-1")),
      "通知列表",
    );
    assert.equal(
      (byLabel(mounted.container, "重试通知 event-2") as HTMLButtonElement).disabled,
      true,
    );
    (byLabel(mounted.container, "重试通知 event-1") as HTMLButtonElement).click();
    await waitFor(
      () => callsTo(mounted, "/notifications/retry").length === 1,
      "重试请求",
    );
    assert.deepEqual(callsTo(mounted, "/notifications/retry")[0]!.body, {
      eventIds: ["event-1"],
    });
  } finally {
    mounted.unmount();
  }
});

/** Reads the detail usage row next to the "Token 用量" term. */
function detailUsage(root: ParentNode): string {
  const term = [...root.querySelectorAll(".worker-detail-grid dt")].find(
    (item) => textOf(item) === "Token 用量",
  );
  return textOf(term?.nextElementSibling ?? null);
}

async function openDetail(mounted: Mounted, label = "查看 任务一") {
  await waitFor(() => Boolean(byLabel(mounted.container, label)), "列表");
  (byLabel(mounted.container, label) as HTMLButtonElement).click();
  await waitFor(
    () => Boolean(mounted.container.querySelector(".worker-detail-grid")),
    "任务详情",
  );
}

test("DOM: Codex usage shows cache fields, a real zero and this-run scope", async () => {
  const codexUsage = run({
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      cacheReadTokens: 0,
      cacheWriteTokens: 250,
      scope: "run",
      partial: false,
    },
  });
  const record = worker({
    type: "codex",
    configName: "Codex default",
    latestRun: codexUsage,
  });
  const mounted = await mountPlugin({
    state: () => snapshot({ workers: [record] }),
    detail: () => ({ worker: record, runs: [codexUsage] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(() => detailUsage(mounted.container).includes("本次运行"), "本次用量");
    assert.equal(
      detailUsage(mounted.container),
      "输入（含缓存） 1,200 · 输出 300 · 缓存读取 0 · 缓存写入 250 · 合计 1,500 · 本次运行",
    );
    assert.equal(detailUsage(mounted.container).includes("部分统计"), false);
  } finally {
    mounted.unmount();
  }
});

test("DOM: legacy usage without cache fields keeps dashes and says the scope was not recorded", async () => {
  const legacyUsage = run({
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });
  const record = worker({ type: "dsh", latestRun: legacyUsage });
  const mounted = await mountPlugin({
    state: () => snapshot({ workers: [record] }),
    detail: () => ({ worker: record, runs: [legacyUsage] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => detailUsage(mounted.container).includes("历史记录"),
      "历史用量范围",
    );
    // DSH input excludes cache, so the label differs from Codex; missing cache is not zero.
    assert.equal(
      detailUsage(mounted.container),
      "未缓存输入 10 · 输出 20 · 缓存读取 — · 缓存写入 — · 合计 30 · 历史记录，统计范围未标注",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: session-scoped partial usage stays marked while every reported number is shown", async () => {
  const sessionUsage = run({
    usage: {
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      cacheReadTokens: null,
      cacheWriteTokens: 0,
      scope: "session",
      partial: true,
    },
  });
  const record = worker({ type: "pi", latestRun: sessionUsage });
  const mounted = await mountPlugin({
    state: () => snapshot({ workers: [record] }),
    detail: () => ({ worker: record, runs: [sessionUsage] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => detailUsage(mounted.container).includes("会话累计"),
      "会话累计用量",
    );
    const usage = detailUsage(mounted.container);
    assert.ok(usage.startsWith("部分统计 · "));
    assert.ok(usage.includes("会话累计（无法确认本次用量）"));
    assert.ok(usage.includes("未缓存输入 5"));
    assert.ok(usage.includes("输出 7"));
    assert.ok(usage.includes("缓存读取 —"));
    assert.ok(usage.includes("缓存写入 0"));
    assert.ok(usage.includes("合计 12"));
  } finally {
    mounted.unmount();
  }
});

test("DOM: selecting a historical run shows that run's usage instead of the latest one", async () => {
  const latest = run({
    id: "run-latest",
    usage: {
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      scope: "unknown",
    },
  });
  const historical = run({
    id: "run-history",
    startedAt: new Date(Date.now() - 900_000).toISOString(),
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      scope: "run",
    },
  });
  const record = worker({ type: "dsh", latestRun: latest });
  const mounted = await mountPlugin({
    state: () => snapshot({ workers: [record] }),
    detail: () => ({ worker: record, runs: [historical, latest] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => detailUsage(mounted.container).includes("统计范围未知"),
      "最新运行用量",
    );
    assert.ok(detailUsage(mounted.container).includes("未缓存输入 200"));

    // The run list is newest-first; the last button is the older run.
    const runButtons = [...mounted.container.querySelectorAll(".worker-runs button")];
    assert.equal(runButtons.length, 2);
    (runButtons[1] as HTMLButtonElement).click();
    await waitFor(
      () => detailUsage(mounted.container).includes("本次运行"),
      "历史运行用量",
    );
    const usage = detailUsage(mounted.container);
    assert.ok(usage.includes("未缓存输入 100"));
    assert.ok(usage.includes("缓存读取 40"));
    assert.ok(usage.includes("缓存写入 5"));
    assert.ok(usage.includes("合计 110"));
    assert.equal(usage.includes("200"), false);
  } finally {
    mounted.unmount();
  }
});

test("DOM: config ids fall back to UUID v4 without randomUUID and stay stable on rerender", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let counter = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues<T extends Uint8Array>(bytes: T): T {
        for (let index = 0; index < bytes.length; index += 1)
          bytes[index] = (counter++ + index * 17) % 256;
        return bytes;
      },
    },
  });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    (byLabel(mounted.container, "新增 DSH 配置") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 4 名称")), "新增配置");
    (byLabel(mounted.container, "配置 3 复制") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 5 名称")), "复制配置");
    await waitFor(() => {
      const saveButton = findButton(mounted.container, "保存设置");
      return saveButton !== undefined && !saveButton.disabled;
    }, "可保存");

    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存请求");
    const first = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<{ id: string }>;
    };
    assert.equal(first.configs.length, 5);
    assert.deepEqual(first.configs.slice(0, 3).map((config) => config.id), [
      "dsh-default",
      "pi-default",
      "codex-default",
    ]);
    assert.match(first.configs[3]!.id, uuid);
    assert.match(first.configs[4]!.id, uuid);
    assert.equal(new Set(first.configs.map((config) => config.id)).size, 5);

    // A rerender and another save must not mint new ids for the same configs.
    await typeInto(
      byLabel(mounted.container, "配置 4 名称") as HTMLInputElement,
      "重命名配置",
    );
    await waitFor(() => {
      const saveButton = findButton(mounted.container, "保存设置");
      return saveButton !== undefined && !saveButton.disabled;
    }, "再次保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 2, "第二次保存");
    const second = callsTo(mounted, "/settings")[1]!.body as typeof first;
    assert.deepEqual(
      second.configs.map((config) => config.id),
      first.configs.map((config) => config.id),
    );
  } finally {
    mounted.unmount();
    if (original) Object.defineProperty(globalThis, "crypto", original);
  }
});

test("DOM: duplicating copies the raw Codex env draft, including emptied and invalid text", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    const originalEnv = byLabel(
      mounted.container,
      "配置 3 Codex 环境变量",
    ) as HTMLTextAreaElement;
    await typeInto(originalEnv, "BROKEN");
    (byLabel(mounted.container, "配置 3 复制") as HTMLButtonElement).click();
    await waitFor(
      () => Boolean(byLabel(mounted.container, "配置 4 Codex 环境变量")),
      "复制 Codex 配置",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 4 Codex 环境变量") as HTMLTextAreaElement).value,
      "BROKEN",
    );
    await waitFor(
      () => textOf(mounted.container).includes("需要 KEY=VALUE"),
      "非法草稿沿用校验",
    );
    assert.equal(button(mounted.container, "保存设置").disabled, true);
    assert.equal(callsTo(mounted, "/settings").length, 0);

    // Fix the copy, clear the source, then duplicate the now-empty draft.
    await typeInto(
      byLabel(mounted.container, "配置 4 Codex 环境变量") as HTMLTextAreaElement,
      "A=1",
    );
    await typeInto(originalEnv, "");
    (byLabel(mounted.container, "配置 3 复制") as HTMLButtonElement).click();
    await waitFor(
      () => Boolean(byLabel(mounted.container, "配置 5 Codex 环境变量")),
      "复制空环境变量",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 5 Codex 环境变量") as HTMLTextAreaElement).value,
      "",
    );
    await waitFor(() => {
      const saveButton = findButton(mounted.container, "保存设置");
      return saveButton !== undefined && !saveButton.disabled;
    }, "修正后可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存复制结果");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
    };
    assert.deepEqual(body.configs[2]!.codex.env, {});
    assert.deepEqual(body.configs[3]!.codex.env, { A: "1" });
    assert.deepEqual(body.configs[4]!.codex.env, {});
    assert.deepEqual(
      body.configs[3]!.codex.legacyExtraArgs,
      body.configs[2]!.codex.legacyExtraArgs,
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: Pi's default model accepts thinking effort while DSH still needs an explicit model", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    // Only Codex exposes a service/env block; Pi and DSH have neither.
    assert.equal(byLabel(mounted.container, "配置 1 Codex 模型服务"), null);
    assert.equal(byLabel(mounted.container, "配置 2 Codex 模型服务"), null);
    assert.equal(byLabel(mounted.container, "配置 1 Codex 环境变量"), null);
    assert.equal(byLabel(mounted.container, "配置 2 Codex 环境变量"), null);
    assert.ok(byLabel(mounted.container, "配置 3 Codex 模型服务"));
    assert.ok(byLabel(mounted.container, "配置 3 Codex 环境变量"));

    const piModel = byLabel(mounted.container, "配置 2 模型") as HTMLSelectElement;
    const piReasoning = byLabel(
      mounted.container,
      "配置 2 reasoning",
    ) as HTMLSelectElement;
    assert.deepEqual(optionValues(piReasoning), ["", "off", "low", "high"]);
    await typeInto(piReasoning, "high");
    await typeInto(piModel, "anthropic/claude-sonnet");
    await waitFor(() => piReasoning.value === "high", "切换模型保留 reasoning");
    await typeInto(piModel, "");
    await waitFor(() => piReasoning.value === "high", "切回默认保留 reasoning");

    await waitFor(() => {
      const saveButton = findButton(mounted.container, "保存设置");
      return saveButton !== undefined && !saveButton.disabled;
    }, "Pi 默认可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存 Pi 默认 effort");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
    };
    assert.equal(body.configs[1]!.model, null);
    assert.equal(body.configs[1]!.effort, "high");
  } finally {
    mounted.unmount();
  }
});

test("DOM: DSH effort still requires an explicit model", async () => {
  const settings = snapshot().settings as Record<string, unknown> & {
    configs: Array<Record<string, any>>;
  };
  settings.configs = configDefaults();
  settings.configs[0] = { ...settings.configs[0], model: null, effort: "high" };
  const mounted = await mountPlugin({ state: () => snapshot({ settings }) });
  try {
    await openSettings(mounted);
    await waitFor(
      () =>
        textOf(mounted.container).includes(
          "DSH reasoning 需要同时配置 DSH 模型",
        ),
      "DSH 需要模型",
    );
    assert.equal(button(mounted.container, "保存设置").disabled, true);
    assert.equal(
      (byLabel(mounted.container, "配置 1 reasoning") as HTMLSelectElement).value,
      "high",
    );
    assert.equal(callsTo(mounted, "/settings").length, 0);
  } finally {
    mounted.unmount();
  }
});

test("DOM: Codex directory loading/failure is shown on an explicit-service card and keeps selections", async () => {
  const settings = snapshot().settings as Record<string, unknown> & {
    configs: Array<Record<string, any>>;
  };
  settings.configs = configDefaults();
  settings.configs[2] = {
    ...settings.configs[2],
    model: "magpie-1",
    effort: "high",
    codex: { ...settings.configs[2].codex, modelProvider: "magpie" },
  };
  let directoryCalls = 0;
  let resolveDirectory: (value: unknown) => void = () => {};
  let rejectDirectory: (error: Error) => void = () => {};
  const pendingDirectory = new Promise((resolve, reject) => {
    resolveDirectory = resolve;
    rejectDirectory = reject;
  });
  const mounted = await mountPlugin({
    state: () => snapshot({ settings }),
    codexProviders: () => {
      directoryCalls += 1;
      return directoryCalls === 1
        ? pendingDirectory
        : Promise.resolve(CODEX_DIRECTORY);
    },
    codexProviderModels: async (modelProvider) => ({
      modelProvider,
      models: ["magpie-1"],
    }),
  });
  try {
    await openSettings(mounted);
    const card = byLabel(
      mounted.container,
      "配置 3 Codex 模型服务",
    )!.closest("details")!;
    await waitFor(() => textOf(card).includes("正在读取模型目录"), "目录加载中");
    const provider = byLabel(
      mounted.container,
      "配置 3 Codex 模型服务",
    ) as HTMLSelectElement;
    const model = byLabel(mounted.container, "配置 3 模型") as HTMLSelectElement;
    const reasoning = byLabel(
      mounted.container,
      "配置 3 reasoning",
    ) as HTMLSelectElement;
    assert.equal(provider.value, "magpie");
    assert.equal(model.value, "magpie-1");
    assert.equal(reasoning.value, "high");

    rejectDirectory(new Error("directory down"));
    await waitFor(() => textOf(card).includes("directory down"), "显式服务卡片显示目录错误");
    assert.equal(provider.value, "magpie");
    assert.equal(model.value, "magpie-1");
    assert.equal(reasoning.value, "high");

    findButton(card, "重试")!.click();
    await waitFor(() => !textOf(card).includes("directory down"), "目录重试恢复");
    assert.equal(directoryCalls, 2);
    assert.equal(provider.value, "magpie");
    assert.equal(model.value, "magpie-1");
    assert.equal(reasoning.value, "high");
    resolveDirectory(CODEX_DIRECTORY);
  } finally {
    mounted.unmount();
  }
});

function configCards(root: ParentNode): HTMLDetailsElement[] {
  return [...root.querySelectorAll(".worker-type-settings")] as HTMLDetailsElement[];
}
function configCardNames(root: ParentNode): string[] {
  return configCards(root).map((card) =>
    textOf(card.querySelector(".worker-type-identity strong")),
  );
}
function dragHandles(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll(".worker-drag-handle")] as HTMLElement[];
}
async function fireDrag(
  target: Element,
  type: string,
  relatedTarget?: Element | null,
) {
  const view = target.ownerDocument.defaultView as unknown as {
    Event: new (type: string, init?: { bubbles?: boolean }) => Event;
    MouseEvent: new (
      type: string,
      init?: { bubbles?: boolean; relatedTarget?: EventTarget | null },
    ) => Event;
  };
  // MouseEvent carries relatedTarget, which dragleave needs to distinguish crossing children
  // from actually leaving the config list.
  target.dispatchEvent(
    relatedTarget === undefined
      ? new view.Event(type, { bubbles: true })
      : new view.MouseEvent(type, { bubbles: true, relatedTarget }),
  );
  await delay(0);
}

test("DOM: reorder buttons keep id-keyed drafts and save the new config order", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    assert.deepEqual(configCardNames(mounted.container), [
      "DSH default",
      "Pi default",
      "Codex default",
    ]);

    // Draft edits stay attached to their config id, not to a list position.
    await typeInto(
      byLabel(mounted.container, "配置 1 名称") as HTMLInputElement,
      "DSH 首选",
    );
    await typeInto(
      byLabel(mounted.container, "配置 3 Codex 环境变量") as HTMLTextAreaElement,
      "SORT_KEEP=1",
    );

    assert.equal(
      (byLabel(mounted.container, "配置 1 上移 DSH 首选") as HTMLButtonElement).disabled,
      true,
    );
    (byLabel(mounted.container, "配置 3 上移 Codex default") as HTMLButtonElement).click();
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "DSH 首选|Codex default|Pi default",
      "按钮上移",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 3 下移 Pi default") as HTMLButtonElement).disabled,
      true,
    );

    // The moved card keeps its name input, env text, default id and open state.
    assert.equal(
      (byLabel(mounted.container, "配置 2 名称") as HTMLInputElement).value,
      "Codex default",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 2 Codex 环境变量") as HTMLTextAreaElement).value,
      "SORT_KEEP=1",
    );
    assert.equal(
      (byLabel(mounted.container, "默认 Worker 配置") as HTMLSelectElement).value,
      "dsh-default",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 1 DSH 首选")!.closest("details") as HTMLDetailsElement)
        .open,
      true,
    );

    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存排序");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<{ id: string; name: string; codex?: { env: Record<string, string> } }>;
      defaultConfigId: string;
    };
    assert.deepEqual(
      body.configs.map((config) => config.id),
      ["dsh-default", "codex-default", "pi-default"],
    );
    assert.deepEqual(
      body.configs.map((config) => config.name),
      ["DSH 首选", "Codex default", "Pi default"],
    );
    assert.equal(body.configs[1]!.codex!.env.SORT_KEEP, "1");
    assert.equal(body.defaultConfigId, "dsh-default");

    // The saved order is what the reloaded editor shows.
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "DSH 首选|Codex default|Pi default",
      "保存后顺序一致",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: drag handle reorders with target feedback and a cancelled drag changes nothing", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    const initialOrder = configCardNames(mounted.container);
    assert.deepEqual(initialOrder, ["DSH default", "Pi default", "Codex default"]);

    await fireDrag(dragHandles(mounted.container)[0]!, "dragstart");
    await waitFor(
      () => configCards(mounted.container)[0]!.getAttribute("data-dragging") === "true",
      "拖动反馈",
    );
    await fireDrag(configCards(mounted.container)[2]!, "dragover");
    await waitFor(
      () => configCards(mounted.container)[2]!.getAttribute("data-drop-target") === "true",
      "目标反馈",
    );
    await fireDrag(configCards(mounted.container)[2]!, "drop");
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "Pi default|Codex default|DSH default",
      "拖放排序",
    );
    assert.equal(configCards(mounted.container).length, 3);
    assert.equal(
      configCards(mounted.container).some((card) => card.getAttribute("data-dragging")),
      false,
    );

    // Dragging the default config away keeps its id as default and keeps its card open.
    assert.equal(
      (byLabel(mounted.container, "默认 Worker 配置") as HTMLSelectElement).value,
      "dsh-default",
    );
    const defaultCard = byLabel(mounted.container, "配置 3 DSH default")!.closest(
      "details",
    ) as HTMLDetailsElement;
    assert.equal(defaultCard.open, true);

    // A cancelled drag (dragend without drop) must not move or drop any config.
    await fireDrag(dragHandles(mounted.container)[0]!, "dragstart");
    await fireDrag(dragHandles(mounted.container)[0]!, "dragend");
    assert.deepEqual(configCardNames(mounted.container), [
      "Pi default",
      "Codex default",
      "DSH default",
    ]);
    assert.equal(configCards(mounted.container).length, 3);
    assert.equal(
      configCards(mounted.container).some(
        (card) => card.getAttribute("data-dragging") === "true",
      ),
      false,
    );

    // The handle never toggles the card, and the move buttons cover keyboard/mobile use.
    (dragHandles(mounted.container)[2]!).click();
    await delay(0);
    assert.equal(defaultCard.open, true);
    assert.equal(
      (byLabel(mounted.container, "默认 Worker 配置") as HTMLSelectElement).value,
      "dsh-default",
    );
    assert.equal(configCards(mounted.container).length, 3);

    (byLabel(mounted.container, "配置 1 下移 Pi default") as HTMLButtonElement).click();
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "Codex default|Pi default|DSH default",
      "按钮下移",
    );
    assert.equal(defaultCard.open, true);
    assert.equal(configCards(mounted.container).length, 3);
  } finally {
    mounted.unmount();
  }
});

test("DOM: crossing cards keeps the drop outline and only leaving the list clears it", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    const list = mounted.container.querySelector(
      ".worker-settings-configs",
    ) as HTMLElement;
    const hasTarget = () =>
      configCards(mounted.container).some(
        (card) => card.getAttribute("data-drop-target") === "true",
      );

    await fireDrag(dragHandles(mounted.container)[0]!, "dragstart");
    await fireDrag(configCards(mounted.container)[1]!, "dragover");
    await waitFor(
      () => configCards(mounted.container)[1]!.getAttribute("data-drop-target") === "true",
      "目标高亮",
    );

    // Leaving the previous card for the next one, or leaving a card into its own child,
    // must keep the outline on the new target.
    await fireDrag(configCards(mounted.container)[0]!, "dragleave", configCards(mounted.container)[1]);
    await fireDrag(
      configCards(mounted.container)[1]!,
      "dragleave",
      configCards(mounted.container)[1]!.querySelector("summary"),
    );
    assert.equal(
      configCards(mounted.container)[1]!.getAttribute("data-drop-target"),
      "true",
    );

    // Actually leaving the config list clears the target.
    await fireDrag(
      list,
      "dragleave",
      mounted.container.querySelector(".worker-heading"),
    );
    await waitFor(() => !hasTarget(), "离开列表清空目标");

    // Re-entering a card restores the outline, and the drop still applies the order.
    await fireDrag(configCards(mounted.container)[2]!, "dragover");
    await waitFor(
      () => configCards(mounted.container)[2]!.getAttribute("data-drop-target") === "true",
      "重新进入目标",
    );
    await fireDrag(configCards(mounted.container)[2]!, "drop");
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "Pi default|Codex default|DSH default",
      "拖放排序",
    );
    assert.equal(hasTarget(), false);
    assert.equal(configCards(mounted.container).length, 3);
  } finally {
    mounted.unmount();
  }
});

test("DOM: dragenter moves the target outline before any dragover", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    const list = mounted.container.querySelector(
      ".worker-settings-configs",
    ) as HTMLElement;

    await fireDrag(dragHandles(mounted.container)[0]!, "dragstart");
    await fireDrag(configCards(mounted.container)[1]!, "dragover");
    await waitFor(
      () => configCards(mounted.container)[1]!.getAttribute("data-drop-target") === "true",
      "旧目标高亮",
    );

    // Only a dragenter on the new card: the outline must move before the next dragover.
    await fireDrag(configCards(mounted.container)[2]!, "dragenter");
    assert.equal(
      configCards(mounted.container)[2]!.getAttribute("data-drop-target"),
      "true",
    );
    assert.equal(
      configCards(mounted.container)[1]!.getAttribute("data-drop-target"),
      null,
    );

    // The old target's leave (relatedTarget = new card) must not clear the new outline.
    await fireDrag(
      configCards(mounted.container)[1]!,
      "dragleave",
      configCards(mounted.container)[2],
    );
    assert.equal(
      configCards(mounted.container)[2]!.getAttribute("data-drop-target"),
      "true",
    );

    // Leaving the whole list still clears, and re-entering restores the target.
    await fireDrag(
      list,
      "dragleave",
      mounted.container.querySelector(".worker-heading"),
    );
    await waitFor(
      () =>
        !configCards(mounted.container).some(
          (card) => card.getAttribute("data-drop-target") === "true",
        ),
      "离开列表清空目标",
    );
    await fireDrag(configCards(mounted.container)[2]!, "dragenter");
    await waitFor(
      () => configCards(mounted.container)[2]!.getAttribute("data-drop-target") === "true",
      "重新进入目标",
    );

    await fireDrag(configCards(mounted.container)[2]!, "drop");
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "Pi default|Codex default|DSH default",
      "拖放排序",
    );
    assert.equal(configCards(mounted.container).length, 3);
  } finally {
    mounted.unmount();
  }
});
