# CloudCLI Worker 插件

支持 Codex app-server 与 DSH ACP 父会话，插件在现有「插件」页签中运行，把父会话拆出的任务交给 DSH 或 Pi 子任务执行，
并在独立进程中记录运行、原始事件与结果。插件负责执行与记录；任务拆分、review 和 Git 集成仍由父会话
与用户授权的主代理负责，不提供自动 Git 集成或 DAG。

## 启用与 skill 部署

插件随 CloudCLI 分发，在插件列表中启用后出现在项目的 Worker 页签。Worker 的自带 skill 位于：

    plugins/worker/skills/cloudcli-workers/SKILL.md

需要让 Codex 发现该 skill 时，由用户把整个目录软链到自己的 Codex skill 目录：

    mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
    ln -s /absolute/path/to/cloudcli/plugins/worker/skills/cloudcli-workers \
      "${CODEX_HOME:-$HOME/.codex}/skills/cloudcli-workers"

DSH 可将同一个 skill 软链到 `${DSH_HOME:-$HOME/.dsh}/skills/cloudcli-workers`，或项目的
`.agents/skills/cloudcli-workers`；已有目录或链接也应先核对，避免覆盖。

宿主不会自动注入、复制或安装这个 skill。目标已存在时保留它，部署时核对并手动处理旧链接或目录。
Worker 的通用规则、计划与合并后清理要求位于 `plugins/worker/CLOUDCLI-WORKERS.md`；运行
对应脚本安装全局引用块：

- Codex：`plugins/worker/install-codex-instructions.sh`，写入 `${CODEX_HOME:-$HOME/.codex}/AGENTS.md`。
- DSH：`plugins/worker/install-dsh-instructions.sh`，写入 `${DSH_HOME:-$HOME/.dsh}/AGENTS.md`。

脚本只维护 `<!-- cloudcli-workers:start -->` 与 `<!-- cloudcli-workers:end -->` 之间的内容，保留块外原文，
重复运行不重复添加；目录或文件缺失时创建，脚本或文档搬移后重新运行会更新引用路径。脚本仅依赖 POSIX sh，
不部署 skill，也不改动其他配置。

使用 skill 前还须让主代理读取通用规则；仅软链 skill 不会自动引入该文档。DSH 默认加载全局及项目
`AGENTS.md`，如需仅对某个项目生效，也可在项目 `AGENTS.md` 中添加对上述文档的引用。

MCP 连接由运行时临时注入，不在用户配置中预置：Codex app-server 通过 CLI `-c` 临时声明 Worker MCP URL
并设 `enabled=false`，无需在 `config.toml` 预置；`thread/start` 与 `resume` 注入专属 owner 凭证，预测线程
不启用 Worker MCP。DSH 仅在 ACP 启动时由临时 patch 挂载 HTTP Worker MCP，headless 不注入。
Codex 原生预测 fork 会继承父线程 MCP 且拒绝配置覆盖；启用 Worker 工具的会话明确显示预测暂不可用，
避免预测线程获得父会话的 Worker 凭证。未启用 Worker 的会话继续使用原生预测。
若 skill 未启用，或当前会话的 Worker MCP 未启用、未连接、缺少所需工具，主代理应跳过
该 skill 并用普通工具直接完成原任务，不要以「请连接 MCP 后重试」为前提报告阻塞。只有已进入 Worker
委派流程后的持续调用失败才报告具体阻塞；任何情况下都不要绕到 shell、`dsh`/`pi` 或复制 runner
启动/管理 worker。

## 使用

先判断是否值得委派：简单问答、代码定位、少量明确的文案、配置或代码修改由主代理直接处理，无需调用
`worker_context`。工作量较大、可独立交接的实现、排查或验证，在预期收益超过启动、交接与 review 成本时
再交给 Worker；简单改动无需强行拆分，也不按文件数或代码行数机械决定。用户明确要求 Worker 执行时
遵从其选择；讨论或修改 skill 本身不算要求派发。查看、续接或取消已有 Worker 仍使用对应 MCP 流程。
Review 发现少量局部、修法明确的问题时，主代理可直接修复并验证；主要实现返工通过原 Worker 续接。

决定委派且满足 skill/MCP 启用条件后，先调用一次 `worker_context` 确认真实父会话、项目和可用状态；
同一轮内复用，仅范围变化或需要刷新时再查。每次 `worker_start` 都必须显式选择工作区：

- `worktree`：插件创建隔离 worktree，并在接受请求时解析 Git 基线（默认 `HEAD`）。源目录脏默认拒绝；
  只有明确传 `allowDirtySource: true` 才放行。
- `existing`：在已存在目录（默认项目根目录）中运行；共享目录允许并行，但插件不加文件写锁，调用方必须在
  `writePaths` 中声明互不重叠的修改范围。

`writePaths` 是相对 cwd 的已声明范围，`[]` 表示只读任务；它约束任务与 review 范围，不是额外的文件系统
权限。`worker_start`/`worker_resume` 是异步派发：接受请求（包括进入排队）后立即返回，Worker 在后台继续，
父会话可以接收新的用户提示词。父会话只剩等待 Worker 时，应报告「已派发/后台进行」并结束当前派发回合、
交还输入权，不要用重复 `worker_list`/`worker_get`/`worker_wait` 让回合保持 Processing，也不要把已派发
说成验收完成；运行预算提醒与终态由 outbox 自动通知，届时再检查实际进展或验收。`worker_wait` 仍保留给用户明确要求
等待或必要的短检查；`worker_cancel` 取消，`worker_resume` 用原 worker 继续并保留 cwd、home 与原生会话
身份，但创建新的 runId，可显式覆盖模型/effort。

查询或验收时，按需用 `worker_list` 定位、`worker_get` 读取目标结果；已有响应足够就复用，通知 ID 批量
`worker_ack`。证据不足时再增量读取相关日志；局部检查通过后，仅有新改动、失败或未决问题时重跑。

每个 run 达到软预算（默认 600 秒或 20 步）时只生成一条运行提醒，以 `status: running` 写入 outbox；
父会话空闲且用户队列处理完后，Codex 或 DSH 主代理会收到提醒。提醒包含耗时、步骤数和阈值，不会自行取消任务。
主代理先核对当前 run，再检查交付物、diff 和验证结果；有进展则继续等待。持续探索、重复检查或方向偏离时，
可在原授权范围内 `worker_cancel` 指定该 Worker、`pause: false`，确认停止后用明确的新提示词 `worker_resume`
同一个 `workerId`，保留原会话、cwd 与已有修改。取消未确认或状态为 `unknown` 时不能续接；反复纠偏无进展时
报告阻塞，不机械重复提示词。运行结束后，尚未投递的提醒转为 `held`，只自动投递终态结果，已投递的提醒保留记录。

父会话页面提供「当前会话 / 当前项目 / 全部」三种视图，显示 DSH/Pi 占额与排队数、阶段、耗时、软提醒、
模型、cwd/worktree、真实原生 ID、结果和分页事件/stderr 日志。页面只读状态并执行取消、暂停、恢复、清理和
通知重试；不展示任何凭证。没有会话时禁用会话视图，没有项目时仅保留全部视图。

## 默认类型、模型与 reasoning

Worker 设置可指定新的 worker 启动请求省略类型时使用的默认类型，以及 DSH/Pi 各自的默认模型和 effort。
并发额度的修改会立即参与排队调度；默认类型、模型和 effort 只用于之后的新 worker 启动请求，不会改写已有
记录或已接受/排队的 run。

`GET /state` 的 `settings` 形状示例（`softReminderSeconds`、`softReminderSteps`、`hardTimeoutSeconds`
由服务端管理，`PUT /settings` 不接受）：

    {
      "concurrency": { "dsh": 3, "pi": 3 },
      "defaultWorkerType": "dsh",
      "defaults": {
        "dsh": { "model": null, "effort": null },
        "pi": { "model": null, "effort": null }
      },
      "retentionDays": 1,
      "softReminderSeconds": 600,
      "softReminderSteps": 20,
      "hardTimeoutSeconds": null
    }

`PUT /settings` 仍要求 `concurrency` 为两个正整数。`defaultWorkerType`、`defaults` 和 `retentionDays` 可省略：旧客户端仅提交
并发时，已保存的默认类型、模型/effort 和保留天数保持不变。`retentionDays` 必须是正整数。提供 `defaults` 时必须同时包含 `dsh` 与 `pi` 两个对象；
`model`/`effort` 为字符串或 `null`，空白字符串按清除处理。非法类型、错误的值类型、缺失的类型对象、非正
整数并发、无效 Pi thinking 级别，或 DSH effort 没有同时配置模型，都会让整次更新失败且不保存任何字段。
旧设置 JSON 在读取时补齐缺少的 `defaultWorkerType: "dsh"`、全为 `null` 的 `defaults` 和
`retentionDays: 1`，原有字段保持不变。

原生 DSH/Pi 会话文件独立保留 3 天，按文件修改时间计算；插件启动时清理一次，之后每 24 小时清理一次。
范围包括 `CODEX_DSH_SESSIONS_ROOT`（默认 `$HOME/tmp/codex-dsh-sessions`）、`$HOME/.pi/agent/sessions`，
以及插件数据目录下的 `sessions/dsh`、`sessions/pi`。DSH 的历史 generation 和 `.zstd` 文件也参与清理。
恰好达到 3 天的文件仍保留；排队、启动、运行、停止中或状态未知的 Worker 引用的原生会话会跳过。
DSH 即使尚无文件路径也按已记录的原生 ID 保护会话目录，Pi 在启动前记录文件路径；
恢复记录仍无法确定会话身份时，保留该运行所属会话根，待确认停止后再参与清理。
`HOME` 缺失时依次使用 `USERPROFILE` 和系统用户目录定位共享会话目录。
清理保留锁文件和其他非会话文件，失败项记录到插件日志并在下次清理时重试。插件停用期间不执行清理。

新 worker 启动请求的参数优先级为：请求中显式给出的非空值 > 所选类型的插件默认值 > 现有后端环境回退（仅 Pi：
`CODEX_PI_MODEL`、`CODEX_PI_THINKING`）> 原生 CLI 自身默认。省略 `type` 时选择
`defaultWorkerType`；显式 `dsh`/`pi` 总是优先。provider 仍只来自请求或 Pi 的
`CODEX_PI_PROVIDER`，没有插件级 provider 默认。插件在接受请求时把最终 type/model/effort 快照到 run；
之后修改默认不会改变已排队 run 已接受的值，原生 argv 与 DSH model patch 也使用该快照。

skill 与 MCP 的参数名是 `effort`，不是 `reasoning`。调用方把用户说的 reasoning 映射为 `effort`；DSH 配置
effort 时必须从请求或已配置默认获得有效模型，Pi 仅接受 `off/minimal/low/medium/high/xhigh/max`。模型或
effort 留空表示沿用执行器现有配置，不会覆盖 Pi 的环境配置，也不是“清空原生配置”。

续接（`worker_resume`）保持原 worker 类型、cwd、home 和原生会话身份；未显式覆盖的 model/effort 沿用上一次
run 的记录值，即使插件默认或环境此后已变化，也不会重新套用新默认。显式覆盖仍按原有校验生效。并发额度仍
按 `(parentSessionId, projectId, workerType)` 独立计算，默认类型或模型设置不改变额度与排队语义。

## 并发、排队与去重

并发键为 `(parentSessionId, projectId, workerType)`，DSH 与 Pi 默认各 3，每个键独立。应用会话 ID 已隐含
provider 隔离，父会话、项目与执行器的额度仍各自独立。`starting`、
`running`、`stopping`、`unknown` 都占用额度；超额请求按 FIFO 排队。同一原生会话只允许一个调用。
start/resume 都要求调用方提供 `requestId` 作为幂等键；相同操作与载荷的重复键返回原 worker/run，不会再次
启动 CLI。同一 `requestId` 用于不同操作或不同载荷时直接拒绝（ID 冲突），不会覆盖原记录。Worker 设置中的
并发只接受正整数，保存后按类型生效；默认类型与模型/reasoning 默认是独立的设置，不改变该并发键。

## 原生 CLI 参数与成功判定

执行器在 PATH 中解析绝对路径后才切换 cwd；以 argv 数组、`shell=false` 启动，不拼接 shell 字符串。
认证沿用现有 CLI 配置，不写入日志、不持久化密钥。

DSH：

    dsh --profile headless --patch <运行目录>/dsh-session.patch.yml \
      [--patch <运行模型 patch>] --json [--session-id <真实会话 ID>] -

- stdin 传 UTF-8 提示词，末尾参数 `-` 表示从 stdin 读取。
- 必需的会话 patch 由插件从打包文件原样复制到每次运行的目录，并以绝对路径传入；原生执行器读取运行副本，
  续接也为新 run 准备独立副本。
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
  显式请求 > 插件 Pi 默认 > `CODEX_PI_*` 环境 > Pi 配置；续接时显式参数 > 旧记录。provider 必须与
  model 一起给出。
- `thinking` 仅接受 `off/minimal/low/medium/high/xhigh/max`。
- 续接前核实会话文件存在且非空、header 的 ID 与 cwd 匹配，否则不续接。
- 成功要求：exit 0、会话身份匹配、最终 assistant 的 `stopReason=stop`、最终 `agent_end` 的
  `willRetry=false`、`agent_settled` 的 `aborted=false`。原生重试后最终成功可以接受。

真实的模型与 effort 能力以执行器配置为准；插件不虚构未支持参数。原始事件与 stderr 落盘保存，日志按页
读取，未上报的用量保持 `null`，不显示为 0。

## 自动唤醒、Stop 与恢复

主会话同一时间只处理一个回合：已开始的回合会先完成，随后用户排队消息按 FIFO 优先，最后才由 Worker outbox
提醒或结果唤醒。用户输入入队或回合完成时立即触发调度，另有约 15 秒的用户队列补充检查。Worker outbox 在父会话
空闲时约 500ms 合并一次通知，忙碌时约每 2 秒重试；这些重试不会抢占或中断用户回合。独立的新用户任务不会
自动 steer 或取消已派发的 Worker。active goal、原生后台任务、queueHeld、stopping、stopFailed 等情况均等候；
其他 worker 仍在运行时可以处理已完成结果。普通 busy 只是延后领取，通知保持 `pending`。用户队列上限仍为 3
条，与 Worker outbox 相互独立，outbox 不占用户队列额度；`chat.send` 与忙碌状态竞态时，消息进入现有持久
队列并返回 `chat_queued`。显式暂停、Stop 或丢失 authority 时，待发通知转为 `held`，必须等用户明确继续
或手工重试，不会被自动唤醒改回 `pending`。MCP 的 `ack` 只表示已收到，不是验收；已通过 MCP 确认的结果会
取消待发通知，领取批次与回执避免重复投递。通知投递失败可在 UI 手工重试。

主会话 Stop 会先封住新任务与自动唤醒，再取消该父会话的排队与运行任务；用户主动停止 app-server 或关闭
Codex 运行时会清理所属 worker，CloudCLI 退出清理全部。关闭浏览器或切换页面不取消任务。主停止或退出
触发的取消不会自动唤醒父会话。
codex-proxy 正常空闲退出与 ACP 空闲回收都只回收传输通道，不取消 worker；Worker 归属和临时凭证保留，
结果到达后按原生会话 ID 恢复父会话。原生回合中途异常退出仍报告失败并暂停其队列，不重发该回合。
代理已退出但仍有 Worker 时，停止 app-server 入口仍可取消任务。DSH 用户主动停止或切换到 headless 会取消 worker。
Codex 与 DSH 的设置按钮都提示当前会话的 Worker 活动，切到其他工作区页签时暂停活动轮询，回到聊天时立即刷新。
DSH 停止未获确认时，即使 ACP 已退出，停止入口仍可重试；普通进程状态轮询不会清除 Worker 清理错误，重试成功后清除。
Codex 的进程停止同样等待 Worker 清理确认；失败时保留暂停的 owner 并回报错误，代理已退出或活动查询失败时仍可重试。
停止也会取消尚在解析模型或注册 Worker 的旧回合初始化，避免空闲代理退出后，旧初始化在停止操作之后重新启动它。

2026-10-31 长时验收使用真实 codex-proxy 调度与回收代码、Codex `0.165.0`、DSH `0.2.1-rc.2` 和构建后的 Worker 插件，模型响应由本地 HTTP 服务提供。proxy 仅通过其测试入口 `Options.AccountHome` 隔离账户目录，保留默认 10 分钟空闲阈值。未发送保活 RPC，约 600.12 秒后日志确认 `idle_timeout` 正常退出，此时原生 Worker 仍在运行。完成结果随后启动新的代理并恢复同一父线程，MCP 凭证保持有效；再经 MCP 取消并续接，Worker ID 与 DSH 原生会话 ID 均保持不变，原始对话上下文仍在。该验收覆盖进程、插件与宿主桥接，不依赖真实模型账户。

重启后恢复运行记录，旧任务不自动重跑。无法确认停止的 run 标记 `unknown` 并继续占额；必须由人工核实原生
CLI 与进程组已停止，再通过 UI 或 `worker_recover` 提交说明与 `confirmedStopped: true`。恢复只写入核实
记录，不重跑任务。

## 进程与清理

每次运行有独立 Node 监护进程，CLI 置于新的进程组。IPC 断开、SIGTERM、SIGINT 都触发 stop；先 TERM，
2 秒后 KILL，确认进程组退出后才进入终态并释放额度。正常完成也会清理遗留子进程；不使用历史 PID 发信号。
插件自身退出时由独立监护进程清理。

`worker_cleanup` 只清理插件创建、工作区干净且已经停止的 worktree；保留分支、会话与日志，不清理 `existing`
目录或用户手工创建的 worktree。主代理 review 并完成必要验证后，才在授权范围内合并；合并后必须执行
`worker_cleanup`，且仅在没有其他任务占用时进行。清理后不能再用 `worker_resume` 续接，新任务应
`worker_start` 新建。

Worker 设置中的“日志和运行记录保留天数”同时控制日志和运行记录，默认 1 天，按每次运行的结束时间计算，
1 天为 24 小时。插件启动恢复完成后、保存设置后立即检查，运行期间每分钟检查一次。仅删除到期的
`completed`、`failed`、`cancelled`、`interrupted` 运行及其日志、退出证据、关联通知和请求去重记录；
排队、启动、运行、停止中及状态未知的运行不会被删除。同一 worker 仍有运行记录时保留 worker，否则删除
worker 记录。原生会话、分支和工作目录不会被自动删除；记录到期删除后无法再通过该 worker ID 续接或清理 worktree。
已经入队的续接使用该 run 在接受时保存的原生会话信息，旧运行记录到期不会改变其会话身份。

## 数据与边界

插件数据位于宿主分配的插件数据目录（通常为 `CLOUDCLI_PLUGIN_DATA_DIR`，按宿主数据库路径隔离），包含
运行记录、outbox 与实例会话目录 `sessions/dsh`、`sessions/pi`。日志与结果可能含敏感内容，只能通过受保护的 UI REST 与 MCP 读取；MCP token
不进入 CLI 环境，host UI token 不能调用 MCP 或 IPC 控制操作。宿主运行时不会自动改写用户全局配置与认证
数据；安装脚本仅在用户主动运行时维护上述引用块。执行器按既有方式读取配置和认证，Worker 原生会话使用独立存储。

`plugins/worker/shared/contracts.ts` 是插件、宿主桥接与 UI 共用的纯类型契约；宿主从
`server/shared/index.ts` 重导出实际使用部分，插件模块直接从该文件导入，禁止重复定义。跨进程使用：

- MCP 工具：`worker_context`、`worker_list`、`worker_start`、`worker_resume`、`worker_get`、
  `worker_logs`、`worker_wait`、`worker_ack`、`worker_cancel`、`worker_recover`、`worker_cleanup`。
- UI 只通过宿主现有 RPC 代理访问插件受保护 REST，不接触 IPC。

## 验收限制

自动化回归使用模拟 CLI 和临时会话，覆盖原生参数、状态与进程清理；另有真实 Codex app-server 与 DSH ACP
连接本地 HTTP MCP、模型夹具的测试，不需要调用真实模型。DSH 测试通过 `CLOUDCLI_DSH_SMOKE_BIN` 指定真实 CLI 后启用。
Codex CLI 与 SDK 固定为 `0.165.0`。本地启动器被代理替换时，可用 `CLOUDCLI_CODEX_TEST_BINARY` 指向同版本官方二进制，
验证原生预测、模型服务切换与 SDK 会话交接，避免代理改写本地测试请求。
实际部署中的执行器、认证和模型联通仍需环境验收。浏览器验收先完成构建，
再按 AGENTS.md 的本地手工测试流程由 Codex 直接启动或重启测试进程并检查日志，不要要求用户代为启动。
