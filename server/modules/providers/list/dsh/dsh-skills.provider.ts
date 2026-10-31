import os from 'node:os';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import { findProviderSkillMarkdownFiles, parseFrontMatter, readObjectRecord } from '@/shared/index.js';
import type { ProviderSkill, ProviderSkillListOptions, ProviderSkillSource } from '@/shared/index.js';

const INVOCATION_BOOLEANS = new Set<unknown>([true, false, 1, 0, '1', '0', 'true', 'false', 'yes', 'no', 'on', 'off']);

/** Supplies the providers skills service with DSH's default roots and native /name invocations. */
export class DshSkillsProvider extends SkillsProvider {
  constructor(private readonly configuration: DshConfigurationProvider) { super('dsh'); }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const sources = await this.getSkillSources(path.resolve(options?.workspacePath ?? process.cwd()));
    const systemDirectory = path.join(this.configuration.read().home, 'skills', '.system');
    const skills: ProviderSkill[] = [];
    const registeredNames = new Set<string>();
    for (const source of sources) {
      for (const skillPath of await findProviderSkillMarkdownFiles(source.rootDir)) {
        if (path.dirname(skillPath) === systemDirectory) continue;
        try {
          const data = readObjectRecord(parseFrontMatter(await readFile(skillPath, 'utf8')).data);
          if (!data || typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)
            || typeof data.description !== 'string' || !data.description.length) continue;
          // Match native DSH's invocation frontmatter, including YAML-style
          // boolean strings. Invalid metadata never registers a gesture.
          if (['userInvocable', 'modelInvocable', 'disableModelInvocation'].some((key) => Object.hasOwn(data, key))) continue;
          const flags = [data['user-invocable'], data['disable-model-invocation']]
            .map((value) => typeof value === 'string' ? value.toLowerCase() : value);
          if (flags.some((value) => value !== undefined && !INVOCATION_BOOLEANS.has(value))) continue;
          if (registeredNames.has(data.name)) continue;
          // A model-only project skill still shadows a user skill of the same
          // name; offering the lower-priority /name would silently do nothing.
          registeredNames.add(data.name);
          if ([false, 0, '0', 'false', 'no', 'off'].some((value) => value === flags[0])) continue;
          skills.push({ provider: 'dsh', name: data.name, description: data.description,
            command: `/${data.name}`, scope: source.scope, sourcePath: skillPath });
        } catch { /* Native DSH also skips malformed or unreadable skill files. */ }
      }
    }
    return skills;
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
