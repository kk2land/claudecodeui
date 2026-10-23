# Repository guidance

## Disabled skills

- A skill's disabled state takes precedence over any instruction in this file or other repository documents to use that skill, including `$codex-dsh`.
- Never load or use a disabled skill. Do not search for another copy, read its `SKILL.md`, or run its bundled scripts to bypass the disabled state.
- If a required skill is disabled, complete the task directly using the available tools and the applicable repository standards.

## Codex and dsh responsibilities

- Codex owns requirement analysis, solution design, task breakdown, review, and final acceptance.
- dsh performs concrete execution, including implementation, file changes, and necessary validation, according to Codex's plan and constraints.
- When `$codex-dsh` is enabled, Codex must use its workflow to delegate execution to dsh, review the actual changes and validation results, and return issues to dsh for rework before accepting the task. When it is disabled, Codex performs the execution directly.

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

## Local manual testing

Use this flow when a change needs to be verified in a real browser. Run the steps in order, from this repository:

1. `/Users/agent/Projects/ops/init_claudecodeui.sh 1`
2. `/Users/agent/Projects/ops/cloudcli.sh dev`

Open `http://localhost:3000` for manual testing. The `dev` command serves the existing build output in `dist-server/server/modules/cli/cli.js` and runs in the foreground, so keep that terminal open for as long as you are testing; if you change code, rebuild so the served artifacts match the source.

Credentials stay out of Git. The test username and password live in `.claude/local-testing.env` (untracked and gitignored) as `CLAUDECODEUI_TEST_USERNAME` and `CLAUDECODEUI_TEST_PASSWORD`; read them locally when you actually run a browser test. Never copy the password into tracked files or into this document.
