import type {
  PublicSchedulerSettings,
  SchedulerImport,
  SchedulerLog,
  SchedulerProject,
  SchedulerRun,
  SchedulerTask,
  SchedulerTaskRow,
} from "../shared/contracts.js";

/**
 * Client-side mirror of the project configuration document returned by the plugin backend.
 * The editor depends on these shapes only, never on unpublished backend-only types.
 */
export type SchedulerProjectConfig = {
  project: SchedulerProject;
  /** Raw JSON text from the file; an empty starter document when the file does not exist. */
  text: string;
  /** Opaque version token used for optimistic concurrency; null before the first write. */
  revision: string | null;
  exists: boolean;
  error?: string;
};
/** Draft-level effect of saving the current configuration text. */
export type SchedulerConfigChanges = {
  added: number;
  updated: number;
  removed: number;
  /** Temporarily disabled stored tasks that the saved file re-enables. */
  reEnabled: number;
};
/** One task's server-evaluated upcoming runs, using the task/project schedule settings. */
export type SchedulerConfigTaskPreview = {
  taskId: string;
  nextRuns: string[];
};
/** Dry-run validation of a draft; the server never writes a file while previewing. */
export type SchedulerConfigPreview = {
  valid: boolean;
  errors?: string[];
  tasks: SchedulerConfigTaskPreview[];
  changes: SchedulerConfigChanges;
};
/** Save result. Business failures are reported with HTTP 200 through flags. */
export type SchedulerConfigSaveResult = {
  saved: boolean;
  loaded: boolean;
  revision: string | null;
  changes: SchedulerConfigChanges;
  error?: string;
  conflict?: boolean;
  /** Newest file content when a revision conflict prevented the write. */
  latest?: SchedulerProjectConfig;
};

/**
 * One selectable model from the host provider catalog. It mirrors only the read-only catalog
 * fields the scheduler uses; effort levels are the provider's real configured levels.
 */
export type SchedulerModelOption = {
  value: string;
  label: string;
  description?: string;
  effort?: {
    default?: string;
    values: Array<{ value: string; description?: string }>;
  };
};
/** Provider model catalog as returned by the host's read-only models lookup. */
export type SchedulerModelCatalog = {
  DEFAULT: string;
  OPTIONS: SchedulerModelOption[];
};

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
  /**
   * Optional host catalog lookup. Older hosts do not expose it, so a missing method or a failed
   * request must read as "catalog unavailable" and leave authored values untouched.
   */
  models?(provider: "codex" | "dsh"): Promise<SchedulerModelCatalog>;
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
    setEnabled: (task: SchedulerTaskRow, enabled: boolean) =>
      request<{ success: boolean; enabled: boolean }>("PUT", "/tasks/enabled", {
        projectId: task.projectId,
        taskId: task.taskId,
        enabled,
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
    configuration: (projectId: string) =>
      request<SchedulerProjectConfig>(
        "GET",
        "/configuration?projectId=" + encodeURIComponent(projectId),
      ),
    previewConfiguration: (projectId: string, text: string) =>
      request<SchedulerConfigPreview>("POST", "/configuration/preview", {
        projectId,
        text,
      }),
    saveConfiguration: (
      projectId: string,
      text: string,
      revision: string | null,
    ) =>
      request<SchedulerConfigSaveResult>("POST", "/configuration/save", {
        projectId,
        text,
        revision,
      }),
  };
}
