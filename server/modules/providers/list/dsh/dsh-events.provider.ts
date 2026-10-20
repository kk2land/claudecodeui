import { randomUUID } from 'node:crypto';

import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord } from '@/shared/utils.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';

/** Normalizes ACP updates, headless events, and decoded native DSH history. */
export class DshEventsProvider {
  normalize(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const record = readObjectRecord(raw);
    if (!record) return [];
    const event = record.update ?? record;
    const data = event.data ?? {};
    const type = event.sessionUpdate ?? event.type;
    const baseId = event.seq !== undefined ? `dsh:${sessionId}:${event.seq}` : record.id ?? `dsh:${randomUUID()}`;
    const make = (fields: AnyRecord): NormalizedMessage => createNormalizedMessage({
      id: baseId, provider: 'dsh', sessionId, timestamp: event.time ? new Date(event.time).toISOString() : undefined,
      kind: 'text', role: 'assistant', ...fields,
    });
    const text = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('') : '';
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      const value = event.content?.type === 'text' ? event.content.text : '';
      return value ? [make({ kind: type === 'agent_thought_chunk' ? 'thinking' : 'text', content: value })] : [];
    }
    if (type === 'text' || type === 'thinking') return event.text ? [make({ kind: type === 'thinking' ? 'thinking' : 'text', content: event.text })] : [];
    if (type === 'user/message' || type === 'assistant/message') {
      const message = type === 'user/message' ? data : data.message;
      if (message?.source?.kind === 'runtime-context') return [];
      return (message?.content ?? []).flatMap((block: AnyRecord, index: number) => {
        // Tool calls are surface blocks of the assistant message. The separate
        // tool/call lifecycle event is not part of the visible history fold.
        if (block.type === 'tool-call') {
          let input = block.arguments;
          try { input = JSON.parse(input); } catch { /* Preserve malformed model arguments as opaque input. */ }
          return [make({ id: `dsh:${sessionId}:tool:${block.id}:call`, kind: 'tool_use',
            toolId: block.id, toolName: block.name, toolInput: input })];
        }
        if (block.type !== 'text' && block.type !== 'reasoning') return [];
        const parsed = type === 'user/message' ? parseFilesInputTag(block.text ?? '') : { text: block.text ?? '', attachments: [] };
        const images = type === 'user/message' ? parseImagesInputTag(parsed.text) : { text: parsed.text, attachments: [] };
        return [make({ id: `${baseId}:${index}`, kind: block.type === 'reasoning' ? 'thinking' : 'text', role: type === 'user/message' ? 'user' : 'assistant', content: images.text,
          ...(images.attachments.length ? { images: images.attachments } : {}),
          ...(parsed.attachments.length ? { files: parsed.attachments } : {}) })];
      });
    }
    if (type === 'tool_call' || type === 'tool_call_update' || type === 'tool/call' || type === 'tool/result' || type === 'tool_result') {
      const toolId = event.toolCallId ?? event.callId ?? data.callId ?? data.message?.toolCallId ?? baseId;
      const result = type === 'tool/result' ? text(data.message?.content) : event.result ?? event.rawOutput
        ?? (Array.isArray(event.content) ? event.content.map((entry: AnyRecord) => text(entry.content ? [entry.content] : [])).join('\n') : undefined);
      const toolName = event.tool ?? event.title ?? data.name ?? 'Tool';
      const resultOnly = type === 'tool_result' || type === 'tool/result'
        || type === 'tool_call_update' && ['completed', 'failed', 'cancelled'].includes(event.status);
      const resultText = typeof result === 'string' ? result : result === undefined ? '' : JSON.stringify(result, null, 2);
      return [make({ id: `dsh:${sessionId}:tool:${toolId}:${resultOnly ? 'result' : 'call'}`, kind: resultOnly ? 'tool_result' : 'tool_use',
        toolId, toolName, toolInput: event.rawInput ?? event.input ?? data.arguments ?? {},
        // Standalone tool_result rows use flat fields; nested toolResult is for tool_use snapshots.
        ...(resultOnly ? { content: resultText, isError: event.status === 'failed' || event.status === 'error' || data.message?.isError === true } : {}),
      })];
    }
    if (type === 'error') return [make({ kind: 'error', content: event.message ?? event.error ?? 'DSH failed.' })];
    if (type === 'status' && event.phase === 'step_end') return [make({ kind: 'stream_end' })];
    return [];
  }
}
