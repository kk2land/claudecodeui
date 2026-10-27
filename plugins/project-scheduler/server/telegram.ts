import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { SchedulerSettings } from "../shared/contracts.js";
import type { SchedulerStore } from "./store.js";

/** Fixed-destination Telegram transport; requests and errors never expose the bot URL/token. */
export async function sendTelegram(
  settings: SchedulerSettings["telegram"],
  text: string,
): Promise<void> {
  if (!settings.botToken || !settings.chatId)
    throw new Error("请先保存 Telegram bot token 和 chat ID");
  const body = JSON.stringify({
    chat_id: settings.chatId,
    text: text.slice(0, 3900),
  });
  await new Promise<void>((resolve, reject) => {
    const request = https.request(
      "https://api.telegram.org/bot" + settings.botToken + "/sendMessage",
      {
        method: "POST",
        agent: settings.proxy ? new HttpsProxyAgent(settings.proxy) : undefined,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let result = "";
        response.on("data", (chunk) => {
          if (result.length < 32768) result += String(chunk);
        });
        response.on("end", () => {
          try {
            const payload = JSON.parse(result) as {
              ok?: boolean;
              description?: string;
            };
            if (response.statusCode === 200 && payload.ok) resolve();
            else
              reject(
                new Error(
                  (
                    payload.description ??
                    "Telegram 返回 HTTP " + response.statusCode
                  ).replaceAll(settings.botToken, "[redacted]"),
                ),
              );
          } catch {
            reject(new Error("Telegram 响应格式无效"));
          }
        });
        response.on("error", () => reject(new Error("读取 Telegram 响应失败")));
      },
    );
    // Includes proxy connect, TLS and response time rather than only socket inactivity.
    const deadline = setTimeout(
      () => request.destroy(new Error("Telegram 请求超时")),
      10000,
    );
    request.on("close", () => clearTimeout(deadline));
    request.on("error", () =>
      reject(new Error("Telegram 请求失败，请检查网络或代理")),
    );
    request.end(body);
  });
}

/** Persisted, bounded retry outbox; alert failure never retries the underlying task. */
export class TelegramNotifier {
  private busy = false;
  private stopped = false;
  constructor(
    private readonly store: SchedulerStore,
    private readonly send = sendTelegram,
  ) {}
  async flush(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const run of this.store.pendingAlerts()) {
        if (this.stopped) break;
        const settings = this.store.settings().telegram;
        if (!settings.enabled) {
          run.alertStatus = "failed";
          run.alertError = "告警渠道已关闭";
          this.store.saveRun(run);
          continue;
        }
        while (run.alertAttempts < 3 && !this.stopped) {
          run.alertAttempts++;
          this.store.saveRun(run);
          try {
            await this.send(
              settings,
              [
                "定时任务执行失败",
                "项目：" + run.projectName,
                "任务：" + run.taskName,
                "时间：" + run.startedAt,
                "状态：" + run.status,
                "退出码：" + String(run.exitCode),
                "原因：" + (run.reason ?? "命令非零退出"),
              ].join("\n"),
            );
            run.alertStatus = "sent";
            run.alertError = null;
            break;
          } catch (error) {
            run.alertError = String(error).replaceAll(
              settings.botToken,
              "[redacted]",
            );
            if (run.alertAttempts < 3)
              await new Promise((resolve) =>
                setTimeout(resolve, run.alertAttempts * 1000),
              );
          }
        }
        if (run.alertStatus !== "sent" && run.alertAttempts >= 3)
          run.alertStatus = "failed";
        this.store.saveRun(run);
      }
    } finally {
      this.busy = false;
    }
  }
  stop(): void {
    this.stopped = true;
  }
}
