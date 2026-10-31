import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Settings2, Square } from 'lucide-react';

import type { ProviderRuntimeControls } from '@/shared/types';

/**
 * ChatComposer uses this panel for advertised transport switching and session-owned process controls.
 *
 * `settingsContainer` mirrors CodexControlPanel's mobile hook: undefined keeps
 * the desktop placement, null hides routine settings while keeping paused-queue
 * and error notices beside the input, and an element portals them into the
 * mobile settings sheet.
 */
export function ProviderRuntimePanel({ controls, providerLabel, settingsContainer, hasQueuedDraft = false }: {
  controls: ProviderRuntimeControls;
  providerLabel: string;
  settingsContainer?: Element | null;
  hasQueuedDraft?: boolean;
}) {
  const { t, i18n } = useTranslation('chat');
  const panelId = useId();
  // Process details remain collapsed until the user opens runtime settings.
  const [open, setOpen] = useState(false);
  const { state, pending, error } = controls;
  const showResumeQueue = Boolean(state?.queueHeld && hasQueuedDraft);
  const transitioning = state?.phase === 'switching' || state?.phase === 'stopping';
  const busy = state?.phase !== 'idle';
  const stoppable = Boolean(state && controls.stoppableModes.includes(state.runtime));
  const hasActiveWorkers = controls.hasActiveWorkers === true;
  const startedAt = state?.diagnostics.startedAt != null ? new Date(state.diagnostics.startedAt) : null;
  const button = 'inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-border/60 bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40';
  const settings = <div className="min-w-0 space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {settingsContainer === undefined && showResumeQueue && <button type="button" className={`${button} mr-auto`} disabled={pending || transitioning}
          onClick={() => void controls.control({ action: 'queue-resume' }).catch(() => {})}>{t('runtime.resumeQueue')}</button>}
        <button type="button" className={`${button} gap-1.5`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />{providerLabel}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>
      {open && <section id={panelId} aria-label={t('runtime.settings', { provider: providerLabel })}
        className="min-w-0 rounded-xl border border-border bg-muted/20 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium sm:w-56">
            <span>{t('runtime.mode')}</span>
            <select value={state?.runtime ?? ''} disabled={pending || busy || !state}
              className="h-9 w-full min-w-0 rounded-lg border border-input bg-background pl-3 pr-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
              onChange={(event) => void controls.control({ action: 'runtime', runtime: event.target.value }).catch(() => {})}>
              {!state && <option value="">{t('runtime.loading')}</option>}
              {controls.modes.map((mode) => <option key={mode} value={mode}>{t(`runtime.modes.${mode}`, { defaultValue: mode })}</option>)}
            </select>
          </label>
          {stoppable && <button type="button" className={`${button} h-9 gap-2 self-start px-3 sm:self-auto`}
            disabled={pending || transitioning || (!hasActiveWorkers && !state?.diagnostics.running && state?.phase !== 'starting')}
            onClick={() => void controls.control({ action: 'stop' }).catch(() => {})}>
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            {t('runtime.stop', { runtime: t(`runtime.modes.${state!.runtime}`, { defaultValue: state!.runtime }) })}
          </button>}
        </div>
        {state && <div className="mt-3 min-w-0 space-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span role="status" className="inline-flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.diagnostics.running ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} aria-hidden="true" />
                {t(transitioning || state.phase === 'starting' ? `runtime.${state.phase}` : state.diagnostics.running ? 'runtime.processRunning' : 'runtime.processIdle')}
              </span>
              {hasActiveWorkers && <span className="text-xs text-muted-foreground">{t('codex.workersActive')}</span>}
              {state.diagnostics.running && state.diagnostics.pid != null && <code className="select-text rounded-md bg-muted px-2 py-0.5 text-[11px]">PID {state.diagnostics.pid}</code>}
              {state.diagnostics.running && startedAt && <span className="inline-flex flex-wrap items-center gap-1">
                {t('runtime.startedAt')}
                <time dateTime={startedAt.toISOString()} className="select-text whitespace-nowrap tabular-nums">{startedAt.toLocaleString(i18n.language, { hour12: false })}</time>
              </span>}
            </div>
            {state.diagnostics.cliVersion && <code className="rounded-md bg-muted px-2 py-0.5 text-[11px]">v{state.diagnostics.cliVersion}</code>}
          </div>
          {state.diagnostics.launcherPath && <details className="min-w-0">
            <summary className="cursor-pointer rounded py-1 hover:text-foreground">{t('runtime.launcherPath')}</summary>
            <code className="mt-1 block max-w-full select-text whitespace-pre-wrap break-all rounded-lg bg-background p-2 text-[11px] leading-relaxed">{state.diagnostics.launcherPath}</code>
          </details>}
          <p>{t('runtime.sessionScope')}</p>
          {!state.supportsPermissionRequests && <p>{t('runtime.noInteractivePermissions')}</p>}
          {state.queueHeld && <p>{t('runtime.queueHeld')}</p>}
        </div>}
      </section>}
    </div>;

  const notices = <div className="min-w-0 space-y-2 text-sm">
      {settingsContainer !== undefined && transitioning && (
        <p role="status" className="text-xs text-muted-foreground">
          {t(`runtime.${state!.phase}`)}
        </p>
      )}
      {settingsContainer !== undefined && showResumeQueue && <button type="button" className={`${button} mr-auto`} disabled={pending || transitioning}
        onClick={() => void controls.control({ action: 'queue-resume' }).catch(() => {})}>{t('runtime.resumeQueue')}</button>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>;
  const hasNotices = Boolean((settingsContainer !== undefined && (showResumeQueue || transitioning)) || error);

  if (settingsContainer === undefined) {
    return (
      <div className="mx-auto mb-2 w-full min-w-0 max-w-[54.25rem] space-y-2 text-sm">
        {settings}
        {hasNotices && notices}
      </div>
    );
  }
  return (
    <div className={hasNotices ? 'mx-auto mb-2 w-full min-w-0 max-w-[54.25rem] space-y-2' : 'contents'}>
      {settingsContainer && createPortal(settings, settingsContainer)}
      {hasNotices && notices}
    </div>
  );
}
