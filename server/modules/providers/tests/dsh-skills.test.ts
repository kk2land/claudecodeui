import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshSkillsProvider } from '@/modules/providers/list/dsh/dsh-skills.provider.js';

test('DSH lists only native user-invocable skills and respects project shadowing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'repo'), home = path.join(root, 'home');
  await mkdir(path.join(workspace, '.git'), { recursive: true });
  const projectSkills = path.join(workspace, '.dsh', 'skills');
  const userSkills = path.join(home, 'skills');
  const fixtures = [
    [projectSkills, 'directory-name', 'name: native-name\ndescription: Valid native skill'],
    [projectSkills, 'missing-name', 'description: No explicit name'],
    [projectSkills, 'missing-description', 'name: missing-description'],
    [projectSkills, 'bad-name', 'name: Bad Skill\ndescription: Invalid native name'],
    [projectSkills, 'invalid-flag', 'name: invalid-flag\ndescription: Invalid policy\nuser-invocable: perhaps'],
    [projectSkills, 'legacy-flag', 'name: legacy-flag\ndescription: Unsupported field\nuserInvocable: true'],
    [projectSkills, 'model-only', 'name: model-only\ndescription: No direct invocation\nuser-invocable: false'],
    [projectSkills, 'manual-only', 'name: manual-only\ndescription: Direct invocation allowed\ndisable-model-invocation: true'],
    [userSkills, 'shadowed', 'name: model-only\ndescription: Lower priority user skill'],
    [userSkills, '.system', 'name: internal\ndescription: DSH ignores this directory'],
    [userSkills, 'user-valid', 'name: user-valid\ndescription: Available globally\nuser-invocable: yes'],
    ...['false', 'no', 'off', '0'].map((value) => [projectSkills, `disabled-${value}`,
      `name: disabled-${value}\ndescription: No direct invocation\nuser-invocable: "${value}"`]),
  ];
  for (const [directory, name, metadata] of fixtures) {
    const bundle = path.join(directory, name);
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, 'SKILL.md'), `---\n${metadata}\n---\nSkill instructions.\n`);
  }
  const provider = new DshSkillsProvider(new DshConfigurationProvider({ DSH_HOME: home, DSH_AGENTS_HOME: path.join(root, 'shared') }));
  const skills = await provider.listSkills({ workspacePath: workspace });
  assert.deepEqual(skills.map((skill) => skill.command).sort(), ['/manual-only', '/native-name', '/user-valid']);
  assert.equal(skills.find((skill) => skill.name === 'native-name')?.sourcePath, path.join(projectSkills, 'directory-name', 'SKILL.md'));
});
