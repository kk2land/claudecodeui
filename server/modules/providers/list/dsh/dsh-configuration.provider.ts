import os from 'node:os';
import path from 'node:path';

import type { DshConfiguration } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Supplies launch snapshots to DSH facets without changing the server environment. */
export class DshConfigurationProvider {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  get sessionsRoot(): string {
    const home = path.resolve(this.environment.DSH_HOME || path.join(os.homedir(), '.dsh'));
    return path.resolve(this.environment.CLOUDCLI_DSH_SESSIONS_DIR || path.join(home, 'sessions'));
  }

  read(): DshConfiguration {
    const env = { ...this.environment };
    const mode = env.CLOUDCLI_DSH_RUNTIME || 'acp';
    if (mode !== 'acp' && mode !== 'headless') {
      throw new AppError('CLOUDCLI_DSH_RUNTIME must be acp or headless.', { code: 'DSH_CONFIG_INVALID', statusCode: 400 });
    }
    let patches: unknown = [];
    try { patches = JSON.parse(env.CLOUDCLI_DSH_PATCHES || '[]'); } catch {
      throw new AppError('CLOUDCLI_DSH_PATCHES must be a JSON array of file paths.', { code: 'DSH_CONFIG_INVALID', statusCode: 400 });
    }
    if (!Array.isArray(patches) || !patches.every((value) => typeof value === 'string' && value.trim())) {
      throw new AppError('CLOUDCLI_DSH_PATCHES must contain non-empty file paths.', { code: 'DSH_CONFIG_INVALID', statusCode: 400 });
    }
    const home = path.resolve(env.DSH_HOME || path.join(os.homedir(), '.dsh'));
    const milliseconds = (name: string, fallback: number) => {
      const value = env[name] === undefined ? fallback : Number(env[name]);
      if (!Number.isSafeInteger(value) || value < 100) throw new Error(`${name} must be at least 100 milliseconds.`);
      return value;
    };
    return {
      mode, bin: env.CLOUDCLI_DSH_BIN || 'dsh', home,
      sessionsRoot: this.sessionsRoot,
      patches: patches.map((value: string) => path.resolve(value)),
      env: { ...env, DSH_HOME: home },
      timeoutMs: milliseconds('CLOUDCLI_DSH_TIMEOUT_MS', 30_000),
      idleMs: milliseconds('CLOUDCLI_DSH_IDLE_MS', 300_000),
    };
  }
}
