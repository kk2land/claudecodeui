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
  // The component refreshes its list on an interval. A test run has nothing to poll, and a live
  // interval would keep the process alive and fire setState outside act; inert timers keep the
  // assertions focused on the interactions under test.
  define("setInterval", () => 0);
  define("clearInterval", () => undefined);
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

  const findButton = (text: string) =>
    Array.from(window.document.querySelectorAll("button"))
      .find((button) => (button.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;

  const click = async (text: string) => {
    const button = findButton(text);
    assert.ok(button, `expected a "${text}" button`);
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  /** Unmounts and stops the component's polling interval so the test process can exit. */
  const close = async () => {
    await act(async () => { root.unmount(); });
    window.close();
  };

  return { window, calls, mounted, opened, messages, click, findButton, root, act, close };
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
