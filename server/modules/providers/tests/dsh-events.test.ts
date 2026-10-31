import assert from 'node:assert/strict';
import test from 'node:test';

import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { appendFilesInputTag, appendImagesInputTag } from '@/shared/image-attachments.js';

const events = new DshEventsProvider();

for (const prompt of ['Describe the image.', '']) {
  test(`DSH history restores image attachments with ${prompt ? 'text and files' : 'an image-only message'}`, () => {
    const images = [{ path: '/uploads/screen shot.png', name: '截图.png' }, { path: '/uploads/second.webp', name: 'second.webp' }];
    const files = prompt ? [{ path: '/uploads/notes.txt', name: 'notes.txt' }] : [];
    const text = appendFilesInputTag(appendImagesInputTag(prompt, images), files);
    const rows = events.normalize({ type: 'user/message', data: { content: [{ type: 'text', text }] } }, 'session-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'user');
    assert.equal(rows[0].content, prompt);
    assert.deepEqual(rows[0].images, images);
    assert.deepEqual(rows[0].files ?? [], files);
  });
}

test('DSH does not interpret assistant text as uploaded images', () => {
  const text = appendImagesInputTag('Example', ['/uploads/example.png']);
  const rows = events.normalize({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }, 'session-1');
  assert.equal(rows[0].content, text);
  assert.equal(rows[0].images, undefined);
});

for (const { name, event, content, isError } of [
  { name: 'headless output', event: { type: 'tool_result', callId: 'tool-1', status: 'completed', result: 'file contents' }, content: 'file contents', isError: false },
  { name: 'headless failure', event: { type: 'tool_result', callId: 'tool-1', status: 'error', result: 'Access denied' }, content: 'Access denied', isError: true },
  { name: 'headless empty output', event: { type: 'tool_result', callId: 'tool-1', status: 'completed' }, content: '', isError: false },
  { name: 'headless structured output', event: { type: 'tool_result', callId: 'tool-1', result: { files: ['README.md'] } }, content: '{\n  "files": [\n    "README.md"\n  ]\n}', isError: false },
  { name: 'ACP output', event: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }] } }, content: 'file contents', isError: false },
  { name: 'ACP failure', event: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed', rawOutput: 'Access denied' } }, content: 'Access denied', isError: true },
  { name: 'native history output', event: { type: 'tool/result', data: { message: { toolCallId: 'tool-1', content: [{ type: 'text', text: 'file contents' }], isError: false } } }, content: 'file contents', isError: false },
  { name: 'native history failure', event: { type: 'tool/result', data: { message: { toolCallId: 'tool-1', content: [{ type: 'text', text: 'Access denied' }], isError: true } } }, content: 'Access denied', isError: true },
]) {
  test(`DSH ${name} uses the flat tool-result contract consumed by the transcript`, () => {
    const rows = events.normalize(event, 'session-1');
    assert.equal(rows.length, 1);
    const [result] = rows;
    assert.equal(result.kind, 'tool_result');
    assert.equal(result.toolId, 'tool-1');
    assert.equal(result.content, content);
    assert.equal(result.isError, isError);
  });
}

test('DSH ACP usage_update becomes the authoritative context token budget', () => {
  const [message] = events.normalize({
    sessionId: 'native-1',
    update: { sessionUpdate: 'usage_update', used: 66_408, size: 1_000_000 },
  }, 'app-1');

  assert.equal(message.kind, 'status');
  assert.equal(message.text, 'token_budget');
  assert.equal(message.provider, 'dsh');
  assert.equal(message.sessionId, 'app-1');
  assert.deepEqual(message.tokenBudget, { used: 66_408, total: 1_000_000 });
});

test('DSH ACP usage_update drops malformed or incomplete readings', () => {
  for (const update of [
    { sessionUpdate: 'usage_update', used: -1, size: 1_000 },
    { sessionUpdate: 'usage_update', used: 1.5, size: 1_000 },
    { sessionUpdate: 'usage_update', used: '10', size: 1_000 },
    { sessionUpdate: 'usage_update', used: 10, size: 0 },
    { sessionUpdate: 'usage_update', used: 10, size: -5 },
    { sessionUpdate: 'usage_update', used: 10 },
    { sessionUpdate: 'usage_update', size: 1_000 },
  ]) {
    assert.deepEqual(events.normalize({ update }, 'app-1'), []);
  }
});

for (const { name, source } of [
  { name: 'initial', source: { kind: 'skill-catalog', form: 'catalog', entries: [] } },
  { name: 'updated', source: { kind: 'skill-catalog', form: 'catalog', update: true, entries: [] } },
  { name: 'invoked instructions', source: { kind: 'skill-invocation', name: 'review-worker', form: 'instructions' } },
]) {
  test(`DSH drops ${name} skill context messages without taking the prompt shape into account`, () => {
    const text = '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n\n<available_skills>\n- `demo`: Demo\n</available_skills>\n</system-reminder>';
    const rows = events.normalize({ type: 'user/message', data: { role: 'user', source, content: [{ type: 'text', text }] } }, 'session-1');
    assert.deepEqual(rows, []);
  });
}

test('DSH preserves genuine user and assistant turns whose text resembles the skill catalog', () => {
  const text = '<system-reminder>A skill is a reusable set of task-specific instructions.<available_skills></available_skills></system-reminder>';
  const [user] = events.normalize({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }, 'session-1');
  assert.equal(user.role, 'user');
  assert.equal(user.content, text);
  const [assistant] = events.normalize({ type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } } }, 'session-1');
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, text);
  const [tool] = events.normalize({ type: 'tool/result', data: { message: { toolCallId: 'tool-1', content: [{ type: 'text', text }], isError: false } } }, 'session-1');
  assert.equal(tool.kind, 'tool_result');
  assert.equal(tool.content, text);
});
