import fs from "node:fs";
import path from "node:path";
import { WorkerService } from "../../server/service.js";
import { pluginRoot, tsxLoader } from "../helpers.js";

const root = process.argv[2]!;
const project = path.join(root, "project");
const data = path.join(root, "data");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(root, "home"), { recursive: true });
const service = new WorkerService({
  dataDirectory: data,
  environment: {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    DSH_HOME: path.join(root, "dsh-home"),
    PI_CODING_AGENT_DIR: path.join(root, "pi-home"),
    TEST_SESSION_ID: "session-harness",
    TEST_SCENARIO: "hangtree",
    TEST_CLI_PID_FILE: path.join(root, "cli.pid"),
    TEST_PID_FILE: path.join(root, "child.pid"),
  },
  executablePaths: {
    dsh: path.join(pluginRoot, "tests/fixtures/fake-dsh.mjs"),
    pi: path.join(pluginRoot, "tests/fixtures/fake-pi.mjs"),
  },
  guardianCommand: [process.execPath, "--import", tsxLoader, path.join(pluginRoot, "server/guardian.ts")],
  dshPatch: path.join(pluginRoot, "patches/dsh-session.patch.yml"),
});
service.registerOwner(
  {
    id: "harness-owner",
    parentSessionId: "harness-parent",
    projectId: "harness-project",
    projectPath: project,
    userId: 1,
    appServerInstanceId: "harness-app",
    paused: false,
  },
  "harness-token",
);
const started = await service.start("harness-owner", {
  taskName: "harness",
  type: "dsh",
  prompt: "run until killed",
  workspace: { mode: "existing" },
  writePaths: [],
  requestId: "harness-request",
});
const deadline = Date.now() + 15000;
while (
  !fs.existsSync(path.join(root, "cli.pid")) ||
  !fs.existsSync(path.join(root, "child.pid"))
) {
  if (Date.now() > deadline) throw new Error("fixture did not start");
  await new Promise((resolve) => setTimeout(resolve, 50));
}
process.stdout.write(
  JSON.stringify({
    ready: true,
    workerId: started.worker.id,
    runId: started.run.id,
    data,
  }) + "\n",
);
setInterval(() => {}, 1000);
