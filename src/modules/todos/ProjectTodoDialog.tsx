import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';

import { useProjectTodos } from '@/modules/todos/hooks/useProjectTodos';
import {
  TodoAttachmentImage,
  TodoAttachmentPreview,
} from '@/modules/todos/TodoAttachmentPreview';
import { TodoEditor } from '@/modules/todos/TodoEditor';
import type { ProjectTodo } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, Pill, PillBar } from '@/shared/ui';
import { cn } from '@/shared/utils';

/** Retention window the server applies before a submitted/deleted todo disappears. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type ProjectTodoTab = 'pending' | 'submitted' | 'deleted';

const TABS: ProjectTodoTab[] = ['pending', 'submitted', 'deleted'];

/** Short local date/time for a todo timestamp; invalid input renders nothing. */
const formatTodoTime = (value: string, locale: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/** Whole days left in the seven-day restore window, derived from the server timestamp. */
const remainingRetentionDays = (stateChangedAt: string): number => {
  const changedAt = Date.parse(stateChangedAt);
  if (Number.isNaN(changedAt)) {
    return 0;
  }
  return Math.max(0, Math.ceil((changedAt + RETENTION_MS - Date.now()) / DAY_MS));
};

/** Props of the project todo dialog; only this component consumes the shape. */
type ProjectTodoDialogProps = {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Appends one pending todo to the chat composer. The chat module prepares
   * the todo and its attachments; resolving true closes the dialog, false (or
   * a rejection) keeps the list open so the user can try another row.
   */
  onSelectTodo: (todo: ProjectTodo) => Promise<boolean>;
  /** Jumps to the session that submitted a historical todo, when the chat can navigate. */
  onNavigateToSession?: (sessionId: string) => void;
};

/**
 * The project todo dialog: pending todos to append to the composer plus the
 * submitted/deleted history with restore. Used by the chat module from the
 * local `/todo` command; it only lists and edits todos and never sends any
 * todo content to a model.
 */
export function ProjectTodoDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
  onSelectTodo,
  onNavigateToSession,
}: ProjectTodoDialogProps) {
  const { t, i18n } = useTranslation('chat');
  const { todos, isLoading, hasError, reload, removeTodo, restoreTodo } = useProjectTodos({
    projectId,
    open,
  });

  // Which lifecycle tab is showing; dialog opens on pending every time.
  const [activeTab, setActiveTab] = useState<ProjectTodoTab>('pending');
  // Pending todo being edited, or null while the list is showing.
  const [editingTodo, setEditingTodo] = useState<ProjectTodo | null>(null);
  // Todo whose attachments are open in the preview overlay.
  const [previewTodo, setPreviewTodo] = useState<ProjectTodo | null>(null);
  // Row currently being appended to the composer; stops repeated clicks while
  // the chat prepares it and disables its row visually.
  const [selectingTodoId, setSelectingTodoId] = useState<string | null>(null);
  // Todo whose delete/restore request is in flight.
  const [actionTodoId, setActionTodoId] = useState<string | null>(null);
  // Short failure message shown above the list; cleared on the next action.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Every open starts on the pending list without a leftover editor/preview.
    setActiveTab('pending');
    setEditingTodo(null);
    setPreviewTodo(null);
    setErrorMessage(null);
  }, [open]);

  const counts = useMemo<Record<ProjectTodoTab, number>>(() => ({
    pending: todos.filter((todo) => todo.status === 'pending').length,
    submitted: todos.filter((todo) => todo.status === 'submitted').length,
    deleted: todos.filter((todo) => todo.status === 'deleted').length,
  }), [todos]);

  const visibleTodos = useMemo(
    () => todos.filter((todo) => todo.status === activeTab),
    [todos, activeTab],
  );

  const handleSelect = async (todo: ProjectTodo) => {
    if (selectingTodoId || todo.status !== 'pending') {
      return;
    }

    setSelectingTodoId(todo.id);
    setErrorMessage(null);
    try {
      const accepted = await onSelectTodo(todo);
      if (accepted) {
        onOpenChange(false);
        return;
      }
      setErrorMessage(t('projectTodo.selectFailed'));
    } catch (error) {
      console.error('Failed to append project todo:', error);
      setErrorMessage(t('projectTodo.selectFailed'));
    } finally {
      setSelectingTodoId(null);
    }
  };

  const runAction = async (todo: ProjectTodo, action: () => Promise<void>) => {
    setActionTodoId(todo.id);
    setErrorMessage(null);
    try {
      await action();
    } catch (error) {
      console.error('Failed to change project todo:', error);
      const message = error instanceof Error ? error.message : '';
      setErrorMessage(message || t('projectTodo.actionFailed'));
    } finally {
      setActionTodoId(null);
    }
  };

  const tabLabel = (tab: ProjectTodoTab): string => {
    if (tab === 'pending') return t('projectTodo.tabPending');
    if (tab === 'submitted') return t('projectTodo.tabSubmitted');
    return t('projectTodo.tabDeleted');
  };

  const emptyMessage = (tab: ProjectTodoTab): string => {
    if (tab === 'pending') return t('projectTodo.emptyPending');
    if (tab === 'submitted') return t('projectTodo.emptySubmitted');
    return t('projectTodo.emptyDeleted');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // No `relative` here: it would win over the shared DialogContent's
          // `fixed` and anchor the panel to the page instead of the viewport,
          // pushing the mobile bottom sheet to the top of the document.
          'flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl bg-popover p-0',
          // Centered 700px dialog on desktop; a full-width bottom sheet on phones.
          'sm:max-w-[700px]',
          'max-sm:bottom-0 max-sm:left-0 max-sm:top-auto max-sm:max-h-[85vh] max-sm:max-w-none',
          'max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl',
        )}
      >
        <DialogTitle>{t('projectTodo.title', { name: projectName })}</DialogTitle>

        <header className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {t('projectTodo.title', { name: projectName })}
            </h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t('projectTodo.close')}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </header>

        {!editingTodo && (
          <div className="border-b border-border/60 px-4 py-2.5">
            <PillBar className="w-full">
              {TABS.map((tab) => (
                <Pill
                  key={tab}
                  isActive={activeTab === tab}
                  onClick={() => {
                    setActiveTab(tab);
                    setErrorMessage(null);
                  }}
                  className="flex-1 justify-center px-2 py-1.5 text-xs"
                >
                  <span>{tabLabel(tab)}</span>
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-[10px]',
                      activeTab === tab ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {counts[tab]}
                  </span>
                </Pill>
              ))}
            </PillBar>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {editingTodo ? (
            <TodoEditor
              projectId={projectId}
              todo={editingTodo}
              onCancel={() => setEditingTodo(null)}
              onSaved={(savedTodo) => {
                setEditingTodo(null);
                setActiveTab(savedTodo.status);
                void reload();
              }}
            />
          ) : (
            <>
              {errorMessage && (
                <p
                  role="alert"
                  className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {errorMessage}
                </p>
              )}

              {isLoading && visibleTodos.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('projectTodo.loading')}
                </div>
              )}

              {!isLoading && hasError && visibleTodos.length === 0 && (
                <div className="space-y-2 py-8 text-center">
                  <p className="text-sm text-muted-foreground">{t('projectTodo.loadFailed')}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
                    {t('projectTodo.retry')}
                  </Button>
                </div>
              )}

              {!isLoading && !hasError && visibleTodos.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {emptyMessage(activeTab)}
                </p>
              )}

              <div className="space-y-2">
                {visibleTodos.map((todo) => (todo.status === 'pending' ? (
                  <PendingTodoRow
                    key={todo.id}
                    todo={todo}
                    isSelecting={selectingTodoId === todo.id}
                    isActionPending={actionTodoId === todo.id}
                    onSelect={() => void handleSelect(todo)}
                    onEdit={() => setEditingTodo(todo)}
                    onPreview={() => setPreviewTodo(todo)}
                    onDelete={() => void runAction(todo, () => removeTodo(todo.id))}
                    labels={{
                      attachmentsOnly: t('projectTodo.attachmentsOnly'),
                      updatedAt: t('projectTodo.updatedAt', {
                        time: formatTodoTime(todo.updatedAt, i18n.language),
                      }),
                      preview: t('projectTodo.previewAttachments'),
                      edit: t('projectTodo.edit'),
                      delete: t('projectTodo.delete'),
                    }}
                  />
                ) : (
                  <HistoryTodoRow
                    key={todo.id}
                    todo={todo}
                    isActionPending={actionTodoId === todo.id}
                    canNavigate={Boolean(onNavigateToSession && todo.submittedSessionId)}
                    onRestore={() => void runAction(todo, () => restoreTodo(todo.id))}
                    onNavigate={() => {
                      if (onNavigateToSession && todo.submittedSessionId) {
                        onNavigateToSession(todo.submittedSessionId);
                        onOpenChange(false);
                      }
                    }}
                    labels={{
                      attachmentsOnly: t('projectTodo.attachmentsOnly'),
                      submittedAt: t('projectTodo.submittedAt', {
                        time: formatTodoTime(todo.stateChangedAt, i18n.language),
                      }),
                      deletedAt: t('projectTodo.deletedAt', {
                        time: formatTodoTime(todo.stateChangedAt, i18n.language),
                      }),
                      remainingDays: t('projectTodo.remainingDays', {
                        days: remainingRetentionDays(todo.stateChangedAt),
                      }),
                      restore: t('projectTodo.restore'),
                      viewSession: t('projectTodo.viewSession'),
                    }}
                  />
                )))}
              </div>
            </>
          )}
        </div>

        {!editingTodo && (
          <footer className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
            {t('projectTodo.footerHint')}
          </footer>
        )}

        {previewTodo && (
          <TodoAttachmentPreview
            projectId={projectId}
            todoId={previewTodo.id}
            attachments={previewTodo.attachments}
            onClose={() => setPreviewTodo(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type PendingTodoRowLabels = {
  attachmentsOnly: string;
  updatedAt: string;
  preview: string;
  edit: string;
  delete: string;
};

type PendingTodoRowProps = {
  todo: ProjectTodo;
  isSelecting: boolean;
  isActionPending: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onPreview: () => void;
  onDelete: () => void;
  labels: PendingTodoRowLabels;
};

/**
 * One pending todo row: clicking anywhere appends it, while the edit, delete
 * and preview buttons stop propagation so they never select the row.
 */
function PendingTodoRow({
  todo,
  isSelecting,
  isActionPending,
  onSelect,
  onEdit,
  onPreview,
  onDelete,
  labels,
}: PendingTodoRowProps) {
  const imageAttachments = todo.attachments.filter((attachment) =>
    attachment.mimeType.startsWith('image/'),
  );
  const fileAttachments = todo.attachments.filter(
    (attachment) => !attachment.mimeType.startsWith('image/'),
  );

  return (
    <article
      role="button"
      tabIndex={0}
      aria-busy={isSelecting}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'w-full cursor-pointer rounded-lg border border-border/60 bg-card/40 p-3 text-left transition-colors',
        'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isSelecting && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {todo.content ? (
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-foreground">
              {todo.content}
            </p>
          ) : (
            <p className="text-sm italic text-muted-foreground">{labels.attachmentsOnly}</p>
          )}

          {imageAttachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {imageAttachments.map((attachment) => (
                <TodoAttachmentImage
                  key={attachment.id}
                  projectId={todo.projectId}
                  todoId={todo.id}
                  attachment={attachment}
                  className="h-10 w-10"
                />
              ))}
            </div>
          )}

          {fileAttachments.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {fileAttachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="max-w-48 truncate">{attachment.name}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2 text-[11px] text-muted-foreground">{labels.updatedAt}</p>
        </div>

        <div
          className="flex shrink-0 items-center gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {todo.attachments.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={labels.preview}
              onClick={onPreview}
            >
              <Paperclip />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={labels.edit}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            aria-label={labels.delete}
            disabled={isActionPending}
            onClick={onDelete}
          >
            {isActionPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </div>
      </div>
    </article>
  );
}

type HistoryTodoRowLabels = {
  attachmentsOnly: string;
  submittedAt: string;
  deletedAt: string;
  remainingDays: string;
  restore: string;
  viewSession: string;
};

type HistoryTodoRowProps = {
  todo: ProjectTodo;
  isActionPending: boolean;
  canNavigate: boolean;
  onRestore: () => void;
  onNavigate: () => void;
  labels: HistoryTodoRowLabels;
};

/** One submitted/deleted todo row with its state time, retention window and restore action. */
function HistoryTodoRow({
  todo,
  isActionPending,
  canNavigate,
  onRestore,
  onNavigate,
  labels,
}: HistoryTodoRowProps) {
  return (
    <article className="rounded-lg border border-border/60 bg-card/20 p-3">
      {todo.content ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-foreground">
          {todo.content}
        </p>
      ) : (
        <p className="text-sm italic text-muted-foreground">{labels.attachmentsOnly}</p>
      )}

      {todo.attachments.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {todo.attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              <Paperclip className="h-3 w-3 shrink-0" />
              <span className="max-w-48 truncate">{attachment.name}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span>{todo.status === 'submitted' ? labels.submittedAt : labels.deletedAt}</span>
        <span aria-hidden>·</span>
        <span>{labels.remainingDays}</span>
      </div>

      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {canNavigate && todo.status === 'submitted' && (
          <Button type="button" variant="outline" size="sm" onClick={onNavigate}>
            <MessageSquare />
            {labels.viewSession}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" disabled={isActionPending} onClick={onRestore}>
          {isActionPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          {labels.restore}
        </Button>
      </div>
    </article>
  );
}
