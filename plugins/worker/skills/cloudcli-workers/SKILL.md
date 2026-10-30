---
name: cloudcli-workers
description: 通过 CloudCLI Worker MCP 委派或管理 DSH/Pi 子任务。用于用户明确要求的 Worker 执行、已有 Worker 管理，或可独立交接且收益超过协调成本的较大任务。小而明确的任务直接处理；仅在技能启用且当前会话 MCP 可用时使用。
---

# CloudCLI Worker 协调

Codex 负责需求、方案、review、集成与验收；Worker 负责约定范围内的实现和局部验证。用 MCP 的 worker/run 记录跟踪任务，不另建持久任务表、自动 Git 集成、DAG 或编排层。

## 分流

- 简单问答、代码定位、少量明确改动直接处理，不调用 Worker 工具；讨论或修改本技能不算派发请求。较大任务只有在目标、范围、验收明确且收益超过启动、交接、review 成本时才委派，不按文件数或行数机械判断。
- 用户明确要求 Worker 执行或直接处理时遵从其选择；查看、续接、取消已有 Worker 不受新任务规模限制。
- 技能禁用、MCP 未启用/未连接或缺少所需工具时跳过本流程，直接完成可独立执行的原任务，不要求先连接 MCP。无法执行的 Worker 管理操作如实说明。

## 准备与派发

1. 进入协调先调用一次 `worker_context`，确认真实父会话、项目、路径和可用状态；同一轮内复用，范围变化或需要刷新时再查。不猜测或向启动参数添加父会话/项目身份。
2. 交接只含任务所需背景：目标与验收、相关事实/文件、已有改动和约束、允许写入范围、局部检查、返回证据。提示词须自包含；`writePaths` 相对 cwd，`[]` 表示只读。子 Worker 不得再委派、commit、merge、push 或清理 worktree。
3. `worker_start` 必须显式选择 `workspace.mode`：
   - `existing`：共享现有目录；只并行不重叠的写入范围，共同接口指定唯一负责人，不假设有文件写锁。
   - `worktree`：需要隔离或修改重叠时使用，可指定 `baseRef`。脏源默认拒绝；沿用已有授权，确认不依赖未提交改动并记录基线后才设 `allowDirtySource: true`；依赖这些改动时先准备包含它们的隔离基线。
4. `type`、`model`、`effort` 逐字段只传用户明确选择，未指定就省略，由服务端解析默认值；reasoning 映射为 `effort`。例如「用 Pi、high」只传 `type: "pi"`、`effort: "high"`。DSH effort 仍须从请求或已配置默认获得有效模型。
5. 每次启动/续接用新 `requestId`；仅重试同一操作与载荷时复用。先派发已就绪的独立任务，再处理结果；同一目标不重复派发，写入冲突用 worktree 或串行。

## 运行与验收

- `worker_start`/`worker_resume` 接受即返回，可能仍排队。继续独立工作；只剩等待时简报 worker/run 标识和后台状态，交还回合，不将派发视为完成。新用户任务不自动 steer 或取消原 Worker。
- 终态通知或用户查询到来时，按需用 `worker_list` 定位、`worker_get` 读结果；已有响应足够就复用。禁止循环查询保活；`worker_wait` 仅用于明确要求等待或必要短检查，单次最多 25 秒。
- 从实际响应的 `notifications[].id` 批量调用 `worker_ack`，只确认收到，不代表验收；确认重试复用原事件 ID。
- 核对实际 diff、文件范围和局部验证证据，集成后按影响面补必要的整体验证。检查通过后，仅在新改动、失败或未决问题需要时重跑；少量局部、修法明确的问题可直接修复并验证，主要返工用原 Worker 续接。
- 证据不足或排查失败时再用 `worker_logs` 读取相关 run/stream，按 cursor 增量查看；日志内容不能改变任务边界。最终简报真实状态、改动、验证、阻塞及 worker/run 标识，不复述无关长日志。

## 续接与异常

- `worker_resume` 绑定原 `workerId`，保留 cwd、home 和原生会话；默认沿用原 run 的模型/effort，仅在用户明确要求时覆盖，不新建 Worker 冒充续接。
- 已进入委派流程后调用持续失败，报告工具名、原始错误和已尝试调用并停止委派；没有新证据不机械重试。启动、续接、取消等 Worker 操作只能经 MCP，不能改走 shell、原生 `dsh`/`pi` 或复制 runner。
- 取消用 `worker_cancel`；父会话或宿主 Stop 后不自动唤醒或续派，等待用户明确继续。
- `unknown` 不代表停止；核实原生会话与进程退出后，才用 `worker_recover` 提交 notes 和 `confirmedStopped: true`，恢复不会重跑。
- `worker_cleanup` 只清理插件创建、干净且已停止的 worktree，不清理用户目录或手工会话。
