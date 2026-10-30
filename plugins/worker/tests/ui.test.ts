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
  input: HTMLInputElement | HTMLTextAreaElement,
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
function worker(overrides: Record<string, unknown> = {}) {
  return {
    id: "worker-1",
    type: "dsh",
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
      total: counts({ running: 1 }),
    },
    settings: {
      concurrency: { dsh: 3, pi: 3 },
      softReminderSeconds: 600,
      softReminderSteps: 20,
      hardTimeoutSeconds: null,
    },
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
};

async function mountPlugin(mode: Mode = {}): Promise<Mounted> {
  const dom = installDom();
  const module = (await import(await bundle())) as WorkerHostModule;
  const container = dom.window.document.getElementById("host")!;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const listeners = new Set<(context: unknown) => void>();
  let context = mode.context ?? DEFAULT_CONTEXT;
  const host = {
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
      if (pathAndQuery === "/settings")
        return {
          concurrency: { dsh: 4, pi: 2 },
          softReminderSeconds: 600,
          softReminderSteps: 20,
          hardTimeoutSeconds: null,
        };
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

test("DOM: settings require positive integers and save the exact concurrency body", async () => {
  const mounted = await mountPlugin();
  try {
    await waitFor(() => Boolean(findButton(mounted.container, "并发设置")), "设置入口");
    button(mounted.container, "并发设置").click();
    await waitFor(() => Boolean(byLabel(mounted.container, "DSH 并发")), "设置面板");
    const dsh = byLabel(mounted.container, "DSH 并发") as HTMLInputElement;
    const pi = byLabel(mounted.container, "Pi 并发") as HTMLInputElement;
    await typeInto(dsh, "0");
    await waitFor(
      () => textOf(mounted.container).includes("必须是大于 0 的整数"),
      "非法并发提示",
    );
    assert.equal(button(mounted.container, "保存设置").disabled, true);
    await typeInto(dsh, "4");
    await typeInto(pi, "2");
    await waitFor(() => !button(mounted.container, "保存设置").disabled, "可保存");
    button(mounted.container, "保存设置").click();
    await waitFor(() => callsTo(mounted, "/settings").length === 1, "保存请求");
    assert.deepEqual(callsTo(mounted, "/settings")[0]!.body, {
      concurrency: { dsh: 4, pi: 2 },
    });
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
      "/workers/worker-1/logs?stream=events&limit=200&runId=run-1&cursor=next-1",
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
