// @ts-nocheck -- subprocess records are narrowed at the Plugins composition boundary.
import path from 'path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { scanPlugins, getPluginsConfig, getPluginDir } from './plugin-registry.service.js';
import { bundledPluginEnvironment, isBundledPlugin, syncBundledPluginContext } from './bundled-plugins.service.js';

// Map<pluginName, { process, port }>
const runningPlugins = new Map();
// Map<pluginName, Promise<port>> — in-flight start operations
const startingPlugins = new Map();
const restartTimers = new Map();
const stoppedPlugins = new Set();
// Host consumers (the Worker bridge) attach to a bundled plugin's IPC channel.
const messageListeners = new Map();
const exitListeners = new Map();
const readyListeners = new Map();
let shuttingDown = false;

function listenersFor(map, name) {
  let listeners = map.get(name);
  if (!listeners) {
    listeners = new Set();
    map.set(name, listeners);
  }
  return listeners;
}

/** Used by the Worker host bridge to send the fixed `cloudcli-workers` IPC envelopes. */
export function sendPluginMessage(name, message) {
  const entry = runningPlugins.get(name);
  if (!entry?.process?.connected) return false;
  try {
    entry.process.send(message);
    return true;
  } catch {
    return false;
  }
}

/** Used by the Worker host bridge to receive request/response and event envelopes. */
export function onPluginMessage(name, listener) {
  const listeners = listenersFor(messageListeners, name);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Used by the Worker host bridge to settle in-flight IPC requests when a plugin exits. */
export function onPluginExit(name, listener) {
  const listeners = listenersFor(exitListeners, name);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Used by the Worker host bridge to re-register owners after a managed builtin restarts. */
export function onPluginReady(name, listener) {
  const listeners = listenersFor(readyListeners, name);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(map, name, ...args) {
  for (const listener of map.get(name) ?? []) {
    try { listener(...args); } catch (error) { console.error(`[Plugins] "${name}" listener failed:`, error); }
  }
}

/**
 * Build the environment handed to a plugin server subprocess.
 *
 * Intentionally minimal: only non-secret essentials, never the host's full
 * environment. On Windows a handful of system variables are required for any
 * child to bootstrap (Node itself, and any Python or CLI a plugin shells out
 * to). Without APPDATA a `pip install --user` tool cannot locate its
 * site-packages and fails to import; SystemRoot, PATHEXT and TEMP are needed to
 * resolve system DLLs, executable extensions and a temp directory. None of
 * these carry secrets, so the ones that are set get passed straight through.
 */
function buildPluginEnv(name) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PLUGIN_NAME: name,
    ...bundledPluginEnvironment(name),
  };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

  if (process.platform === 'win32') {
    const WINDOWS_ESSENTIALS = [
      'SystemRoot', 'windir', 'SystemDrive',
      'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'TEMP', 'TMP', 'PATHEXT',
    ];
    for (const key of WINDOWS_ESSENTIALS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
  }

  return env;
}

/**
 * Start a plugin's server subprocess.
 * The plugin's server entry must print a JSON line with { ready: true, port: <number> }
 * to stdout within 10 seconds.
 */
export function startPluginServer(name, pluginDir, serverEntry) {
  if (shuttingDown) return Promise.reject(new Error('Host is shutting down'));
  stoppedPlugins.delete(name);
  if (runningPlugins.has(name)) {
    return Promise.resolve(runningPlugins.get(name).port);
  }

  // Coalesce concurrent starts for the same plugin
  if (startingPlugins.has(name)) {
    return startingPlugins.get(name);
  }

  const startPromise = new Promise((resolve, reject) => {

    const serverPath = path.join(pluginDir, serverEntry);

    const pluginProcess = spawn(process.execPath, [serverPath], {
      cwd: pluginDir,
      env: buildPluginEnv(name),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let resolved = false;
    let stdout = '';

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        pluginProcess.kill();
        reject(new Error('Plugin server did not report ready within 10 seconds'));
      }
    }, 10000);

    pluginProcess.on('message', (message) => {
      notify(messageListeners, name, message);
    });
    pluginProcess.stdout.on('data', (data) => {
      if (resolved) return;
      stdout += data.toString();

      // Look for the JSON ready line
      const lines = stdout.split('\n');
      for (const line of lines) {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.ready && typeof msg.port === 'number') {
            clearTimeout(timeout);
            resolved = true;
            runningPlugins.set(name, { process: pluginProcess, port: msg.port });
            const contextTimer = setInterval(() => {
              try { syncBundledPluginContext(name); } catch (error) { console.error('[Plugins] Project context unavailable:', error.message); }
            }, 5000);
            contextTimer.unref();

            pluginProcess.on('exit', () => {
              clearInterval(contextTimer);
              if (runningPlugins.get(name)?.process === pluginProcess) runningPlugins.delete(name);
              notify(exitListeners, name);
              // Every managed builtin restarts with the same bounded backoff. A
              // disabled or explicitly stopped plugin stays down.
              if (isBundledPlugin(name) && !runningPlugins.has(name)) scheduleRestart(name, pluginDir, serverEntry);
            });

            console.log(`[Plugins] Server started for "${name}" on port ${msg.port}`);
            notify(readyListeners, name, msg.port);
            resolve(msg.port);
          }
        } catch {
          // Not JSON yet, keep buffering
        }
      }
    });

    pluginProcess.stderr.on('data', (data) => {
      console.warn(`[Plugin:${name}] ${data.toString().trim()}`);
    });

    pluginProcess.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to start plugin server: ${err.message}`));
      }
    });

    pluginProcess.on('exit', (code) => {
      clearTimeout(timeout);
      if (runningPlugins.get(name)?.process === pluginProcess) runningPlugins.delete(name);
      if (!resolved) {
        resolved = true;
        notify(exitListeners, name);
        reject(new Error(`Plugin server exited with code ${code} before reporting ready`));
      }
    });
  }).finally(() => {
    startingPlugins.delete(name);
  });

  startingPlugins.set(name, startPromise);
  return startPromise;
}

/**
 * Stop a plugin's server subprocess.
 * Returns a Promise that resolves when the process has fully exited.
 */
export function stopPluginServer(name) {
  stoppedPlugins.add(name);
  clearTimeout(restartTimers.get(name));
  restartTimers.delete(name);
  if (startingPlugins.has(name)) return startingPlugins.get(name).catch(() => {}).then(() => stopPluginServer(name));
  const entry = runningPlugins.get(name);
  if (!entry) return Promise.resolve();

  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(forceKillTimer);
      if (runningPlugins.get(name)?.process === entry.process) runningPlugins.delete(name);
      resolve();
    };

    entry.process.once('exit', cleanup);

    entry.process.kill('SIGTERM');

    // Force kill after 5 seconds if still running
    const forceKillTimer = setTimeout(() => {
      if (runningPlugins.has(name)) {
        entry.process.kill('SIGKILL');
        cleanup();
      }
    }, 5000);

    console.log(`[Plugins] Server stopped for "${name}"`);
  });
}

/**
 * Get the port a running plugin server is listening on.
 */
export function getPluginPort(name) {
  return runningPlugins.get(name)?.port ?? null;
}

/**
 * Check if a plugin's server is running.
 */
export function isPluginRunning(name) {
  return runningPlugins.has(name);
}

/**
 * Stop all running plugin servers (called on host shutdown).
 */
export function stopAllPlugins() {
  shuttingDown = true;
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  const stops = [];
  for (const name of new Set([...runningPlugins.keys(), ...startingPlugins.keys()])) {
    stops.push(stopPluginServer(name));
  }
  return Promise.all(stops);
}

function scheduleRestart(name, directory, entry, delay = 1000) {
  if (shuttingDown || runningPlugins.has(name) || stoppedPlugins.has(name) || getPluginsConfig()[name]?.enabled === false) return;
  const timer = setTimeout(() => {
    restartTimers.delete(name);
    startPluginServer(name, directory, entry).catch(error => {
      console.error('[Plugins] Scheduler restart failed:', error.message);
      scheduleRestart(name, directory, entry, Math.min(delay * 2, 30000));
    });
  }, delay);
  timer.unref();
  restartTimers.set(name, timer);
}

/** Used by the Worker bridge and MCP proxy to honor the user's plugin enable switch. */
export function isPluginEnabled(name) {
  return getPluginsConfig()[name]?.enabled !== false;
}

/**
 * Ensure an enabled plugin's server is ready, starting it once when needed.
 * Used by the Worker bridge before registering an owner; the MCP proxy never
 * calls it, so an unauthenticated request cannot start a plugin.
 */
export async function ensurePluginServer(name) {
  if (shuttingDown) return null;
  const config = getPluginsConfig();
  if (config[name]?.enabled === false) return null;
  const plugin = scanPlugins().find((candidate) => candidate.name === name);
  if (!plugin?.server) return null;
  if (runningPlugins.has(name)) return runningPlugins.get(name).port;
  const directory = getPluginDir(name);
  if (!directory) return null;
  try {
    return await startPluginServer(name, directory, plugin.server);
  } catch (error) {
    console.error(`[Plugins] Could not start "${name}":`, error.message);
    return null;
  }
}

/**
 * Start servers for all enabled plugins that have a server entry.
 * Called once on host server boot.
 */
export async function startEnabledPluginServers() {
  const plugins = scanPlugins();
  const config = getPluginsConfig();

  for (const plugin of plugins) {
    if (!plugin.server) continue;
    if (config[plugin.name]?.enabled === false) continue;

    const pluginDir = getPluginDir(plugin.name);
    if (!pluginDir) continue;

    try {
      await startPluginServer(plugin.name, pluginDir, plugin.server);
    } catch (err) {
      console.error(`[Plugins] Failed to start server for "${plugin.name}":`, err.message);
    }
  }
}
