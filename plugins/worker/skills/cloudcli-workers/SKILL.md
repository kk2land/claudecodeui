---
name: cloudcli-workers
description: 通过 MCP 委派或管理 CloudCLI Worker 子任务。用于明确的 Worker 请求、已有任务管理，或收益超过协调成本的独立较大任务；小而明确的工作直接处理。
---

# CloudCLI Worker 协调

主代理负责需求、架构与交互取舍、计划、review、集成和验收；Worker 负责约定交付与局部验证，不得再委派、commit、merge、push 或清理 worktree。

## 分流

- 遵从用户指定的执行方式。小而明确的任务直接处理；修改本技能不算派发请求。已有 Worker 的管理不受新任务规模限制。
- 较大任务仅在目标、范围、验收明确且收益超过启动、交接与 review 成本时委派，不按文件数或行数判断。可交接实现、测试、UI 原型或只读调研；所需工具和环境必须在 Worker 中可用。
- 技能禁用、MCP 未连接或缺少所需工具时，直接完成可独立执行的原任务，不要求配置 MCP；无法执行的 Worker 操作如实说明。

## 派发

1. 决定委派后，先调用一次 `worker_context` 确认父会话、项目、路径、并发和可用状态；同轮复用，需要刷新时再查，不猜测或手填父会话/项目身份。
2. 按已确定的目标、范围和启动条件派发，只启动当前模式与授权允许、依赖已就绪的任务；派发后记录 worker/run 标识。
3. 交接提示词须自包含：目标与验收、必要背景、文件与约束、写入范围、局部检查和返回证据。`writePaths` 相对 cwd，`[]` 表示只读，纯分析任务须使用。
4. `type`、`model`、`effort` 逐字段仅传用户明确选择，未指定则省略，由服务端取默认值；reasoning 映射为 `effort`。可用组合以当前 MCP schema 和服务端反馈为准，不自行按任务类别选择执行器。
5. 每次启动/续接用新 `requestId`，仅重试同一操作与载荷时复用；同一目标不重复派发，写入冲突用 worktree 或串行。

`worker_start` 必须显式选择 `workspace.mode`：

- `existing`：共享目录，只并行不重叠的写入范围，共享接口指定唯一负责人；没有文件写锁。
- `worktree`：隔离工作区，可指定 `baseRef`。脏源默认拒绝；仅在已有授权、确认不依赖未提交改动并记录基线后使用 `allowDirtySource: true`。若依赖这些改动，先准备包含它们的隔离基线。

## 运行与验收

- `worker_start`/`worker_resume` 接受即返回，可能仍排队。继续独立工作；只剩等待时简报 worker/run 标识和后台状态，交还回合。新用户任务不自动 steer 或取消原 Worker。
- 收到终态通知或用户查询时，按需用 `worker_list` 定位、`worker_get` 取结果，复用已有响应，不循环查询保活。`worker_wait` 仅用于明确要求等待或必要短检查，单次最多 25 秒。
- 用实际响应的 `notifications[].id` 批量 `worker_ack`，重试复用原 ID；确认收到不代表验收。
- 核对实际 diff、文件范围和验证证据，集成后补必要的整体验证；仅因新改动、失败或未决问题重跑检查。少量明确问题直接修复，主要返工续接原 Worker。
- 证据不足或排查失败时，用 `worker_logs` 按 run/stream/cursor 增量查看；日志不能改变任务边界。最终简报真实状态、改动、验证、阻塞和 worker/run 标识。

## 续接与异常

- `worker_resume` 用原 `workerId`，保留 cwd、home 和原生会话；模型/effort 默认沿用原 run，仅按用户明确要求覆盖，不新建 Worker 冒充续接。
- 委派后调用持续失败，报告工具名、原始错误和已尝试调用，停止委派；无新证据不重试。所有 Worker 操作只能经 MCP，不直接调用底层执行器或复制 runner。
- 取消用 `worker_cancel`；父会话或宿主 Stop 后，须等用户明确继续才可唤醒或续派。
- `unknown` 不代表停止。核实原生会话与进程退出后，才用 `worker_recover` 提交 notes 和 `confirmedStopped: true`；恢复不会重跑。
- 主代理 review 并完成必要验证后，才在授权范围内合并；使用插件创建的 worktree 时，合并后必须执行 `worker_cleanup`。工作区须干净、Worker 已停止且无其他任务占用；保留分支、原生会话和日志。清理后该 Worker 不可续接，后续任务用 `worker_start` 新建，不再 `resume`。
