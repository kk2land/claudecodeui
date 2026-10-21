import { useTranslation } from 'react-i18next';
import { SparklesIcon } from 'lucide-react';

import type { CodexComposerPredictionReason } from '@/shared/types';
import { cn } from '@/shared/utils';

type ComposerPredictionOverlayProps = {
  /** Ghost text from Codex's native prediction; never written into the textarea value. */
  suggestion: string;
  /** Writes the suggestion into the composer as an editable draft; never submits. */
  onAccept(): void;
  /** Hides this turn's suggestion. */
  onDismiss(): void;
};

/**
 * Rendered by ChatComposer directly below the textarea while a native
 * suggestion is visible. It occupies its own row rather than painting over the
 * textarea, so the real value, draft and placeholder are untouched until the
 * user accepts.
 */
export function ComposerPredictionOverlay({ suggestion, onAccept, onDismiss }: ComposerPredictionOverlayProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="flex items-start gap-2 border-t border-border/20 px-4 py-1.5" aria-live="polite">
      <p
        data-testid="composer-prediction"
        className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground/70"
      >
        {suggestion}
      </p>
      {/* Mouse and touch accept without submitting: both buttons are type="button" inside the form. */}
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          onAccept();
        }}
        title={t('prediction.acceptHint')}
        className="shrink-0 rounded-md border border-border/50 bg-card/90 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {t('prediction.accept')}
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          onDismiss();
        }}
        aria-label={t('prediction.dismiss')}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

type ComposerPredictionStatusProps = {
  /** The persisted switch, shown only where the integration actually supports predictions. */
  enabled: boolean;
  /** The selected Codex build lacks the protocol; show a short explanation instead of a toggle. */
  unsupported?: boolean;
  onChange(enabled: boolean): void;
  /** A finished turn's native request is still outstanding; a low-key note. */
  pending?: boolean;
  /** A finished turn reported no suggestion; a low-key note, never a chat error. */
  unavailable: boolean;
  /**
   * Classified reason the native service returned nothing. Raw provider text is
   * deliberately not accepted here: the copy is fully localized, and a missing
   * reason falls back to the generic sentence.
   */
  unavailableReason?: CodexComposerPredictionReason;
  className?: string;
};

/** Locale key for one classified prediction failure; unknown values stay generic. */
function predictionReasonKey(reason: CodexComposerPredictionReason | undefined): string {
  switch (reason) {
    case 'empty': return 'prediction.unavailableEmpty';
    case 'failed': return 'prediction.unavailableFailed';
    case 'rejected': return 'prediction.unavailableRejected';
    case 'request_failed': return 'prediction.unavailableRequestFailed';
    case 'timeout': return 'prediction.unavailableTimeout';
    case 'unsupported': return 'prediction.unavailableUnsupported';
    case 'ineligible': return 'prediction.unavailableIneligible';
    case 'config_unavailable': return 'prediction.unavailableConfig';
    default: return 'prediction.unavailable';
  }
}

/**
 * Rendered by ChatComposer's footer as the small persisted toggle for native
 * suggestions plus, while the native request is outstanding or when it produced
 * none, a muted note. It is never an error surface: an unavailable prediction
 * says nothing about the conversation itself.
 */
export function ComposerPredictionStatus({
  enabled, onChange, unsupported = false, pending = false, unavailable, unavailableReason, className,
}: ComposerPredictionStatusProps) {
  const { t } = useTranslation('chat');
  if (unsupported) {
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/60', className)} data-testid="composer-prediction-unsupported">
        <SparklesIcon className="h-3 w-3" aria-hidden="true" />
        <span className="truncate">{t('prediction.unavailableUnsupported')}</span>
      </span>
    );
  }
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/60', className)}>
      <button
        type="button"
        aria-pressed={enabled}
        title={t('prediction.toggleHint')}
        onClick={() => onChange(!enabled)}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground',
          enabled ? 'text-muted-foreground' : 'text-muted-foreground/50',
        )}
      >
        <SparklesIcon className="h-3 w-3" aria-hidden="true" />
        {t(enabled ? 'prediction.toggleOn' : 'prediction.toggleOff')}
      </button>
      {enabled && pending && !unavailable && (
        <span data-testid="composer-prediction-pending" aria-live="polite" className="truncate">
          {t('prediction.pending')}
        </span>
      )}
      {enabled && unavailable && !pending && (
        <span data-testid="composer-prediction-unavailable" className="truncate">
          {t(predictionReasonKey(unavailableReason))}
        </span>
      )}
    </span>
  );
}
