# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Branch maintenance: main into codex-app-server

The long-lived integration branch is `codex-app-server`. Design changes so future updates from `main` can be merged **into `codex-app-server`** with minimal conflicts and clear behavior.

- Before implementation, inspect the difference from `main` and identify shared files likely to change upstream. Keep provider code in its owning directory under `server/modules/providers/list/`.
- Prefer small, additive changes to registries, capabilities, routes, shared contracts, and UI entry points. Reuse existing provider interfaces and normalized events. Add optional extension points only when required by real consumers, with existing providers retaining their behavior.
- Keep Codex-specific protocol and controls inside the Codex adapter. Do not copy Codex's implementation or broadly rename/refactor shared code just to add a provider. Do not combine provider work with unrelated formatting, file moves, cleanup, or dependency upgrades.
- Drive UI availability from actual provider capabilities. Unsupported plan, steer, history, permission, or model features must be reported explicitly rather than simulated as native support.
- Preserve upstream database migrations. Add incremental, compatible migrations for new provider constraints or state, preserving existing data, columns, and indexes.
- Separate provider implementation, necessary shared integration, and unrelated fixes into reviewable commits. Keep shared-file edits localized so upstream changes remain recognizable.
- After bringing `main` into this branch, reconcile its provider/runtime/UI changes with Codex app-server behavior. Run the affected provider and shared-path regressions, plus the repository's applicable build, type, and lint checks.

## DeepSeek Harness (`dsh`) status

The `dsh` app provider was removed: no registry entry, capability row, chat or
settings entry, model catalog, auth check, MCP writer, skills, runtime controls,
session watcher, retention sweep or transcript reader remain, and its HTTP
endpoints answer `UNSUPPORTED_PROVIDER`. Do not reintroduce it without a new
agreed plan; the repository guidance that described its ACP/headless scope is
historical (see the git history of `server/modules/providers/list/dsh/`).

Stored `dsh` rows, transcripts, `provider_models` records,
`session_runtime_settings` rows and `$DSH_HOME` credentials must be preserved:
they stay in the database, are excluded from the session lists and draft
dispatch by the `RETIRED_SESSION_PROVIDERS` predicate, and are only ever archived
or deleted without touching their native files.

Two independent DSH paths remain and must keep working:

- The bundled Worker plugin keeps `dsh` only as a historical record type. Its
  workers, runs, notifications and native data stay in SQLite/disk untouched,
  but are hidden from every Worker list, history page and notification view.
  Queued DSH runs are skipped by admission and recovery, while new dispatch and
  resume are rejected with `WORKER_TYPE_UNSUPPORTED`. Executable Worker engines
  are Pi, Codex and agy.
- The project-scheduler plugin keeps `dsh` agent configuration readable. Native
  scheduled prompt sessions and resident tasks are Codex-only, so the host
  refuses a `dsh` job explicitly instead of starting a session it cannot read.

## Service restarts

- Codex may restart the `dev` service (`localhost:3000`) as needed for testing.
- Leave non-`dev` service restarts, including `tap` on port `3001`, to the user. Do not stop or restart those services during builds, deployment, or verification unless the user explicitly requests that specific restart.
- For non-`dev` deployments, prepare the code and build artifacts, then report that the build is ready for the user to restart the service. A general request to deploy does not authorize a non-`dev` restart.

## Local manual testing

Use this flow when a change needs to be verified in a real browser:

1. Codex runs `npm run build` from this repository and checks that it succeeds.
2. Codex runs these commands directly, in order, without asking the user to run them or confirm:
   - `/Users/agent/Projects/ops/cloudcli_init.sh 1`
   - `/Users/agent/Projects/ops/cloudcli.sh dev`
3. Codex confirms `http://localhost:3000` is ready and checks `/Users/agent/workspaces/tap/dev/cloudcli.log` for startup and plugin errors, then uses `$ego-browser` to open `http://localhost:3000` and verify the affected frontend functionality.

The `dev` command serves the existing build output in `dist-server/server/modules/cli/cli.js` using the home directory `/Users/agent/workspaces/tap/dev`, and starts it in the background with `nohup ... >$HOME/cloudcli.log 2>&1 &`. Run the startup commands in a persistent terminal session and keep that session open during testing; a short-lived execution can return successfully without leaving the background server running. If code changes during verification, Codex rebuilds, reruns both commands in order, confirms readiness, and then continues browser verification.

Codex can stop the service directly with `/Users/agent/Projects/ops/cloudcli.sh dev stop`. The `stop` command only waits for the running service to shut down; it does not restart it.

Credentials stay out of Git. The test username and password live in `.claude/local-testing.env` (untracked and gitignored) as `CLAUDECODEUI_TEST_USERNAME` and `CLAUDECODEUI_TEST_PASSWORD`; read them locally when you actually run a browser test. Never copy the password into tracked files or into this document.
