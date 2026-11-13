import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

/**
 * The run detail's conversation tab is the primary view of a run. These tests drive the real
 * plugin bundle through its host contract: a bound run must hand its own session id and a live
 * refresh cadence to the host viewer, every change of run/tab/task must dispose the previous
 * viewer, and a legacy run without a session must still show something readable and truthful
 * instead of a blank panel or a fabricated native transcript.
 */

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html?: string) => { window: Window & typeof globalThis };
};

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>");
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

async function waitFor(check: () => boolean, label: string, timeout = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待超时：" + label);
}

const textOf = (node: Element | null | undefined) =>
  (node?.textContent ?? "").replace(/\s+/g, " ");

const taskDefinition = {
  id: "nightly",
  name: "Nightly",
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
  prompt: "总结今天的仓库变更",
  notify: false,
};

function run(overrides: Record<string, unknown> = {}) {
  const now = "2026-02-03T04:05:06.000Z";
  return {
    id: "run-1",
    projectId: "project-a",
    projectName: "项目 A",
    taskId: "nightly",
    taskName: "Nightly",
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
    ...overrides,
  };
}

type MountedViewer = { sessionId: string; pollIntervalMs?: number; container: HTMLElement; disposed: boolean };

async function mountDetail(options: {
  task?: Record<string, unknown>;
  runs?: Array<Record<string, unknown>>;
  stdout?: string;
  /** Which optional host capabilities the fixture exposes; "none" emulates an older host. */
  hostCapabilities?: "viewer-and-open" | "open-only";
}) {
  const dom = installDom();
  const module = (await import(new URL("../dist/client.js", import.meta.url).href)) as {
    mount(container: HTMLElement, host: unknown): void;
    unmount(container: HTMLElement): void;
  };
  const task = options.task ?? {
    projectId: "project-a",
    projectName: "项目 A",
    projectPath: "/tmp/project-a",
    taskId: "nightly",
    definition: taskDefinition,
    updatedAt: "2026-02-03T00:00:00.000Z",
    nextRun: null,
    activeRuns: [],
    lastRun: null,
  };
  const runs = options.runs ?? [];
  // The run's own output grows while it is running, which is what the fallback must follow.
  let stdoutText = options.stdout ?? "";
  const calls: Array<{ method: string; path: string }> = [];
  const viewers: MountedViewer[] = [];
  const opened: string[] = [];
  const capabilities = options.hostCapabilities ?? "viewer-and-open";
  const host = {
    context: { theme: "light" as const, project: { name: "project-a", path: "/tmp/project-a" } },
    onContextChange: () => () => undefined,
    ...(capabilities === "viewer-and-open"
      ? {
          mountSessionOutput: (
            container: HTMLElement,
            viewerOptions: { sessionId: string; pollIntervalMs?: number },
          ) => {
            const viewer: MountedViewer = {
              sessionId: viewerOptions.sessionId,
              pollIntervalMs: viewerOptions.pollIntervalMs,
              container,
              disposed: false,
            };
            viewers.push(viewer);
            container.setAttribute("data-mounted-session", viewerOptions.sessionId);
            return () => {
              viewer.disposed = true;
              container.removeAttribute("data-mounted-session");
            };
          },
        }
      : {}),
    openSession: (sessionId: string) => { opened.push(sessionId); },
    async rpc(method: string, path: string) {
      calls.push({ method, path });
      if (path === "/settings")
        return {
          retentionDays: 30,
          timeoutSeconds: 3600,
          maxConcurrentRuns: 4,
          timezone: "Asia/Shanghai",
          env: {},
          telegram: { enabled: false, chatId: "", proxy: "", botTokenConfigured: false },
        };
      if (path === "/tasks") return { tasks: [task] };
      if (path === "/resident-tasks") return { tasks: [] };
      if (path === "/projects") return { projects: [{ id: "project-a", name: "项目 A", path: "/tmp/project-a" }] };
      if (path.startsWith("/runs?")) return { runs };
      if (path.includes("/log?")) {
        const query = new URLSearchParams(path.split("?")[1] ?? "");
        const offset = Number(query.get("offset") ?? 0);
        if (query.get("stream") !== "stdout")
          return { text: "", offset, hasMore: false, expired: false, truncated: false };
        return {
          text: stdoutText.slice(offset),
          offset: stdoutText.length,
          hasMore: false,
          expired: false,
          truncated: false,
        };
      }
      if (path.startsWith("/runs/")) return { run: runs[0], task: (task as { definition: unknown }).definition };
      return {};
    },
  };

  const container = dom.window.document.getElementById("host")!;
  module.mount(container, host);

  // Matches an exact label first (tabs, actions), then a list row whose button carries more text.
  const findButton = (label: string) => {
    const buttons = Array.from(container.querySelectorAll("button"));
    return (buttons.find(
      (button) => textOf(button) === label || button.getAttribute("aria-label") === label,
    ) ?? buttons.find((button) => textOf(button).includes(label))) as HTMLButtonElement | undefined;
  };
  const click = async (label: string) => {
    const button = findButton(label);
    assert.ok(button, `找不到按钮：${label}`);
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const activeTab = () =>
    textOf(container.querySelector('.cron-log-tabs button[aria-pressed="true"]'));
  // The diagnostic/fallback follow control is deliberately absent beside the native viewer.
  const autoScroll = () =>
    container.querySelector<HTMLInputElement>(".cron-console-header input[type=checkbox]");

  await waitFor(() => Boolean(findButton("Nightly")), "任务列表");
  return {
    dom,
    container,
    calls,
    viewers,
    opened,
    click,
    findButton,
    activeTab,
    autoScroll,
    writeStdout: (next: string) => { stdoutText = next; },
    text: () => textOf(container),
    close: () => {
      module.unmount(container);
      dom.window.close();
    },
  };
}

/**
 * jsdom has no layout, so a pane that scrolls itself looks exactly like one that does not. This
 * gives one element a fixed viewport and a growable content height, and clamps scrollTop the way a
 * browser does, so the assertions describe where the reader actually ends up.
 */
function stubScrollBox(element: HTMLElement, contentHeight: number, viewportHeight = 400) {
  let content = contentHeight;
  let top = 0;
  const maxScroll = () => Math.max(content - viewportHeight, 0);
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => viewportHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(value, maxScroll())); },
  });
  return {
    get top() { return top; },
    grow(nextContent: number) { content = nextContent; },
    maxScroll,
  };
}

test("a bound run opens on the conversation tab with the run's own session and live polling", async () => {
  const bound = run({ sessionId: "session-a" });
  const mounted = await mountDetail({ runs: [bound] });
  try {
    await mounted.click("Nightly");
    await waitFor(() => mounted.viewers.length === 1, "会话视图挂载");

    assert.equal(mounted.activeTab(), "对话");
    // The viewer is mounted for the run's bound session, not for the task or a plugin-local id.
    assert.equal(mounted.viewers[0]!.sessionId, "session-a");
    // Polling stays on while the tab is open, including for an already finished run: the final
    // message can be written just after the status flips, so stopping then would hide it.
    assert.equal(mounted.viewers[0]!.pollIntervalMs, 1000);
    assert.equal((mounted.container.querySelector(".cron-meta")?.textContent ?? "").includes("成功"), true);
    assert.equal(mounted.viewers[0]!.container.isConnected, true);
    // The conversation replaces the raw log; no fallback transcript is shown beside the viewer.
    assert.equal(mounted.container.querySelector(".cron-transcript"), null);
    assert.doesNotMatch(mounted.text(), /当前宿主不提供只读会话视图/);
    // The viewer owns its own scroll and its own "open session" entry, so neither is duplicated
    // here: no second follow control, and no raw session id in the default UI.
    assert.equal(mounted.autoScroll(), null);
    assert.equal(mounted.findButton("打开会话"), undefined);
    assert.doesNotMatch(mounted.text(), /session-a/);
  } finally {
    mounted.close();
  }
});

test("selecting another run, another tab, the task list, or unmounting disposes the old viewer", async () => {
  const latest = run({ id: "run-2", sessionId: "session-b", startedAt: "2026-02-04T04:05:06.000Z" });
  const earlier = run({ id: "run-1", sessionId: "session-a" });
  const mounted = await mountDetail({ runs: [latest, earlier] });
  try {
    await mounted.click("Nightly");
    await waitFor(() => mounted.viewers.length === 1, "首屏会话视图");
    assert.equal(mounted.viewers[0]!.sessionId, "session-b");

    // History buttons carry only the timestamp, so pick the older run by position.
    const history = Array.from(
      mounted.container.querySelectorAll<HTMLButtonElement>(".cron-history button"),
    );
    assert.equal(history.length, 2);
    history[1]!.click();
    await waitFor(() => mounted.viewers.length === 2, "切换运行记录后重挂载");
    assert.equal(mounted.viewers[0]!.disposed, true);
    assert.equal(mounted.viewers[1]!.sessionId, "session-a");

    // Leaving the conversation tab disposes the viewer again; returning mounts the current run.
    await mounted.click("stdout");
    await waitFor(() => mounted.viewers[1]!.disposed, "离开对话标签后卸载");
    assert.equal(mounted.container.querySelector("[data-mounted-session]"), null);
    await mounted.click("对话");
    await waitFor(() => mounted.viewers.length === 3, "回到对话标签重挂载");
    assert.equal(mounted.viewers[2]!.sessionId, "session-a");

    // Back to the task list unmounts the detail, and with it the viewer.
    await mounted.click("返回任务列表");
    await waitFor(() => mounted.viewers[2]!.disposed, "返回列表后卸载");
    assert.equal(mounted.container.querySelector(".cron-log-tabs"), null);
  } finally {
    mounted.close();
  }
});

test("a legacy run without a session shows its prompt and real output, never a fake transcript", async () => {
  const legacy = run({ reason: null });
  const mounted = await mountDetail({
    runs: [legacy],
    stdout: "已生成 3 条变更摘要\n第 2 行输出",
  });
  try {
    await mounted.click("Nightly");
    await waitFor(
      () => textOf(mounted.container.querySelector(".cron-transcript")).includes("已生成 3 条变更摘要"),
      "回退展示读取 stdout",
    );

    // Nothing is mounted for a run that never had a session.
    assert.equal(mounted.viewers.length, 0);
    assert.equal(mounted.activeTab(), "对话");
    assert.match(mounted.text(), /这次运行没有绑定会话/);
    // The task's own snapshot prompt and the run's actual stdout, in readable rows.
    const rows = Array.from(mounted.container.querySelectorAll(".cron-transcript-row"));
    assert.equal(rows.length, 2);
    assert.match(textOf(rows[0]), /用户输入/);
    assert.match(textOf(rows[0]), /总结今天的仓库变更/);
    assert.match(textOf(rows[1]), /Agent 输出/);
    assert.match(textOf(rows[1]), /已生成 3 条变更摘要/);
    assert.equal(mounted.calls.some((call) => call.path.includes("stream=stdout")), true);
    // A fallback pane scrolls with the plugin's follow control, so the checkbox applies here.
    assert.ok(mounted.autoScroll());

    // The raw streams remain reachable as diagnostics.
    await mounted.click("stdout");
    assert.match(textOf(mounted.container.querySelector(".cron-output")), /已生成 3 条变更摘要/);
    assert.ok(mounted.findButton("stderr"));
    assert.ok(mounted.findButton("原始事件"));
  } finally {
    mounted.close();
  }
});

test("a host without the viewer says so and still shows the run's own output", async () => {
  const bound = run({ sessionId: "session-c" });
  const mounted = await mountDetail({ runs: [bound], hostCapabilities: "open-only" });
  try {
    await mounted.click("Nightly");
    await waitFor(() => Boolean(mounted.container.querySelector(".cron-transcript")), "宿主回退");

    assert.equal(mounted.viewers.length, 0);
    assert.match(mounted.text(), /当前宿主不提供只读会话视图/);
    // A compact label, not the raw host session id, and the plugin still offers the write entry.
    assert.match(mounted.text(), /任务会话/);
    assert.doesNotMatch(mounted.text(), /session-c/);
    assert.ok(mounted.autoScroll());
    // The panel is not blank: the snapshot prompt and stdout still render.
    assert.match(mounted.text(), /总结今天的仓库变更/);
    assert.match(mounted.text(), /暂无输出/);
    // The writable session can still be opened through the remaining capability.
    await mounted.click("打开会话");
    assert.deepEqual(mounted.opened, ["session-c"]);
  } finally {
    mounted.close();
  }
});

test("a script run's conversation fallback shows the command and its stdout", async () => {
  const scriptTask = {
    projectId: "project-a",
    projectName: "项目 A",
    projectPath: "/tmp/project-a",
    taskId: "nightly",
    definition: {
      ...taskDefinition,
      type: "script",
      command: "bash",
      args: ["-lc", "echo hi"],
      prompt: undefined,
    },
    updatedAt: "2026-02-03T00:00:00.000Z",
    nextRun: null,
    activeRuns: [],
    lastRun: null,
  };
  const mounted = await mountDetail({
    task: scriptTask,
    runs: [run()],
    stdout: "hi\n",
  });
  try {
    await mounted.click("Nightly");
    await waitFor(
      () => textOf(mounted.container.querySelector(".cron-transcript-agent")).includes("hi"),
      "脚本回退读取 stdout",
    );
    const rows = Array.from(mounted.container.querySelectorAll(".cron-transcript-row"));
    assert.match(textOf(rows[0]), /命令/);
    assert.match(textOf(rows[0]), /bash -lc echo hi/);
    assert.match(textOf(rows[1]), /stdout/);
    assert.match(textOf(rows[1]), /hi/);
    assert.equal(mounted.viewers.length, 0);
  } finally {
    mounted.close();
  }
});

test("a legacy fallback lands on the newest output, follows new output, and holds when follow is off", async () => {
  const running = run({ status: "running", endedAt: null });
  const mounted = await mountDetail({
    runs: [running],
    stdout: "第一行\n第二行\n第三行",
  });
  try {
    await mounted.click("Nightly");
    const pane = mounted.container.querySelector<HTMLDivElement>(".cron-transcript");
    assert.ok(pane, "回退面板已渲染");
    const box = stubScrollBox(pane!, 1200);

    // Entering a legacy run must land on its newest output, not at the top of the transcript.
    await waitFor(() => mounted.text().includes("第三行"), "首屏输出");
    await waitFor(() => box.top === box.maxScroll(), "首次进入定位到最新");
    assert.equal(box.top, 800);

    // Output that arrives while the run is still going keeps following.
    box.grow(1600);
    mounted.writeStdout("第一行\n第二行\n第三行\n运行中的新输出");
    await waitFor(() => mounted.text().includes("运行中的新输出"), "运行中新增输出");
    await waitFor(() => box.top === box.maxScroll(), "新增输出后继续跟随");
    assert.equal(box.top, 1200);

    // Turning the follow control off leaves the reader where they are.
    const follow = mounted.autoScroll();
    assert.ok(follow);
    follow!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(follow!.checked, false);
    box.grow(2000);
    mounted.writeStdout("第一行\n第二行\n第三行\n运行中的新输出\n不被拉下去的输出");
    await waitFor(() => mounted.text().includes("不被拉下去的输出"), "关闭跟随后新增输出");
    assert.equal(box.top, 1200);
  } finally {
    mounted.close();
  }
});
