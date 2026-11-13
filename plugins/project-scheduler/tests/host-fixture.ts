import type { ScheduledHost } from "../server/scheduler.js";

type ScheduledPrepare = {
  projectId: string;
  taskId: string;
  sessionId: string;
  executionId: string;
  nativeSessionId: string | null;
};

/**
 * Minimal in-memory stand-in for the host resident IPC used by scheduled prompt runs. It models
 * only the four scheduled-run actions: one binding per project/task, one prepared run per runId,
 * and it records every call in order so tests can assert prepare → attach → finish sequencing.
 */
export function fakeScheduledHost() {
  const calls: { action: string; payload: Record<string, any> }[] = [];
  const bindings = new Map<string, { sessionId: string; nativeSessionId: string }>();
  const runs = new Map<string, ScheduledPrepare>();
  const finished = new Set<string>();
  let counter = 0;
  const hooks: { [action: string]: (payload: any) => unknown } = {};
  const key = (projectId: string, taskId: string) => projectId + ":" + taskId;
  const request = (async (action: string, payload: any) => {
    calls.push({ action, payload });
    const hook = hooks[action];
    if (action === "scheduledPrepare") {
      const bound = payload.reuseSession
        ? bindings.get(key(payload.projectId, payload.taskId))
        : undefined;
      const defaults: ScheduledPrepare = {
        projectId: payload.projectId,
        taskId: payload.taskId,
        sessionId: bound?.sessionId ?? "session-" + ++counter,
        executionId: "execution-" + ++counter,
        nativeSessionId: bound?.nativeSessionId ?? null,
      };
      // A hook may delay or replace the answer but the run still becomes known to the host.
      const answer = hook ? await hook(payload) : undefined;
      runs.set(payload.runId, { ...defaults, ...(answer ?? {}) });
      return answer ?? {
        sessionId: defaults.sessionId,
        executionId: defaults.executionId,
        nativeSessionId: defaults.nativeSessionId,
      };
    }
    if (hook) return await hook(payload);
    if (action === "scheduledAttachNative") {
      const prepared = runs.get(payload.runId);
      if (!prepared) throw new Error("unknown run " + payload.runId);
      if (prepared.nativeSessionId && prepared.nativeSessionId !== payload.nativeSessionId)
        throw new Error("resumed run reported a different native session");
      prepared.nativeSessionId = payload.nativeSessionId;
      bindings.set(key(prepared.projectId, prepared.taskId), {
        sessionId: prepared.sessionId,
        nativeSessionId: payload.nativeSessionId,
      });
      return { sessionId: prepared.sessionId };
    }
    if (action === "scheduledFinishRun") {
      finished.add(payload.runId);
      return { finished: true };
    }
    if (action === "scheduledSyncTasks") return { released: 0 };
    throw new Error("unexpected action " + action);
  }) as ScheduledHost["request"];

  return {
    host: { request } as ScheduledHost,
    calls,
    runs,
    finished,
    hooks,
    requests(action: string) {
      return calls.filter((call) => call.action === action).map((call) => call.payload);
    },
  };
}
