import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { CodexProviderId, ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  getCodexHome,
  findTopmostGitRoot,
} from '@/shared/utils.js';

/** Codex and GPT Web provider composition reuse this adapter with their own profile identity. */
export class CodexSkillsProvider extends SkillsProvider {
  constructor(private readonly codexProvider: CodexProviderId = 'codex') {
    super(codexProvider);
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.agents', 'skills'),
      commandPrefix: '$',
    });

    if (repoRoot) {
      // Codex checks repository skills at the launch folder, one folder above it,
      // and the topmost git root; these can collapse to the same directory.
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(path.dirname(workspacePath), '.agents', 'skills'),
        commandPrefix: '$',
      });
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.agents', 'skills'),
        commandPrefix: '$',
      });
    }

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(getCodexHome(this.codexProvider), 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'admin',
      rootDir: path.join('/etc', 'codex', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'system',
      rootDir: path.join(getCodexHome(this.codexProvider), 'skills', '.system'),
      commandPrefix: '$',
    });

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    };
  }
}
