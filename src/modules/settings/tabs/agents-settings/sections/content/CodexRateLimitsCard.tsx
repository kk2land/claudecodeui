import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { useCodexRateLimits } from '@/modules/settings/hooks/useCodexRateLimits';
import type { CodexRateLimitWindow } from '@/shared/types';

type CodexRateLimitsCardProps = {
  /** Deployment flag from the provider capability matrix; false hides the card entirely. */
  enabled: boolean;
};

/** Formats a remaining percentage, keeping one decimal only when it is meaningful. */
function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Renders one quota window row: its remaining percentage and, when known, the reset instant. */
function QuotaWindowRow({ label, window: quotaWindow }: { label: string; window: CodexRateLimitWindow }) {
  const { t, i18n } = useTranslation('settings');
  const resetText = quotaWindow.resetsAt === null
    ? null
    : new Date(quotaWindow.resetsAt * 1000).toLocaleString(i18n.language);

  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-muted-foreground">{label}</div>
        {resetText && (
          <div className="text-xs text-muted-foreground/80">
            {t('agents.rateLimits.resetsAt', { time: resetText })}
          </div>
        )}
      </div>
      <div className="text-lg font-semibold text-foreground">
        {t('agents.rateLimits.remaining', { percent: formatPercent(quotaWindow.remainingPercent) })}
      </div>
    </div>
  );
}

/**
 * The Codex account quota card in the settings account panel.
 *
 * It renders only when the deployment enables quota reporting. Mounting reads
 * only the server's cached snapshot, so opening settings never starts the
 * app-server; the refresh button is the single explicit read. The weekly window
 * is always shown (with an explicit "no data" line when missing) while the
 * five-hour window appears only when Codex reports one.
 *
 * Used only by AccountContent.
 */
export function CodexRateLimitsCard({ enabled }: CodexRateLimitsCardProps) {
  const { t } = useTranslation('settings');
  const { enabled: serverEnabled, snapshot, loaded, refreshing, error, refresh } = useCodexRateLimits(enabled);

  // Hidden both when the capability matrix says off and when the cache endpoint
  // reports the deployment flag off, so a disabled server is never rendered as
  // an empty quota card.
  if (!enabled || !serverEnabled) return null;

  return (
    <div
      data-testid="codex-rate-limits"
      className="border-t border-border/50 pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium text-gray-900 dark:text-gray-100">
            {t('agents.rateLimits.title')}
          </div>
          <div className="text-sm text-gray-700 dark:text-gray-300">
            {t('agents.rateLimits.description')}
          </div>
        </div>
        <Button
          onClick={() => { void refresh(); }}
          disabled={refreshing}
          variant="outline"
          size="sm"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {t('agents.rateLimits.refresh')}
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        {!loaded && (
          <div className="text-sm text-muted-foreground">{t('agents.rateLimits.loading')}</div>
        )}

        {loaded && !snapshot && (
          <div className="text-sm text-muted-foreground">{t('agents.rateLimits.empty')}</div>
        )}

        {snapshot && (
          <>
            {snapshot.weekly ? (
              <QuotaWindowRow label={t('agents.rateLimits.weekly')} window={snapshot.weekly} />
            ) : (
              <div className="text-sm text-muted-foreground">{t('agents.rateLimits.weeklyUnavailable')}</div>
            )}
            {snapshot.fiveHour && (
              <QuotaWindowRow label={t('agents.rateLimits.fiveHour')} window={snapshot.fiveHour} />
            )}
            {snapshot.stale && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                {t('agents.rateLimits.stale')}
              </div>
            )}
          </>
        )}

        {error && (
          <div role="alert" className="text-sm text-red-600 dark:text-red-400">
            <span className="font-medium">{t('agents.rateLimits.refreshFailed')}</span>{' '}
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
