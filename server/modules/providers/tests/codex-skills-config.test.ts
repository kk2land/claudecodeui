import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const writeSkill = async (
  skillDirectory: string,
  name: string,
): Promise<string> => {
  await fs.mkdir(skillDirectory, { recursive: true });
  const skillPath = path.join(skillDirectory, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n\nBody.\n`,
    'utf8',
  );
  return skillPath;
};

const readConfigText = (codexHome: string): Promise<string> => (
  fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')
);

const readConfig = async (codexHome: string): Promise<Record<string, any>> => (
  TOML.parse(await readConfigText(codexHome)) as Record<string, any>
);

const skillConfigEntries = (config: Record<string, any>): Array<Record<string, any>> => (
  ((config.skills?.config ?? []) as Array<Record<string, any>>)
);

const writeConfig = async (codexHome: string, content: string): Promise<void> => {
  await fs.writeFile(path.join(codexHome, 'config.toml'), content, 'utf8');
};

/**
 * Every test gets its own CODEX_HOME plus a separate fake home so the user
 * `.agents/skills` root cannot read the machine's real files. The environment
 * is restored afterwards because provider adapters read it per call.
 */
async function withCodexHome(
  run: (context: { codexHome: string; homeDir: string }) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-skills-toggle-'));
  const codexHome = path.join(tempRoot, 'codex-home');
  const homeDir = path.join(tempRoot, 'home');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const restoreHomeDir = patchHomeDir(homeDir);

  try {
    await run({ codexHome, homeDir });
  } finally {
    restoreHomeDir();
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('codex skill toggle defaults to enabled and persists disable and re-enable', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'demo'), 'demo');
    const original = [
      'model = "gpt-5"',
      '',
      '[projects."/work/demo"]',
      'trust_level = "trusted"',
      '',
      '[features]',
      'goals = true',
      '',
    ].join('\n');
    await writeConfig(codexHome, original);

    const initial = await providerSkillsService.listProviderSkills('codex');
    assert.equal(initial.find((skill) => skill.name === 'demo')?.enabled, true);

    const disabled = await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });
    assert.deepEqual(disabled, { provider: 'codex', sourcePath: skillPath, enabled: false });

    // Appending is the only addition: the original prefix is byte-identical.
    assert.equal(
      await readConfigText(codexHome),
      `${original}[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n`,
    );
    const afterDisable = await readConfig(codexHome);
    assert.equal(afterDisable.model, 'gpt-5');
    assert.equal(afterDisable.projects?.['/work/demo']?.trust_level, 'trusted');
    assert.equal(afterDisable.features?.goals, true);
    assert.deepEqual(skillConfigEntries(afterDisable), [{ path: skillPath, enabled: false }]);

    // The disabled skill stays listed so the settings screen can switch it back on.
    const listedAfterDisable = await providerSkillsService.listProviderSkills('codex');
    assert.equal(listedAfterDisable.find((skill) => skill.name === 'demo')?.enabled, false);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: true,
    });
    const afterEnable = await readConfig(codexHome);
    assert.deepEqual(skillConfigEntries(afterEnable), [{ path: skillPath, enabled: true }]);
    const listedAfterEnable = await providerSkillsService.listProviderSkills('codex');
    assert.equal(listedAfterEnable.find((skill) => skill.name === 'demo')?.enabled, true);

    // Only the appended boolean token differs from the disabled state.
    assert.equal(
      await readConfigText(codexHome),
      `${original}[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = true\n`,
    );
  });
});

test('codex skill toggle rewrites only the target enabled token', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const targetSkill = await writeSkill(path.join(homeDir, '.agents', 'skills', 'alpha'), 'alpha');
    const otherSkill = await writeSkill(path.join(homeDir, '.agents', 'skills', 'beta'), 'beta');
    const original = [
      '# top comment stays',
      'model   =   "gpt-5"   # inline model comment',
      '',
      '[features]',
      '  goals = true',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(targetSkill)}`,
      'enabled = true   # keep this comment',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(otherSkill)}`,
      'enabled=true',
      '',
      '[projects."/work/demo"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');

    await writeConfig(codexHome, original);
    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: targetSkill,
      enabled: false,
    });

    const expected = original.replace(
      'enabled = true   # keep this comment',
      'enabled = false   # keep this comment',
    );
    assert.equal(await readConfigText(codexHome), expected);
    // The untouched sibling entry keeps its compact spelling and value.
    assert.ok(expected.includes('enabled=true\n'));
    assert.deepEqual(
      skillConfigEntries(await readConfig(codexHome)).map((entry) => entry.enabled),
      [false, true],
    );
  });
});

test('codex skill toggle preserves CRLF line endings', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'crlf'), 'crlf');
    const original = [
      '# comment',
      'model = "gpt-5"',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = true',
      '',
    ].join('\r\n');

    await writeConfig(codexHome, original);
    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });
    assert.equal(
      await readConfigText(codexHome),
      original.replace('enabled = true', 'enabled = false'),
    );

    // A document without entries appends with CRLF, not LF.
    await writeConfig(codexHome, ['model = "gpt-5"', 'enabled = true', ''].join('\r\n'));
    const otherSkill = await writeSkill(path.join(homeDir, '.agents', 'skills', 'extra'), 'extra');
    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: otherSkill,
      enabled: false,
    });
    const appended = await readConfigText(codexHome);
    assert.equal(
      appended,
      [
        'model = "gpt-5"',
        'enabled = true',
        '[[skills.config]]',
        `path = ${JSON.stringify(otherSkill)}`,
        'enabled = false',
        '',
      ].join('\r\n'),
    );
    // No lone LF anywhere: every line break stays CRLF.
    assert.equal(/[^\r]\n/.test(appended), false);
  });
});

test('codex skill toggle handles quoted and dotted header and key spellings', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'quoted'), 'quoted');
    const original = [
      '# quoted table header, dotted and quoted key',
      '[["skills" . \'config\']]',
      `path = ${JSON.stringify(skillPath)}`,
      '"enabled" = true',
      '',
    ].join('\n');

    await writeConfig(codexHome, original);
    // Confirm the parser agrees this is the same table and key.
    assert.deepEqual(skillConfigEntries(await readConfig(codexHome)), [
      { path: skillPath, enabled: true },
    ]);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });
    assert.equal(
      await readConfigText(codexHome),
      original.replace('"enabled" = true', '"enabled" = false'),
    );
  });
});

test('codex skill toggle ignores fake tables and enabled values inside multiline strings', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'real'), 'real');
    const original = [
      'notes = """',
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = true',
      '"""',
      '',
      "literal_notes = '''",
      '[[skills.config]]',
      'enabled = false',
      "'''",
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = true',
      '',
    ].join('\n');

    await writeConfig(codexHome, original);
    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });

    const updated = await readConfigText(codexHome);
    // The fake header and `enabled` inside both multiline strings keep their
    // bytes; only the real entry after them flips.
    assert.ok(updated.includes(`notes = """\n[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = true\n"""`));
    assert.ok(updated.includes("enabled = false\n'''"));
    const lastEnabled = original.lastIndexOf('enabled = true');
    assert.equal(updated, `${original.slice(0, lastEnabled)}enabled = false\n`);
    assert.deepEqual(skillConfigEntries(await readConfig(codexHome)), [
      { path: skillPath, enabled: false },
    ]);
  });
});

test('codex skill toggle appends without an entry and preserves a prefix with no trailing newline', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'append'), 'append');
    const prefix = 'model = "gpt-5"\n# trailing comment with no newline';
    await writeConfig(codexHome, prefix);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });

    const expected = `${prefix}\n[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n`;
    assert.equal(await readConfigText(codexHome), expected);
  });
});

test('codex skill toggle updates duplicate paths without deleting entries', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'dup'), 'dup');
    const otherSkill = await writeSkill(path.join(homeDir, '.agents', 'skills', 'other'), 'other');
    const original = [
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = true',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(otherSkill)}`,
      'enabled = true',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = true',
      '',
    ].join('\n');
    await writeConfig(codexHome, original);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });

    // All three entries remain, in order; only the two matching booleans change
    // and the unrelated middle entry keeps every byte.
    const expected = [
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = false',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(otherSkill)}`,
      'enabled = true',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = false',
      '',
    ].join('\n');
    assert.equal(await readConfigText(codexHome), expected);
    const entries = skillConfigEntries(await readConfig(codexHome));
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => entry.enabled), [false, true, false]);
    assert.equal(entries[1].path, otherSkill);

    const listed = await providerSkillsService.listProviderSkills('codex');
    assert.equal(listed.find((skill) => skill.name === 'dup')?.enabled, false);
    assert.equal(listed.find((skill) => skill.name === 'other')?.enabled, true);
  });
});

test('codex skill toggle twice restores the original bytes', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'roundtrip'), 'roundtrip');
    const original = [
      '# keep',
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = true # note',
      '',
      '[features]',
      'goals = true',
      '',
    ].join('\n');
    await writeConfig(codexHome, original);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });
    // `false` is one byte longer than `true`; the second edit must still land
    // on the right token because offsets are recomputed from the document.
    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: true,
    });
    assert.equal(await readConfigText(codexHome), original);
  });
});

test('codex skill toggle leaves the file untouched when the value already matches', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'same'), 'same');
    const original = [
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = true',
      '',
    ].join('\n');
    await writeConfig(codexHome, original);
    // Pin the mtime so a no-op write would be detectable even with identical bytes.
    const configPath = path.join(codexHome, 'config.toml');
    const pinned = new Date('2020-01-02T03:04:05.000Z');
    await fs.utimes(configPath, pinned, pinned);
    const before = await fs.stat(configPath);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: true,
    });

    const after = await fs.stat(configPath);
    assert.equal(await readConfigText(codexHome), original);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ino, before.ino);
  });
});

test('codex skill toggle preserves the config file permissions', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'private'), 'private');
    const configPath = path.join(codexHome, 'config.toml');
    await fs.writeFile(
      configPath,
      ['[[skills.config]]', `path = ${JSON.stringify(skillPath)}`, 'enabled = true', ''].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.chmod(configPath, 0o600);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });

    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  });
});

test('codex skill toggle creates a private config when none exists', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'fresh'), 'fresh');

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });

    assert.equal((await fs.stat(path.join(codexHome, 'config.toml'))).mode & 0o777, 0o600);
  });
});

test('codex skill toggles are serialized and preserve each other', { concurrency: false }, async () => {
  await withCodexHome(async ({ homeDir }) => {
    const firstSkill = await writeSkill(path.join(homeDir, '.agents', 'skills', 'first'), 'first');
    const secondSkill = await writeSkill(path.join(homeDir, '.agents', 'skills', 'second'), 'second');

    await Promise.all([
      providerSkillsService.setProviderSkillEnabled('codex', { sourcePath: firstSkill, enabled: false }),
      providerSkillsService.setProviderSkillEnabled('codex', { sourcePath: secondSkill, enabled: false }),
    ]);

    const listed = await providerSkillsService.listProviderSkills('codex');
    assert.equal(listed.find((skill) => skill.name === 'first')?.enabled, false);
    assert.equal(listed.find((skill) => skill.name === 'second')?.enabled, false);
  });
});

test('codex skill toggle matches symlinked skill paths', { concurrency: false }, async () => {
  await withCodexHome(async ({ homeDir }) => {
    const targetDirectory = path.join(homeDir, 'shared-skills', 'linked');
    await writeSkill(targetDirectory, 'linked');
    const skillsRoot = path.join(homeDir, '.agents', 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });
    const symlinkPath = path.join(skillsRoot, 'linked');
    await fs.symlink(targetDirectory, symlinkPath, 'dir');

    const listed = await providerSkillsService.listProviderSkills('codex');
    const linked = listed.find((skill) => skill.name === 'linked');
    assert.ok(linked);
    assert.equal(linked?.enabled, true);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: linked!.sourcePath,
      enabled: false,
    });

    const relisted = await providerSkillsService.listProviderSkills('codex');
    assert.equal(relisted.find((skill) => skill.name === 'linked')?.enabled, false);
  });
});

test('codex skill toggle preserves a symlinked config and rewrites its target', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'linked-config'), 'linked-config');
    // Users commonly keep the real config in a dotfiles repository and link it
    // into CODEX_HOME; replacing the link would silently detach that setup.
    const realConfigPath = path.join(homeDir, 'dotfiles', 'codex-config.toml');
    await fs.mkdir(path.dirname(realConfigPath), { recursive: true });
    const original = ['model = "gpt-5"', ''].join('\n');
    await fs.writeFile(realConfigPath, original, 'utf8');
    const configPath = path.join(codexHome, 'config.toml');
    await fs.symlink(realConfigPath, configPath, 'file');

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });

    // The link survives and still resolves to the same real file.
    assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true);
    assert.equal(await fs.realpath(configPath), await fs.realpath(realConfigPath));

    const updated = await fs.readFile(realConfigPath, 'utf8');
    assert.ok(updated.startsWith(original));
    assert.deepEqual(skillConfigEntries(await readConfig(codexHome)), [
      { path: skillPath, enabled: false },
    ]);
    // Only the documented table was appended to the real file.
    assert.equal(
      updated,
      `${original}[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n`,
    );
  });
});

test('codex skill toggle refuses a dangling config symlink and creates nothing', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'dangling'), 'dangling');
    const missingTarget = path.join(homeDir, 'dotfiles', 'missing-config.toml');
    const configPath = path.join(codexHome, 'config.toml');
    await fs.symlink(missingTarget, configPath, 'file');

    await assert.rejects(
      providerSkillsService.setProviderSkillEnabled('codex', { sourcePath: skillPath, enabled: false }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_SKILLS_CONFIG_UNSAFE',
    );

    // The link is untouched and no file was created at either location.
    assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true);
    await assert.rejects(fs.stat(missingTarget), { code: 'ENOENT' });
  });
});

test('codex skill toggle uses CODEX_HOME for discovery and config', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(codexHome, 'skills', 'home-skill'), 'home-skill');
    // A decoy in the fake home proves discovery follows CODEX_HOME.
    await writeSkill(path.join(homeDir, '.codex', 'skills', 'decoy'), 'decoy');

    const listed = await providerSkillsService.listProviderSkills('codex');
    assert.ok(listed.some((skill) => skill.name === 'home-skill'));
    assert.equal(listed.some((skill) => skill.name === 'decoy'), false);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });
    assert.deepEqual(skillConfigEntries(await readConfig(codexHome)), [
      { path: skillPath, enabled: false },
    ]);
  });
});

test('codex skill toggle refuses malformed or invalid config without overwriting it', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'guarded'), 'guarded');
    const configPath = path.join(codexHome, 'config.toml');

    const malformed = 'model = \n';
    await fs.writeFile(configPath, malformed, 'utf8');
    await assert.rejects(
      providerSkillsService.setProviderSkillEnabled('codex', { sourcePath: skillPath, enabled: false }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_SKILLS_CONFIG_INVALID',
    );
    await assert.rejects(
      providerSkillsService.listProviderSkills('codex'),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_SKILLS_CONFIG_INVALID',
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), malformed);

    const invalidEnabled = [
      '[[skills.config]]',
      `path = ${JSON.stringify(skillPath)}`,
      'enabled = "yes"',
      '',
    ].join('\n');
    await fs.writeFile(configPath, invalidEnabled, 'utf8');
    await assert.rejects(
      providerSkillsService.setProviderSkillEnabled('codex', { sourcePath: skillPath, enabled: true }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_SKILLS_CONFIG_INVALID',
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), invalidEnabled);
  });
});

test('codex skill toggle refuses to append into a closed inline skills table', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'closed'), 'closed');
    const configPath = path.join(codexHome, 'config.toml');
    // Valid TOML: `skills` is a closed inline table, so appending a
    // `[[skills.config]]` table would produce a document the parser rejects.
    const original = 'skills = {}\n';
    await fs.writeFile(configPath, original, 'utf8');

    await assert.rejects(
      providerSkillsService.setProviderSkillEnabled('codex', { sourcePath: skillPath, enabled: false }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_SKILLS_CONFIG_UNSAFE',
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), original);
  });
});

test('codex skill toggle refuses to append after a closed skills.config array', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'closed-array'), 'closed-array');
    const configPath = path.join(codexHome, 'config.toml');
    // `[skills] config = []` is valid, but appending `[[skills.config]]` would
    // try to extend a statically-closed array and fail to parse.
    const original = ['[skills]', 'config = []', ''].join('\n');
    await fs.writeFile(configPath, original, 'utf8');

    await assert.rejects(
      providerSkillsService.setProviderSkillEnabled('codex', { sourcePath: skillPath, enabled: false }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_SKILLS_CONFIG_UNSAFE',
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), original);
  });
});

test('codex skill toggle appends into an open [skills] table without config', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'open-table'), 'open-table');
    const original = ['[skills]', 'other = 1', ''].join('\n');
    await writeConfig(codexHome, original);

    await providerSkillsService.setProviderSkillEnabled('codex', {
      sourcePath: skillPath,
      enabled: false,
    });

    // This layout can be extended legally, so the append succeeds and the
    // prefix is untouched.
    const updated = await readConfigText(codexHome);
    assert.ok(updated.startsWith(original));
    assert.deepEqual(skillConfigEntries(await readConfig(codexHome)), [
      { path: skillPath, enabled: false },
    ]);
  });
});

test('codex skill toggle never rewrites layouts it cannot locate safely', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'inline'), 'inline');
    const configPath = path.join(codexHome, 'config.toml');
    const inlineArray = [
      '# an inline array is valid TOML this editor will not rewrite',
      `skills.config = [{ path = ${JSON.stringify(skillPath)}, enabled = true }]`,
      '',
    ].join('\n');
    await fs.writeFile(configPath, inlineArray, 'utf8');

    // The parser accepts the layout, but the localized editor cannot express
    // the change as a boolean-token replacement, so it must refuse and keep
    // the original bytes.
    assert.deepEqual(skillConfigEntries(await readConfig(codexHome)), [
      { path: skillPath, enabled: true },
    ]);
    await assert.rejects(
      providerSkillsService.setProviderSkillEnabled('codex', { sourcePath: skillPath, enabled: false }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_SKILLS_CONFIG_UNSAFE',
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), inlineArray);
  });
});

test('codex skill toggle validates the target file and the enabled flag', { concurrency: false }, async () => {
  await withCodexHome(async ({ codexHome, homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'valid'), 'valid');
    const plainFile = path.join(homeDir, 'notes.md');
    await fs.writeFile(plainFile, '# notes\n', 'utf8');

    const invalidInputs = [
      { sourcePath: '', enabled: false },
      { sourcePath: 'relative/SKILL.md', enabled: false },
      { sourcePath: path.join(homeDir, '.agents', 'skills', 'valid', 'OTHER.md'), enabled: false },
      { sourcePath: path.join(homeDir, 'missing', 'SKILL.md'), enabled: false },
      { sourcePath: plainFile, enabled: false },
    ];
    for (const input of invalidInputs) {
      await assert.rejects(
        providerSkillsService.setProviderSkillEnabled('codex', input),
        (error: unknown) => ['PROVIDER_SKILL_SOURCE_REQUIRED', 'PROVIDER_SKILL_SOURCE_INVALID'].includes(
          (error as { code?: string }).code ?? '',
        ),
        JSON.stringify(input),
      );
    }

    await assert.rejects(
      providerSkillsService.setProviderSkillEnabled('codex', {
        sourcePath: skillPath,
        enabled: 'false' as unknown as boolean,
      }),
      (error: unknown) => (error as { code?: string }).code === 'PROVIDER_SKILL_ENABLED_INVALID',
    );

    // None of the rejected attempts created a config file.
    await assert.rejects(
      fs.stat(path.join(codexHome, 'config.toml')),
      { code: 'ENOENT' },
    );
  });
});

test('providers without native skill enablement reject the toggle', { concurrency: false }, async () => {
  await withCodexHome(async ({ homeDir }) => {
    const skillPath = await writeSkill(path.join(homeDir, '.agents', 'skills', 'claude-skill'), 'claude-skill');
    await assert.rejects(
      providerSkillsService.setProviderSkillEnabled('claude', {
        sourcePath: skillPath,
        enabled: false,
      }),
      (error: unknown) => (error as { code?: string }).code === 'PROVIDER_SKILL_ENABLED_UNSUPPORTED',
    );
  });
});
