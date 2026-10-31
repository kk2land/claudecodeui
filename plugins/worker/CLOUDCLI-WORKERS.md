# CloudCLI Workers

## Disabled skills

- A skill's disabled state overrides instructions here or in repository documents to use it. Do not load or use it, search for another copy, or run its scripts to bypass that state. Use available tools directly instead.

## cloudcli-workers 使用说明

本节约束 `cloudcli-workers` 的使用；下文“主代理”同时指 Codex 和 DSH。

- 小而明确的请求直接处理：问答、代码查找、文案或配置修改、局部修复，以及修改 skill 本身，都不因提及 `cloudcli-workers` 而委派。文件数或行数不是委派门槛。
- 用户意图优先：用户要求直接处理或仅委派部分工作时遵从。以整个用户任务判断是否采用 `cloudcli-workers`，适用于明确的 Worker 执行请求、已有任务管理，或目标、范围、验收明确且整体收益超过协调成本的较大任务。
- 一旦采用 Worker 执行，本次任务的调研、实现、测试和修复等执行性子任务全部交给 Worker。主代理负责需求、设计、计划、调度、review、集成与最终验收，不自行接管未派发的子任务或少量修复；用户明确指定部分委派时按指定范围执行。
- 决定委派前，技能被禁用、未启用，或当前会话的 Worker MCP 未连接、缺少所需工具时，跳过该 skill，直接用普通工具完成原任务，不要求先配置 MCP。已进入 Worker 流程后的持续调用失败如实报告，不自行接管执行子任务；任何情况下都不绕过 MCP 调用底层执行器或复制 runner。
- 接受前核对实际 diff 和验证证据，集成后完成必要的最终验收；需要修改代码时续接原 Worker 或派发后续 Worker，包括集成和验收发现的小修复。
- 收到运行预算提醒时，主代理核对当前 run、交付物和检查结果；有进展就继续等待。方向偏离或重复无效工作时，可在原授权范围内取消该 Worker（`pause: false`），确认停止后用明确反馈续接同一 Worker。软提醒本身不触发自动取消，用户 Stop 后仍须等待用户明确继续。

### 计划阶段

符合委派条件时，在方案定稿前明确：

- 覆盖全部执行交付物的 W1/W2 等 Worker 分工，以及主代理的协调、review、集成与最终验收职责。
- 各自的工作区、读写范围和共享接口负责人。
- 依赖及启动条件；串行步骤、共享接口和收尾工作也要指定 Worker。依赖产物必须真正进入下游 cwd 或 `baseRef`，独立 worktree 不会自动同步。
- 基线，以及局部验证项和需要返回的证据。
- 可并行项。MCP 排队没有 `dependsOn`，并发排队不能表达依赖。

派发后记录 worker/run 标识，不创建 DAG 或任务表。方案定稿不等于派发：计划模式下不得实际派发；按当前会话模式与授权执行，仅启动已就绪任务。

### 合并后清理

- 主代理 review 并完成必要验证后，才在授权范围内合并；使用插件创建的 worktree 时，合并完成后必须对相应 Worker 执行 `worker_cleanup`。
- 仅当 worktree 由插件创建、工作区干净、Worker 已停止且无其他任务占用时清理。保留分支、原生会话和日志。
- 清理后该 Worker 不可续接；后续任务用 `worker_start` 新建 Worker，不再 `resume`。
