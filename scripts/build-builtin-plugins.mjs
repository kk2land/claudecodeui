import { mkdir, chmod, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins/project-scheduler");
if (process.argv.includes("--if-missing")) {
  const ready = await Promise.all(
    ["client.js", "server.mjs", "worker.mjs", "agent-exec.mjs"].map((file) =>
      access(path.join(plugin, "dist", file)).then(
        () => true,
        () => false,
      ),
    ),
  );
  if (ready.every(Boolean)) process.exit(0);
}
const { build } = await import("esbuild");
await mkdir(path.join(plugin, "dist"), { recursive: true });
await build({
  entryPoints: {
    server: path.join(plugin, "server/entry.ts"),
    worker: path.join(plugin, "server/worker.ts"),
    "agent-exec": path.join(plugin, "server/agent-exec.ts"),
  },
  outdir: path.join(plugin, "dist"),
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node20",
  format: "esm",
  bundle: true,
  packages: "external",
});
await build({
  entryPoints: [path.join(plugin, "client/index.tsx")],
  outfile: path.join(plugin, "dist/client.js"),
  platform: "browser",
  target: "es2020",
  format: "esm",
  bundle: true,
  loader: { ".css": "text" },
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
await chmod(path.join(plugin, "dist/agent-exec.mjs"), 0o755);
