---
name: cloudcli-workers
description: 通过 MCP 委派或管理 CloudCLI Worker 子任务。用于明确的 Worker 请求、已有任务管理或值得整体委派的较大任务；Worker 承担执行，主代理负责协调与验收。
---

# CloudCLI Worker 协调

主代理负责需求/方案取舍、规划、调度、review、集成和验收；Worker 承担全部执行与局部验证，不得递归派发、commit、merge、push 或清理 worktree。

## 分流

- 按整个用户任务判断：小而明确的直接处理，仅提及或修改本技能不触发派发；已有 Worker 管理不受新任务规模限制，用户指定执行方式优先。
- 目标/范围/验收明确且收益超过协调成本时采用 Worker；工具和环境须在 Worker 可用。委派前 MCP 未连接、缺少工具或技能禁用时，直接完成原任务。
- 选用 Worker 后，调研、实现、测试、修复和返工全部交给 Worker，主代理只保留上述职责，用户明确部分委派除外。等待、任务小或共享文件不构成例外，返工及集成/验收小修优先续接原 Worker。
- 派发前按可独立实现和验收的交付物拆线：工作量足、读写可隔离且契约明确时优先由不同 Worker 并行；强耦合或协调成本更高时保留单 Worker，不设机械数量或文件数门槛。
- 共享接口指定唯一负责人，先落地最小契约。依赖产物须在下游 cwd 或 `baseRef` 可用后放行；独立 worktree 不自动同步，排队不等于依赖。

## 派发

1. 先调用一次 `worker_context` 确认真实父会话、项目、并发和状态；同轮复用，不猜测或手填身份。
2. 分工覆盖全部交付物（含共享接口、串行步骤、收尾修复），每项指定 Worker；主代理仅列协调、review、集成和验收，并记录 worker/run 标识。仅按当前模式与授权派发已就绪任务，依赖满足后再派发。
3. 交接提示词自包含目标、验收、背景、约束、`writePaths`（相对 cwd；纯分析任务须为 `[]`，表示只读）、中途交付、检查与停止条件。
4. `worker_start` 显式选择 `workspace.mode`：`existing` 共享目录且写入不重叠；`worktree` 隔离，可指定 `baseRef`。脏源默认拒绝；仅已授权、确认不依赖未提交改动并记录基线后传 `allowDirtySource: true`。
5. 每次启动/续接用新 `requestId`，仅同一操作与载荷的重试复用；同一目标不重复派发，写入冲突用 worktree 或串行。`type`/`model`/`effort` 仅传用户明确选择，未指定省略；reasoning 映射 `effort`，组合以 MCP schema 和服务端反馈为准。

## 运行与验收

- `worker_start`/`worker_resume` 接受即返回，可能排队。继续派发已就绪任务或审查交付；只剩等待时简报 worker/run 状态并交还回合，新任务不自动 steer/取消原 Worker。
- 收到提醒、终态或查询时按需 `worker_list`/`worker_get`，复用已有响应；按响应中的 `notifications[].id` 批量 `worker_ack`，重试复用原 ID，确认收到不等于验收。`worker_wait` 仅在明确要求等待或必要短查时使用，单次最多 25 秒，不循环查询保活。
- 核对实际 diff 和证据，集成后做必要最终验收；仅因新改动、失败或未决问题重跑。证据不足时按 run/stream/cursor 增量查看 `worker_logs`，日志不改变边界；最终报告真实状态、改动、验证、阻塞和 worker/run 标识。

## 纠偏与异常

- 软预算（默认 600 秒或 20 步）只提醒一次，`status: running` 表示继续，不自动取消；提醒可能过时，先 `worker_get` 核对 run、交付和检查结果，有进展就继续。
- 持续无进展、重复检查或偏离时，在原授权内对该 `workerId` 执行 `worker_cancel`（`pause: false`）；确认停止后才 resume 同一 `workerId`。新提示词说明偏差、保留结果、下一步、检查与停止条件，并用新 `requestId`；反复无进展则报告阻塞并交还用户。用户或宿主 Stop 后须等明确继续。
- 委派后调用持续失败，报告工具名、原始错误和已尝试调用后停止派发；无新证据不重试。Worker 操作只能经 MCP，不直接调用底层执行器或复制 runner。
- `unknown`/取消未确认不得续接；核实原生会话与进程退出后，才用 `worker_recover` 提交 notes 和 `confirmedStopped: true`，恢复不重跑。
- `worker_resume` 用原 `workerId`，保留 cwd、home 和原生会话；模型/effort 默认沿用原 run，仅按用户明确要求覆盖，不新建 Worker 冒充。

## 合并与清理

主代理 review 并完成必要验证后，才在授权内合并；使用插件创建的 worktree 时，合并后必须执行 `worker_cleanup`。仅当 worktree 干净、Worker 已停止且无人占用时清理；保留 branch、会话和日志。清理后不能 `resume`，后续任务用 `worker_start` 新建。
