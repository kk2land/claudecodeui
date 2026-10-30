import { mkdir, chmod, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scheduler = path.join(root, "plugins/project-scheduler");
const worker = path.join(root, "plugins/worker");

const builtinPlugins = [
  {
    directory: scheduler,
    outputs: ["client.js", "server.mjs", "worker.mjs", "agent-exec.mjs"],
    serverEntryPoints: {
      server: path.join(scheduler, "server/entry.ts"),
      worker: path.join(scheduler, "server/worker.ts"),
      "agent-exec": path.join(scheduler, "server/agent-exec.ts"),
    },
    executable: "agent-exec.mjs",
  },
  {
    directory: worker,
    outputs: ["client.js", "server.mjs", "guardian.mjs"],
    serverEntryPoints: {
      server: path.join(worker, "server/entry.ts"),
      guardian: path.join(worker, "server/guardian.ts"),
    },
    executable: null,
  },
];

if (process.argv.includes("--if-missing")) {
  const ready = await Promise.all(
    builtinPlugins.flatMap((plugin) =>
      plugin.outputs.map((file) =>
        access(path.join(plugin.directory, "dist", file)).then(
          () => true,
          () => false,
        ),
      ),
    ),
  );
  if (ready.every(Boolean)) process.exit(0);
}

const { build } = await import("esbuild");

for (const plugin of builtinPlugins) {
  const outdir = path.join(plugin.directory, "dist");
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: plugin.serverEntryPoints,
    outdir,
    outExtension: { ".js": ".mjs" },
    platform: "node",
    target: "node20",
    format: "esm",
    bundle: true,
    packages: "external",
  });
  await build({
    entryPoints: [path.join(plugin.directory, "client/index.tsx")],
    outfile: path.join(outdir, "client.js"),
    platform: "browser",
    target: "es2020",
    format: "esm",
    bundle: true,
    loader: { ".css": "text" },
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (plugin.executable) await chmod(path.join(outdir, plugin.executable), 0o755);
}
