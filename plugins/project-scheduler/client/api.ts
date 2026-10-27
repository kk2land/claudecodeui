import type {
  PublicSchedulerSettings,
  SchedulerImport,
  SchedulerLog,
  SchedulerProject,
  SchedulerRun,
  SchedulerTask,
  SchedulerTaskRow,
} from "../shared/contracts.js";

/** Host plugin contract. Only the authenticated RPC bridge talks to the local backend. */
export type SchedulerHost = {
  context: {
    theme: "light" | "dark";
    project: { name: string; path: string } | null;
  };
  onContextChange(
    callback: (context: SchedulerHost["context"]) => void,
  ): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
};

/** Client endpoints centralized for the plugin's components and polling hooks. */
export function schedulerApi(host: SchedulerHost) {
  const request = <T>(method: string, path: string, body?: unknown) =>
    host.rpc(method, path, body) as Promise<T>;
  return {
    tasks: () => request<{ tasks: SchedulerTaskRow[] }>("GET", "/tasks"),
    projects: () =>
      request<{ projects: SchedulerProject[] }>("GET", "/projects"),
    settings: () => request<PublicSchedulerSettings>("GET", "/settings"),
    saveSettings: (body: unknown) =>
      request<PublicSchedulerSettings>("PUT", "/settings", body),
    testAlert: () =>
      request<{ success: boolean }>("POST", "/settings/telegram/test"),
    load: (
      projectIds: string[] | undefined,
      removeMissing: boolean,
      apply: boolean,
    ) =>
      request<{ results: SchedulerImport[] }>("POST", "/load", {
        projectIds,
        removeMissing,
        apply,
      }),
    run: (task: SchedulerTaskRow) =>
      request<{ run: SchedulerRun }>("POST", "/run", {
        projectId: task.projectId,
        taskId: task.taskId,
      }),
    stop: (id: string) =>
      request<{ success: boolean }>(
        "POST",
        "/runs/" + encodeURIComponent(id) + "/stop",
      ),
    runs: (task: Pick<SchedulerTaskRow, "projectId" | "taskId">) =>
      request<{ runs: SchedulerRun[] }>(
        "GET",
        "/runs?projectId=" +
          encodeURIComponent(task.projectId) +
          "&taskId=" +
          encodeURIComponent(task.taskId),
      ),
    log: (id: string, stream: string, offset: number) =>
      request<SchedulerLog>(
        "GET",
        "/runs/" +
          encodeURIComponent(id) +
          "/log?stream=" +
          stream +
          "&offset=" +
          offset,
      ),
    snapshot: (id: string) =>
      request<{ run: SchedulerRun; task: SchedulerTask | null }>(
        "GET",
        "/runs/" + encodeURIComponent(id),
      ),
  };
}
