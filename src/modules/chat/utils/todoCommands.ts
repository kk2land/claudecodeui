import type { ChatAttachment, PreparedProjectTodo, TodoDraftMeta } from '@/shared/types';

/**
 * The local `/todo` command this composer input should run, or null when the
 * text is an ordinary message. `open` still carries the text to keep after the
 * explicit tail command line is removed; `create` carries the todo body with
 * only the leading command prefix stripped.
 */
export type ComposerTodoCommand =
  | { kind: 'open'; text: string }
  | { kind: 'create'; text: string };

/** `/todo` as a whole word, so `/todolist` is never read as the command. */
const TODO_PREFIX = /^\/todo(?=\s|$)/;
const TAIL_COMMAND = '/todo';

/**
 * Decides between opening the todo list and saving the composer text as a
 * todo. A leading `/todo` wins unless the composer already carries todo
 * sources, where the text is literal todo content; the explicit final line
 * `/todo` always opens the list so a source draft can append another todo.
 */
export function parseComposerTodoCommand(
  input: string,
  options: { hasSources: boolean; hasAttachments: boolean },
): ComposerTodoCommand | null {
  if (!options.hasSources) {
    const prefix = TODO_PREFIX.exec(input);
    if (prefix) {
      // Strip the command prefix only; every following line stays verbatim.
      const body = input.slice(prefix[0].length).replace(/^[ \t]+/, '');
      if (!body.trim() && !options.hasAttachments) {
        return { kind: 'open', text: '' };
      }
      return { kind: 'create', text: body };
    }
  }

  const lines = input.split('\n');
  if (lines.length > 1 && lines[lines.length - 1].trim() === TAIL_COMMAND) {
    const kept = lines.slice(0, -1).join('\n').replace(/\s+$/, '');
    return { kind: 'open', text: kept };
  }
  // A source draft may consist of the tail command alone.
  if (options.hasSources && lines.length === 1 && input.trim() === TAIL_COMMAND) {
    return { kind: 'open', text: '' };
  }
  return null;
}

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const sameAttachment = (left: ChatAttachment, right: ChatAttachment): boolean => (
  left.path === right.path && left.name === right.name
);

/**
 * Appends the text and attachments the server prepared for one todo to the
 * current draft. Returns null when adding it would exceed the attachment cap,
 * so the caller can refuse atomically and keep the composer unchanged.
 */
export function appendPreparedTodo(
  current: { text: string; meta: TodoDraftMeta | null },
  prepared: PreparedProjectTodo,
  fileCount = 0,
): { text: string; meta: TodoDraftMeta } | null {
  const meta = current.meta ?? { todoIds: [], attachments: [] };
  const attachments = [...meta.attachments];
  for (const attachment of prepared.attachments) {
    if (!attachments.some((existing) => sameAttachment(existing, attachment))) {
      attachments.push(attachment);
    }
  }
  // The final composer holds existing stored descriptors, the prepared ones
  // and every browser File still attached; all three share one cap.
  if (
    attachments.length + fileCount > MAX_ATTACHMENT_COUNT
    || attachments.some((attachment) => (attachment.size ?? 0) > MAX_ATTACHMENT_SIZE)
  ) {
    return null;
  }
  const text = [current.text.trimEnd(), prepared.text.trim()]
    .filter((part) => part)
    .join('\n\n');
  return {
    text,
    meta: {
      todoIds: [...new Set([...meta.todoIds, ...prepared.todoIds])],
      attachments,
    },
  };
}
