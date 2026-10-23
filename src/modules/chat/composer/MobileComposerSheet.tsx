import { useId } from 'react';
import type { ReactNode } from 'react';
import { XIcon } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type MobileComposerSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  doneLabel: string;
  children: (close: () => void) => ReactNode;
};

/**
 * Bottom sheet for the mobile composer's actions and chat settings. Rendered by
 * chat's ChatComposer outside the prompt form, so provider forms inside the
 * sheet never bubble a submit into the message composer.
 */
export function MobileComposerSheet({
  open,
  onOpenChange,
  title,
  doneLabel,
  children,
}: MobileComposerSheetProps) {
  const titleId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-labelledby={titleId}
        wrapperClassName="z-[60]"
        animationClassName="animate-bottom-sheet-content-show"
        className="fixed inset-x-0 bottom-0 top-auto flex max-h-[80dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-b-none rounded-t-3xl border-x-0 border-b-0 px-0 pb-safe-area-inset-bottom pt-0"
      >
        <DialogTitle id={titleId}>{title}</DialogTitle>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-4 py-3">
          <p className="min-w-0 truncate text-sm font-semibold">{title}</p>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={doneLabel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          {/* Closed sheets stay mounted so the shared Dialog can restore focus
              and release the scroll lock, but their provider/model lists are
              not built until the sheet is actually open. */}
          {open && children(() => onOpenChange(false))}
        </div>
        <div className="shrink-0 border-t border-border/50 p-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-10 w-full rounded-xl bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            {doneLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type MobileSheetActionProps = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  badge?: number;
  disabled?: boolean;
};

/** One tappable row in the mobile composer's action sheet, used by chat's ChatComposer. */
export function MobileSheetAction({
  icon,
  label,
  onClick,
  badge,
  disabled = false,
}: MobileSheetActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
