import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Paperclip, X } from 'lucide-react';

import { TodoAttachmentImage } from '@/modules/todos/TodoAttachmentPreview';
import { api, readApiJson } from '@/shared/api';
import type { ProjectTodo } from '@/shared/types';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';

/** Mirrors the server's per-todo attachment cap so the UI rejects what the route would. */
const MAX_TODO_ATTACHMENTS = 10;
/** Mirrors the server's per-file upload limit (10 MB). */
const MAX_TODO_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const formatMegabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}`;

type TodoEditorProps = {
  projectId: string;
  todo: ProjectTodo;
  onSaved: (todo: ProjectTodo) => void;
  onCancel: () => void;
};

/**
 * Edits one pending todo's text and attachments. Used by ProjectTodoDialog;
 * the draft lives here so a failed save keeps exactly what the user typed.
 */
export function TodoEditor({ projectId, todo, onSaved, onCancel }: TodoEditorProps) {
  const { t } = useTranslation('chat');
  // The unsaved text; the only copy until the user saves, so a failed request
  // can leave it untouched for a retry.
  const [content, setContent] = useState(todo.content);
  // Ids of the todo's existing attachments the user chose to keep; removing one
  // drops it from this list and the server deletes the file on save.
  const [keptAttachmentIds, setKeptAttachmentIds] = useState<string[]>(
    todo.attachments.map((attachment) => attachment.id),
  );
  // Files picked during this edit, uploaded only when the user saves.
  const [newFiles, setNewFiles] = useState<File[]>([]);
  // Validation or save failure, shown above the actions; the draft is kept.
  const [error, setError] = useState<string | null>(null);
  // Guards against a second submit while the multipart request is in flight.
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const keptAttachments = todo.attachments.filter((attachment) =>
    keptAttachmentIds.includes(attachment.id),
  );
  const attachmentCount = keptAttachments.length + newFiles.length;

  const addFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const incoming = Array.from(fileList);
    const tooLarge = incoming.find((file) => file.size > MAX_TODO_ATTACHMENT_BYTES);
    if (tooLarge) {
      setError(
        t('projectTodo.editor.errorSize', {
          name: tooLarge.name,
          size: formatMegabytes(MAX_TODO_ATTACHMENT_BYTES),
        }),
      );
      return;
    }

    if (attachmentCount + incoming.length > MAX_TODO_ATTACHMENTS) {
      setError(t('projectTodo.editor.errorCount', { max: MAX_TODO_ATTACHMENTS }));
      return;
    }

    setError(null);
    setNewFiles((previousFiles) => [...previousFiles, ...incoming]);
  };

  const save = async () => {
    if (!content.trim() && attachmentCount === 0) {
      setError(t('projectTodo.editor.errorEmpty'));
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('content', content);
      for (const file of newFiles) {
        formData.append('files', file);
      }
      // The route reads both as JSON-encoded strings inside the multipart body.
      formData.append('keepAttachmentIds', JSON.stringify(keptAttachmentIds));
      // Editing never converts chat attachments, so there are none to store.
      formData.append('storedAttachments', JSON.stringify([]));

      const data = await readApiJson<{ todo: ProjectTodo }>(
        await api.todos.update(projectId, todo.id, formData),
      );
      onSaved(data.todo);
    } catch (saveError) {
      console.error('Failed to save project todo:', saveError);
      const message = saveError instanceof Error ? saveError.message : '';
      setError(message || t('projectTodo.editor.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t('projectTodo.editor.title')}
        </span>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={t('projectTodo.editor.contentPlaceholder')}
          rows={5}
          className={cn(
            'w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground',
            'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        />
      </label>

      {(keptAttachments.length > 0 || newFiles.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {keptAttachments.map((attachment) => (
            <span
              key={attachment.id}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-card/40 p-1.5 pr-2"
            >
              {attachment.mimeType.startsWith('image/') ? (
                <TodoAttachmentImage
                  projectId={projectId}
                  todoId={todo.id}
                  attachment={attachment}
                  className="h-8 w-8"
                />
              ) : (
                <FileTextIcon />
              )}
              <span className="max-w-40 truncate text-xs text-foreground">{attachment.name}</span>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={t('projectTodo.editor.removeAttachment', { name: attachment.name })}
                onClick={() =>
                  setKeptAttachmentIds((previousIds) =>
                    previousIds.filter((id) => id !== attachment.id),
                  )
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          {newFiles.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-dashed border-border/60 bg-card/20 p-1.5 pr-2"
            >
              <FileTextIcon />
              <span className="max-w-40 truncate text-xs text-foreground">{file.name}</span>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={t('projectTodo.editor.removeAttachment', { name: file.name })}
                onClick={() =>
                  setNewFiles((previousFiles) =>
                    previousFiles.filter((_, fileIndex) => fileIndex !== index),
                  )
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              // Let the same file be picked again after it was removed.
              event.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSaving}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip />
            {t('projectTodo.editor.addFiles')}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {t('projectTodo.editor.attachmentsLimit', {
              max: MAX_TODO_ATTACHMENTS,
              size: formatMegabytes(MAX_TODO_ATTACHMENT_BYTES),
            })}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('projectTodo.editor.keepHint')}</p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={isSaving} onClick={onCancel}>
          {t('projectTodo.editor.cancel')}
        </Button>
        <Button type="button" size="sm" disabled={isSaving} onClick={() => void save()}>
          {isSaving && <Loader2 className="animate-spin" />}
          {isSaving ? t('projectTodo.editor.saving') : t('projectTodo.editor.save')}
        </Button>
      </div>
    </div>
  );
}

/** Neutral file glyph shared by the existing and new attachment chips above. */
function FileTextIcon() {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Paperclip className="h-3.5 w-3.5" />
    </span>
  );
}
