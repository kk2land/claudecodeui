import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';
import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

/** Boots the provider router alone so the tests exercise transport parsing, not the app shell. */
async function withProviderServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-skills-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('skills enabled route persists Codex enablement and rejects invalid input', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-skills-enabled-'));
  const codexHome = path.join(tempRoot, 'codex-home');
  const skillDirectory = path.join(codexHome, 'skills', 'route-skill');
  const skillPath = path.join(skillDirectory, 'SKILL.md');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    skillPath,
    '---\nname: route-skill\ndescription: Route skill\n---\n\nBody.\n',
    'utf8',
  );

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    await withProviderServer(async (baseUrl) => {
      const updated = await fetch(`${baseUrl}/api/providers/codex/skills/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: skillPath, enabled: false }),
      });
      assert.equal(updated.status, 200);
      assert.deepEqual((await updated.json() as { data: unknown }).data, {
        provider: 'codex',
        sourcePath: skillPath,
        enabled: false,
      });

      const config = TOML.parse(await readFile(path.join(codexHome, 'config.toml'), 'utf8')) as {
        skills: { config: Array<{ path: string; enabled: boolean }> };
      };
      assert.deepEqual(config.skills.config, [{ path: skillPath, enabled: false }]);

      const invalidBodies = [
        [{ enabled: false }, 'PROVIDER_SKILL_SOURCE_REQUIRED'],
        [{ sourcePath: skillPath }, 'PROVIDER_SKILL_ENABLED_INVALID'],
        [{ sourcePath: skillPath, enabled: 'false' }, 'PROVIDER_SKILL_ENABLED_INVALID'],
        [{ sourcePath: 'relative/SKILL.md', enabled: false }, 'PROVIDER_SKILL_SOURCE_INVALID'],
      ] as const;
      for (const [body, code] of invalidBodies) {
        const response = await fetch(`${baseUrl}/api/providers/codex/skills/enabled`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.equal((await response.json() as { error: { code: string } }).error.code, code);
      }

      const unsupported = await fetch(`${baseUrl}/api/providers/claude/skills/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: skillPath, enabled: false }),
      });
      assert.equal(unsupported.status, 400);
      assert.equal(
        (await unsupported.json() as { error: { code: string } }).error.code,
        'PROVIDER_SKILL_ENABLED_UNSUPPORTED',
      );
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
