import fs from "node:fs";
import express from "express";
import { SchedulerStore } from "./store.js";
import { ProjectScheduler } from "./scheduler.js";
import { updateSettings } from "./configuration.js";
import { TelegramNotifier, sendTelegram } from "./telegram.js";
import type { PublicSchedulerSettings } from "../shared/contracts.js";

const token = process.env.CLOUDCLI_PLUGIN_TOKEN;
const directory = process.env.CLOUDCLI_PLUGIN_DATA_DIR;
const catalog = process.env.CLOUDCLI_PROJECTS_FILE;
if (!token || !directory || !catalog)
  throw new Error("定时任务插件必须通过宿主启动");
const store = new SchedulerStore(directory);
const notifier = new TelegramNotifier(store);
const scheduler = new ProjectScheduler(store, catalog, () => {
  void notifier.flush().catch((error) => console.error(String(error)));
});
scheduler.recover();
const app = express();
app.use((req, res, next) => {
  if (req.headers.authorization !== "Bearer " + token) {
    res.sendStatus(401);
    return;
  }
  next();
});
app.use(express.json({ limit: "3mb" }));
const route =
  (
    handler: (req: express.Request) => unknown | Promise<unknown>,
  ): express.RequestHandler =>
  async (req, res, next) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      next(error);
    }
  };
const publicSettings = (): PublicSchedulerSettings => {
  const settings = store.settings();
  const { botToken, ...telegram } = settings.telegram;
  return {
    ...settings,
    telegram: { ...telegram, botTokenConfigured: Boolean(botToken) },
  };
};
app.get(
  "/projects",
  route(() => ({ projects: scheduler.projects() })),
);
app.get(
  "/configuration",
  route((req) => {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId : "";
    const document = scheduler.readConfiguration(projectId);
    if (!document) throw new Error("项目不存在或已归档");
    return document;
  }),
);
app.post(
  "/configuration/preview",
  route((req) => {
    const { projectId, text } = req.body ?? {};
    if (typeof projectId !== "string" || !projectId.trim())
      throw new Error("需要项目 ID");
    if (typeof text !== "string") throw new Error("需要配置文本");
    const preview = scheduler.previewConfiguration(projectId, text);
    if (!preview) throw new Error("项目不存在或已归档");
    return preview;
  }),
);
app.post(
  "/configuration/save",
  route((req) => {
    const { projectId, text, revision } = req.body ?? {};
    if (typeof projectId !== "string" || !projectId.trim())
      throw new Error("需要项目 ID");
    if (typeof text !== "string") throw new Error("需要配置文本");
    // The version must be sent explicitly; an omitted revision must never imply "create".
    if (revision !== null && typeof revision !== "string")
      throw new Error("revision 必须是字符串或 null");
    const result = scheduler.saveConfiguration(projectId, text, revision);
    if (!result) throw new Error("项目不存在或已归档");
    return result;
  }),
);
app.get(
  "/tasks",
  route(() => ({ tasks: scheduler.inventory() })),
);
app.post(
  "/load",
  route((req) => {
    const {
      projectIds,
      removeMissing = false,
      apply = false,
    } = req.body as Record<string, unknown>;
    if (
      projectIds !== undefined &&
      (!Array.isArray(projectIds) ||
        !projectIds.every((id) => typeof id === "string"))
    )
      throw new Error("projectIds 必须是字符串数组");
    if (typeof removeMissing !== "boolean" || typeof apply !== "boolean")
      throw new Error("装载选项必须是布尔值");
    return {
      results: scheduler.load(
        projectIds as string[] | undefined,
        removeMissing,
        apply,
      ),
    };
  }),
);
app.put(
  "/tasks/enabled",
  route((req) => {
    const { projectId, taskId, enabled } = req.body ?? {};
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof taskId !== "string" || !taskId.trim() || typeof enabled !== "boolean")
      throw new Error("需要项目、任务 ID 和布尔类型的 enabled");
    scheduler.setTaskEnabled(projectId, taskId, enabled);
    return { success: true, enabled };
  }),
);
app.post(
  "/run",
  route((req) => {
    if (
      typeof req.body?.projectId !== "string" ||
      typeof req.body?.taskId !== "string"
    )
      throw new Error("缺少项目或任务 ID");
    return {
      run: scheduler.start(req.body.projectId, req.body.taskId, "manual"),
    };
  }),
);
app.post(
  "/runs/:id/stop",
  route((req) => {
    scheduler.stop(String(req.params.id));
    return { success: true };
  }),
);
app.get(
  "/runs",
  route((req) => ({
    runs: store.runs(
      typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      typeof req.query.taskId === "string" ? req.query.taskId : undefined,
    ),
  })),
);
app.get(
  "/runs/:id/log",
  route((req) =>
    scheduler.log(
      String(req.params.id),
      String(req.query.stream ?? "stdout"),
      Number(req.query.offset ?? 0),
    ),
  ),
);
app.get(
  "/runs/:id",
  route((req) => scheduler.snapshot(String(req.params.id))),
);
app.get("/settings", route(publicSettings));
app.put(
  "/settings",
  route((req) => {
    store.saveSettings(updateSettings(req.body, store.settings()));
    scheduler.cleanup();
    return publicSettings();
  }),
);
app.post(
  "/settings/telegram/test",
  route(async () => {
    await sendTelegram(
      store.settings().telegram,
      "CloudCLI 定时任务：测试告警，渠道配置成功。",
    );
    return { success: true };
  }),
);
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const secret = store.settings().telegram.botToken;
    res
      .status(400)
      .json({
        error: secret
          ? error.message.replaceAll(secret, "[redacted]")
          : error.message,
      });
  },
);
const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    process.stdout.write(
      JSON.stringify({ ready: true, port: address.port }) + "\n",
    );
});
const maintenance = setInterval(() => {
  try {
    scheduler.maintenance();
  } catch (error) {
    console.error(String(error));
  }
  void notifier.flush().catch((error) => console.error(String(error)));
}, 1000);
const cleanup = setInterval(() => {
  try {
    scheduler.cleanup();
  } catch (error) {
    console.error(String(error));
  }
}, 60000);
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(maintenance);
  clearInterval(cleanup);
  notifier.stop();
  server.close();
  server.closeAllConnections();
  await scheduler.close();
  // Notification transport may still be unwinding. It cannot access a closed database.
  process.exit(0);
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
process.on("disconnect", () => {
  void close();
});
if (!process.connected) throw new Error("宿主 IPC 通道未建立");
// Ensure a data directory exists even before the first imported job produces logs.
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
