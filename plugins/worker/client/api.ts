import type {
  WorkerLogPage,
  WorkerLogStream,
  WorkerNotificationRetryInput,
  WorkerRecoverInput,
  WorkerRecord,
  WorkerRun,
  WorkerSettings,
  WorkerSettingsInput,
  WorkerCancelInput,
  WorkerStateQuery,
  WorkerStateSnapshot,
} from "../shared/contracts.js";

/** Host context handed to every plugin tab by `PluginTabContent`. */
export type WorkerPluginContext = {
  theme: "light" | "dark";
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};

/**
 * Authenticated host surface. The plugin only calls its own protected REST routes through this
 * bridge; it never receives the host UI token, the MCP token, or any other credential.
 */
export type WorkerHost = {
  context: WorkerPluginContext;
  onContextChange(
    callback: (context: WorkerPluginContext) => void,
  ): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
};

/** One worker plus its run history, as returned by `GET /workers/:workerId`. */
export type WorkerDetail = {
  worker: WorkerRecord;
  runs: WorkerRun[];
};

function statePath(query: WorkerStateQuery): string {
  const params = new URLSearchParams();
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.parentSessionId)
    params.set("parentSessionId", query.parentSessionId);
  const suffix = params.toString();
  return suffix ? "/state?" + suffix : "/state";
}

/**
 * Fixed client endpoints. Paths and payloads mirror the plugin's REST contract exactly so the
 * UI cannot drift into a plugin-private shape.
 */
export function workerApi(host: WorkerHost) {
  const request = <T>(method: string, path: string, body?: unknown) =>
    host.rpc(method, path, body) as Promise<T>;
  return {
    state: (query: WorkerStateQuery) =>
      request<WorkerStateSnapshot>("GET", statePath(query)),
    worker: (workerId: string) =>
      request<WorkerDetail>(
        "GET",
        "/workers/" + encodeURIComponent(workerId),
      ),
    logs: (
      workerId: string,
      runId: string | null,
      stream: WorkerLogStream,
      cursor: string | null,
      limit = 64 * 1024,
    ) => {
      const params = new URLSearchParams({ stream, limit: String(limit) });
      if (runId) params.set("runId", runId);
      if (cursor) params.set("cursor", cursor);
      return request<WorkerLogPage>(
        "GET",
        "/workers/" +
          encodeURIComponent(workerId) +
          "/logs?" +
          params.toString(),
      );
    },
    cancel: (input: WorkerCancelInput) =>
      request<{ workerIds?: string[] }>("POST", "/cancel", input),
    saveSettings: (input: WorkerSettingsInput) =>
      request<WorkerSettings>("PUT", "/settings", input),
    recover: (input: WorkerRecoverInput) =>
      request<unknown>("POST", "/recover", input),
    cleanup: (workerId: string) =>
      request<unknown>("POST", "/cleanup", { workerId }),
    retryNotifications: (input: WorkerNotificationRetryInput) =>
      request<unknown>("POST", "/notifications/retry", input),
  };
}
