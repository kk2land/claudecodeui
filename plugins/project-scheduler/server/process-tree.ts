import { execFile } from "node:child_process";

/** Used by workers and the scheduler to terminate only the process group created for a run. */
export function terminateTree(pid: number, force = false): void | Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        () => resolve(),
      );
    });
  } else {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
