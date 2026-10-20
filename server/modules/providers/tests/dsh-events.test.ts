import assert from 'node:assert/strict';
import test from 'node:test';

import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';

const events = new DshEventsProvider();

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
