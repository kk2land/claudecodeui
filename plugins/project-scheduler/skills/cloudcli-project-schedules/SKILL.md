---
name: cloudcli-project-schedules
description: 创建或更新 CloudCLI 项目内的 .cloudcli/project-schedules.json 定时任务配置（cron、脚本、提示词、时区、告警），用于为当前项目登记、修改或停用定时任务。
---

# 项目定时任务配置

为 CloudCLI 项目维护 `.cloudcli/project-schedules.json`。该文件由用户在项目内编辑，再由
CloudCLI 的「定时任务 → 装载当前项目」读取入库；装载只按任务 ID 新增或更新，不会执行任务。

## 步骤

1. 定位用户目标项目根目录；若 `.cloudcli/project-schedules.json` 已存在，先完整读取并保留其结构与未知字段；若不存在，按用户需求创建 `.cloudcli/` 和 `version: 1`、`tasks` 配置。
2. 若文件无效（JSON 解析失败、字段类型错误），停止并报告；不要用默认配置覆盖或清空原文件。
3. 以稳定 `task.id` 作为更新依据：已有任务原地修改，新任务追加到 `tasks`，不改动其他任务。
4. 只写入用户显式要求的字段；未要求的项沿用文件或默认值，不用默认值覆盖用户显式设置（如 `timezone`、`timeoutSeconds`、`allowConcurrent`、`agent`）。
5. 时间语义不明确时先问清时区与频率（例如“每天 9 点”是哪个时区、工作日还是每天），不要自行猜测。
6. 写回前校验待保存内容：JSON 合法、任务 ID 唯一且匹配 `^[a-zA-Z0-9_-]{1,128}$`、cron 段数正确、时区为有效 IANA 名称。
   项目可用时优先使用现有解析器校验，不要依赖本仓库绝对路径，也不要要求安装插件源码。
7. 校验通过后写回文件并重新读取确认。告知用户：需在 CloudCLI「定时任务」中装载当前项目后才生效；不要自动执行任务或安装技能。

## 文件结构

```json
{
  "version": 1,
  "timezone": "Asia/Shanghai",
  "defaults": {
    "allowConcurrent": false,
    "timeoutSeconds": 3600,
    "agent": { "provider": "codex", "model": "default" }
  },
  "alerts": { "telegram": "default" },
  "tasks": []
}
```

- `version` 必须为 `1`；`tasks` 为数组，最多 500 项。
- 新建配置应明确项目 `timezone`；时区值使用有效 IANA 名称，如 `Asia/Shanghai`，不要写 `UTC+8`。任务可用自身 `timezone` 覆盖项目值；缺省时按任务、项目、插件设置的顺序继承。
- `alerts.telegram` 仅支持 `"default"` 或 `false`，且只作用于项目级；不要在配置中写 bot token、chat ID 或代理凭据，凭据在插件设置中单独保存。

## 任务字段

- `id`：必填，稳定标识，1–128 位字母、数字、下划线或连字符；同一文件内唯一。
- `name`：显示名，可省略，默认取 `id`。
- `type`：`script` 或 `prompt`。
- `cron`：五段或六段；六段时第一段为秒（如 `0 0 9 * * *` 为每天 9:00:00）。
- `enabled`：缺省 `true`；设为 `false` 可停用而不删除。
- `cwd`：可选，相对项目根目录，且必须是项目内已存在的目录；缺省为项目根目录。
- `timeoutSeconds`：整数，`0` 表示不限，最大 2147483。
- `allowConcurrent`：缺省 `false`；同一任务默认不重叠，忙碌时跳过。
- `env`：字符串键值对；不能覆盖 `AGENT_EXEC`、`CLOUDCLI_HOST_ROOT`、`CLOUDCLI_PLUGIN_*`、`CLOUDCLI_SCHEDULER_*` 等内部变量。
- 脚本任务：`command` 必填，`args` 为字符串数组；命令直接启动，不经隐式 shell。需要管道或重定向时显式使用 `bash -lc`。
- 提示词任务：`prompt` 必填。
- `agent`：对象，例如 `{ "provider": "codex", "model": "default" }`；`provider` 仅支持 `codex` 或 `dsh`，`model` 缺省为 `"default"`。DSH 的 `model` 可写 `provider/model` 路由。
- 项目级 `alerts.telegram: false` 对该项目所有任务关闭 Telegram 告警；任务内没有单独的告警配置字段。

## 完整示例

```json
{
  "version": 1,
  "timezone": "Asia/Shanghai",
  "defaults": { "allowConcurrent": false, "timeoutSeconds": 3600 },
  "alerts": { "telegram": "default" },
  "tasks": [
    {
      "id": "daily-review",
      "name": "每日项目检查",
      "type": "prompt",
      "cron": "0 0 9 * * *",
      "enabled": true,
      "agent": { "provider": "codex", "model": "default" },
      "prompt": "检查项目当前状态，汇总未完成事项、潜在风险与建议，输出简洁报告。"
    },
    {
      "id": "health-check",
      "name": "健康检查",
      "type": "script",
      "cron": "*/30 * * * *",
      "enabled": true,
      "cwd": ".",
      "command": "bash",
      "args": ["scripts/health.sh"],
      "timeoutSeconds": 300
    }
  ]
}
```

## 删除与停用

- 停用：把对应任务 `"enabled"` 设为 `false`，保留任务定义。
- 删除：从 `tasks` 中移除该任务，并提醒用户在装载对话框中勾选“同步删除已移除任务”，否则已装载的旧任务仍会保留。
