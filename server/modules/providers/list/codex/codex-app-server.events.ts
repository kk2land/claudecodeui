import type { AnyRecord, NormalizedMessage } from '@/shared/index.js';
import { createNormalizedMessage, unifiedDiffToTexts, parseFilesInputTag } from '@/shared/index.js';

/** Codex runtime uses this adapter for both progressive items and final item snapshots. */
export function normalizeAppServerItem(item: AnyRecord, sessionId: string, turnId: string): NormalizedMessage[] {
  const id = `codex:${turnId}:${String(item.id)}`;
  const base = { id, provider: 'codex' as const, sessionId, turnId };
  const make = (fields: AnyRecord) => createNormalizedMessage({ ...base, kind: 'text', ...fields });
  const tool = (fields: AnyRecord) => {
    const rows = [make({ kind: 'tool_use', toolId: String(item.id), ...fields })];
    if (item.completed) rows.push(make({ id: `${id}:result`, kind: 'tool_result', toolId: String(item.id), content: '', isError: item.status === 'failed' }));
    return rows;
  };
  const status = item.status === 'inProgress' ? 'in_progress' : item.status;
  switch (item.type) {
    case 'agentMessage':
      return [make({ role: 'assistant', content: item.text ?? '', model: item.model, isStreaming: !item.completed })];
    case 'userMessage': {
      const parsed = parseFilesInputTag((item.content ?? []).filter((part: AnyRecord) => part.type === 'text').map((part: AnyRecord) => part.text).join('\n'));
      return [make({
        id: item.clientId || id,
        clientMessageId: item.clientId,
        role: 'user',
        content: parsed.text,
        files: parsed.attachments.length ? parsed.attachments : undefined,
        images: (item.content ?? []).filter((part: AnyRecord) => part.type === 'localImage').map((part: AnyRecord) => ({ path: part.path })),
      })];
    }
    case 'functionCallOutput':
      return [make({ id: `${id}:result`, kind: 'tool_result', toolId: String(item.id),
        content: typeof item.output === 'string' ? item.output : (item.output ?? []).map((part: AnyRecord) => part.text ?? '').join('\n') })];
    case 'reasoning':
      return [make({ kind: 'thinking', content: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') })];
    case 'plan':
      return tool({ toolName: 'ExitPlanMode', toolInput: { plan: item.text ?? '' }, status });
    case 'commandExecution': {
      const rows = [make({ kind: 'tool_use', toolName: 'Bash', toolId: String(item.id), toolInput: { command: item.command }, status })];
      if (item.aggregatedOutput || item.completed) rows.push(make({
        id: `${id}:result`, kind: 'tool_result', toolId: String(item.id), content: item.aggregatedOutput ?? '',
        isError: status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
      }));
      return rows;
    }
    case 'fileChange':
      return (item.changes ?? []).flatMap((change: AnyRecord, index: number) => {
        const toolId = `${item.id}#${index}`;
        const { oldText, newText } = unifiedDiffToTexts(change.diff ?? '');
        const rows = [make({
          id: `${id}:${index}`, kind: 'tool_use', toolId,
          toolName: change.kind?.type === 'add' ? 'Write' : 'Edit', status,
          toolInput: { file_path: change.path, old_string: oldText, new_string: newText, ...(change.kind?.type === 'delete' ? { deleted: true } : {}) },
        })];
        if (item.completed) rows.push(make({ id: `${id}:${index}:result`, kind: 'tool_result', toolId, content: '', isError: status === 'failed' || status === 'declined' }));
        return rows;
      });
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const rows = [make({ kind: 'tool_use', toolId: String(item.id), toolName: item.server ? `mcp__${item.server}__${item.tool}` : item.tool, toolInput: item.arguments, status })];
      if (item.completed) rows.push(make({
        id: `${id}:result`, kind: 'tool_result', toolId: String(item.id),
        content: item.error ? String(item.error.message ?? item.error) : JSON.stringify(item.result ?? item.contentItems ?? ''),
        isError: Boolean(item.error) || item.success === false,
      }));
      return rows;
    }
    case 'webSearch':
      return tool({ toolName: 'WebSearch', toolInput: { query: item.query }, status });
    case 'collabAgentToolCall':
      return tool({ toolName: item.tool, toolInput: { prompt: item.prompt, agents: item.agentsStates }, status });
    case 'contextCompaction':
      return [make({ role: 'assistant', content: 'Context compacted', isCompactSummary: true, compact: { phase: item.completed ? 'done' : 'running' } })];
    default:
      return [];
  }
}
