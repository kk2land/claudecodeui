import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

test('SQLite statements survive allocation-driven garbage collection', () => {
  const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3');

  // Node 24.19+ headers added ObjectWrap cleanup hooks that abort during natural
  // GC in the v12 driver. Explicit global.gc() does not reproduce that failure.
  // Keep the native work in a child so a regression fails this test, not the runner.
  // https://github.com/nodejs/node/issues/65446
  const child = spawnSync(process.execPath, [
    '--max-semi-space-size=1',
    '--input-type=commonjs',
    '-e',
    `
      const assert = require('node:assert/strict');
      const Database = require(${JSON.stringify(sqliteModule)});
      const db = new Database(':memory:');
      let allocations = [];

      for (let i = 0; i < 100_000; i++) {
        assert.equal(db.prepare('SELECT ? AS value').get(i).value, i);
        allocations.push({ i, text: 'x'.repeat(1024) });
        if (allocations.length > 1000) allocations = [];
      }

      db.close();
      console.log('SQLite GC stress completed');
    `,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.ifError(child.error);
  assert.equal(
    child.status,
    0,
    `SQLite stress process failed (${child.signal ?? child.status}):\n${child.stderr}`,
  );
  assert.match(child.stdout, /SQLite GC stress completed/);
});
