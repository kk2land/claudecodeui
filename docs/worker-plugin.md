# CloudCLI Worker 插件

基于 codex-app-server，插件在现有「插件」页签中运行，把父会话拆出的任务交给 DSH 或 Pi 子任务执行，
并在独立进程中记录运行、原始事件与结果。插件负责执行与记录；任务拆分、review 和 Git 集成仍由父会话
与用户授权的 Codex 负责，不提供自动 Git 集成或 DAG。

## 启用与 skill 部署

插件随 CloudCLI 分发，在插件列表中启用后出现在项目的 Worker 页签。Worker 的自带 skill 位于：

    plugins/worker/skills/cloudcli-workers/SKILL.md

需要让 Codex 发现该 skill 时，由用户把整个目录软链到自己的 Codex skill 目录：

    mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
    ln -s /absolute/path/to/cloudcli/plugins/worker/skills/cloudcli-workers \
      "${CODEX_HOME:-$HOME/.codex}/skills/cloudcli-workers"

宿主不会自动注入、复制或安装这个 skill，也不会修改用户的 Codex 全局配置。目标已存在时保留它，
部署时核对并手动处理旧链接或目录。MCP 连接由 app-server 的线程配置临时注入，预测线程不启用
Worker MCP。若 skill 或 MCP 不可用，父会话应报告阻塞，而不是绕到 shell 直接调用原生 runner。

## 使用

父会话先通过 `worker_context` 获取真实父会话、项目和可用状态，再调用 `worker_start`。每次启动都必须
显式选择工作区：

- `worktree`：插件创建隔离 worktree，并在接受请求时解析 Git 基线（默认 `HEAD`）。源目录脏默认拒绝；
  只有明确传 `allowDirtySource: true` 才放行。
- `existing`：在已存在目录（默认项目根目录）中运行；共享目录允许并行，但插件不加文件写锁，调用方必须在
  `writePaths` 中声明互不重叠的修改范围。

`writePaths` 是相对 cwd 的已声明范围，`[]` 表示只读任务；它约束任务与 review 范围，不是额外的文件系统
权限。随后可用 `worker_list`、`worker_get`、`worker_logs`、`worker_wait` 跟踪；`worker_cancel` 取消；
`worker_resume` 用原 worker 继续，保留 cwd、home 与原生会话身份，但创建新的 runId，可显式覆盖模型/effort。

父会话页面提供「当前会话 / 当前项目 / 全部」三种视图，显示 DSH/Pi 占额与排队数、阶段、耗时、软提醒、
模型、cwd/worktree、真实原生 ID、结果和分页事件/stderr 日志。页面只读状态并执行取消、暂停、恢复、清理和
通知重试；不展示任何凭证。没有会话时禁用会话视图，没有项目时仅保留全部视图。

## 并发、排队与去重

并发键为 `(parentSessionId, projectId, workerType)`，DSH 与 Pi 默认各 3，每个键独立。`starting`、
`running`、`stopping`、`unknown` 都占用额度；超额请求按 FIFO 排队。同一原生会话只允许一个调用。
start/resume 都要求调用方提供 `requestId` 作为幂等键；相同操作与载荷的重复键返回原 worker/run，不会再次
启动 CLI。同一 `requestId` 用于不同操作或不同载荷时直接拒绝（ID 冲突），不会覆盖原记录。UI 的并发设置只
接受正整数，保存后按类型生效。

## 原生 CLI 参数与成功判定

执行器在 PATH 中解析绝对路径后才切换 cwd；以 argv 数组、`shell=false` 启动，不拼接 shell 字符串。
认证沿用现有 CLI 配置，不写入日志、不持久化密钥。

DSH：

    dsh --profile headless --patch <绝对路径>/plugins/worker/patches/dsh-session.patch.yml \
      [--patch <运行模型 patch>] --json [--session-id <真实会话 ID>] -

- stdin 传 UTF-8 提示词，末尾参数 `-` 表示从 stdin 读取。
- 若设置了 `CLOUDCLI_DSH_PATCHES`（文件路径 JSON 数组），这些 patch 先于插件必需的会话持久化 patch 和
  运行模型 patch 传入，顺序固定为：用户 patch、`dsh-session.patch.yml`、模型 patch。
- `DSH_HOME` 使用原环境值或 `~/.dsh`；会话根由插件显式设为实例数据目录下的 `sessions/dsh`。
- 模型与 effort 通过 `agent-default-model` 的 provider/model/reasoningEffort patch 注入，不伪造 CLI flags；
  effort 必须同时有显式模型。
- 成功要求：exit 0、事件完整合法、`session.cwd` 与 ID 匹配、出现 final，且最后一个 turn_end 的
  `reason.kind=completed`。已确认 CLI 退出但事件协议非法（例如缺少或错误的原生会话身份）是 `failed`，
  不会据此猜测原生身份，也不能续接；只有进程存活/退出证据本身缺失时才是 `unknown`。

Pi：

    pi --print --mode json --session-dir <实例数据目录>/sessions/pi \
      --session <首次 runId>.jsonl [--model X] [--provider X] [--thinking X]

- 通过 stdin 输入提示词，不追加 `-`。
- `PI_CODING_AGENT_DIR` 使用原环境值或 `~/.pi/agent`。新请求参数优先级：
  显式请求 > `CODEX_PI_*` 环境 > Pi 配置；续接时显式参数 > 旧记录。provider 必须与 model 一起给出。
- `thinking` 仅接受 `off/minimal/low/medium/high/xhigh/max`。
- 续接前核实会话文件存在且非空、header 的 ID 与 cwd 匹配，否则不续接。
- 成功要求：exit 0、会话身份匹配、最终 assistant 的 `stopReason=stop`、最终 `agent_end` 的
  `willRetry=false`、`agent_settled` 的 `aborted=false`。原生重试后最终成功可以接受。

真实的模型与 effort 能力以执行器配置为准；插件不虚构未支持参数。原始事件与 stderr 落盘保存，日志按页
读取，未上报的用量保持 `null`，不显示为 0。

## 自动唤醒、Stop 与恢复

终态通知保存于插件独立 outbox，不占用用户的三条消息队列。parent 空闲时合并约 500ms 窗口，忙时约每 2 秒
检查；用户排队消息优先。active goal、原生后台任务、queueHeld、stopping、stopFailed 等情况均等候；
其他 worker 仍在运行时可以处理已完成结果。普通 busy 只是延后领取，通知保持 `pending`。显式暂停、Stop
或丢失 authority 时，待发通知转为 `held`，必须等用户明确继续或手工重试，不会被自动唤醒改回 `pending`。
MCP 的 `ack` 只表示已收到，不是验收；已通过 MCP 确认的结果会取消待发通知，领取批次与回执避免重复投递。
通知投递失败可在 UI 手工重试。

主会话 Stop 会先封住新任务与自动唤醒，再取消该父会话的排队与运行任务；app-server 退出清理该实例全部
worker，CloudCLI 退出清理全部。关闭浏览器或切换页面不取消任务。主停止或退出触发的取消不会自动唤醒父会话。

重启后恢复运行记录，旧任务不自动重跑。无法确认停止的 run 标记 `unknown` 并继续占额；必须由人工核实原生
CLI 与进程组已停止，再通过 UI 或 `worker_recover` 提交说明与 `confirmedStopped: true`。恢复只写入核实
记录，不重跑任务。

## 进程与清理

每次运行有独立 Node 监护进程，CLI 置于新的进程组。IPC 断开、SIGTERM、SIGINT 都触发 stop；先 TERM，
2 秒后 KILL，确认进程组退出后才进入终态并释放额度。正常完成也会清理遗留子进程；不使用历史 PID 发信号。
插件自身退出时由独立监护进程清理。

`worker_cleanup` 只清理插件创建、工作区干净且已经停止的 worktree；保留分支、会话与日志，不清理 `existing`
目录或用户手工创建的 worktree。

## 数据与边界

插件数据位于宿主分配的插件数据目录（通常为 `CLOUDCLI_PLUGIN_DATA_DIR`，按宿主数据库路径隔离），包含
运行记录、outbox 与实例会话目录 `sessions/dsh`、`sessions/pi`。日志与结果可能含敏感内容，只能通过受保护的 UI REST 与 MCP 读取；MCP token
不进入 CLI 环境，host UI token 不能调用 MCP 或 IPC 控制操作。插件不改写用户全局配置与认证数据；执行器按既有方式读取配置和认证，Worker 原生会话使用独立存储。

`plugins/worker/shared/contracts.ts` 是插件、宿主桥接与 UI 共用的纯类型契约；宿主从
`server/shared/index.ts` 重导出实际使用部分，插件模块直接从该文件导入，禁止重复定义。跨进程使用：

- MCP 工具：`worker_context`、`worker_list`、`worker_start`、`worker_resume`、`worker_get`、
  `worker_logs`、`worker_wait`、`worker_ack`、`worker_cancel`、`worker_recover`、`worker_cleanup`。
- UI 只通过宿主现有 RPC 代理访问插件受保护 REST，不接触 IPC。

## 验收限制

自动化回归使用模拟 CLI 和临时会话，覆盖原生参数、状态与进程清理，不需要调用真实模型。
真实 Codex app-server 与 DSH/Pi 的联通仍需在支持这些执行器的部署环境验收。浏览器验收先完成构建，
再按仓库流程由用户启动或重启测试进程。
