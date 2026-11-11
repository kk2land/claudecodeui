import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, X } from 'lucide-react';

import { api } from '@/shared/api';
import type { ProjectTodoAttachment } from '@/shared/types';
import { Button } from '@/shared/ui';
import { cn, downloadBlob } from '@/shared/utils';

/** Todo attachments are served from the todo's own private route, never a chat asset path. */
const isImageAttachment = (attachment: ProjectTodoAttachment): boolean =>
  attachment.mimeType.startsWith('image/');

/**
 * Resolves one todo attachment to an object URL through its authenticated
 * endpoint, because a bare <img src> cannot carry the auth header. The URL is
 * revoked when the attachment changes or the consumer unmounts.
 */
function useTodoAttachmentUrl(
  projectId: string,
  todoId: string,
  attachment: ProjectTodoAttachment,
  enabled: boolean,
): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setSrc(null);
      setFailed(false);
      return undefined;
    }

    let objectUrl: string | null = null;
    let cancelled = false;
    setFailed(false);

    const load = async () => {
      try {
        const response = await api.todos.attachment(projectId, todoId, attachment.id);
        if (!response.ok) {
          throw new Error(`Failed to load attachment (${response.status})`);
        }
        objectUrl = URL.createObjectURL(await response.blob());
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setSrc(objectUrl);
      } catch (error) {
        if (cancelled) {
          return;
        }
        console.error('Failed to load todo attachment:', error);
        setSrc(null);
        setFailed(true);
      }
    };

    void load();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [attachment.id, enabled, projectId, todoId]);

  return { src, failed };
}

/** Downloads one todo attachment through its authenticated route. */
async function downloadTodoAttachment(
  projectId: string,
  todoId: string,
  attachment: ProjectTodoAttachment,
): Promise<void> {
  const response = await api.todos.attachment(projectId, todoId, attachment.id);
  if (!response.ok) {
    throw new Error(`Failed to download attachment (${response.status})`);
  }
  downloadBlob(await response.blob(), attachment.name);
}

type TodoAttachmentImageProps = {
  projectId: string;
  todoId: string;
  attachment: ProjectTodoAttachment;
  className?: string;
};

/**
 * Thumbnail for one image todo attachment, falling back to a file icon while
 * loading or when the preview fails. Used by ProjectTodoDialog's rows and by
 * the todo editor's attachment list.
 */
export function TodoAttachmentImage({
  projectId,
  todoId,
  attachment,
  className,
}: TodoAttachmentImageProps) {
  const { src } = useTodoAttachmentUrl(projectId, todoId, attachment, isImageAttachment(attachment));

  if (!src) {
    return (
      <span
        className={cn(
          'flex h-12 w-12 items-center justify-center rounded-md border border-border/60 bg-muted text-muted-foreground',
          className,
        )}
        aria-hidden
      >
        <FileText className="h-4 w-4" />
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={attachment.name}
      className={cn('h-12 w-12 rounded-md border border-border/60 object-cover', className)}
    />
  );
}

type TodoAttachmentPreviewProps = {
  projectId: string;
  todoId: string;
  attachments: ProjectTodoAttachment[];
  onClose: () => void;
};

/**
 * Attachment viewer opened from a todo row: images render from a private blob
 * URL and every other file is offered as a download. Used by ProjectTodoDialog.
 */
export function TodoAttachmentPreview({
  projectId,
  todoId,
  attachments,
  onClose,
}: TodoAttachmentPreviewProps) {
  const { t } = useTranslation('chat');

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col bg-background/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('projectTodo.previewTitle')}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <p className="truncate text-sm font-medium text-foreground">
          {t('projectTodo.previewAttachments')}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t('projectTodo.close')}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {attachments.map((attachment) => (
          <TodoAttachmentPreviewItem
            key={attachment.id}
            projectId={projectId}
            todoId={todoId}
            attachment={attachment}
          />
        ))}
      </div>
    </div>
  );
}

type TodoAttachmentPreviewItemProps = {
  projectId: string;
  todoId: string;
  attachment: ProjectTodoAttachment;
};

/** One entry of the todo attachment viewer, private to TodoAttachmentPreview. */
function TodoAttachmentPreviewItem({
  projectId,
  todoId,
  attachment,
}: TodoAttachmentPreviewItemProps) {
  const { t } = useTranslation('chat');
  const isImage = isImageAttachment(attachment);
  const { src, failed } = useTodoAttachmentUrl(projectId, todoId, attachment, isImage);

  if (isImage && src) {
    return (
      <figure className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
        <img
          src={src}
          alt={attachment.name}
          className="mx-auto max-h-[55vh] w-auto max-w-full object-contain"
        />
        <figcaption className="truncate border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {attachment.name}
        </figcaption>
      </figure>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {attachment.name}
      </span>
      {failed && (
        <span className="text-xs text-muted-foreground">{t('projectTodo.loadFailed')}</span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void downloadTodoAttachment(projectId, todoId, attachment).catch((error) => {
            console.error('Failed to download todo attachment:', error);
          });
        }}
      >
        <Download />
        {t('projectTodo.download')}
      </Button>
    </div>
  );
}
