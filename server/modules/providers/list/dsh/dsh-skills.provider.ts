import os from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource,ProviderSkillListOptions } from '@/shared/types.js';

/** Exposes DSH's default directory-bundle skill roots to the existing skills UI. */
export class DshSkillsProvider extends SkillsProvider {
  constructor(private readonly configuration: DshConfigurationProvider) { super('dsh'); }

  async listSkills(options?: ProviderSkillListOptions) {
    const skills = await super.listSkills(options);
    // Neither ACP nor headless exposes native slash commands. Selecting a
    // listed skill inserts an ordinary instruction the agent can act on.
    return skills.map((skill) => ({ ...skill, command: `Use the skill at ${skill.sourcePath}` }));
  }

  protected async getSkillSources(workspace: string): Promise<ProviderSkillSource[]> {
    let root = path.resolve(workspace);
    let cursor = root;
    while (true) {
      try { await access(path.join(cursor, '.git')); root = cursor; break; } catch { /* Continue to the nearest repository root. */ }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const config = this.configuration.read();
    return [
      { scope: 'repo', rootDir: path.join(root, '.dsh', 'skills'), commandPrefix: '/' },
      { scope: 'repo', rootDir: path.join(root, '.agents', 'skills'), commandPrefix: '/' },
      { scope: 'user', rootDir: path.join(config.home, 'skills'), commandPrefix: '/' },
      { scope: 'user', rootDir: path.join(config.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'), commandPrefix: '/' },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return { scope: 'user', rootDir: path.join(this.configuration.read().home, 'skills'), commandPrefix: '/' };
  }
}
