import { memo } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
  provider?: string;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Rendered by chat's ChatComposer to show the session's context-window usage
 * and open the detailed token breakdown on click.
 */
function TokenUsageSummary({ usage, onClick, provider }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;

  const contextWindow = readUsageNumber(usage?.total);
  // Codex TUI normalizes both counts by its fixed prompt/tool baseline.
  const codexRemainingPercent = provider === 'codex' && contextWindow > 0
    ? contextWindow <= 12_000 ? 0 : Math.round(
      Math.max(0, contextWindow - 12_000 - Math.max(0, usedTokens - 12_000))
      / (contextWindow - 12_000) * 100,
    )
    : null;
  // ChatComposer passes the displayed provider label, so DSH arrives as either
  // its provider id or the "DeepSeek Harness" label lowercased.
  const isDsh = provider === 'dsh' || provider === 'deepseek harness';
  // DSH reports its own live context usage, so it needs no Codex baseline.
  // Clamp both ends: overfull usage is 0% and negative usage cannot exceed 100%.
  const dshRemainingPercent = isDsh && contextWindow > 0
    ? Math.round(Math.min(1, Math.max(0, 1 - usedTokens / contextWindow)) * 100)
    : null;
  const remainingPercent = codexRemainingPercent ?? dshRemainingPercent;

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={t('chat:misc.tokensUsed', { count: usedTokens })}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
      {remainingPercent !== null && (
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-semibold tabular-nums text-primary">
          {t('chat:misc.contextRemaining', { percent: remainingPercent, defaultValue: '{{percent}}% left' })}
        </span>
      )}
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
