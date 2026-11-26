import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, XIcon, CornerDownRight, MoreHorizontal, Loader2 } from 'lucide-react';

import type { CodexControls } from '@/shared/types';

type QueuedMessageCardProps = {
  controls?: CodexControls;
  canSteerMode?: boolean;
  content: string;
  attachmentCount?: number;
  /** Only the queue head is dispatched or steered next. */
  isHead?: boolean;
  /** 1-based position in the send order, for the position badge. */
  position?: number;
  /** Total queued entries, for the position badge and movement controls. */
  total?: number;
  onMove?: (direction: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * Rendered by chat's ChatComposer to show one message queued for a busy
 * session, with move, edit and delete actions before it is auto-sent.
 * Native steer is offered only for the head, because only the head is the turn
 * the provider would take next.
 */
export default function QueuedMessageCard({
  content,
  controls,
  canSteerMode = true,
  attachmentCount = 0,
  isHead = true,
  position = 1,
  total = 1,
  onMove,
  onEdit,
  onDelete,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');
  const state = controls?.state;
  const delivery = controls?.delivery;
  const locked = Boolean(controls?.pending || ['steering', 'unknown'].includes(delivery?.status ?? ''));
  const modelRequired = state?.runtime === 'app-server' && state.modelSelection?.model === null;
  const canSteer = Boolean(isHead && canSteerMode && state?.turnId && state.phase === 'running' && !locked && !modelRequired);
  const showSteer = isHead && state?.runtime === 'app-server';

  return (
    <div className="settings-content-enter mx-auto mb-2 chat-content-width rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
            <span>{t('input.queue.label', { defaultValue: 'Queued' })}</span>
            {total > 1 && (
              <span className="normal-case text-muted-foreground/60" title={t('input.queue.positionHint', { defaultValue: 'Queue position' })}>
                {t('input.queue.position', { position, total, defaultValue: '{{position}} of {{total}}' })}
              </span>
            )}
            <span className="normal-case text-muted-foreground/60">
              · {isHead
                ? t(modelRequired ? 'codex.queueNeedsModel' : locked ? 'codex.confirming' : delivery?.status === 'held' || state?.queueHeld ? 'codex.queueHeld' : 'input.queue.willSend', { defaultValue: 'Will send when this finishes' })
                : t('input.queue.waitingBehind', { defaultValue: 'Waiting behind the queued message above' })}
            </span>
          </div>
          {/* Keep the complete queued turn readable and scrollable from the keyboard. */}
          <p
            tabIndex={0}
            className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-sm text-sm text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {content}
          </p>
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {attachmentCount} {attachmentCount === 1 ? 'file' : 'files'} attached
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {onMove && ([-1, 1] as const).map((direction) => {
            const up = direction === -1;
            const Icon = up ? ArrowUpIcon : ArrowDownIcon;
            const label = t(up ? 'input.queue.moveUp' : 'input.queue.moveDown', { position });
            return (
              <button
                key={direction}
                type="button"
                onClick={() => onMove(direction)}
                disabled={locked || (up ? position === 1 : position === total)}
                aria-label={label}
                title={label}
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-40"
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
              </button>
            );
          })}
          {!showSteer && <button
            type="button"
            onClick={onEdit}
            disabled={locked}
            aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>}
          {showSteer && <button type="button" onClick={() => void controls?.steer().catch(() => {})} disabled={!canSteer}
            title={t(canSteer ? 'codex.steerHint' : 'codex.steerUnavailable')} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-primary hover:bg-accent disabled:opacity-40">
            {locked ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CornerDownRight className="h-3.5 w-3.5" />}
            {t(locked ? 'codex.steering' : 'codex.steer')}
          </button>}
          <button
            type="button"
            onClick={onDelete}
            disabled={locked}
            aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
          {showSteer && <details className="relative">
            <summary aria-label={t('codex.more')} className={`list-none rounded-md p-1.5 text-muted-foreground ${locked ? 'pointer-events-none opacity-40' : 'cursor-pointer hover:bg-accent'}`}><MoreHorizontal className="h-3.5 w-3.5" /></summary>
            <div className="absolute right-0 top-full z-20 mt-1 rounded-md border border-border bg-background p-1 shadow-lg">
              <button type="button" disabled={locked} onClick={onEdit} className="flex items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-xs hover:bg-accent"><PencilIcon className="h-3.5 w-3.5" />{t('input.queue.edit')}</button>
            </div>
          </details>}
        </div>
      </div>
      {delivery?.error && <p role="alert" className="mt-1 text-xs text-destructive">{delivery.error}</p>}
      {delivery?.status === 'unknown' && !controls?.pending && !state?.turnId && state?.goal?.status !== 'active' && !['starting', 'stopping', 'stopFailed'].includes(state?.phase ?? '') && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-primary">{t('codex.recoverDelivery')}</summary>
          <p className="mt-1 text-muted-foreground">{t('codex.unknownDelivery')}</p>
          <div className="mt-2 flex gap-3">
            <button type="button" className="text-primary" onClick={() => void controls?.control({ action: 'queue-recover', decision: 'queue' }).catch(() => {})}>{t('codex.queueAgain')}</button>
            <button type="button" className="text-muted-foreground" onClick={() => void controls?.control({ action: 'queue-recover', decision: 'discard' }).catch(() => {})}>{t('codex.discardQueue')}</button>
          </div>
        </details>
      )}
      {delivery?.status === 'held' && <button type="button" className="mt-1 text-xs text-primary" disabled={locked || modelRequired} onClick={() => void controls?.control({ action: 'queue-resume' }).catch(() => {})}>{t('codex.resumeQueue')}</button>}
    </div>
  );
}
