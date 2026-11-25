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
  views: ConversationViewRecord[];
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

/**
 * jsdom has no layout and no `ResizeObserver`; the plugin's content-resize hook is provided by a
 * fake that a test flushes after it changes the simulated scroll metrics.
 */
class FakeResizeObserver {
  private static all = new Set<FakeResizeObserver>();
  constructor(private callback: () => void) {
    FakeResizeObserver.all.add(this);
  }
  observe() {}
  disconnect() {
    FakeResizeObserver.all.delete(this);
  }
  static flush() {
    for (const observer of [...FakeResizeObserver.all]) observer.callback();
  }
  static get count() {
    return FakeResizeObserver.all.size;
  }
}

/** Replaces scroll metrics so a test can act out layout changes jsdom cannot compute. */
function stubScrollMetrics(box: HTMLElement) {
  const metrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  for (const name of ["scrollHeight", "clientHeight"] as const)
    Object.defineProperty(box, name, {
      configurable: true,
      get: () => metrics[name],
    });
  Object.defineProperty(box, "scrollTop", {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (next: number) => {
      metrics.scrollTop = Math.max(0, Math.min(next, Math.max(0, metrics.scrollHeight - metrics.clientHeight)));
    },
  });
  return metrics;
}

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
    "MutationObserver",
    "ResizeObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ])
    globals[name] = (dom.window as unknown as Record<string, unknown>)[name];
  // jsdom provides no ResizeObserver; the fake lets a test flush the plugin's layout hook.
  globals.ResizeObserver = FakeResizeObserver;
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
  AGY: {
    id: "agy-default",
    name: "Agy default",
    type: "agy",
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 300,
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
    hardTimeoutSeconds: 300,
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
    hardTimeoutSeconds: 300,
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
    CONFIG_DEFAULTS.AGY,
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
    finished: { items: [], nextCursor: null },
    settings: {
      schemaVersion: 2,
      configs: configDefaults(),
      defaultConfigId: "agy-default",
      concurrency: { dsh: 1, pi: 3, codex: 3, agy: 3 },
      defaultWorkerType: "agy",
      enabled: { pi: true, codex: true, agy: true },
      roles: { dsh: [], pi: [], codex: [], agy: [] },
      defaults: {
        dsh: { model: null, effort: null },
        pi: { model: null, effort: null },
        agy: { model: null, effort: null },
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
    agyCooldownUntil: null,
    notifications: { items: [], nextCursor: null },
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
  /** `GET /history`; the default is an empty final page. */
  history?: (kind: string, path: string) => Promise<unknown> | unknown;
  /** `POST /notifications/retry`; the default queues nothing. */
  retry?: (body: unknown) => Promise<unknown> | unknown;
  detail?: (workerId: string) => unknown;
  logs?: (workerId: string, path: string) => unknown;
  input?: (workerId: string, path: string) => unknown;
  /** Installs the optional host conversation view capability. */
  conversation?: boolean;
  settings?: (body: unknown) => unknown;
  models?: (provider: "codex") => Promise<unknown>;
  codexProviders?: () => Promise<unknown>;
  codexProviderModels?: (modelProvider: string) => Promise<unknown>;
  piCatalog?: () => Promise<unknown>;
  agyCatalog?: () => Promise<unknown>;
};

type ConversationViewRecord = {
  provider: string;
  messages: Array<Record<string, unknown>>;
  updates: Array<Array<Record<string, unknown>>>;
  disposed: boolean;
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
// The plugin's own `GET /catalog/agy` runs the local CLI; ids and labels are its real rows.
const AGY_CATALOG = {
  models: [
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
  ],
};

async function mountPlugin(mode: Mode = {}): Promise<Mounted> {
  const dom = installDom();
  const module = (await import(await bundle())) as WorkerHostModule;
  const container = dom.window.document.getElementById("host")!;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const listeners = new Set<(context: unknown) => void>();
  const views: ConversationViewRecord[] = [];
  let context = mode.context ?? DEFAULT_CONTEXT;
  const host: Record<string, unknown> = {
    // The host serves only the Codex metadata catalog; any other provider is a regression.
    models: mode.models ?? (async (provider: "codex") => {
      if (provider !== "codex") throw new Error("宿主未提供该模型目录");
      return CODEX_MODELS;
    }),
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
      if (pathAndQuery.startsWith("/history")) {
        const kind = new URLSearchParams(pathAndQuery.split("?")[1] ?? "").get(
          "kind",
        ) ?? "";
        if (mode.history) return mode.history(kind, pathAndQuery);
        return { items: [], nextCursor: null };
      }
      const workerMatch = /^\/workers\/([^/?]+)$/.exec(pathAndQuery);
      if (workerMatch) {
        if (mode.detail) return mode.detail(workerMatch[1]!);
        return { worker: worker(), runs: [run()] };
      }
      const logsMatch = /^\/workers\/([^/]+)\/logs/.exec(pathAndQuery);
      if (logsMatch) {
        if (mode.logs) return mode.logs(decodeURIComponent(logsMatch[1]!), pathAndQuery);
        return { text: "", nextCursor: null, done: true };
      }
      const inputMatch = /^\/workers\/([^/]+)\/input/.exec(pathAndQuery);
      if (inputMatch) {
        if (mode.input) return mode.input(decodeURIComponent(inputMatch[1]!), pathAndQuery);
        return { prompt: null };
      }
      if (pathAndQuery === "/cancel") return { workerIds: ["worker-1"] };
      if (pathAndQuery === "/catalog/pi") {
        if (mode.piCatalog) return mode.piCatalog();
        return PI_CATALOG;
      }
      if (pathAndQuery === "/catalog/agy") {
        if (mode.agyCatalog) return mode.agyCatalog();
        return AGY_CATALOG;
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
      if (pathAndQuery === "/notifications/retry") {
        if (mode.retry) return mode.retry(body);
        return { retried: 0 };
      }
      throw new Error("unexpected RPC " + method + " " + pathAndQuery);
    },
  };
  if (mode.conversation) {
    host.mountConversationOutput = (
      element: HTMLElement,
      options: {
        provider: string;
        messages: Array<Record<string, unknown>>;
      },
    ) => {
      const record: ConversationViewRecord = {
        provider: options.provider,
        messages: options.messages,
        updates: [],
        disposed: false,
      };
      views.push(record);
      const render = (messages: Array<Record<string, unknown>>) => {
        record.messages = messages;
        element.textContent = messages
          .map((row) => String(row.text ?? row.toolName ?? ""))
          .join("\n");
      };
      render(options.messages);
      return {
        update(messages: Array<Record<string, unknown>>) {
          record.updates.push(messages);
          render(messages);
        },
        dispose() {
          record.disposed = true;
        },
      };
    };
  }
  module.mount(container, host);
  return {
    container,
    calls,
    listeners,
    views,
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
      "/state?view=overview&projectId=project-a&parentSessionId=session-1",
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
      "/state?view=overview&projectId=project-b&parentSessionId=session-2",
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
    assert.equal(stateCalls(mounted)[0]!.path, "/state?view=overview");
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
      () => stateCalls(mounted).at(-1)?.path === "/state?view=overview&projectId=project-a",
      "项目查询",
    );
    (byLabel(mounted.container, "范围：全部") as HTMLButtonElement).click();
    await waitFor(
      () => stateCalls(mounted).at(-1)?.path === "/state?view=overview",
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
    await waitFor(
      () => Boolean(byLabel(mounted.container, "取消 任务一")),
      "取消按钮",
    );
    const cancel = byLabel(
      mounted.container,
      "取消 任务一",
    ) as HTMLButtonElement;
    assert.equal(textOf(cancel), "取消");
    assert.equal(cancel.querySelector("svg"), null, "取消是文字按钮");
    cancel.click();
    await waitFor(() => callsTo(mounted, "/cancel").length === 1, "取消请求");
    assert.deepEqual(callsTo(mounted, "/cancel")[0]!.body, {
      workerIds: ["worker-1"],
    });
    await waitFor(
      () => textOf(mounted.container).includes("已请求取消 任务一"),
      "取消提示",
    );
    const firstScreen = mounted.container.querySelector(".worker-first-screen")!;
    assert.ok(
      firstScreen.querySelector(".worker-notice")!.textContent!.includes(
        "已请求取消 任务一",
      ),
      "the notice joins the filled first screen instead of pushing it down",
    );
    assert.ok(
      firstScreen.contains(mounted.container.querySelector(".worker-card")),
      "the live card body stays in the first screen",
    );
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
    () => Boolean(byLabel(mounted.container, "新增 Pi 配置")),
    "配置编辑器",
  );
}

test("DOM: configs can be added, cloned with hidden Codex values, deleted before save and saved whole", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);

    // A not-yet-saved config can always be deleted again without touching the server.
    (byLabel(mounted.container, "新增 Antigravity 配置") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 4 名称")), "新增配置");
    assert.equal(configCards(mounted.container)[3]!.open, false);
    assert.equal(
      (byLabel(mounted.container, "配置 4 名称") as HTMLInputElement).value,
      "agy#1",
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
    assert.equal(configCards(mounted.container)[4]!.open, false);
    assert.equal(
      (byLabel(mounted.container, "配置 5 名称") as HTMLInputElement).value,
      "codex#1",
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
          ?.textContent?.includes("codex#1") === true,
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
      ["Agy default", "Pi default", "Codex default", "后备 Pi", "codex#1"],
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
        hardTimeoutSeconds: 600,
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
      () => (byLabel(mounted.container, "默认 Worker 配置") as HTMLSelectElement).value === "agy-default",
      "默认切回 Agy",
    );
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "停用后保存");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<{ id: string; enabled: boolean }>;
      defaultConfigId: string;
    };
    assert.deepEqual(
      body.configs.map((config) => config.id),
      ["agy-default", "codex-default"],
    );
    assert.deepEqual(
      body.configs.map((config) => [config.id, config.enabled]),
      [
        ["agy-default", true],
        ["codex-default", false],
      ],
    );
    assert.equal(body.defaultConfigId, "agy-default");
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

    // The first card is a real agy config: its model is a select, never a DSH text route.
    assert.equal(
      (byLabel(mounted.container, "配置 1 模型") as HTMLSelectElement).tagName,
      "SELECT",
    );
    assert.equal(callsTo(mounted, "/catalog/dsh").length, 0);

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
    assert.equal(byName["Agy default"].model, null);
    assert.equal(byName["Agy default"].effort, null);
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
      hardTimeoutSeconds: 300,
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

test("DOM: settings never offer DSH and the list only renders server records", async () => {
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: [
          worker({
            type: "pi",
            configId: "pi-default",
            configName: "Pi default",
          }),
        ],
      }),
  });
  try {
    await openSettings(mounted);
    assert.equal(byLabel(mounted.container, "新增 DSH 配置"), null);
    assert.equal(findButton(mounted.container, "新增 DSH 配置"), undefined);
    for (const select of mounted.container.querySelectorAll(
      'select[aria-label$="执行引擎"]',
    )) {
      assert.equal(
        optionValues(select as HTMLSelectElement).includes("dsh"),
        false,
        "engine select excludes DSH",
      );
    }
    assert.equal(callsTo(mounted, "/catalog/dsh").length, 0);

    // The list renders exactly what the filtered server response contains: no DSH row and no
    // client-side reconstruction of legacy records.
    button(mounted.container, "返回列表").click();
    await waitFor(() => Boolean(byLabel(mounted.container, "查看 任务一")), "返回列表");
    const text = textOf(mounted.container);
    assert.ok(text.includes("任务一"));
    assert.equal(text.includes("DSH"), false);
    assert.equal(mounted.container.querySelectorAll(".worker-type-dsh").length, 0);
  } finally {
    mounted.unmount();
  }
});

test("DOM: catalog failures stay local, keep stored values and retry in place", async () => {
  let modelsFail = true;
  let agyFail = true;
  let piFail = true;
  const settings = snapshot().settings as Record<string, any>;
  settings.configs = configDefaults();
  settings.configs[0] = {
    ...settings.configs[0],
    model: "gemini-legacy",
    effort: null,
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
      return CODEX_MODELS;
    },
    agyCatalog: async () => {
      if (agyFail) throw new Error("agy catalog down");
      return AGY_CATALOG;
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
    // An unlisted agy id stays selectable, so a failed directory never drops it.
    const agyModel = byLabel(mounted.container, "配置 1 模型") as HTMLSelectElement;
    assert.equal(agyModel.value, "gemini-legacy");
    assert.deepEqual(optionValues(agyModel), ["", "gemini-legacy"]);
    assert.equal(
      (byLabel(mounted.container, "配置 1 reasoning") as HTMLSelectElement).value,
      "",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 2 模型") as HTMLSelectElement).value,
      "anthropic/legacy-model",
    );
    await typeInto(
      byLabel(mounted.container, "配置 1 名称") as HTMLInputElement,
      "Agy 改名",
    );
    await waitFor(() => !button(mounted.container, "保存设置").disabled, "目录失败仍可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "目录失败保存");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
    };
    assert.equal(body.configs[0]!.model, "gemini-legacy");
    assert.equal(body.configs[0]!.effort, null);
    assert.equal(body.configs[2]!.model, "legacy-codex");
    assert.equal(body.configs[2]!.effort, "ultra");
    assert.equal(body.configs[2]!.codex.modelProvider, "magpie");
    assert.equal(body.configs[1]!.model, "anthropic/legacy-model");

    // Retrying recovers the catalogs without clearing any stored selection.
    modelsFail = false;
    agyFail = false;
    piFail = false;
    const retries = retryButtons(mounted.container);
    assert.ok(retries.length >= 4);
    for (const retry of retries) retry.click();
    await waitFor(
      () =>
        optionValues(byLabel(mounted.container, "配置 1 模型") as HTMLSelectElement).includes(
          "gemini-3.8-flash-low",
        ),
      "agy 目录恢复",
    );
    // Recovering the directory never rewrites the stored id into a listed one.
    assert.equal(
      (byLabel(mounted.container, "配置 1 模型") as HTMLSelectElement).value,
      "gemini-legacy",
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
      "gemini-legacy",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: equal history timestamps order by id descending like the server", async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const a = worker({
    id: "worker-a",
    taskName: "任务 A",
    latestRun: run({ status: "completed", finishedAt: at, exitCode: 0 }),
  });
  const b = worker({
    id: "worker-b",
    taskName: "任务 B",
    taskRole: "testing",
    latestRun: run({ status: "completed", finishedAt: at, exitCode: 0 }),
  });
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: [],
        finished: { items: [a, b], nextCursor: null },
      }),
  });
  try {
    await waitFor(
      () =>
        mounted.container.querySelectorAll(
          ".worker-history-table tbody tr",
        ).length === 2,
      "历史表",
    );
    const headers = [
      ...mounted.container.querySelectorAll(".worker-history-table thead th"),
    ].map((cell) => textOf(cell));
    assert.deepEqual(headers, [
      "任务 / 会话",
      "任务角色",
      "引擎 / 配置",
      "状态 / 耗时",
      "工作区",
      "操作",
    ]);
    const rows = [
      ...mounted.container.querySelectorAll(".worker-history-table tbody tr"),
    ];
    const screen = mounted.container.querySelector(".worker-first-screen")!;
    assert.equal(
      screen.classList.contains("worker-first-screen-fill"),
      false,
      "without live cards the first screen does not reserve a page",
    );
    assert.ok(
      screen.nextElementSibling!.classList.contains("worker-history"),
      "paged history follows the first screen instead of living inside it",
    );
    assert.equal(screen.querySelector(".worker-history"), null);
    const names = rows.map((row) => textOf(row));
    assert.ok(names[0]!.includes("任务 B"), "id descending breaks the timestamp tie");
    assert.ok(names[1]!.includes("任务 A"));
    const finished = rows[0]!;
    const body = textOf(finished);
    for (const text of [
      "project-a",
      "会话 session-1",
      "原生 native-session-1",
      "测试",
      "DSH",
      "配置 DSH default",
      "deepseek-v4 / deepseek / high",
      "已完成",
      "退出码 0",
      "结束 ",
      "/tmp/project-a",
      "existing",
      "写入范围 plugins/worker/client/",
    ])
      assert.ok(body.includes(text), "finish row shows " + text);
    assert.equal(
      finished.querySelector(".worker-role")!.textContent,
      "测试",
    );
    assert.equal(
      finished.querySelector(".worker-type-dsh")!.textContent,
      "DSH",
    );
    assert.equal(
      finished.querySelectorAll("button").length,
      2,
      "a finished row offers view only, not cancel",
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
    assert.equal(byLabel(mounted.container, "新增 Pi 配置"), null);
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
      () => Boolean(byLabel(mounted.container, "新增 Pi 配置")),
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
      ["agy-default", "pi-default", "codex-default"],
    );
    assert.equal(saved.defaultConfigId, "agy-default");
  } finally {
    mounted.unmount();
  }
});

test("DOM: list and detail show recorded task roles and handle legacy records without a role", async () => {
  const ui = worker({
    type: "pi",
    configId: "pi-default",
    configName: "Pi default",
    taskRole: "ui_design",
    taskName: "界面任务",
  });
  const legacy = worker({
    id: "worker-legacy",
    type: "pi",
    configId: "pi-default",
    configName: "Pi default",
    taskName: "历史任务",
  });
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: [ui, legacy],
        counts: {
          dsh: counts({ running: 2 }),
          pi: counts(),
          codex: counts(),
          agy: counts(),
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
    assert.ok(textOf(mounted.container).includes("UI设计"));
    assert.ok(textOf(mounted.container).includes("未指定"));
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
    assert.ok(detailText.includes("Pi default"));
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

test("DOM: overview cards, queued rows and finished history use the engine labels", async () => {
  const records = [
    worker({
      id: "worker-pi",
      type: "pi",
      taskName: "Pi 任务",
      latestRun: run({ id: "run-pi", workerId: "worker-pi", status: "queued" }),
    }),
    worker({
      id: "worker-agy",
      type: "agy",
      configId: "agy-default",
      configName: "agy#1",
      taskName: "Antigravity 任务",
      latestRun: run({
        id: "run-agy",
        workerId: "worker-agy",
        status: "running",
        finishedAt: null,
      }),
    }),
  ];
  const finished = worker({
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
  });
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: records,
        finished: { items: [finished], nextCursor: null },
      }),
  });
  try {
    await waitFor(
      () => textOf(mounted.container).includes("Antigravity 任务"),
      "活跃卡片",
    );
    const text = textOf(mounted.container);
    assert.equal(text.includes("DSH 任务"), false, "no legacy DSH row is rendered");
    assert.ok(text.includes("Antigravity"));
    assert.ok(text.includes("Pi"));
    assert.ok(text.includes("排队中"), "queued work is a compact row");
    assert.ok(text.includes("Codex 任务"), "finished history is listed below");
    assert.ok(text.includes("已结束任务"));
    assert.ok(text.includes("通知"));
    assert.equal(
      mounted.container.querySelector('[aria-label="按类型统计"]'),
      null,
      "engine statistic cards are replaced by conversation cards",
    );
    assert.ok(
      text.includes("Agy default 3 / Pi default 3 / Codex default 3"),
      "concurrency footer stays",
    );
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
    await openDetail(mounted);
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
    await openDetail(mounted);
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
    await openDetail(mounted);
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
    await openDetail(mounted);
    await waitFor(
      () => Boolean(findButton(mounted.container, "原始事件")),
      "日志标签",
    );
    // The conversation tab owns the run's first drain: its first page plus the page that
    // reaches terminal EOF here. Wait for that drain to finish so its reads cannot be
    // counted as raw-tab requests; the snapshot itself races the mounted effects.
    await delay(100);
    findButton(mounted.container, "原始事件")!.click();
    const before = mounted.calls.length;
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
    const logCalls = mounted.calls
      .slice(before)
      .filter((call) => call.path.includes("/logs?"));
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
        notifications: { items: [
          {
            id: "event-1",
            taskName: "任务一",
            ownerId: "owner-1",
            workerId: "worker-1",
            runId: "run-1",
            summary: "任务一已完成",
            status: "completed",
            createdAt: new Date().toISOString(),
            delivery: "held",
            batchId: null,
          },
          {
            id: "event-2",
            taskName: "任务一",
            ownerId: "owner-1",
            workerId: "worker-1",
            runId: "run-1",
            summary: "已送达的通知",
            status: "completed",
            createdAt: new Date().toISOString(),
            delivery: "delivered",
            batchId: "batch-1",
          },
        ], nextCursor: null },
      }),
  });
  try {
    await waitFor(
      () => Boolean(byLabel(mounted.container, "重试通知 event-1")),
      "通知列表",
    );
    // Delivered notifications expose no retry entry.
    assert.equal(byLabel(mounted.container, "重试通知 event-2"), null);
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

test("DOM: task and run info cards start collapsed and stay independent of progress and logs", async () => {
  const mounted = await mountPlugin();
  try {
    await openDetail(mounted);
    const info = mounted.container.querySelector(
      ".worker-detail-info",
    ) as HTMLDetailsElement | null;
    assert.ok(info);
    const summary = info.querySelector("summary")!;
    assert.equal(info.open, false);
    assert.ok(textOf(summary).includes("任务与本次运行"));
    assert.ok(textOf(mounted.container).includes("进度与预算"));
    assert.ok(textOf(mounted.container).includes("运行记录"));
    summary.click();
    await waitFor(() => info.open, "展开任务信息");
    assert.ok(textOf(info).includes("Worker 配置"));
    summary.click();
    await waitFor(() => !info.open, "收起任务信息");
  } finally {
    mounted.unmount();
  }
});

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

test("DOM: each config edits its timeout, validates it, and copies it on duplication", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    const first = byLabel(mounted.container, "配置 1 硬超时（秒）") as HTMLInputElement;
    const second = byLabel(mounted.container, "配置 2 硬超时（秒）") as HTMLInputElement;
    assert.equal(first.value, "300");
    assert.equal(second.value, "300");
    await typeInto(first, "0");
    await waitFor(() => button(mounted.container, "保存设置").disabled, "拒绝零秒超时");
    assert.ok(textOf(mounted.container).includes("硬超时必须是大于 0 的整数"));
    await typeInto(first, "1.5");
    assert.equal(button(mounted.container, "保存设置").disabled, true);
    await typeInto(first, "600");
    await typeInto(second, "");
    (byLabel(mounted.container, "新增 Codex 配置") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 4 硬超时（秒）")), "新增默认超时");
    assert.equal((byLabel(mounted.container, "配置 4 硬超时（秒）") as HTMLInputElement).value, "600");
    (byLabel(mounted.container, "配置 1 复制") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 5 硬超时（秒）")), "复制超时配置");
    assert.equal((byLabel(mounted.container, "配置 5 硬超时（秒）") as HTMLInputElement).value, "600");
    await waitFor(() => !button(mounted.container, "保存设置").disabled, "可保存超时配置");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存各配置超时");
    const body = callsTo(mounted, "/settings")[0]!.body as { configs: Array<{ hardTimeoutSeconds: number | null }> };
    assert.deepEqual(body.configs.map((config) => config.hardTimeoutSeconds), [600, null, 300, 600, 600]);
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
    (byLabel(mounted.container, "新增 Antigravity 配置") as HTMLButtonElement).click();
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
      "agy-default",
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

test("DOM: Pi's default model accepts thinking effort and only Codex exposes service/env blocks", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    // Only Codex exposes a service/env block; agy and Pi have neither.
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

function agySettings(): Record<string, any> & {
  configs: Array<Record<string, any>>;
} {
  const settings = snapshot().settings as Record<string, any> & {
    configs: Array<Record<string, any>>;
  };
  settings.configs = [
    ...configDefaults(),
    {
      id: "agy-extra",
      name: "agy#2",
      type: "agy",
      enabled: true,
      roles: [],
      concurrency: 3,
      hardTimeoutSeconds: 600,
      model: "gemini-3.8-flash-low",
      effort: "low",
    },
  ];
  return settings;
}

test("DOM: agy models are a real select and reasoning is fixed to the model default", async () => {
  const settings = agySettings();
  const mounted = await mountPlugin({ state: () => snapshot({ settings }) });
  try {
    await openSettings(mounted);
    const model = byLabel(mounted.container, "配置 4 模型") as HTMLSelectElement;
    const reasoning = byLabel(
      mounted.container,
      "配置 4 reasoning",
    ) as HTMLSelectElement;
    assert.equal(model.tagName, "SELECT");
    assert.deepEqual(optionValues(model), [
      "",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-high",
      "gemini-pro-orchestrator-neon",
    ]);
    assert.equal(optionLabels(model)[0], "默认（沿用执行器）");
    assert.equal(optionLabels(model)[1], "Gemini 3.8 Flash (Low)");
    assert.equal(model.value, "gemini-3.8-flash-low");
    // The previously stored level is neither shown nor editable: agy models own their effort.
    assert.deepEqual(optionValues(reasoning), [""]);
    assert.deepEqual(optionLabels(reasoning), ["默认（随模型）"]);
    assert.equal(reasoning.disabled, true);
    assert.equal(callsTo(mounted, "/catalog/agy").length, 1);

    await typeInto(model, "gemini-pro-orchestrator-neon");
    await waitFor(
      () => model.value === "gemini-pro-orchestrator-neon",
      "选择真实模型",
    );
    assert.deepEqual(optionValues(reasoning), [""]);
    assert.equal(reasoning.value, "");

    await waitFor(() => !button(mounted.container, "保存设置").disabled, "agy 可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存 agy 配置");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
    };
    assert.equal(body.configs[3]!.model, "gemini-pro-orchestrator-neon");
    assert.equal(body.configs[3]!.effort, null);
  } finally {
    mounted.unmount();
  }
});

test("DOM: agy runs the directory only for an agy config and fills the select from it", async () => {
  const settings = snapshot().settings as Record<string, unknown> & {
    configs: Array<Record<string, any>>;
  };
  // Start without an agy config so adding the first one is what triggers the directory.
  settings.configs = configDefaults().filter((config) => config.type !== "agy");
  let calls = 0;
  const mounted = await mountPlugin({
    state: () => snapshot({ settings }),
    agyCatalog: async () => {
      calls += 1;
      return AGY_CATALOG;
    },
  });
  try {
    await openSettings(mounted);
    // `agy models` is a network-backed CLI command: no agy card, no request.
    assert.equal(calls, 0);
    (byLabel(mounted.container, "新增 Antigravity 配置") as HTMLButtonElement).click();
    await waitFor(() => Boolean(byLabel(mounted.container, "配置 3 模型")), "新增 agy 配置");
    await waitFor(() => calls === 1, "首个 agy 配置触发目录");
    const model = byLabel(mounted.container, "配置 3 模型") as HTMLSelectElement;
    await waitFor(
      () => optionValues(model).includes("gemini-3.8-flash-low"),
      "agy 目录加载",
    );
    assert.deepEqual(optionValues(model), [
      "",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-high",
      "gemini-pro-orchestrator-neon",
    ]);
    await typeInto(model, "gemini-3.8-flash-low");
    // Deleting the only agy config removes the need and never re-runs the CLI.
    (byLabel(mounted.container, "配置 3 删除") as HTMLButtonElement).click();
    await waitFor(() => !byLabel(mounted.container, "配置 3 模型"), "删除 agy 配置");
    assert.equal(calls, 1);
  } finally {
    mounted.unmount();
  }
});

test("DOM: a failing agy directory keeps the saved id and retries in place", async () => {
  const settings = agySettings();
  let calls = 0;
  const mounted = await mountPlugin({
    state: () => snapshot({ settings }),
    agyCatalog: async () => {
      calls += 1;
      if (calls === 1) throw new Error("agy catalog down");
      return AGY_CATALOG;
    },
  });
  try {
    await openSettings(mounted);
    const card = byLabel(mounted.container, "配置 4 模型")!.closest("details")!;
    const model = byLabel(mounted.container, "配置 4 模型") as HTMLSelectElement;
    const reasoning = byLabel(
      mounted.container,
      "配置 4 reasoning",
    ) as HTMLSelectElement;
    await waitFor(() => textOf(card).includes("agy catalog down"), "agy 目录失败");
    assert.equal(model.value, "gemini-3.8-flash-low");
    assert.deepEqual(optionValues(model), ["", "gemini-3.8-flash-low"]);
    assert.match(
      optionLabels(model)[1]!,
      /gemini-3\.8-flash-low（当前已保存）/,
    );
    assert.deepEqual(optionLabels(reasoning), ["默认（随模型）"]);
    assert.equal(reasoning.disabled, true);

    findButton(card, "重试")!.click();
    await waitFor(() => !textOf(card).includes("agy catalog down"), "agy 目录重试");
    await waitFor(
      () => optionValues(model).includes("gemini-3.8-flash-high"),
      "agy 目录恢复",
    );
    assert.equal(calls, 2);
    assert.equal(model.value, "gemini-3.8-flash-low");
    assert.equal(reasoning.value, "");
  } finally {
    mounted.unmount();
  }
});

test("DOM: a stale stored agy effort is not shown, cleared on save and never blocks", async () => {
  const settings = agySettings();
  settings.configs[3] = {
    ...settings.configs[3],
    model: "gemini-3.8-flash-low",
    effort: "high",
  };
  const mounted = await mountPlugin({ state: () => snapshot({ settings }) });
  try {
    await openSettings(mounted);
    await waitFor(
      () => Boolean(byLabel(mounted.container, "配置 4 reasoning")),
      "agy reasoning",
    );
    // The obsolete UI conflict warning is gone; the old level never blocks the save.
    assert.equal(textOf(mounted.container).includes("固定使用 low reasoning"), false);
    const reasoning = byLabel(
      mounted.container,
      "配置 4 reasoning",
    ) as HTMLSelectElement;
    assert.deepEqual(optionValues(reasoning), [""]);
    assert.deepEqual(optionLabels(reasoning), ["默认（随模型）"]);
    assert.equal(reasoning.disabled, true);
    assert.equal(reasoning.value, "");

    await waitFor(() => !button(mounted.container, "保存设置").disabled, "旧 effort 不阻止保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存 agy 默认 effort");
    const body = callsTo(mounted, "/settings")[0]!.body as {
      configs: Array<Record<string, any>>;
    };
    assert.equal(body.configs[3]!.model, "gemini-3.8-flash-low");
    assert.equal(body.configs[3]!.effort, null);
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

test("DOM: config summaries follow draft roles and settings reopen closed", async () => {
  const mounted = await mountPlugin();
  try {
    await openSettings(mounted);
    const cards = configCards(mounted.container);
    assert.deepEqual(cards.map((card) => card.open), [false, false, false]);
    const card = cards[0]!;
    const summary = card.querySelector("summary")!;
    assert.equal(textOf(summary.querySelector(".worker-type-roles")), "未设置角色");
    summary.click();
    assert.equal(card.open, true);
    (byLabel(card, "配置 1 任务角色 开发") as HTMLInputElement).click();
    (byLabel(card, "配置 1 任务角色 测试") as HTMLInputElement).click();
    await waitFor(
      () => textOf(summary.querySelector(".worker-type-roles")) === "测试、开发",
      "角色摘要实时更新并按目录排序",
    );
    assert.equal(card.open, true);
    (byLabel(card, "配置 1 下移 Agy default") as HTMLButtonElement).click();
    await waitFor(() => configCards(mounted.container)[1] === card, "移动已展开配置");
    assert.equal(card.open, true);
    summary.click();
    assert.equal(card.open, false);
    assert.equal(textOf(summary.querySelector(".worker-type-roles")), "测试、开发");
    summary.click();
    (byLabel(card, "配置 2 任务角色 测试") as HTMLInputElement).click();
    (byLabel(card, "配置 2 任务角色 开发") as HTMLInputElement).click();
    await waitFor(
      () => textOf(summary.querySelector(".worker-type-roles")) === "未设置角色",
      "清空角色显示占位",
    );
    button(mounted.container, "返回列表").click();
    await openSettings(mounted);
    assert.deepEqual(configCards(mounted.container).map((item) => item.open), [false, false, false]);
    assert.equal(callsTo(mounted, "/settings").length, 0);
  } finally {
    mounted.unmount();
  }
});

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
      "Agy default",
      "Pi default",
      "Codex default",
    ]);
    configCards(mounted.container)[0]!.querySelector("summary")!.click();

    // Draft edits stay attached to their config id, not to a list position.
    await typeInto(
      byLabel(mounted.container, "配置 1 名称") as HTMLInputElement,
      "Agy 首选",
    );
    await typeInto(
      byLabel(mounted.container, "配置 3 Codex 环境变量") as HTMLTextAreaElement,
      "SORT_KEEP=1",
    );

    assert.equal(
      (byLabel(mounted.container, "配置 1 上移 Agy 首选") as HTMLButtonElement).disabled,
      true,
    );
    (byLabel(mounted.container, "配置 3 上移 Codex default") as HTMLButtonElement).click();
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "Agy 首选|Codex default|Pi default",
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
      "agy-default",
    );
    assert.equal(
      (byLabel(mounted.container, "配置 1 Agy 首选")!.closest("details") as HTMLDetailsElement)
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
      ["agy-default", "codex-default", "pi-default"],
    );
    assert.deepEqual(
      body.configs.map((config) => config.name),
      ["Agy 首选", "Codex default", "Pi default"],
    );
    assert.equal(body.configs[1]!.codex!.env.SORT_KEEP, "1");
    assert.equal(body.defaultConfigId, "agy-default");

    // The saved order is what the reloaded editor shows.
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "Agy 首选|Codex default|Pi default",
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
    assert.deepEqual(initialOrder, ["Agy default", "Pi default", "Codex default"]);
    configCards(mounted.container)[0]!.querySelector("summary")!.click();

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
        "Pi default|Codex default|Agy default",
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
      "agy-default",
    );
    const defaultCard = byLabel(mounted.container, "配置 3 Agy default")!.closest(
      "details",
    ) as HTMLDetailsElement;
    assert.equal(defaultCard.open, true);

    // A cancelled drag (dragend without drop) must not move or drop any config.
    await fireDrag(dragHandles(mounted.container)[0]!, "dragstart");
    await fireDrag(dragHandles(mounted.container)[0]!, "dragend");
    assert.deepEqual(configCardNames(mounted.container), [
      "Pi default",
      "Codex default",
      "Agy default",
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
      "agy-default",
    );
    assert.equal(configCards(mounted.container).length, 3);

    (byLabel(mounted.container, "配置 1 下移 Pi default") as HTMLButtonElement).click();
    await waitFor(
      () =>
        configCardNames(mounted.container).join("|") ===
        "Codex default|Pi default|Agy default",
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
        "Pi default|Codex default|Agy default",
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
        "Pi default|Codex default|Agy default",
      "拖放排序",
    );
    assert.equal(configCards(mounted.container).length, 3);
  } finally {
    mounted.unmount();
  }
});

function jsonl(events: Array<Record<string, unknown>>): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

test("DOM: the conversation tab is default and the host view reads /input plus parsed events", async () => {
  const piRun = run();
  const record = worker({
    type: "pi",
    configId: "pi-default",
    configName: "Pi default",
    latestRun: piRun,
  });
  const answer = {
    role: "assistant",
    content: [{ type: "text", text: "pi 答复" }],
  };
  const events = jsonl([
    // Pi echoes the prompt; `/input` stays the single source of the user row.
    {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "请执行任务" }] },
    },
    {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "请执行任务" }] },
    },
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "pi " },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "答复",
      },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "pi 答复",
      },
    },
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer },
  ]);
  const mounted = await mountPlugin({
    conversation: true,
    logs: () => ({ text: events, nextCursor: null, done: true }),
    input: () => ({ prompt: "请执行任务" }),
    detail: () => ({ worker: record, runs: [piRun] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(() => mounted.views.length >= 1, "宿主对话视图");
    await waitFor(
      () => textOf(mounted.container).includes("pi 答复"),
      "对话内容",
    );
    assert.equal(
      findButton(mounted.container, "对话")!.getAttribute("aria-pressed"),
      "true",
    );
    // The overview card reads the same run before the detail surface opens, so the same input
    // request appears twice; only the detail request carries every parsed event.
    const inputCalls = mounted.calls
      .filter((call) => call.path.includes("/input"))
      .map((call) => call.path);
    assert.deepEqual([...new Set(inputCalls)], [
      "/workers/worker-1/input?runId=run-1",
    ]);
    const view = mounted.views.at(-1)!;
    assert.equal(view.provider, "pi");
    const rows = view.messages;
    // The prompt arrives once from `/input`; Pi's echo of the same prompt is not repeated.
    assert.equal(
      rows.filter((row) => row.text === "请执行任务").length,
      1,
    );
    assert.deepEqual(rows[0], { id: "__input", role: "user", text: "请执行任务" });
    assert.equal(rows.filter((row) => row.text === "pi 答复").length, 1);
    // pi is reported as pi; the plugin never pretends to be Codex.
    assert.equal(view.provider, "pi");
  } finally {
    mounted.unmount();
  }
});

test("DOM: an older host keeps a readable fallback and the raw/stderr pages", async () => {
  const completed = run({
    status: "completed",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    finalText: "存储的最终答复",
  });
  const record = worker({ latestRun: completed });
  const mounted = await mountPlugin({
    logs: (_id, pathAndQuery) =>
      pathAndQuery.includes("stream=stderr")
        ? { text: "stderr 一行", nextCursor: null, done: true }
        : {
            text: jsonl([{ type: "final", text: "dsh 答复" }]),
            nextCursor: null,
            done: true,
          },
    input: () => {
      throw new Error("服务器版本较旧");
    },
    detail: () => ({ worker: record, runs: [completed] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => textOf(mounted.container).includes("dsh 答复"),
      "回退对话",
    );
    assert.ok(textOf(mounted.container).includes("当前宿主不支持对话视图"));
    // The stored final text is not duplicated under the conversation that already has it.
    assert.equal(textOf(mounted.container).includes("存储的最终答复"), false);

    findButton(mounted.container, "原始事件")!.click();
    await waitFor(
      () => textOf(byLabel(mounted.container, "原始事件日志")).includes("dsh 答复"),
      "原始事件",
    );
    findButton(mounted.container, "stderr")!.click();
    await waitFor(
      () => textOf(byLabel(mounted.container, "stderr 日志")).includes("stderr 一行"),
      "stderr",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: the stored result appears once, only after the log really ends", async () => {
  const completed = run({
    status: "completed",
    finishedAt: new Date().toISOString(),
    finalText: "过期运行的结果",
  });
  const record = worker({ latestRun: completed });
  let polls = 0;
  const mounted = await mountPlugin({
    logs: () => {
      polls += 1;
      // Still no record and still not terminal: an empty running page, then the end.
      // The overview card consumes the first empty page before the detail surface opens.
      return polls <= 2
        ? { text: "", nextCursor: "1", done: false }
        : { text: "", nextCursor: null, done: true };
    },
    detail: () => ({ worker: record, runs: [completed] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(() => polls >= 1, "首次读取");
    assert.equal(
      textOf(mounted.container).includes("过期运行的结果"),
      false,
      "the stored result must not flash before terminal EOF",
    );
    await waitFor(
      () => textOf(mounted.container).includes("仅显示存储的运行结果"),
      "仅结果提示",
    );
    const body = textOf(mounted.container);
    assert.equal(body.split("过期运行的结果").length - 1, 1);
  } finally {
    mounted.unmount();
  }
});

test("DOM: the conversation drains every page and retries an empty running page", async () => {
  let cursorCalls = 0;
  const mounted = await mountPlugin({
    logs: (_id, pathAndQuery) => {
      if (!pathAndQuery.includes("cursor="))
        return {
          text: jsonl([{ type: "text", text: "第一页" }]),
          nextCursor: "1",
          done: false,
        };
      cursorCalls++;
      if (cursorCalls <= 1)
        return { text: "", nextCursor: "1", done: false };
      return {
        text: jsonl([{ type: "text", text: "最新答复" }]),
        nextCursor: null,
        done: true,
      };
    },
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => textOf(mounted.container).includes("第一页最新答复"),
      "拉取到最新",
    );
    const logCalls = mounted.calls.filter((call) => call.path.includes("/logs?"));
    assert.ok(logCalls.length >= 3, JSON.stringify(logCalls.map((call) => call.path)));
    assert.ok(
      logCalls.filter((call) => call.path.includes("cursor=1")).length >= 2,
      "an empty running page keeps the cursor and retries",
    );
    assert.ok(!logCalls.some((call) => call.path.includes("stream=stderr")));
  } finally {
    mounted.unmount();
  }
});

test("DOM: the conversation reads its last page first and prepends earlier pages in log order", async () => {
  const completed = run({
    status: "completed",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  });
  const record = worker({ latestRun: completed });
  const requests: string[] = [];
  const mounted = await mountPlugin({
    conversation: true,
    logs: (_id, pathAndQuery) => {
      requests.push(pathAndQuery);
      if (pathAndQuery.includes("before=900"))
        return {
          // The earlier page ends its own turn, so it stays a row of its own after the rebuild.
          text: jsonl([
            { type: "text", text: "更早一段" },
            { type: "status", phase: "turn_end" },
          ]),
          prevCursor: null,
          nextCursor: "900",
          done: true,
        };
      return {
        text: jsonl([{ type: "text", text: "尾页答复" }]),
        prevCursor: "900",
        nextCursor: null,
        done: true,
      };
    },
    input: () => ({ prompt: "请执行任务" }),
    detail: () => ({ worker: record, runs: [completed] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => textOf(mounted.container).includes("尾页答复"),
      "尾页对话",
    );
    // Opening a run reads only the end of its log: one tail page, no history request. The
    // overview card already read the same tail before the detail surface opened.
    const baseline = requests.length;
    await delay(30);
    assert.deepEqual(requests.length, baseline, JSON.stringify(requests));
    const tailRequest = requests.at(-1)!;
    assert.ok(tailRequest.includes("tail=true"), tailRequest);
    assert.equal(tailRequest.includes("cursor="), false);
    assert.equal(tailRequest.includes("before="), false);
    // The run's first prompt belongs to the log start, which is not loaded yet.
    assert.equal(textOf(mounted.container).includes("请执行任务"), false);
    const box = byLabel(mounted.container, "对话内容")!;
    const view = mounted.dom.window as unknown as {
      Event: new (type: string) => Event;
    };
    // The first placement and a downward or motionless scroll never read history.
    box.dispatchEvent(new view.Event("scroll"));
    box.dispatchEvent(new view.Event("scroll"));
    await delay(60);
    assert.deepEqual(requests.length, baseline, JSON.stringify(requests));
    // A real upward move to the top does. jsdom has no layout, so the offset is simulated.
    const metrics = stubScrollMetrics(box);
    metrics.clientHeight = 300;
    metrics.scrollHeight = 2000;
    metrics.scrollTop = 400;
    box.dispatchEvent(new view.Event("scroll"));
    metrics.scrollTop = 0;
    box.dispatchEvent(new view.Event("scroll"));
    await waitFor(
      () => textOf(mounted.container).includes("更早一段"),
      "更早内容",
    );
    assert.equal(requests.filter((path) => path.includes("before=900")).length, 1);
    await waitFor(
      () => textOf(mounted.container).includes("请执行任务"),
      "日志开头的提示词",
    );
    const rows = mounted.views.at(-1)!.messages.map((row) => String(row.text));
    assert.deepEqual(rows, ["请执行任务", "更早一段", "尾页答复"]);
  } finally {
    mounted.unmount();
  }
});

test("DOM: a short tail page pages back only on an upward wheel at the top", async () => {
  const completed = run({
    status: "completed",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  });
  const record = worker({ latestRun: completed });
  const requests: string[] = [];
  const mounted = await mountPlugin({
    conversation: true,
    detail: () => ({ worker: record, runs: [completed] }),
    logs: (_id, pathAndQuery) => {
      requests.push(pathAndQuery);
      if (!pathAndQuery.includes("before="))
        return {
          text: jsonl([{ type: "text", text: "唯一尾页" }]),
          prevCursor: "40",
          nextCursor: null,
          done: true,
        };
      return {
        text: jsonl([
          { type: "text", text: "开头一段" },
          { type: "status", phase: "turn_end" },
        ]),
        // Another page stays available, so a spurious scroll would request a second one.
        prevCursor: "10",
        nextCursor: "40",
        done: true,
      };
    },
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => textOf(mounted.container).includes("唯一尾页"),
      "短尾页",
    );
    // A tail page that fits the panel is not extended by itself. The overview card read the
    // same tail once before the detail surface opened.
    await delay(80);
    const baseline = requests.length;
    assert.deepEqual(requests.length, baseline, JSON.stringify(requests));
    const box = byLabel(mounted.container, "对话内容")!;
    const view = mounted.dom.window as unknown as {
      WheelEvent: new (type: string, init: { deltaY: number }) => Event;
    };
    // A downward wheel at the top requests nothing; an upward one asks for the page above.
    box.dispatchEvent(new view.WheelEvent("wheel", { deltaY: 120 }));
    await delay(60);
    assert.deepEqual(requests.length, baseline, JSON.stringify(requests));
    box.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -120 }));
    await waitFor(
      () => textOf(mounted.container).includes("开头一段"),
      "主动翻页",
    );
    assert.ok(requests.at(-1)!.includes("before=40"), requests.at(-1));
  } finally {
    mounted.unmount();
  }
});

test("DOM: an earlier page from a short tail replaces the followed bottom with its own start", async () => {
  const completed = run({
    status: "completed",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  });
  const record = worker({ latestRun: completed });
  const requests: string[] = [];
  const mounted = await mountPlugin({
    detail: () => ({ worker: record, runs: [completed] }),
    logs: (_id, pathAndQuery) => {
      requests.push(pathAndQuery);
      if (!pathAndQuery.includes("before="))
        return {
          text: jsonl([{ type: "text", text: "唯一尾页" }]),
          prevCursor: "40",
          nextCursor: null,
          done: true,
        };
      return {
        text: jsonl([
          { type: "text", text: "开头一段" },
          { type: "status", phase: "turn_end" },
        ]),
        // Another page stays available, so a spurious scroll would request a second one.
        prevCursor: "10",
        nextCursor: "40",
        done: true,
      };
    },
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => textOf(mounted.container).includes("唯一尾页"),
      "短尾页",
    );
    const box = byLabel(mounted.container, "对话内容")!;
    // The tail page fits the panel: there is no scroll range to keep.
    const metrics = stubScrollMetrics(box);
    metrics.clientHeight = 300;
    metrics.scrollHeight = 200;
    const view = mounted.dom.window as unknown as {
      WheelEvent: new (type: string, init: { deltaY: number }) => Event;
    };
    box.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -120 }));
    await waitFor(
      () => textOf(mounted.container).includes("开头一段"),
      "上滚加载到更早内容",
    );
    assert.ok(requests.at(-1)!.includes("before=40"), requests.at(-1));
    // The host keeps following the newest row while the rows are drawn; the earlier page must
    // still open at its own first row.
    metrics.scrollHeight = 900;
    metrics.scrollTop = 600;
    const scrollEvents = mounted.dom.window as unknown as { Event: new (type: string) => Event };
    box.dispatchEvent(new scrollEvents.Event("scroll"));
    FakeResizeObserver.flush();
    assert.equal(metrics.scrollTop, 0, "短尾页翻页后应停在新增内容的开头");
    // The browser then delivers the scroll of that compensation; it is not a reader move.
    box.dispatchEvent(new scrollEvents.Event("scroll"));
    await delay(120);
    assert.equal(
      requests.filter((path) => path.includes("before=")).length,
      1,
      JSON.stringify(requests),
    );
    // That hold ended with the first overflowing page.
    metrics.scrollTop = 500;
    FakeResizeObserver.flush();
    assert.equal(metrics.scrollTop, 500);
  } finally {
    mounted.unmount();
  }
});

test("DOM: a bottom position clamped by a growing viewport is not an upward scroll", async () => {
  const mounted = await mountPlugin({
    logs: (_id, pathAndQuery) => {
      requests.push(pathAndQuery);
      return {
        text: jsonl([{ type: "text", text: "尾页" }]),
        prevCursor: "40",
        nextCursor: null,
        done: true,
      };
    },
  });
  const requests: string[] = [];
  try {
    await openDetail(mounted);
    await waitFor(() => textOf(mounted.container).includes("尾页"), "尾页");
    const box = byLabel(mounted.container, "对话内容")!;
    const metrics = stubScrollMetrics(box);
    const view = mounted.dom.window as unknown as { Event: new (type: string) => Event };
    // The overview card and the detail surface each read the tail once.
    const baseline = requests.length;
    // 440px of text in a 400px viewport: the bottom is 40px.
    metrics.scrollHeight = 440;
    metrics.clientHeight = 400;
    metrics.scrollTop = 40;
    box.dispatchEvent(new view.Event("scroll"));
    await delay(60);
    assert.deepEqual(requests.length, baseline, JSON.stringify(requests));
    // A viewport grown to 420px leaves a 20px maximum, so the browser clamps the offset.
    metrics.clientHeight = 420;
    metrics.scrollTop = 20;
    box.dispatchEvent(new view.Event("scroll"));
    await delay(80);
    assert.deepEqual(
      requests.length,
      baseline,
      "夹紧到新的底部不算上滚，不应请求历史",
    );
    // A real upward scroll still pages.
    metrics.scrollTop = 0;
    box.dispatchEvent(new view.Event("scroll"));
    await waitFor(
      () => requests.length === baseline + 1,
      "真实上滚请求历史",
    );
    assert.ok(requests.at(-1)!.includes("before=40"), requests.at(-1));
  } finally {
    mounted.unmount();
  }
});

test("DOM: selecting another record opens its conversation tail instead of the last log tab", async () => {
  const older = run({
    id: "run-1",
    status: "completed",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    model: "old-model",
  });
  const latest = run({
    id: "run-2",
    status: "completed",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    model: "new-model",
  });
  const record = worker({ latestRun: older });
  const requests: string[] = [];
  const mounted = await mountPlugin({
    conversation: true,
    detail: () => ({ worker: record, runs: [older, latest] }),
    logs: (_id, pathAndQuery) => {
      requests.push(pathAndQuery);
      return {
        text: jsonl([
          {
            type: "final",
            text: pathAndQuery.includes("runId=run-2") ? "run2 尾页" : "run1 尾页",
          },
        ]),
        prevCursor: null,
        nextCursor: null,
        done: true,
      };
    },
  });
  try {
    await openDetail(mounted);
    await waitFor(() => textOf(mounted.container).includes("run1 尾页"), "首个运行");
    findButton(mounted.container, "原始事件")!.click();
    await waitFor(
      () => Boolean(byLabel(mounted.container, "原始事件日志")),
      "原始事件",
    );
    findButton(mounted.container, "new-model")!.click();
    await waitFor(
      () =>
        findButton(mounted.container, "对话")!.getAttribute("aria-pressed") ===
        "true",
      "默认回到对话标签",
    );
    await waitFor(() => textOf(mounted.container).includes("run2 尾页"), "新运行对话");
    const reopened = requests
      .slice(requests.findIndex((path) => path.includes("runId=run-2")))
      .find((path) => path.includes("runId=run-2"))!;
    assert.ok(reopened.includes("tail=true"), reopened);
    assert.equal(reopened.includes("stream=stderr"), false);
  } finally {
    mounted.unmount();
  }
});

test("DOM: clicking the selected record again returns to its conversation end", async () => {
  const completed = run({
    status: "completed",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  });
  const record = worker({ latestRun: completed });
  const requests: string[] = [];
  let tails = 0;
  const mounted = await mountPlugin({
    conversation: true,
    detail: () => ({ worker: record, runs: [completed] }),
    logs: (_id, pathAndQuery) => {
      requests.push(pathAndQuery);
      if (pathAndQuery.includes("tail=true")) tails += 1;
      return {
        text: jsonl([{ type: "text", text: "尾页第 " + tails + " 次读取" }]),
        prevCursor: null,
        nextCursor: null,
        done: true,
      };
    },
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => /尾页第 \d+ 次读取/.test(textOf(mounted.container)),
      "首次对话",
    );
    const firstTail = tails;
    findButton(mounted.container, "原始事件")!.click();
    await waitFor(
      () => Boolean(byLabel(mounted.container, "原始事件日志")),
      "原始事件",
    );
    // The already selected record is reopened: the console returns to its conversation tail.
    findButton(mounted.container, "deepseek-v4")!.click();
    await waitFor(
      () =>
        findButton(mounted.container, "对话")!.getAttribute("aria-pressed") ===
        "true",
      "回到对话标签",
    );
    await waitFor(
      () =>
        tails > firstTail &&
        textOf(mounted.container).includes("尾页第 " + tails + " 次读取"),
      "重新读取尾页",
    );
    const last = requests.at(-1)!;
    assert.ok(last.includes("tail=true"), last);
  } finally {
    mounted.unmount();
  }
});

test("DOM: switching runs never shows the previous run's conversation", async () => {
  const older = run({
    id: "run-1",
    status: "completed",
    finishedAt: new Date().toISOString(),
    model: "old-model",
  });
  const latest = run({ id: "run-2", model: "new-model" });
  const record = worker({ latestRun: older });
  const pending: { release: ((value: unknown) => void) | null } = {
    release: null,
  };
  const mounted = await mountPlugin({
    detail: () => ({ worker: record, runs: [older, latest] }),
    logs: (_id, pathAndQuery) => {
      if (pathAndQuery.includes("runId=run-1"))
        return new Promise((resolve) => {
          pending.release = resolve;
        });
      return {
        text: jsonl([{ type: "final", text: "run2 答复" }]),
        nextCursor: null,
        done: true,
      };
    },
    input: (_id, pathAndQuery) => ({
      prompt: pathAndQuery.includes("runId=run-1") ? "run1 输入" : "run2 输入",
    }),
  });
  try {
    await openDetail(mounted);
    await waitFor(() => Boolean(findButton(mounted.container, "new-model")), "运行列表");
    findButton(mounted.container, "new-model")!.click();
    await waitFor(
      () => textOf(mounted.container).includes("run2 答复"),
      "第二个运行的对话",
    );
    assert.ok(pending.release, "old run request is still pending");
    pending.release!({
      text: jsonl([{ type: "final", text: "run1 旧答复" }]),
      nextCursor: null,
      done: true,
    });
    await delay(50);
    assert.equal(textOf(mounted.container).includes("run1 旧答复"), false);
    assert.equal(textOf(mounted.container).includes("run2 答复"), true);
  } finally {
    mounted.unmount();
  }
});

test("DOM: leaving the conversation tab stops the pump and reopening reads to the latest", async () => {
  let opens = 0;
  let cursorCalls = 0;
  const mounted = await mountPlugin({
    conversation: true,
    logs: (_id, pathAndQuery) => {
      if (!pathAndQuery.includes("cursor=")) {
        opens += 1;
        // The overview card and the detail surface each open the run once.
        if (opens <= 2)
          return {
            text: jsonl([{ type: "text", text: "第一段" }]),
            nextCursor: "1",
            done: false,
          };
        return {
          text: jsonl([{ type: "text", text: "重新打开后的最新内容" }]),
          nextCursor: null,
          done: true,
        };
      }
      cursorCalls += 1;
      return { text: "", nextCursor: "1", done: false };
    },
  });
  try {
    await openDetail(mounted);
    await waitFor(() => textOf(mounted.container).includes("第一段"), "首屏对话");
    await waitFor(() => cursorCalls >= 1, "游标轮询");
    findButton(mounted.container, "原始事件")!.click();
    await waitFor(() => Boolean(byLabel(mounted.container, "原始事件日志")), "原始事件");
    const settled = cursorCalls;
    await delay(150);
    assert.equal(cursorCalls, settled, "leaving the tab clears the pump and timer");
    assert.equal(mounted.views.at(-1)!.disposed, true, "the host view is disposed");
    findButton(mounted.container, "对话")!.click();
    await waitFor(
      () => textOf(mounted.container).includes("重新打开后的最新内容"),
      "重开加载到最新",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: a transient log failure keeps retrying and resumes live updates", async () => {
  let attempts = 0;
  const mounted = await mountPlugin({
    logs: () => {
      attempts += 1;
      // The overview card consumes one read before the detail surface starts polling.
      if (attempts <= 2) throw new Error("网络抖动");
      return {
        text: jsonl([{ type: "text", text: "恢复后的内容" }]),
        nextCursor: null,
        done: true,
      };
    },
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => textOf(mounted.container).includes("读取失败，正在重试"),
      "简短错误",
    );
    await waitFor(
      () => textOf(mounted.container).includes("恢复后的内容"),
      "重试恢复",
    );
    await waitFor(
      () => !textOf(mounted.container).includes("读取失败"),
      "错误清理",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: a thinking-only log is not an answer, so the stored result still shows", async () => {
  const completed = run({
    status: "completed",
    finishedAt: new Date().toISOString(),
    finalText: "唯一结果",
  });
  const record = worker({ type: "pi", latestRun: completed });
  const mounted = await mountPlugin({
    logs: () => ({
      text: jsonl([
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "只想不做",
          },
        },
      ]),
      nextCursor: null,
      done: true,
    }),
    detail: () => ({ worker: record, runs: [completed] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(() => textOf(mounted.container).includes("只想不做"), "思考行");
    await waitFor(
      () => textOf(mounted.container).includes("仅显示存储的运行结果"),
      "仅结果提示",
    );
    assert.equal(textOf(mounted.container).split("唯一结果").length - 1, 1);
  } finally {
    mounted.unmount();
  }
});

test("DOM: a run without an input record says so instead of inventing one", async () => {
  const completed = run({
    status: "completed",
    finishedAt: new Date().toISOString(),
  });
  const record = worker({ latestRun: completed });
  const mounted = await mountPlugin({
    logs: () => ({ text: "", nextCursor: null, done: true }),
    detail: () => ({ worker: record, runs: [completed] }),
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => textOf(mounted.container).includes("本次输入记录不可用"),
      "输入记录提示",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: switching runs re-mounts the host conversation view instead of reusing it", async () => {
  const older = run({
    id: "run-1",
    status: "completed",
    finishedAt: new Date().toISOString(),
    model: "old-model",
  });
  const latest = run({ id: "run-2", model: "new-model" });
  const record = worker({ latestRun: older });
  const pending: { release: ((value: unknown) => void) | null } = {
    release: null,
  };
  const mounted = await mountPlugin({
    conversation: true,
    detail: () => ({ worker: record, runs: [older, latest] }),
    logs: (_id, pathAndQuery) => {
      if (pathAndQuery.includes("runId=run-1"))
        return new Promise((resolve) => {
          pending.release = resolve;
        });
      return {
        text: jsonl([{ type: "text", text: "run2 答复" }]),
        nextCursor: null,
        done: true,
      };
    },
  });
  try {
    await openDetail(mounted);
    await waitFor(() => mounted.views.length >= 1, "第一个 run 的视图");
    assert.equal(mounted.views.at(-1)!.provider, "dsh");
    findButton(mounted.container, "new-model")!.click();
    // Same provider, different run: the old view is disposed and a fresh one mounts, so a
    // scroll/follow state from the previous run cannot survive.
    await waitFor(
      () => mounted.views.at(-1)?.provider === "dsh" && mounted.views.length >= 2,
      "第二个 run 的视图",
    );
    assert.equal(mounted.views.at(-2)!.disposed, true);
    assert.equal(mounted.views.at(-1)!.disposed, false);
    assert.equal(mounted.views.at(-1)!.provider, "dsh");
    await waitFor(
      () => textOf(mounted.container).includes("run2 答复"),
      "新 run 的对话",
    );
    assert.ok(pending.release, "the old run request is still pending");
    pending.release!({
      text: jsonl([{ type: "text", text: "run1 旧答复" }]),
      nextCursor: null,
      done: true,
    });
    await delay(50);
    assert.equal(textOf(mounted.container).includes("run1 旧答复"), false);
    assert.equal(mounted.views.at(-1)!.disposed, false);
  } finally {
    mounted.unmount();
  }
});

test("DOM: switching runs re-mounts the fallback conversation so its follow state resets", async () => {
  const older = run({
    id: "run-1",
    status: "completed",
    finishedAt: new Date().toISOString(),
    model: "old-model",
  });
  const latest = run({ id: "run-2", model: "new-model" });
  const record = worker({ latestRun: older });
  const mounted = await mountPlugin({
    detail: () => ({ worker: record, runs: [older, latest] }),
    logs: (_id, pathAndQuery) =>
      pathAndQuery.includes("runId=run-1")
        ? { text: jsonl([{ type: "text", text: "run1 答复" }]), nextCursor: null, done: true }
        : {
            text: jsonl([{ type: "text", text: "run2 答复" }]),
            nextCursor: null,
            done: true,
          },
  });
  try {
    await openDetail(mounted);
    await waitFor(
      () => Boolean(mounted.container.querySelector(".worker-conv-fallback")),
      "回退视图",
    );
    const first = mounted.container.querySelector(".worker-conv-fallback");
    findButton(mounted.container, "new-model")!.click();
    await waitFor(() => {
      const node = mounted.container.querySelector(".worker-conv-fallback");
      return Boolean(node) && node !== first;
    }, "回退视图重挂");
    await waitFor(
      () => textOf(mounted.container).includes("run2 答复"),
      "新 run 的对话",
    );
  } finally {
    mounted.unmount();
  }
});

//----------------- OVERVIEW LIST: CARDS, PAGING, AND POLLING ---------------

function finishedWorker(index: number) {
  return worker({
    id: "finished-" + index,
    taskName: "已结束 " + index,
    latestRun: run({
      id: "run-finished-" + index,
      workerId: "finished-" + index,
      status: "completed",
      finishedAt: new Date(Date.now() - index * 60_000).toISOString(),
      exitCode: 0,
    }),
  });
}

function notification(index: number) {
  return {
    id: "event-" + index,
    taskName: "已结束 " + index,
    ownerId: "owner-1",
    workerId: "finished-" + index,
    runId: "run-finished-" + index,
    summary: "通知 " + index,
    status: "completed" as const,
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    delivery: "delivered" as const,
    batchId: "batch-1",
  };
}

/** Scrolls one of the two history tables to its bottom, which requests that table's next page. */
async function scrollHistoryToBottom(mounted: Mounted, index: 0 | 1) {
  const box = mounted.container.querySelectorAll<HTMLElement>(
    ".worker-history-scroll",
  )[index]!;
  const metrics = stubScrollMetrics(box);
  metrics.clientHeight = 100;
  metrics.scrollHeight = 1000;
  metrics.scrollTop = 900;
  const view = mounted.dom.window as unknown as {
    Event: new (type: string) => Event;
  };
  box.dispatchEvent(new view.Event("scroll"));
}

test("DOM: each history table pages only itself, keeps loaded pages and resets on scope", async () => {
  const first = Array.from({ length: 20 }, (_, index) => finishedWorker(index));
  const older = finishedWorker(20);
  const notifications = Array.from({ length: 20 }, (_, index) => notification(index));
  const history: string[] = [];
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: [],
        finished: { items: first, nextCursor: "finished-1" },
        notifications: { items: notifications, nextCursor: "notifications-1" },
      }),
    history: (kind, pathAndQuery) => {
      history.push(pathAndQuery);
      if (kind === "finished")
        return { items: [older], nextCursor: null };
      return { items: [notification(20)], nextCursor: null };
    },
  });
  try {
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-history-table tbody tr")
          .length === 20 &&
        mounted.container.querySelectorAll(".worker-notification").length === 20,
      "两张历史表首屏各 20 行",
    );
    assert.equal(history.length, 0, "loading never walks history on its own");
    const details = mounted.container.querySelector(
      ".worker-notifications",
    ) as HTMLDetailsElement;
    assert.equal(details.open, true, "notifications stay an open details list");
    assert.equal(
      details.querySelector(".worker-history-table"),
      null,
      "notifications no longer render a table",
    );

    await scrollHistoryToBottom(mounted, 0);
    // The notification rows use the same "已结束 N" names, and their clock immediately follows
    // the name ("已结束 2" + "00:26" flattens to "已结束 200:26"), so a whole-container text
    // match is satisfied before this table's page arrives. Wait on the finished table itself.
    await waitFor(
      () =>
        [...mounted.container.querySelectorAll(".worker-history-table tbody tr")].some(
          (row) => textOf(row).includes("已结束 20"),
        ),
      "已结束任务下一页",
    );
    assert.deepEqual(
      history.map((path) => new URLSearchParams(path.split("?")[1]).get("kind")),
      ["finished"],
      "the notifications table is not paged by the finished table",
    );
    assert.ok(history[0]!.includes("cursor=finished-1"), history[0]);
    assert.equal(
      mounted.container.querySelectorAll(".worker-history-table tbody tr")
        .length,
      21,
      "the loaded first page survives the next page",
    );

    await scrollHistoryToBottom(mounted, 1);
    await waitFor(
      () => textOf(mounted.container).includes("通知 20"),
      "通知下一页",
    );
    assert.equal(history.length, 2);
    assert.ok(history[1]!.includes("cursor=notifications-1"), history[1]);

    // A scope switch clears both feeds and starts again from the overview's first page.
    (byLabel(mounted.container, "范围：全部") as HTMLButtonElement).click();
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-history-table tbody tr")
          .length === 20 &&
        mounted.container.querySelectorAll(".worker-notification").length === 20,
      "切换范围后重建",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: a first page that drifts past a paged window rebuilds it and keeps results reachable", async () => {
  const oldRows = Array.from({ length: 43 }, (_, index) => finishedWorker(index));
  const newRows = Array.from({ length: 20 }, (_, index) =>
    worker({
      // Reuses a known id with a new finishedAt: id-only overlap would miss the hole below.
      id: index === 0 ? "finished-0" : "new-" + index,
      taskName: "新任务 " + (index + 1),
      latestRun: run({
        id: "run-new-" + index,
        workerId: "new-" + index,
        status: "completed",
        finishedAt: new Date(Date.now() + (20 - index) * 60_000).toISOString(),
        exitCode: 0,
      }),
    }),
  );
  const missing = worker({
    id: "new-missing",
    taskName: "新任务 21",
    latestRun: run({
      id: "run-new-missing",
      workerId: "new-missing",
      status: "completed",
      finishedAt: new Date(Date.now() + 1000).toISOString(),
      exitCode: 0,
    }),
  });
  const history: string[] = [];
  let refreshed = false;
  const mounted = await mountPlugin({
    state: () =>
      refreshed
        ? snapshot({
            workers: [],
            finished: { items: newRows, nextCursor: "finished-new-1" },
          })
        : snapshot({
            workers: [],
            finished: { items: oldRows.slice(0, 20), nextCursor: "finished-1" },
          }),
    history: (kind, pathAndQuery) => {
      history.push(pathAndQuery);
      const cursor = new URLSearchParams(pathAndQuery.split("?")[1]).get("cursor");
      if (cursor === "finished-1")
        return { items: oldRows.slice(20, 40), nextCursor: "finished-2" };
      if (cursor === "finished-2")
        return { items: oldRows.slice(40), nextCursor: null };
      if (cursor === "finished-new-1")
        return {
          items: [missing, ...oldRows.slice(1, 20)],
          nextCursor: "finished-new-2",
        };
      if (cursor === "finished-new-2")
        return { items: oldRows.slice(20), nextCursor: null };
      throw new Error("unexpected history cursor " + cursor);
    },
  });
  try {
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-history-table tbody tr")
          .length === 20,
      "首屏 20 行",
    );
    await scrollHistoryToBottom(mounted, 0);
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-history-table tbody tr")
          .length === 40,
      "第二页",
    );
    await scrollHistoryToBottom(mounted, 0);
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-history-table tbody tr")
          .length === 43,
      "第三页",
    );
    // A normal overlapping poll keeps every loaded page and the deep cursor.
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.equal(
      mounted.container.querySelectorAll(".worker-history-table tbody tr").length,
      43,
    );

    // Two new pages arrived while the window sat at 43 rows: the polled first page no longer
    // intersects it, so the table realigns instead of leaving a hole between them.
    refreshed = true;
    await waitFor(
      () =>
        textOf(mounted.container).includes("新任务 1") &&
        mounted.container.querySelectorAll(".worker-history-table tbody tr")
          .length === 20,
      "脱节后按新首页重建",
    );
    assert.equal(textOf(mounted.container).includes("已结束 0"), false);

    const before = history.length;
    await scrollHistoryToBottom(mounted, 0);
    await waitFor(
      () => textOf(mounted.container).includes("新任务 21"),
      "补齐中间缺失行",
    );
    assert.ok(history[before]!.includes("cursor=finished-new-1"), history[before]);
    assert.equal(
      mounted.container.querySelectorAll(".worker-history-table tbody tr").length,
      40,
      "重建后从新首页的下一页继续",
    );

    await scrollHistoryToBottom(mounted, 0);
    await waitFor(
      () => textOf(mounted.container).includes("已结束 42"),
      "翻到最后一页",
    );
    assert.equal(
      mounted.container.querySelectorAll(".worker-history-table tbody tr").length,
      63,
    );
    // The final page's null cursor leaves no retry for old cursors.
    await scrollHistoryToBottom(mounted, 0);
    assert.equal(history.length, before + 2);
  } finally {
    mounted.unmount();
  }
});

test("DOM: retrying a loaded older notification updates that row and keeps the pages", async () => {
  const held = {
    ...notification(20),
    id: "event-held",
    summary: "第二页的暂缓通知",
    delivery: "held" as const,
  };
  const attempts: Array<"fail" | "none" | "queued"> = ["fail", "none", "queued"];
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: [],
        notifications: {
          items: Array.from({ length: 20 }, (_, index) => notification(index)),
          nextCursor: "notifications-1",
        },
      }),
    history: () => ({ items: [held], nextCursor: null }),
    retry: () => {
      const attempt = attempts.shift();
      if (attempt === "fail") throw new Error("投递服务不可用");
      return { retried: attempt === "queued" ? 1 : 0 };
    },
  });
  try {
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-notification").length === 20,
      "通知首屏",
    );
    await scrollHistoryToBottom(mounted, 1);
    await waitFor(
      () => Boolean(byLabel(mounted.container, "重试通知 event-held")),
      "第二页通知",
    );
    assert.equal(
      mounted.container.querySelectorAll(".worker-notification").length,
      21,
    );
    assert.ok(textOf(mounted.container).includes("暂缓"));

    // A failed request is not a queued retry: the row stays held and retryable.
    (byLabel(mounted.container, "重试通知 event-held") as HTMLButtonElement).click();
    await waitFor(
      () => textOf(mounted.container).includes("投递服务不可用"),
      "重试失败提示",
    );
    assert.ok(byLabel(mounted.container, "重试通知 event-held"));
    assert.ok(textOf(mounted.container).includes("暂缓"));
    await waitFor(
      () => callsTo(mounted, "/notifications/retry").length === 1,
      "失败请求完成",
    );

    // `retried: 0` also leaves the row untouched.
    await waitFor(
      () =>
        !(byLabel(mounted.container, "重试通知 event-held") as HTMLButtonElement)
          .disabled,
      "失败后可再次重试",
    );
    (byLabel(mounted.container, "重试通知 event-held") as HTMLButtonElement).click();
    await waitFor(
      () => textOf(mounted.container).includes("没有可重试的通知"),
      "零重试提示",
    );
    assert.ok(byLabel(mounted.container, "重试通知 event-held"));
    assert.ok(textOf(mounted.container).includes("暂缓"));
    await waitFor(
      () => callsTo(mounted, "/notifications/retry").length === 2,
      "零重试请求完成",
    );

    // A queued retry updates this loaded row immediately and removes the duplicate entry.
    await waitFor(
      () =>
        !(byLabel(mounted.container, "重试通知 event-held") as HTMLButtonElement)
          .disabled,
      "零重试后可再次重试",
    );
    (byLabel(mounted.container, "重试通知 event-held") as HTMLButtonElement).click();
    await waitFor(
      () => !byLabel(mounted.container, "重试通知 event-held"),
      "成功后移除重试入口",
    );
    assert.ok(textOf(mounted.container).includes("待领取"));
    assert.equal(
      mounted.container.querySelectorAll(".worker-notification").length,
      21,
      "the loaded notification page survives the retry",
    );
    assert.equal(callsTo(mounted, "/notifications/retry").length, 3);
    assert.deepEqual(callsTo(mounted, "/notifications/retry")[2]!.body, {
      eventIds: ["event-held"],
    });
  } finally {
    mounted.unmount();
  }
});

test("DOM: an authoritative empty first page clears only its own loaded table", async () => {
  let phase = 0;
  const first = Array.from({ length: 20 }, (_, index) => finishedWorker(index));
  const older = Array.from({ length: 20 }, (_, index) => finishedWorker(index + 20));
  const notices = Array.from({ length: 20 }, (_, index) => notification(index));
  const later = worker({
    id: "after-clear",
    taskName: "清空后的任务",
    latestRun: run({
      id: "run-after-clear",
      workerId: "after-clear",
      status: "completed",
      finishedAt: new Date(Date.now() + 60_000).toISOString(),
      exitCode: 0,
    }),
  });
  const mounted = await mountPlugin({
    state: () => {
      if (phase === 0)
        return snapshot({
          workers: [],
          finished: { items: first, nextCursor: "finished-1" },
          notifications: { items: notices, nextCursor: null },
        });
      if (phase === 1)
        return snapshot({
          workers: [],
          finished: { items: [], nextCursor: null },
          notifications: { items: notices, nextCursor: null },
        });
      if (phase === 2)
        return snapshot({
          workers: [],
          finished: { items: [], nextCursor: null },
          notifications: { items: [], nextCursor: null },
        });
      return snapshot({
        workers: [],
        finished: { items: [later], nextCursor: null },
        notifications: { items: [], nextCursor: null },
      });
    },
    history: (_kind, path) =>
      path.includes("cursor=finished-1")
        ? { items: older, nextCursor: null }
        : { items: [], nextCursor: null },
  });
  const section = (table: number) =>
    mounted.container.querySelectorAll(
      table === 0 ? ".worker-history" : ".worker-notifications",
    )[0];
  const rows = (table: number) =>
    table === 0
      ? section(0)?.querySelectorAll("tbody tr").length ?? 0
      : mounted.container.querySelectorAll(".worker-notification").length;
  try {
    await waitFor(() => rows(0) === 20, "已结束首屏");
    await scrollHistoryToBottom(mounted, 0);
    await waitFor(() => rows(0) === 40, "已结束已翻页缓存");
    assert.equal(rows(1), 20);

    // Retention clears finished first: only that table drops its rows and its paged cursor.
    phase = 1;
    await waitFor(() => rows(0) === 0, "已结束表清空");
    assert.ok(section(0)!.textContent!.includes("暂无已结束任务"));
    assert.equal(rows(1), 20, "the notifications table keeps its rows");

    phase = 2;
    await waitFor(() => rows(1) === 0, "通知表清空");
    assert.ok(section(1)!.textContent!.includes("暂无通知"));

    // A record that arrives after the clear is still merged in normally.
    phase = 3;
    await waitFor(
      () => textOf(mounted.container).includes("清空后的任务"),
      "清空后的新记录",
    );
    assert.equal(rows(0), 1);
  } finally {
    mounted.unmount();
  }
});

test("DOM: a late older page is discarded after the first page rebuilds the window", async () => {
  let resolvePage: ((page: unknown) => void) | null = null;
  let refreshed = false;
  const oldRows = Array.from({ length: 25 }, (_, index) => finishedWorker(index));
  const newRows = Array.from({ length: 20 }, (_, index) =>
    worker({
      id: "fresh-" + index,
      taskName: "刷新 " + index,
      latestRun: run({
        id: "run-fresh-" + index,
        workerId: "fresh-" + index,
        status: "completed",
        finishedAt: new Date(Date.now() + (20 - index) * 60_000).toISOString(),
        exitCode: 0,
      }),
    }),
  );
  const mounted = await mountPlugin({
    state: () =>
      refreshed
        ? snapshot({
            workers: [],
            finished: { items: newRows, nextCursor: "finished-fresh-1" },
          })
        : snapshot({
            workers: [],
            finished: { items: oldRows.slice(0, 20), nextCursor: "finished-1" },
          }),
    history: () =>
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
  });
  try {
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-history-table tbody tr")
          .length === 20,
      "旧首页",
    );
    // The first page was already read and its next page is still on the wire.
    await scrollHistoryToBottom(mounted, 0);
    refreshed = true;
    await waitFor(
      () =>
        textOf(mounted.container).includes("刷新 0") &&
        mounted.container.querySelectorAll(".worker-history-table tbody tr")
          .length === 20,
      "在途分页时仍按新首页重建",
    );
    resolvePage!({ items: oldRows.slice(20), nextCursor: "finished-2" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      mounted.container.querySelectorAll(".worker-history-table tbody tr").length,
      20,
      "the retired page never overwrites the rebuilt window",
    );
    assert.equal(textOf(mounted.container).includes("已结束 24"), false);
  } finally {
    mounted.unmount();
  }
});

test("DOM: a retry response keeps a delivery that polling already refreshed", async () => {
  let delivery: "held" | "delivered" = "held";
  let resolveRetry: ((value: unknown) => void) | null = null;
  const live = () => ({
    ...notification(0),
    id: "event-live",
    summary: "刚送达的通知",
    delivery,
  });
  const mounted = await mountPlugin({
    state: () => snapshot({ workers: [], notifications: { items: [live()], nextCursor: null } }),
    retry: () =>
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
  });
  try {
    await waitFor(
      () => Boolean(byLabel(mounted.container, "重试通知 event-live")),
      "暂缓通知",
    );
    (byLabel(mounted.container, "重试通知 event-live") as HTMLButtonElement).click();
    await waitFor(
      () => callsTo(mounted, "/notifications/retry").length === 1,
      "重试在途",
    );
    // Polling observes the delivered state before the retry response arrives.
    delivery = "delivered";
    await waitFor(
      () => textOf(mounted.container).includes("已送达"),
      "轮询刷新投递状态",
    );
    resolveRetry!({ retried: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(textOf(mounted.container).includes("已送达"));
    assert.equal(byLabel(mounted.container, "重试通知 event-live"), null);
  } finally {
    mounted.unmount();
  }
});

test("DOM: a worker that resumes leaves the finished table for a live card", async () => {
  const resumed = finishedWorker(0);
  resumed.taskName = "恢复任务";
  resumed.latestRun!.status = "running";
  resumed.latestRun!.finishedAt = null;
  let calls = 0;
  const mounted = await mountPlugin({
    state: () => {
      calls += 1;
      return calls === 1
        ? snapshot({
            workers: [],
            finished: { items: [resumed], nextCursor: null },
          })
        : snapshot({
            workers: [resumed],
            finished: { items: [], nextCursor: null },
          });
    },
  });
  try {
    await waitFor(
      () => Boolean(byLabel(mounted.container, "任务卡片 恢复任务")),
      "轮询把恢复的任务重新放进活动区",
    );
    assert.equal(
      textOf(mounted.container).includes("已结束任务 1"),
      false,
      "the stale finished row is dropped once the worker is active again",
    );
    assert.equal(
      textOf(mounted.container).includes("恢复任务"),
      true,
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: each conversation card follows its own latest rows", async () => {
  const one = worker({
    id: "worker-one",
    taskName: "对话一",
    latestRun: run({ id: "run-one", workerId: "worker-one", status: "running" }),
  });
  const two = worker({
    id: "worker-two",
    taskName: "对话二",
    latestRun: run({ id: "run-two", workerId: "worker-two", status: "running" }),
  });
  const mounted = await mountPlugin({
    state: () => snapshot({ workers: [one, two] }),
    logs: (_id, pathAndQuery) => ({
      text: jsonl([
        {
          type: "text",
          text: pathAndQuery.includes("runId=run-two") ? "第二条对话" : "第一条对话",
        },
      ]),
      nextCursor: null,
      done: true,
    }),
  });
  try {
    await waitFor(
      () =>
        textOf(mounted.container).includes("第一条对话") &&
        textOf(mounted.container).includes("第二条对话"),
      "两张独立对话",
    );
    assert.equal(
      mounted.container.querySelectorAll('[aria-label="对话内容"]').length,
      2,
    );
    const first = mounted.container.querySelectorAll<HTMLElement>(
      '[aria-label="对话内容"]',
    )[0]!;
    const metrics = stubScrollMetrics(first);
    metrics.clientHeight = 100;
    metrics.scrollHeight = 600;
    metrics.scrollTop = 100;
    const view = mounted.dom.window as unknown as {
      Event: new (type: string) => Event;
    };
    first.dispatchEvent(new view.Event("scroll"));
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-conv-latest").length === 1,
      "只有上翻的对话暂停跟随",
    );
    (mounted.container.querySelector(".worker-conv-latest") as HTMLButtonElement).click();
    await waitFor(
      () => mounted.container.querySelectorAll(".worker-conv-latest").length === 0,
      "恢复跟随后隐藏回到最新",
    );
  } finally {
    mounted.unmount();
  }
});

test("DOM: four cards stay one flat two-row grid and keep their panes on redraw", async () => {
  let count = 4;
  const workers = Array.from({ length: 6 }, (_, index) =>
    worker({
      id: "grid-" + index,
      taskName: "网格 " + index,
      latestRun: run({
        id: "run-grid-" + index,
        workerId: "grid-" + index,
        status: "running",
      }),
    }),
  );
  const mounted = await mountPlugin({
    state: () => snapshot({ workers: workers.slice(0, count) }),
    logs: () => ({ text: "", nextCursor: null, done: false }),
  });
  try {
    await waitFor(
      () =>
        mounted.container.querySelectorAll(".worker-card").length === 4,
      "四张卡片",
    );
    const grid = mounted.container.querySelector(".worker-cards")!;
    assert.equal(grid.getAttribute("data-count"), "4");
    assert.equal(grid.getAttribute("data-many"), null);
    assert.ok(
      grid.closest(".worker-first-screen-fill"),
      "live cards fill the measured first screen",
    );
    assert.equal(
      grid.closest(".worker-first-screen")!.querySelector(".worker-history"),
      null,
      "history tables stay outside the first screen",
    );
    const firstCard = grid.querySelector(".worker-card")!;
    const firstPane = firstCard.querySelector(".worker-conv")!;
    count = 5;
    await waitFor(
      () => mounted.container.querySelectorAll(".worker-card").length === 5,
      "轮询新增第五张",
    );
    assert.equal(
      mounted.container.querySelector(".worker-cards"),
      grid,
      "the scroll container is reused",
    );
    assert.equal(grid.querySelector(".worker-card"), firstCard);
    assert.equal(firstCard.querySelector(".worker-conv"), firstPane);
  } finally {
    mounted.unmount();
  }
});

test("DOM: the agy cooldown is one global deadline countdown", async () => {
  const deadline = new Date(Date.now() + 65_000).toISOString();
  const mounted = await mountPlugin({
    state: () => snapshot({ agyCooldownUntil: deadline }),
  });
  try {
    await waitFor(
      () => textOf(mounted.container).includes("Antigravity 冷却中"),
      "冷却提示",
    );
    assert.ok(textOf(mounted.container).includes("1:0"), textOf(mounted.container));
  } finally {
    mounted.unmount();
  }
});

test("DOM: multiple live cards load initial and subsequent pages independently without blocking or cross-talk", async () => {
  let runBId = "run-b-1";
  let releaseWorkerAFirst: ((value: unknown) => void) | null = null;
  let deliverSecondPages = false;
  const activeWorkers = () => [
    worker({
      id: "worker-a",
      type: "codex",
      taskName: "并行 Codex",
      latestRun: run({ id: "run-a-1", workerId: "worker-a", status: "running" }),
    }),
    worker({
      id: "worker-b",
      type: "pi",
      taskName: "并行 Pi",
      latestRun: run({ id: runBId, workerId: "worker-b", status: "running" }),
    }),
    worker({
      id: "worker-c",
      type: "agy",
      taskName: "并行 Agy",
      latestRun: run({ id: "run-c-1", workerId: "worker-c", status: "running" }),
    }),
  ];
  const mounted = await mountPlugin({
    conversation: true,
    state: () => snapshot({ workers: activeWorkers() }),
    input: (workerId) => ({ prompt: "输入 " + workerId }),
    logs: (workerId, pathAndQuery) => {
      const params = new URLSearchParams(pathAndQuery.split("?")[1] ?? "");
      const runId = params.get("runId");
      const cursor = params.get("cursor");
      if (workerId === "worker-a" && runId === "run-a-1") {
        if (!cursor) {
          return new Promise((resolve) => {
            releaseWorkerAFirst = resolve;
          });
        }
        if (cursor === "a-1" && deliverSecondPages) {
          return {
            text: jsonl([
              {
                type: "item.completed",
                item: { id: "a-m2", type: "agent_message", text: "A 第二页更新" },
              },
            ]),
            prevCursor: null,
            nextCursor: "a-2",
            done: false,
          };
        }
        return { text: "", prevCursor: null, nextCursor: cursor, done: false };
      }
      if (workerId === "worker-b" && runId === "run-b-1") {
        if (!cursor) {
          return {
            text: jsonl([
              {
                type: "message_end",
                message: {
                  id: "b-m1",
                  role: "assistant",
                  content: [{ type: "text", text: "B 首页内容" }],
                },
              },
            ]),
            prevCursor: null,
            nextCursor: "b-1",
            done: false,
          };
        }
        if (cursor === "b-1" && deliverSecondPages) {
          return {
            text: jsonl([
              {
                type: "message_end",
                message: {
                  id: "b-m2",
                  role: "assistant",
                  content: [{ type: "text", text: "B 第二页更新" }],
                },
              },
            ]),
            prevCursor: null,
            nextCursor: "b-2",
            done: false,
          };
        }
        return { text: "", prevCursor: null, nextCursor: cursor, done: false };
      }
      if (workerId === "worker-b" && runId === "run-b-2") {
        return {
          text: jsonl([
            {
              type: "message_end",
              message: {
                id: "b2-m1",
                role: "assistant",
                content: [{ type: "text", text: "B 续跑新内容" }],
              },
            },
          ]),
          prevCursor: null,
          nextCursor: null,
          done: true,
        };
      }
      if (workerId === "worker-c" && runId === "run-c-1") {
        if (!cursor) {
          return {
            text: jsonl([
              {
                event: "step_update",
                step_update: {
                  step_index: 1,
                  step_type: "agent_response",
                  state: "ACTIVE",
                  text_delta: "C 首页内容",
                },
              },
            ]),
            prevCursor: null,
            nextCursor: "c-1",
            done: false,
          };
        }
        if (cursor === "c-1" && deliverSecondPages) {
          return {
            text: jsonl([
              {
                event: "step_update",
                step_update: {
                  step_index: 1,
                  step_type: "agent_response",
                  state: "DONE",
                  text_delta: " + C 第二页更新",
                },
              },
            ]),
            prevCursor: null,
            nextCursor: "c-2",
            done: false,
          };
        }
        return { text: "", prevCursor: null, nextCursor: cursor, done: false };
      }
      throw new Error("unexpected logs " + workerId + " " + pathAndQuery);
    },
  });
  try {
    // While worker-a's first log request is still pending, worker-b and worker-c load independently.
    await waitFor(
      () => {
        const cardB = byLabel(mounted.container, "任务卡片 并行 Pi");
        const cardC = byLabel(mounted.container, "任务卡片 并行 Agy");
        return (
          Boolean(releaseWorkerAFirst) &&
          textOf(cardB).includes("B 首页内容") &&
          textOf(cardC).includes("C 首页内容")
        );
      },
      "B 和 C 不受阻塞的 A 影响",
    );
    const cardA = byLabel(mounted.container, "任务卡片 并行 Codex")!;
    const cardB = byLabel(mounted.container, "任务卡片 并行 Pi")!;
    const cardC = byLabel(mounted.container, "任务卡片 并行 Agy")!;
    assert.equal(mounted.views.length, 3, "each card mounts its own host conversation view");
    assert.equal(textOf(cardB).includes("C 首页内容"), false);
    assert.equal(textOf(cardC).includes("B 首页内容"), false);

    // Release worker-a's first page, then deliver subsequent pages for all three cards.
    releaseWorkerAFirst!({
      text: jsonl([
        {
          type: "item.completed",
          item: { id: "a-m1", type: "agent_message", text: "A 首页内容" },
        },
      ]),
      prevCursor: null,
      nextCursor: "a-1",
      done: false,
    });
    await waitFor(() => textOf(cardA).includes("A 首页内容"), "A 首页到达");
    assert.ok(textOf(cardA).includes("输入 worker-a"));
    assert.ok(textOf(cardB).includes("输入 worker-b"));
    assert.ok(textOf(cardC).includes("输入 worker-c"));

    deliverSecondPages = true;
    await waitFor(
      () =>
        textOf(cardA).includes("A 第二页更新") &&
        textOf(cardB).includes("B 第二页更新") &&
        textOf(cardC).includes("C 第二页更新"),
      "三张卡片持续读取各自后续日志页",
    );
    assert.equal(textOf(cardA).includes("B 第二页更新"), false);
    assert.equal(textOf(cardB).includes("C 第二页更新"), false);
    assert.equal(textOf(cardC).includes("A 第二页更新"), false);

    // Carousel switching scrolls horizontally without losing or crossing any card's content.
    const cardsEl = mounted.container.querySelector<HTMLElement>(".worker-cards")!;
    Object.defineProperty(cardsEl, "scrollWidth", { configurable: true, value: 1116 });
    Object.defineProperty(cardsEl, "clientWidth", { configurable: true, value: 358 });
    Object.defineProperty(cardA, "offsetWidth", { configurable: true, value: 358 });
    let scrollLeft = 0;
    Object.defineProperty(cardsEl, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    cardsEl.scrollTo = ((options?: ScrollToOptions) => {
      if (typeof options?.left === "number") scrollLeft = options.left;
    }) as typeof cardsEl.scrollTo;
    (byLabel(mounted.container, "下一组卡片") as HTMLButtonElement).click();
    assert.ok(scrollLeft > 0, "carousel shifts right to reveal the next card");
    (byLabel(mounted.container, "上一组卡片") as HTMLButtonElement).click();
    assert.equal(scrollLeft, 0, "carousel shifts back to the first card");
    assert.ok(textOf(cardA).includes("A 第二页更新"));
    assert.ok(textOf(cardB).includes("B 第二页更新"));
    assert.ok(textOf(cardC).includes("C 第二页更新"));

    // Switching one card to a new run remounts only that card's conversation host view.
    const viewA = mounted.views[0]!;
    const viewB = mounted.views[1]!;
    const viewC = mounted.views[2]!;
    runBId = "run-b-2";
    await waitFor(() => textOf(cardB).includes("B 续跑新内容"), "B 切换新 run 后加载新内容");
    assert.equal(viewB.disposed, true, "old run host view is disposed on run switch");
    assert.equal(viewA.disposed, false, "sibling card A view stays mounted");
    assert.equal(viewC.disposed, false, "sibling card C view stays mounted");
    assert.equal(textOf(cardB).includes("B 首页内容"), false);
  } finally {
    mounted.unmount();
  }
});

test("DOM: overview list root scrolls vertically so its background covers history past the first screen", async () => {
  const mounted = await mountPlugin({
    state: () =>
      snapshot({
        workers: [worker()],
        finished: { items: [finishedWorker(0)], nextCursor: null },
      }),
  });
  try {
    await waitFor(
      () => textOf(mounted.container).includes("已结束任务"),
      "总览列表已渲染",
    );
    const root = mounted.container.querySelector<HTMLElement>('.worker-plugin[data-view="list"]')!;
    const sheet = mounted.container.querySelector("style")!.textContent ?? "";
    assert.match(
      sheet,
      /\.worker-plugin\[data-view="list"\]\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/,
      "list root owns vertical scrolling so background does not cut off across the history heading",
    );
    assert.ok(root.querySelector(".worker-first-screen-fill"));
    assert.ok(root.querySelector(".worker-history h3"));
  } finally {
    mounted.unmount();
  }
});
