# 项目定时任务插件

基于 codex-app-server，实现于 codex-app-server-cron。插件随应用分发，在设置 → 插件中独立启停。
进入项目的「定时任务」页签；右上角「插件设置」只提供告警渠道、运行与日志，不提供执行环境界面。

## 配置与装载

点击「装载当前项目」或「装载全部项目」，读取已登记且未归档项目的 .cloudcli/project-schedules.json。
按项目、任务 ID 新增或更新；勾选同步删除时删除配置中缺失的任务。重复装载不重复注册。
每个项目先整体校验再原子提交；配置损坏或不存在不修改旧任务。装载不会中断当前运行。
重启恢复已装载定义，不自动重读文件，不补跑停机期间的时间点。

    {
      "version": 1,
      "timezone": "Asia/Shanghai",
      "defaults": {
        "allowConcurrent": false,
        "timeoutSeconds": 3600,
        "agent": { "provider": "codex", "model": "default" }
      },
      "tasks": [
        {
          "id": "health", "name": "健康检查", "type": "script",
          "cron": "*/30 * * * * *", "command": "bash", "args": ["scripts/health.sh"]
        },
        {
          "id": "review", "name": "每日检查", "type": "prompt",
          "cron": "0 0 9 * * *",
          "agent": { "provider": "dsh", "model": "deepseek-official/deepseek-v4-flash" },
          "prompt": "检查项目状态，报告问题与建议。"
        }
      ]
    }

Cron 接受五或六段，六段首项为秒；时区使用 IANA 名称。cwd 默认为项目根目录，必须在项目内。
脚本以 command、args 直接启动；管道请显式使用 bash -lc。env 不能覆盖插件内部执行控制变量。
同一项目、任务默认禁止重叠，忙碌时跳过至下个时间点；手动运行遵守同一规则，容量用完也跳过。

## Agent

脚本获得可执行包装器 AGENT_EXEC，调用方式为 "$AGENT_EXEC" "提示词"。
脚本和提示词任务共用入口。Codex 从 claudecodeui 安装目录解析依赖的原生二进制；
macOS arm64 优先 node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex。
不依赖全局 Codex。以 exec --ephemeral --json 启动，通过 stdin 传递提示词。
DSH 使用宿主 CLOUDCLI_DSH_BIN（默认 dsh）、DSH_HOME 和 CLOUDCLI_DSH_PATCHES，
追加临时 patch 选择模型并禁用 session-persistence-jsonl；不修改 profile，不恢复会话。
DSH headless 文本在步骤提交时产生，不承诺逐 token 显示。

无人值守任务沿用 CLI 权限配置，需要审批时不自动授予额外权限。
Agent 会话不保存，调度日志仍保存；stderr 非空本身不代表失败。

## 生命周期与日志

数据按宿主数据库完整路径的散列隔离，保存于其 plugins/project-scheduler 子目录，不在项目内保存日志或凭据。
同一目录下不同数据库文件对应独立调度数据，避免多个宿主实例互相影响。
宿主提供可信项目目录快照，不接受浏览器指定任意目录。loopback 内部 RPC 使用随机令牌。
数据目录有独占锁。宿主/插件退出通过 IPC 通知 worker，由其终止命令进程组。
重启记录意外中断，不自动重试有副作用的任务。

完整运行记录与 stdout、stderr、原始事件从运行结束起默认保留 30 天；0 永久保留。
运行中不清理；最近一次结果摘要单独保留。缩短天数影响已有数据，清理后不可恢复。
每个日志流最多 16 MiB，超过后继续排空管道并明确提示截断。

## 告警与构建

设置 Telegram bot token、chat ID、可选 HTTP 代理。失败、启动失败、超时及意外中断告警。
手动停止、并发跳过不告警。发送结果单独记录，有限退避重试不重新执行任务。
测试按钮会实际发送消息。Token 不返回浏览器、不注入任务进程、不写项目文件。

npm run build:plugins 构建插件；普通 dev/build 包含插件构建。npm run test:cron 验证核心行为。
