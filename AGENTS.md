# Repository guidance

## Codex and dsh responsibilities

- Codex owns requirement analysis, solution design, task breakdown, review, and final acceptance.
- dsh performs concrete execution, including implementation, file changes, and necessary validation, according to Codex's plan and constraints.
- Codex must use the `$codex-dsh` workflow to delegate execution to dsh, review the actual changes and validation results, and return issues to dsh for rework before accepting the task.

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Branch maintenance: main into codex-app-server

The long-lived integration branch is `codex-app-server`. Design changes so future updates from `main` can be merged **into `codex-app-server`** with minimal conflicts and clear behavior.

- Before implementation, inspect the difference from `main` and identify shared files likely to change upstream. Keep provider additions in their owning directories; put DeepSeek Harness code in `server/modules/providers/list/dsh/`.
- Prefer small, additive changes to registries, capabilities, routes, shared contracts, and UI entry points. Reuse existing provider interfaces and normalized events. Add optional extension points only when required by real consumers, with existing providers retaining their behavior.
- Keep Codex-specific protocol and controls inside the Codex adapter. Do not copy Codex's implementation or broadly rename/refactor shared code just to add DSH. Do not combine provider work with unrelated formatting, file moves, cleanup, or dependency upgrades.
- Drive UI availability from actual provider capabilities. Unsupported plan, steer, history, permission, or model features must be reported explicitly rather than simulated as native support.
- Preserve upstream database migrations. Add incremental, compatible migrations for new provider constraints or state, preserving existing data, columns, and indexes.
- Separate provider implementation, necessary shared integration, and unrelated fixes into reviewable commits. Keep shared-file edits localized so upstream changes remain recognizable.
- After bringing `main` into this branch, reconcile its provider/runtime/UI changes with both Codex app-server and DSH behavior. Run the affected provider and shared-path regressions, plus the repository's applicable build, type, and lint checks.

See [DeepSeek Harness provider plan](docs/deepseek-harness-provider-plan.md) for the proposed scope, protocol limits, and implementation stages.

## DeepSeek Harness scope

The DSH provider supports ACP and headless transports only. Do not add a DSH SDK runtime, native steer, or native plan mode. Inputs submitted during a run use the existing application queue. Preserve the existing Codex features independently.
