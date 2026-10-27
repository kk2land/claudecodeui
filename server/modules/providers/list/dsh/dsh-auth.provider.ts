import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

import spawn from 'cross-spawn';
import { parse as parseYaml } from 'yaml';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';
import { probeCliVersion, readObjectRecord } from '@/shared/utils.js';

/** Reports executable availability and configured credentials without calling the model. */
export class DshAuthProvider implements IProviderAuth {
  constructor(private readonly configuration: DshConfigurationProvider) {}

  /** Provider CLI settings probe the configured executable without reading credentials. */
  checkInstalled(): CliVersionProbe {
    try {
      return probeCliVersion(this.configuration.read().bin);
    } catch {
      return { installed: false, exitCode: null, version: null };
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const base: ProviderAuthStatus = { installed: false, installedVersion: null, provider: 'dsh', authenticated: false, email: null, method: 'api_key' };
    try {
      const config = this.configuration.read();
      const installed = await new Promise<boolean>((resolve) => {
        const child = spawn(config.bin, ['--help'], { env: config.env, stdio: 'ignore' });
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 5000);
        child.once('error', () => { clearTimeout(timeout); resolve(false); });
        child.once('close', (code) => { clearTimeout(timeout); resolve(code === 0); });
      });
      if (!installed) return { ...base, error: 'DSH executable is unavailable. Install @deepseek-ai/dsh or set CLOUDCLI_DSH_BIN.' };
      base.installed = true;
      const variable = config.env.CLOUDCLI_DSH_AUTH_ENV || 'DEEPSEEK_API_KEY';
      let configured = false;
      if (config.mode === 'acp') {
        try {
          const credentials = readObjectRecord(parseYaml(await readFile(path.join(config.home, '.credentials.yaml'), 'utf8')));
          configured = Boolean(credentials?.refs?.[variable]);
          const account = credentials?.records?.['deepseek-account-platform/default'];
          if (config.env.CLOUDCLI_DSH_AUTH_ENV === undefined && account?.kind === 'grant' && typeof account.payload?.token === 'string' && account.payload.token) {
            configured = true;
            base.method = 'dsh_account';
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The DSH credential file could not be read or is invalid.'); }
      }
      if (!configured) {
        if (config.env[variable] !== undefined) configured = Boolean(config.env[variable]?.trim());
        else for (const directory of [process.cwd(), config.home]) {
          try {
            const values = parseEnv(await readFile(path.join(directory, '.env'), 'utf8'));
            if (Object.hasOwn(values, variable)) { configured = Boolean(values[variable]?.trim()); break; }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      return { ...base, authenticated: configured, ...(configured ? {} : { error: `Configure ${variable} for the DSH profile. The model runtime validates credentials when a task starts.` }) };
    } catch (error) { return { ...base, error: error instanceof Error ? error.message : 'DSH configuration could not be read.' }; }
  }
}
