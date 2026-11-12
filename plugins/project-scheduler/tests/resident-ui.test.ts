import assert from "node:assert/strict";
import test from "node:test";

import {
  residentCapacityNote,
  residentStatusLabel,
  residentTaskActions,
} from "../client/residentTaskView.js";
import type { ResidentTaskRow } from "../shared/contracts.js";

/** One binding with the host-reported fields the view rules read. */
function row(overrides: Partial<ResidentTaskRow> = {}): ResidentTaskRow {
  return {
    taskId: "resident-1",
    name: "会话 A",
    sessionId: "session-1",
    projectId: "project-1",
    enabled: true,
    visible: true,
    status: "running",
    executionId: "exec-1",
    stopCause: null,
    runtime: { provider: "codex", permissionMode: "default", sandboxMode: null },
    terminal: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    notify: true,
    ...overrides,
  };
}

test("resident status labels come from the host state, not guesses", () => {
  assert.equal(residentStatusLabel("running"), "运行中");
  assert.equal(residentStatusLabel("stopping"), "正在停止");
  assert.equal(residentStatusLabel("stopped"), "已停止");
  assert.equal(residentStatusLabel("idle"), "未启动");
});

test("only a running binding offers stop and only a stopped, enabled one offers continue", () => {
  assert.deepEqual(
    (({ canStop, canContinue }) => ({ canStop, canContinue }))(residentTaskActions(row())),
    { canStop: true, canContinue: false },
  );
  assert.deepEqual(
    (({ canStop, canContinue }) => ({ canStop, canContinue }))(
      residentTaskActions(row({ status: "stopped", executionId: "exec-1" })),
    ),
    { canStop: false, canContinue: true },
  );
  // Disabled is not a licence to resume: it holds protection but waits for re-enable.
  assert.equal(
    residentTaskActions(row({ status: "stopped", enabled: false })).canContinue,
    false,
  );
  // A stop already settling is neither re-stopped nor unbound mid-flight.
  const stopping = residentTaskActions(row({ status: "stopping" }));
  assert.equal(stopping.canStop, false);
  assert.equal(stopping.canRemove, false);
});

test("a disabled binding explains that it keeps protection and will not recover", () => {
  const actions = residentTaskActions(row({ status: "stopped", enabled: false }));
  assert.match(String(actions.note), /保护/);
  assert.equal(residentTaskActions(row({ status: "running" })).canRemove, true);
});

test("resident tasks are documented as not consuming the cron concurrency limit", () => {
  assert.match(residentCapacityNote(), /不占用/);
  assert.match(residentCapacityNote(), /maxConcurrentRuns/);
});

// --------------------------- DOM interaction ---------------------------

import { createRequire } from "node:module";
import { schedulerApi } from "../client/api.js";
import type { SchedulerHost } from "../client/api.js";

const requireDom = createRequire(import.meta.url);
const { JSDOM } = requireDom("jsdom") as {
  JSDOM: new (html?: string) => { window: Window & typeof globalThis };
};

/**
 * Renders the real `ResidentTasks` component in jsdom against the real client API layer, with a
 * fake host transport. These assertions are about what the plugin actually sends and mounts, not
 * about a re-implementation of its rules.
 */
async function mountResidentTasks(options: {
  tasks: ResidentTaskRow[];
  rpc?: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** Which optional host capabilities the fixture exposes, to pin the documented degradation. */
  hostCapabilities?: "both" | "open-only" | "none";
}) {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  const { window } = dom;
  const globals = globalThis as unknown as Record<string, unknown>;
  const define = (name: string, value: unknown) => {
    Object.defineProperty(globals, name, { value, configurable: true, writable: true });
  };
  define("window", window);
  define("document", window.document);
  define("HTMLElement", window.HTMLElement);
  define("navigator", window.navigator);
  define("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  define("cancelAnimationFrame", (id: number) => clearTimeout(id));
  define("IS_REACT_ACT_ENVIRONMENT", true);
  // The list and the log panel poll on intervals. Timers are captured instead of left live, so a
  // test can advance them explicitly and the process can still exit.
  const intervals = new Map<number, () => void>();
  let nextIntervalId = 1;
  define("setInterval", (callback: () => void) => {
    const id = nextIntervalId++;
    intervals.set(id, callback);
    return id;
  });
  define("clearInterval", (id: number) => { intervals.delete(id); });
  (window as unknown as Record<string, unknown>).confirm = () => true;

  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const mounted: Array<{ sessionId: string; container: unknown }> = [];
  const opened: string[] = [];
  const messages: string[] = [];
  const capabilities = options.hostCapabilities ?? "both";
  const host: SchedulerHost = {
    context: { theme: "light", project: null },
    onContextChange: () => () => undefined,
    rpc: async (method, path, body) => {
      calls.push({ method, path, body });
      if (options.rpc) return options.rpc(method, path, body);
      if (method === "GET") return { tasks: options.tasks };
      return options.tasks[0];
    },
    ...(capabilities === "none"
      ? {}
      : {
        ...(capabilities === "both"
          ? {
            mountSessionOutput: (container: HTMLElement, { sessionId }: { sessionId: string }) => {
              mounted.push({ sessionId, container });
              return () => undefined;
            },
          }
          : {}),
        openSession: (sessionId: string) => { opened.push(sessionId); },
      }),
  };

  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react-dom/test-utils");
  const { ResidentTasks } = await import("../client/ResidentTasks.js");
  const api = schedulerApi(host);
  const root = createRoot(window.document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(ResidentTasks, {
        api,
        host,
        onMessage: (message: string) => messages.push(message),
      }),
    );
  });
  // The list is read in an effect; let it settle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  // Matches visible text, or an icon-only button's accessible name ("关闭阶段日志").
  const findButton = (text: string) =>
    Array.from(window.document.querySelectorAll("button"))
      .find((button) => (button.textContent ?? "").trim() === text
        || button.getAttribute("aria-label") === text) as HTMLButtonElement | undefined;

  const click = async (text: string) => {
    const button = findButton(text);
    assert.ok(button, `expected a "${text}" button`);
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  /** Runs every captured interval once, the way one poll period would. */
  const runIntervals = async () => {
    await act(async () => {
      for (const callback of Array.from(intervals.values())) callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  /** Unmounts and stops the component's polling interval so the test process can exit. */
  const close = async () => {
    await act(async () => { root.unmount(); });
    window.close();
  };

  return { window, calls, mounted, opened, messages, click, findButton, runIntervals, root, act, close };
}

const residentRow = (overrides: Partial<ResidentTaskRow> = {}): ResidentTaskRow => ({
  taskId: "resident-1",
  name: "会话 A",
  sessionId: "session-1",
  projectId: "project-1",
  enabled: true,
  visible: true,
  status: "running",
  executionId: "exec-1",
  stopCause: null,
  runtime: { provider: "codex", permissionMode: "default", sandboxMode: null },
  terminal: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  notify: true,
  ...overrides,
});

test("clicking a task name opens the original session once and shows no read-only panel", async () => {
  const mountedHost = await mountResidentTasks({ tasks: [residentRow()] });

  await mountedHost.click("会话 A");

  // The conversation is opened by its session id, never by the plugin's task id.
  assert.deepEqual(mountedHost.opened, ["session-1"]);
  // No detail is requested and no viewer is mounted: the click is a navigation, not a drill-in.
  assert.equal(mountedHost.calls.some((call) => call.path === "/resident-tasks/resident-1"), false);
  assert.equal(mountedHost.mounted.length, 0);
  const text = mountedHost.window.document.body.textContent ?? "";
  assert.doesNotMatch(text, /常驻结束记录|只读输出/);
  assert.ok(mountedHost.findButton("会话 A"), "the list is still on screen after opening the session");
  await mountedHost.close();
});

test("without openSession the name is disabled and says why, while controls stay usable", async () => {
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    hostCapabilities: "none",
  });

  const name = mountedHost.findButton("会话 A");
  assert.ok(name);
  assert.equal(name!.disabled, true);
  assert.match(mountedHost.window.document.body.textContent ?? "", /不提供打开会话能力/);

  await mountedHost.click("停止");
  assert.ok(mountedHost.calls.some((call) => call.path === "/resident-tasks/resident-1/stop"));
  await mountedHost.close();
});

test("an open-only host still navigates even though it cannot render a viewer", async () => {
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    hostCapabilities: "open-only",
  });

  await mountedHost.click("会话 A");
  assert.deepEqual(mountedHost.opened, ["session-1"]);
  assert.equal(mountedHost.mounted.length, 0);
  await mountedHost.close();
});

test("row controls call their APIs and never navigate", async () => {
  const stopped = residentRow({ status: "stopped" });
  const mountedHost = await mountResidentTasks({ tasks: [stopped] });

  await mountedHost.click("继续");
  await mountedHost.click("删除");

  const paths = mountedHost.calls.map((call) => call.path);
  assert.ok(paths.includes("/resident-tasks/resident-1/continue"));
  assert.ok(paths.includes("/resident-tasks/resident-1"));
  assert.deepEqual(mountedHost.opened, []);
  await mountedHost.close();
});

test("continue is posted once and only an accepted continue is reported as success", async () => {
  const stopped = residentRow({ status: "stopped", executionId: "exec-9" });
  const mountedHost = await mountResidentTasks({
    tasks: [stopped],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [stopped] };
      if (method === "GET") return { ...stopped, runs: [] };
      if (path.endsWith("/continue")) {
        return { task: residentRow({ status: "running" }), result: { accepted: true, executionId: "exec-10", reason: null } };
      }
      return stopped;
    },
  });

  await mountedHost.click("会话 A");
  await mountedHost.click("继续");
  const continued = mountedHost.calls.filter((call) => call.path === "/resident-tasks/resident-1/continue");
  assert.equal(continued.length, 1);
  assert.equal(continued[0]!.method, "POST");
  assert.ok(mountedHost.messages.includes("已在原会话中发送继续"));
  await mountedHost.close();
});

test("a refused stop is reported and the task stays on screen", async () => {
  const running = residentRow();
  const mountedHost = await mountResidentTasks({
    tasks: [running],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [running] };
      if (method === "GET") return { ...running, runs: [] };
      if (method === "POST" && path.endsWith("/stop")) throw new Error("停止失败：宿主拒绝");
      return running;
    },
  });

  await mountedHost.click("会话 A");
  await mountedHost.click("停止");
  assert.equal(mountedHost.calls.filter((call) => call.path.endsWith("/stop")).length, 1);
  assert.ok(mountedHost.messages.some((message) => message.includes("停止失败")));
  assert.ok(mountedHost.messages.every((message) => !message.includes("已停止常驻任务")));
  assert.ok(mountedHost.findButton("停止"), "the task is still shown after a failed stop");
  await mountedHost.close();
});

test("a list refusal does not fake a running task", async () => {
  const mountedHost = await mountResidentTasks({
    tasks: [],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") throw new Error("RPC error 500");
      return {};
    },
  });

  assert.ok(mountedHost.messages.some((message) => message.includes("RPC error 500")));
  assert.equal(mountedHost.mounted.length, 0);
  await mountedHost.close();
});

test("the enabled and visible checkboxes PATCH their own field and keep state on failure", async () => {
  const running = residentRow();
  let failEnabled = true;
  const mountedHost = await mountResidentTasks({
    tasks: [running],
    rpc: async (method, path, body) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [running] };
      if (method === "GET") return { ...running, runs: [] };
      if (method === "PATCH" && failEnabled && (body as { enabled?: boolean }).enabled === false) {
        throw new Error("禁用失败：宿主拒绝");
      }
      return running;
    },
  });

  const checkboxes = Array.from(mountedHost.window.document.querySelectorAll("input[type=checkbox]")) as HTMLInputElement[];
  assert.equal(checkboxes.length, 2);
  const [enabledBox, visibleBox] = checkboxes as [HTMLInputElement, HTMLInputElement];

  // Enabled is refused: the error is reported and the checkbox is not left looking disabled.
  enabledBox.click();
  await mountedHost.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const enabledPatch = mountedHost.calls.filter((call) => call.method === "PATCH");
  assert.equal(enabledPatch.length, 1);
  assert.equal(enabledPatch[0]!.path, "/resident-tasks/resident-1");
  assert.deepEqual(enabledPatch[0]!.body, { enabled: false });
  assert.ok(mountedHost.messages.some((message) => message.includes("禁用失败")));
  assert.equal(
    (mountedHost.window.document.querySelectorAll("input[type=checkbox]")[0] as HTMLInputElement).checked,
    true,
  );

  // Visible goes to the same row but carries only its own field, and the server row is applied.
  failEnabled = false;
  visibleBox.click();
  await mountedHost.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const patches = mountedHost.calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(patches[patches.length - 1]!.body, { visible: false });
  // Toggling a control is not a navigation.
  assert.deepEqual(mountedHost.opened, []);
  await mountedHost.close();
});

// --------------------------- resident stage log ---------------------------

type StageLogRow = {
  id: string;
  taskId: string;
  sessionId: string;
  executionId: string | null;
  source: "agent" | "system";
  occurredAt: string;
  createdAt: string;
  content: string;
  status: string;
  phase?: string;
  data?: Record<string, unknown>;
};

const stageLogRow = (overrides: Partial<StageLogRow> = {}): StageLogRow => ({
  id: "log-1",
  taskId: "resident-1",
  sessionId: "session-1",
  executionId: "exec-1",
  source: "agent",
  occurredAt: "2026-02-03T04:05:06.000Z",
  createdAt: "2026-02-03T04:05:07.000Z",
  content: "开始分析仓库结构",
  status: "thinking",
  ...overrides,
});

/** Logs RPC as a function so a test can change the page between polls. */
function stageLogsHost(pages: () => { logs: StageLogRow[]; nextCursor?: string | null }) {
  return async (method: string, path: string) => {
    if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow()] };
    if (method === "GET" && path.includes("/logs")) {
      const page = pages();
      return { logs: page.logs, nextCursor: page.nextCursor ?? null };
    }
    return residentRow();
  };
}

const stageLogRequests = (calls: Array<{ method: string; path: string }>) =>
  calls.filter((call) => call.path.includes("/logs"));

const tableText = (host: { window: Window }) =>
  (host.window.document.querySelector('[aria-label^="阶段日志"]')?.textContent ?? "").replace(/\s+/g, " ");

test("the node-log button expands this task's log without navigating, and the name still opens chat", async () => {
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: stageLogsHost(() => ({ logs: [stageLogRow()] })),
  });

  await mountedHost.click("阶段日志");
  assert.deepEqual(mountedHost.opened, []);
  assert.match(tableText(mountedHost), /开始分析仓库结构/);
  const requests = stageLogRequests(mountedHost.calls);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "/resident-tasks/resident-1/logs?limit=50");

  // The task name keeps its separate behaviour: it opens the original conversation.
  await mountedHost.click("会话 A");
  assert.deepEqual(mountedHost.opened, ["session-1"]);
  await mountedHost.close();
});

test("a log entry shows both timestamps, its free status, source, phase and raw data", async () => {
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: stageLogsHost(() => ({
      logs: [stageLogRow({
        source: "system",
        status: "等待人工确认",
        phase: "review",
        data: { files: 3, ok: true },
      })],
    })),
  });

  await mountedHost.click("阶段日志");
  const text = tableText(mountedHost);
  const occurred = new Date("2026-02-03T04:05:06.000Z").toLocaleString("zh-CN", { hour12: false });
  const created = new Date("2026-02-03T04:05:07.000Z").toLocaleString("zh-CN", { hour12: false });
  assert.ok(text.includes(occurred), "event time is rendered in local time");
  assert.ok(text.includes(created), "insertion time is rendered separately");
  // Both sources are shown in Chinese; the raw server vocabulary is not user-facing.
  assert.match(text, /系统/);
  assert.match(text, /等待人工确认/);
  assert.match(text, /review/);
  assert.match(text, /"files": 3/);
  assert.match(text, /仅保留最近 7 天/);
  await mountedHost.close();
});

test("an empty log and a failed read are reported, and retry loads the log", async () => {
  let fail = false;
  const entries = { logs: [stageLogRow({ content: "重试后的日志" })] };
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow()] };
      if (path.includes("/logs")) {
        if (fail) throw new Error("RPC error 502");
        return { logs: entries.logs, nextCursor: null };
      }
      return residentRow();
    },
  });

  await mountedHost.click("阶段日志");
  assert.match(tableText(mountedHost), /重试后的日志/);
  await mountedHost.close();

  const failing = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow()] };
      if (path.includes("/logs")) throw new Error("RPC error 502");
      return residentRow();
    },
  });
  await failing.click("阶段日志");
  assert.match(failing.window.document.body.textContent ?? "", /RPC error 502/);
  assert.ok(failing.findButton("重试"), "a failed read offers retry");
  await failing.close();

  const empty = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: stageLogsHost(() => ({ logs: [] })),
  });
  await empty.click("阶段日志");
  assert.match(tableText(empty), /还没有阶段日志/);
  await empty.close();
});

test("retry after a failure re-reads the log instead of staying on the error", async () => {
  let fail = true;
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow()] };
      if (path.includes("/logs")) {
        if (fail) throw new Error("RPC error 502");
        return { logs: [stageLogRow({ content: "恢复后的日志" })], nextCursor: null };
      }
      return residentRow();
    },
  });

  await mountedHost.click("阶段日志");
  fail = false;
  await mountedHost.click("重试");
  assert.match(tableText(mountedHost), /恢复后的日志/);
  assert.doesNotMatch(tableText(mountedHost), /RPC error 502/);
  await mountedHost.close();
});

test("the newest page is replaced on each poll, never appended", async () => {
  let current = [stageLogRow({ id: "log-1", content: "第一版" })];
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: stageLogsHost(() => ({ logs: current })),
  });

  await mountedHost.click("阶段日志");
  assert.match(tableText(mountedHost), /第一版/);

  // The host returns the fresh page; a replace keeps one copy of each entry.
  current = [stageLogRow({ id: "log-1", content: "第一版" }), stageLogRow({ id: "log-2", content: "第二版" })];
  await mountedHost.runIntervals();
  assert.equal(tableText(mountedHost).split("第一版").length - 1, 1);
  assert.match(tableText(mountedHost), /第二版/);

  current = [stageLogRow({ id: "log-2", content: "第二版" })];
  await mountedHost.runIntervals();
  assert.doesNotMatch(tableText(mountedHost), /第一版/);
  await mountedHost.close();
});

test("paging older stops polling, and 回到最新 clears the cursor and resumes it", async () => {
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow()] };
      if (path.includes("/logs")) {
        if (path.includes("cursor=older-1")) {
          return { logs: [stageLogRow({ id: "log-0", content: "更早的日志" })], nextCursor: null };
        }
        return { logs: [stageLogRow({ content: "最新日志" })], nextCursor: "older-1" };
      }
      return residentRow();
    },
  });

  await mountedHost.click("阶段日志");
  await mountedHost.click("加载更早日志");
  assert.match(tableText(mountedHost), /更早的日志/);
  assert.match(tableText(mountedHost), /自动刷新已暂停/);
  const afterPaging = stageLogRequests(mountedHost.calls).length;

  await mountedHost.runIntervals();
  assert.equal(stageLogRequests(mountedHost.calls).length, afterPaging, "a history page does not poll");

  await mountedHost.click("回到最新");
  assert.doesNotMatch(tableText(mountedHost), /更早的日志/);
  const afterLatest = stageLogRequests(mountedHost.calls).length;
  await mountedHost.runIntervals();
  assert.ok(stageLogRequests(mountedHost.calls).length > afterLatest, "polling resumes on the newest page");
  await mountedHost.close();
});

test("switching tasks or closing drops the previous task's in-flight log response", async () => {
  const second = residentRow({ taskId: "resident-2", sessionId: "session-2", name: "会话 B" });
  let releaseFirst: ((value: unknown) => void) | null = null;
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow(), second],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow(), second] };
      if (path.includes("/logs")) {
        if (path.includes("resident-1")) {
          // The first task's read stays pending until after the user switched away.
          return new Promise((resolve) => { releaseFirst = resolve; });
        }
        return { logs: [stageLogRow({ taskId: "resident-2", content: "B 的日志" })], nextCursor: null };
      }
      return residentRow();
    },
  });

  await mountedHost.click("阶段日志");
  // Switch to the other task's log: only one panel exists at a time.
  await mountedHost.act(async () => {
    const buttons = Array.from(mountedHost.window.document.querySelectorAll("button"))
      .filter((button) => (button.textContent ?? "").trim() === "阶段日志");
    buttons[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await mountedHost.act(async () => {
    releaseFirst?.({ logs: [stageLogRow({ content: "A 的迟到日志" })], nextCursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const text = tableText(mountedHost);
  assert.match(text, /B 的日志/);
  assert.doesNotMatch(text, /A 的迟到日志/);
  await mountedHost.close();
});

test("closing the log stops its timer, and the row controls still work", async () => {
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: stageLogsHost(() => ({ logs: [stageLogRow()] })),
  });

  await mountedHost.click("阶段日志");
  const withPanel = stageLogRequests(mountedHost.calls).length;
  await mountedHost.click("关闭阶段日志");
  assert.equal(mountedHost.window.document.querySelector('[aria-label^="阶段日志"]'), null);

  await mountedHost.runIntervals();
  assert.equal(stageLogRequests(mountedHost.calls).length, withPanel, "closing clears the log timer");

  await mountedHost.click("停止");
  assert.ok(mountedHost.calls.some((call) => call.path === "/resident-tasks/resident-1/stop"));
  assert.deepEqual(mountedHost.opened, []);
  await mountedHost.close();
});

test("the logs request carries the page size, and a history request carries its cursor", async () => {
  // The plugin's own HTTP layer is exercised here, not a component stub: this is the path the
  // host.rpc receives, which is what the plugin server parses.
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow()] };
      if (path.includes("/logs")) {
        return path.includes("cursor=")
          ? { logs: [stageLogRow({ id: "log-0", content: "更早" })], nextCursor: null }
          : { logs: [stageLogRow()], nextCursor: "older-1" };
      }
      return residentRow();
    },
  });

  await mountedHost.click("阶段日志");
  const first = stageLogRequests(mountedHost.calls)[0]!.path;
  assert.equal(first, "/resident-tasks/resident-1/logs?limit=50");

  await mountedHost.click("加载更早日志");
  const second = stageLogRequests(mountedHost.calls)[1]!.path;
  assert.equal(second, "/resident-tasks/resident-1/logs?cursor=older-1&limit=50");
  await mountedHost.close();
});

test("opening an older page pauses the live poll before its response arrives", async () => {
  let releaseOlder: ((value: unknown) => void) | null = null;
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow()] };
      if (path.includes("/logs")) {
        if (path.includes("cursor=older-1")) {
          // Older page stays in flight while the poll interval fires.
          return new Promise((resolve) => { releaseOlder = resolve; });
        }
        return { logs: [stageLogRow({ content: "最新日志" })], nextCursor: "older-1" };
      }
      return residentRow();
    },
  });

  await mountedHost.click("阶段日志");
  const beforeOlder = stageLogRequests(mountedHost.calls).length;
  await mountedHost.click("加载更早日志");
  // The user already asked for history, so a poll tick must not fetch (and win) the newest page.
  assert.equal(stageLogRequests(mountedHost.calls).length, beforeOlder + 1);
  await mountedHost.runIntervals();
  assert.equal(stageLogRequests(mountedHost.calls).length, beforeOlder + 1);

  await mountedHost.act(async () => {
    releaseOlder?.({ logs: [stageLogRow({ id: "log-0", content: "历史返回" })], nextCursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(tableText(mountedHost), /历史返回/);
  assert.match(tableText(mountedHost), /自动刷新已暂停/);

  // Returning to the newest page switches immediately and resumes polling.
  await mountedHost.click("回到最新");
  const afterReturn = stageLogRequests(mountedHost.calls).length;
  await mountedHost.runIntervals();
  assert.ok(stageLogRequests(mountedHost.calls).length > afterReturn);
  assert.doesNotMatch(tableText(mountedHost), /历史返回/);
  await mountedHost.close();
});

test("a failed older page keeps the history view and retry repeats that page only", async () => {
  let failOlder = true;
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: async (method, path) => {
      if (method === "GET" && path === "/resident-tasks") return { tasks: [residentRow()] };
      if (path.includes("/logs")) {
        if (path.includes("cursor=older-1")) {
          if (failOlder) throw new Error("RPC error 503");
          return { logs: [stageLogRow({ id: "log-0", content: "重试到的历史" })], nextCursor: null };
        }
        return { logs: [stageLogRow()], nextCursor: "older-1" };
      }
      return residentRow();
    },
  });

  await mountedHost.click("阶段日志");
  await mountedHost.click("加载更早日志");
  assert.match(mountedHost.window.document.body.textContent ?? "", /RPC error 503/);
  const requestsWhileFailed = stageLogRequests(mountedHost.calls).length;
  await mountedHost.runIntervals();
  assert.equal(stageLogRequests(mountedHost.calls).length, requestsWhileFailed, "a failed history view does not poll");

  failOlder = false;
  await mountedHost.click("重试");
  const retried = stageLogRequests(mountedHost.calls);
  assert.equal(retried[retried.length - 1]!.path, "/resident-tasks/resident-1/logs?cursor=older-1&limit=50");
  assert.match(tableText(mountedHost), /重试到的历史/);
  await mountedHost.close();
});

test("the stage log is one table row per entry, with the columns the operator scans", async () => {
  const longContent = `${"很长的日志内容".repeat(40)}结束标记`;
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: stageLogsHost(() => ({
      logs: [
        stageLogRow({
          id: "log-1",
          source: "agent",
          status: "成功",
          phase: "deploy",
          content: "部署预发环境完成",
          data: { env: "staging", ms: 1200 },
        }),
        stageLogRow({
          id: "log-2",
          source: "system",
          status: "跳过",
          occurredAt: "2026-02-03T04:10:00.000Z",
          createdAt: "2026-02-03T04:10:01.000Z",
          content: longContent,
        }),
      ],
      nextCursor: null,
    })),
  });

  await mountedHost.click("阶段日志");
  const doc = mountedHost.window.document;

  // Exactly one tbody row per entry — no cards, no extra rows for the JSON detail.
  const rows = Array.from(doc.querySelectorAll("tbody tr[data-stage-log-row]"));
  assert.equal(rows.length, 2);
  assert.equal(doc.querySelectorAll("tbody tr").length, 2);

  // Real table semantics with column headers.
  assert.ok(doc.querySelector("table"));
  const headers = Array.from(doc.querySelectorAll("thead th")).map((th) => (th.textContent ?? "").trim());
  assert.deepEqual(headers, ["时间", "阶段", "状态", "日志内容", "来源", "添加时间", "详情"]);
  assert.equal(doc.querySelectorAll("thead th[scope=col]").length, 7);
  assert.equal(rows[0]!.querySelectorAll("td").length, 7);

  const first = Array.from(rows[0]!.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim());
  const occurred = new Date("2026-02-03T04:05:06.000Z").toLocaleString("zh-CN", { hour12: false });
  const created = new Date("2026-02-03T04:05:07.000Z").toLocaleString("zh-CN", { hour12: false });
  assert.equal(first[0], occurred);
  assert.equal(first[1], "deploy");
  assert.equal(first[2], "成功");
  assert.equal(first[3], "部署预发环境完成");
  assert.equal(first[4], "Agent");
  assert.equal(first[5], created);
  assert.match(first[6] ?? "", /staging/);
  // Both times stay on one line.
  assert.equal(doc.querySelectorAll(".cron-stage-log-time").length, 4);

  // Optional phase falls back to a dash; long content is preserved verbatim in its cell.
  const second = Array.from(rows[1]!.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim());
  assert.equal(second[1], "—");
  assert.equal(second[4], "系统");
  assert.equal(second[3], longContent);
  assert.equal(second[6], "—");

  // The JSON detail expands inside the same row.
  const details = rows[0]!.querySelector("details");
  assert.ok(details);
  assert.equal(rows.length, doc.querySelectorAll("tbody tr[data-stage-log-row]").length);
  details!.open = true;
  assert.match((details!.textContent ?? ""), /"ms": 1200/);

  // None of the previous card markup or wording survives.
  assert.equal(doc.querySelector(".cron-node-log, ol.cron-resident-log-list, li.cron-resident-log-row"), null);
  assert.doesNotMatch(doc.body.textContent ?? "", /节点日志/);
  await mountedHost.close();
});

test("an empty stage log uses a full-width placeholder row under the intact header", async () => {
  const mountedHost = await mountResidentTasks({
    tasks: [residentRow()],
    rpc: stageLogsHost(() => ({ logs: [] })),
  });

  await mountedHost.click("阶段日志");
  const doc = mountedHost.window.document;
  assert.equal(doc.querySelectorAll("tbody tr[data-stage-log-row]").length, 0);
  const placeholder = doc.querySelector("tbody tr td[colspan='7']");
  assert.ok(placeholder);
  assert.match(placeholder!.textContent ?? "", /还没有阶段日志/);
  assert.equal(doc.querySelectorAll("thead th[scope=col]").length, 7);
  await mountedHost.close();
});
