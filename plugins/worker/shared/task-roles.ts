/**
 * The single catalog of Worker task roles shared by the Worker plugin, the Codex host bridge,
 * and the UI.
 *
 * A role describes the kind of execution work delegated to a Worker. Workers can research
 * solution options or review an existing plan; the parent session owns technical solution
 * decisions, architecture, and planning.
 *
 * This module is data and types only: importing it must never pull in plugin runtime code.
 */

/** Every task role a Worker can be started with; `value` is the stable API/UI value. */
export const WORKER_TASK_ROLES = [
  {
    value: "testing",
    label: "测试",
    description: "测试编写与执行、回归和验收。",
  },
  {
    value: "development",
    label: "开发",
    description: "功能实现、代码修改和问题修复。",
  },
  {
    value: "ui_design",
    label: "UI设计",
    description: "界面布局、视觉样式和交互设计。",
  },
  {
    value: "plan_research",
    label: "方案调研",
    description: "调研现状与可选方案，比较取舍并提供事实依据与建议。",
  },
  {
    value: "plan_review",
    label: "方案审核",
    description: "审核主会话已经产出的技术方案、架构和实施计划。",
  },
  {
    value: "code_review",
    label: "代码审核",
    description: "审查实现、缺陷和回归风险。",
  },
] as const;

/** A valid `WORKER_TASK_ROLES` value. */
export type WorkerTaskRole = (typeof WORKER_TASK_ROLES)[number]["value"];
