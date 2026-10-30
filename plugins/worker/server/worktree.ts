import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WorkerFailure } from "./shared/index.js";
import type { WorkerRecord, WorkerStartWorkspace } from "./shared/index.js";

const run = promisify(execFile);

function inside(parent: string, child: string): boolean {
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await run("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new WorkerFailure(
      "GIT_FAILED",
      (failure.stderr || failure.message || "git 执行失败").trim(),
    );
  }
}

async function real(pathname: string): Promise<string> {
  try {
    return await fs.promises.realpath(pathname);
  } catch {
    throw new WorkerFailure("PATH_INVALID", "目录不存在或无法访问: " + pathname);
  }
}

/** Git worktree creation/validation and the narrow cleanup path required by the contract. */
export class WorkspaceManager {
  constructor(readonly dataDirectory: string) {}

  /** Resolves the declared workspace once at admission; existing directories are never created. */
  async resolve(
    workerId: string,
    projectPath: string,
    input: WorkerStartWorkspace,
  ): Promise<WorkerRecord["workspace"]> {
    if (input.mode === "existing")
      return {
        mode: "existing",
        path: await this.existingPath(projectPath, input.cwd),
      };
    const source = (await git(projectPath, ["rev-parse", "--show-toplevel"])).trim();
    if (!source)
      throw new WorkerFailure("NOT_A_REPOSITORY", "项目目录不是 Git 仓库");
    const sourceRoot = await real(source);
    const status = await git(sourceRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]);
    if (status.trim() && !input.allowDirtySource)
      throw new WorkerFailure(
        "DIRTY_SOURCE",
        "源仓库存在未提交改动；确认后使用 allowDirtySource=true",
      );
    const baseRef = input.baseRef?.trim() || "HEAD";
    const baseCommit = (
      await git(sourceRoot, ["rev-parse", "--verify", baseRef + "^{commit}"])
    ).trim();
    if (!baseCommit)
      throw new WorkerFailure("BASE_REF_INVALID", "无法解析 worktree 基线: " + baseRef);
    const target = path.join(this.dataDirectory, "worktrees", workerId);
    const branch = "cloudcli-worker/" + workerId;
    if (fs.existsSync(target))
      throw new WorkerFailure("WORKTREE_EXISTS", "worktree 目录已存在: " + target);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await git(sourceRoot, ["worktree", "add", "-b", branch, target, baseCommit]);
    } catch (error) {
      // A failed add must not leave a partial worktree reported as a usable worker.
      try {
        await git(sourceRoot, ["worktree", "remove", "--force", target]);
      } catch {
        /* a partial directory may remain for the operator; the run is still failed */
      }
      throw error;
    }
    return {
      mode: "worktree",
      path: await real(target),
      sourcePath: sourceRoot,
      baseCommit,
      createdByPlugin: true,
      branch,
    };
  }

  private async existingPath(projectPath: string, cwd?: string): Promise<string> {
    const requested = await real(cwd?.trim() ? cwd : projectPath);
    const stat = await fs.promises.stat(requested);
    if (!stat.isDirectory())
      throw new WorkerFailure("PATH_INVALID", "existing 工作目录不是目录");
    const root = await real(projectPath);
    if (requested === root || inside(root, requested)) return requested;
    let worktrees = "";
    try {
      worktrees = await git(root, ["worktree", "list", "--porcelain"]);
    } catch {
      worktrees = "";
    }
    const allowed = worktrees
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    for (const candidate of allowed) {
      try {
        const worktree = await fs.promises.realpath(candidate);
        if (worktree === requested || inside(worktree, requested)) return requested;
      } catch {
        /* deleted worktree entries cannot authorize a directory */
      }
    }
    throw new WorkerFailure(
      "PATH_NOT_ALLOWED",
      "existing 目录不属于项目或其 Git worktree",
    );
  }

  /** Removes only a plugin-created, clean, stopped worktree; branch, sessions and logs stay. */
  async cleanup(worker: WorkerRecord): Promise<void> {
    const workspace = worker.workspace;
    if (
      workspace.mode !== "worktree" ||
      !workspace.createdByPlugin ||
      !workspace.sourcePath
    )
      throw new WorkerFailure(
        "CLEANUP_NOT_ALLOWED",
        "只能清理插件创建且未清理的 worktree",
      );
    const managed = path.join(this.dataDirectory, "worktrees", worker.id);
    let managedStat: fs.Stats;
    try {
      managedStat = fs.lstatSync(managed);
    } catch {
      throw new WorkerFailure("WORKTREE_MISSING", "worktree 记录目录已不存在");
    }
    if (!managedStat.isDirectory() || managedStat.isSymbolicLink())
      throw new WorkerFailure(
        "CLEANUP_NOT_ALLOWED",
        "worktree 路径不是插件创建的普通目录",
      );
    let target: string;
    try {
      target = await fs.promises.realpath(workspace.path);
    } catch {
      throw new WorkerFailure("WORKTREE_MISSING", "worktree 目录已不存在");
    }
    let expected: string;
    try {
      expected = await fs.promises.realpath(managed);
    } catch {
      throw new WorkerFailure("WORKTREE_MISSING", "worktree 记录目录已不存在");
    }
    if (target !== expected)
      throw new WorkerFailure(
        "CLEANUP_NOT_ALLOWED",
        "worktree 路径不属于插件数据目录",
      );
    const status = await git(target, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]);
    if (status.trim())
      throw new WorkerFailure("WORKTREE_DIRTY", "worktree 有未提交改动，拒绝清理");
    const listed = await git(workspace.sourcePath, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const registered = listed
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .some((line) => path.resolve(line.slice("worktree ".length)) === target);
    if (!registered)
      throw new WorkerFailure("WORKTREE_MISSING", "worktree 未注册在源仓库");
    await git(workspace.sourcePath, ["worktree", "remove", target]);
  }
}
