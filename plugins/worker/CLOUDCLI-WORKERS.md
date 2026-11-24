# CloudCLI Workers

## Disabled skills

- A skill's disabled state overrides instructions here or in repository documents to use it. Do not load or use it, search for another copy, or run its scripts to bypass that state. Use available tools directly instead.

## cloudcli-workers 使用门槛

本节约束 `cloudcli-workers` 的使用，也是分流、回退与角色门槛的唯一来源。下文“主代理”指 Codex。

- 按整个用户任务判断，默认委派 CloudCLI Worker。主代理直接处理的范围限于极简单任务，例如根据已有信息回答、一次明确查询即可确认结果，或在已知位置按明确指示做可直接核对的机械修改。难以判定时默认委派。用户明确指定直接处理、委派或部分委派时，按其要求执行。
- 需要调研原因、评估影响、选择改法、代码审查或运行测试的任务都走 Worker，即使只涉及一个文件。实施范围取决于调研结果时，可先派发只读调研。
- 工具齐备才委派。当前会话的 Worker MCP 已连接且具备所需工具时，在开始实质工作前进入 Worker 流程，通过这道门槛后再加载已启用的技能。
- 技能被禁用、未启用或未安装，MCP 未连接，或缺所需工具时，跳过该 skill，直接用普通工具完成原任务，不要求先配置 MCP。
- 已进入 Worker 流程后的持续调用失败，如实报告事实、原始错误和已尝试的调用，不自行接管执行子任务。任何情况下都不绕过 MCP 调用底层执行器或复制 runner。

## 角色

- 主代理负责需求、设计、计划、调度、review、集成与最终验收。采用 Worker 后，调研、实现、测试与修复（含返工和集成小修）都由 Worker 执行，主代理不接管未派发的子任务。用户明确部分委派时按指定范围执行。
- 子 Worker 只做本次派发给它的任务，不递归派发、不 commit/merge/push、不清理 worktree。其余限制随每次任务交接写明，不靠子会话自己推断。
- 已有 Worker 用对应的 MCP 工具管理。

## 仅剩等待时结束回合

- `worker_start` / `worker_resume` 接受后继续推进任何未完成的独立工作。一旦只剩等待，发简短状态并立即结束当前回合。Worker 在后台继续，下一次检查由 Worker 通知唤醒（进度提醒或完成通知）。
- 不用原生 `clock.sleep`、shell `sleep`，也不反复查 Worker 状态或日志来等结果。`worker_wait` 只在用户明确要求当前回合同步等待时调用一次，最长 25 秒。状态可单次检查，通知到达后的验收照常。

## 正常流程入口

采用 Worker 后使用当前已启用的 `cloudcli-workers` 技能执行，其源文件为插件内 [`skills/cloudcli-workers/SKILL.md`](skills/cloudcli-workers/SKILL.md)。计划阶段分工、派发与续接、验收与纠偏都在那里，模板和路由按需读取该目录下的 references。不要另找或加载同名副本，本文不重复这些步骤。
