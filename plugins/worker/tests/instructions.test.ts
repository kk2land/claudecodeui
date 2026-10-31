import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const pluginDirectory = fileURLToPath(new URL('..', import.meta.url));
const start = '<!-- cloudcli-workers:start -->';
const end = '<!-- cloudcli-workers:end -->';

for (const provider of ['codex', 'dsh']) {
  test(`${provider} instructions install once and update only the managed block after relocation`, { skip: process.platform === 'win32' }, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker instructions-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const targetDirectory = path.join(root, `${provider} home`);
    const agentsFile = path.join(targetDirectory, 'AGENTS.md');
    const environment = {
      ...process.env,
      CODEX_HOME: path.join(root, 'codex home'),
      DSH_HOME: path.join(root, 'dsh home'),
    };
    const entry = `install-${provider}-instructions.sh`;
    execFileSync('sh', [path.join(pluginDirectory, entry)], { env: environment });
    const installed = readFileSync(agentsFile, 'utf8');
    assert.ok(installed.includes(path.join(pluginDirectory, 'CLOUDCLI-WORKERS.md')));
    assert.equal(installed.split(start).length - 1, 1);

    const before = '# Existing rules\nPreserve `literal` $text.\n\n';
    const after = '\nKeep the project instructions.\n';
    writeFileSync(agentsFile, before + installed + after);
    execFileSync('sh', [path.join(pluginDirectory, entry)], { env: environment });
    assert.equal(readFileSync(agentsFile, 'utf8'), before + installed + after);

    const relocated = path.join(root, 'moved plugin');
    mkdirSync(relocated);
    for (const file of [entry, 'install-instructions.sh', 'CLOUDCLI-WORKERS.md']) {
      copyFileSync(path.join(pluginDirectory, file), path.join(relocated, file));
    }
    execFileSync('sh', [path.join(relocated, entry)], { env: environment });
    const updated = readFileSync(agentsFile, 'utf8');
    assert.equal(updated, before + installed.replace(pluginDirectory.replace(/\/$/, ''), relocated) + after);
    assert.equal(updated.split(start).length - 1, 1);
    assert.equal(updated.split(end).length - 1, 1);
  });

  test(`${provider} instructions leave a malformed existing block untouched`, { skip: process.platform === 'win32' }, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-instructions-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const agentsFile = path.join(root, 'AGENTS.md');
    const original = `# Keep my rules\n${start}\nUnclosed reference\n`;
    writeFileSync(agentsFile, original);
    const result = spawnSync('sh', [path.join(pluginDirectory, `install-${provider}-instructions.sh`)], {
      env: { ...process.env, CODEX_HOME: root, DSH_HOME: root }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /start marker without end marker/);
    assert.equal(readFileSync(agentsFile, 'utf8'), original);
  });
}
