# CloudCLI Workers

## Disabled skills

- A skill's disabled state overrides instructions here or in repository documents to use it. Do not load or use it, search for another copy, or run its scripts to bypass that state. Use available tools directly instead.

## cloudcli-workers 使用说明

本节约束 `cloudcli-workers` 的使用；下文“主代理”同时指 Codex 和 DSH。

- 小而明确的请求直接处理：问答、代码查找、文案或配置修改、局部修复，以及修改 skill 本身，都不因提及 `cloudcli-workers` 而委派。文件数或行数不是委派门槛。
- 用户意图优先：用户要求直接处理时遵从。仅对明确的 Worker 执行请求、已有 Worker 的管理，或目标、范围、验收明确且收益超过启动、交接与 review 成本的独立较大任务，才考虑 `cloudcli-workers`。
- 技能被禁用、未启用，或当前会话的 Worker MCP 未连接、缺少所需工具时，跳过该 skill，直接用普通工具完成原任务，不要求先配置 MCP。无法执行的 Worker 操作如实说明；任何情况下都不绕过 MCP 调用底层执行器或复制 runner。
- 主代理负责需求、设计、计划、review、集成与验收；Worker 只执行约定范围与局部检查。接受前核对实际 diff 和验证证据；少量明确问题由主代理直接修复，主要返工续接原 Worker。
- 收到运行预算提醒时，主代理核对当前 run、交付物和检查结果；有进展就继续等待。方向偏离或重复无效工作时，可在原授权范围内取消该 Worker（`pause: false`），确认停止后用明确反馈续接同一 Worker。软提醒本身不触发自动取消，用户 Stop 后仍须等待用户明确继续。

### 计划阶段

符合委派条件时，在方案定稿前明确：

- 主代理与 W1/W2 等 Worker 各自的目标交付物。
- 各自的工作区、读写范围和共享接口负责人。
- 依赖及启动条件；依赖产物必须真正进入下游 cwd 或 `baseRef`，独立 worktree 不会自动同步。
- 基线，以及局部验证项和需要返回的证据。
- 可并行项。MCP 排队没有 `dependsOn`，并发排队不能表达依赖。

派发后记录 worker/run 标识，不创建 DAG 或任务表。方案定稿不等于派发：计划模式下不得实际派发；按当前会话模式与授权执行，仅启动已就绪任务。

### 合并后清理

- 主代理 review 并完成必要验证后，才在授权范围内合并；使用插件创建的 worktree 时，合并完成后必须对相应 Worker 执行 `worker_cleanup`。
- 仅当 worktree 由插件创建、工作区干净、Worker 已停止且无其他任务占用时清理。保留分支、原生会话和日志。
- 清理后该 Worker 不可续接；后续任务用 `worker_start` 新建 Worker，不再 `resume`。
