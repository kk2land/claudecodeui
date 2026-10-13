import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAppServerItem } from '@/modules/providers/list/codex/codex-app-server.events.js';
import { appendFilesInputTag } from '@/shared/index.js';

test('native user echoes restore attachment metadata without exposing the transport envelope', () => {
  const text = appendFilesInputTag('Read the file', [{ path: '/tmp/input.txt', name: 'input.txt', mimeType: 'text/plain' }]);
  const [message] = normalizeAppServerItem({ type: 'userMessage', id: 'item', clientId: 'queued-request',
    content: [{ type: 'text', text }, { type: 'localImage', path: '/tmp/picture.png' }] }, 'app', 'turn');
  assert.equal(message.id, 'queued-request');
  assert.equal(message.content, 'Read the file');
  assert.ok(Array.isArray(message.files));
  assert.ok(Array.isArray(message.images));
  assert.equal(message.files?.[0]?.path, '/tmp/input.txt');
  assert.equal(message.images?.[0]?.path, '/tmp/picture.png');
});

test('completed plans and file diffs close their tool cards using stable history identities', () => {
  const plan = normalizeAppServerItem({ type: 'plan', id: 'plan', text: 'Do these steps', completed: true }, 'app', 'turn');
  assert.deepEqual(plan.map((message) => message.kind), ['tool_use', 'tool_result']);
  assert.equal(plan[0].toolId, plan[1].toolId);
  const patch = normalizeAppServerItem({ type: 'fileChange', id: 'patch', completed: true, status: 'completed',
    changes: [{ path: '/tmp/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' }] }, 'app', 'turn');
  assert.equal(patch[0].toolId, 'patch#0');
  assert.deepEqual(patch[0].toolInput, { file_path: '/tmp/a.ts', old_string: 'old', new_string: 'new' });
  assert.equal(patch[1].toolId, 'patch#0');
  assert.equal(patch[1].isError, false);
});
