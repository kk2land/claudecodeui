import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Square, Settings2 } from 'lucide-react';

import type { CodexControls, CodexUserInputRequest } from '@/shared/types';
import { cn } from '@/shared/utils';

function NativeQuestion({ request, controls }: { request: CodexUserInputRequest; controls: CodexControls }) {
  const { t } = useTranslation('chat');
  // Answers are scoped by the native request id and discarded when it resolves.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <form className="space-y-3 rounded-lg border border-border p-3" onSubmit={(event) => {
      event.preventDefault();
      void controls.control({ action: 'answer', requestId: request.requestId,
        answers: Object.fromEntries(request.questions.map((question) => [question.id, { answers: [answers[question.id]?.trim() ?? ''] }])) }).catch(() => {});
    }}>
      <p className="text-xs text-muted-foreground">{t(request.isBlocking ? 'codex.questionBlocking' : 'codex.questionOptional')}</p>
      {request.questions.map((question) => (
        <fieldset key={question.id} className="space-y-2">
          <legend className="text-sm font-medium">{question.question}</legend>
          {question.options?.map((option) => (
            <label key={option.label} className="flex cursor-pointer gap-2 text-sm">
              <input type="radio" name={`${request.requestId}:${question.id}`} checked={answers[question.id] === option.label}
                onChange={() => setAnswers((old) => ({ ...old, [question.id]: option.label }))} />
              <span>{option.label}<span className="block text-xs text-muted-foreground">{option.description}</span></span>
            </label>
          ))}
          <input className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm" aria-label={question.question}
            type={question.isSecret ? 'password' : 'text'} placeholder={t('codex.answerPlaceholder')} value={answers[question.id] ?? ''}
            onChange={(event) => setAnswers((old) => ({ ...old, [question.id]: event.target.value }))} />
        </fieldset>
      ))}
      <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
        disabled={controls.pending || request.questions.some((question) => !answers[question.id]?.trim())}>{t('codex.submitAnswers')}</button>
    </form>
  );
}

/**
 * ChatComposer displays native Plan, Goal, runtime selection and request_user_input controls here.
 *
 * `settingsContainer` lets the mobile composer move routine settings into its
 * bottom sheet while this component stays mounted, so local objective/budget
 * state survives closing the sheet. Undefined keeps the desktop placement;
 * null renders only the blocking notices/questions that must stay beside the
 * input; an element portals the settings into it.
 */
export function CodexControlPanel({ controls, onExecutePlan, settingsContainer, hasQueuedDraft = false }: {
  controls: CodexControls;
  onExecutePlan(): void;
  settingsContainer?: Element | null;
  hasQueuedDraft?: boolean;
}) {
  const { t, i18n } = useTranslation('chat');
  const { state, error, pending } = controls;
  const showResumeQueue = Boolean(state?.queueHeld && hasQueuedDraft);
  const runtimePanelId = useId();
  // Keep advanced runtime controls out of the toolbar until the user opens them.
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  // The objective editor supports both creation and explicit replacement of a native goal.
  const [objective, setObjective] = useState('');
  // A blank budget means no user-specified cap; editing it never changes native usage by itself.
  const [budget, setBudget] = useState('');
  const goal = state?.goal;
  const busy = Boolean(state?.turnId || state?.goal?.status === 'active' || ['starting', 'stopping', 'stopFailed'].includes(state?.phase ?? ''));
  const native = state?.runtime !== 'sdk';
  const startedAt = state?.diagnostics?.startedAt != null ? new Date(state.diagnostics.startedAt) : null;
  const button = 'inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-border/60 bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40';
  const settings = <div className="min-w-0 space-y-2 text-sm">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {native && <>
            <button type="button" className={button} disabled={pending || state?.phase === 'stopping'}
              aria-pressed={state?.mode === 'plan'} onClick={() => void controls.control({ action: 'mode', mode: state?.mode === 'plan' ? 'default' : 'plan' }).catch(() => {})}>
              {t(state?.mode === 'plan' ? 'codex.planMode' : 'codex.executeMode')}
            </button>
            {state?.mode === 'plan' && <button type="button" className={button} disabled={pending || busy}
              onClick={() => void controls.control({ action: 'mode', mode: 'default' }).then(onExecutePlan).catch(() => {})}>{t('codex.executePlan')}</button>}
            {settingsContainer === undefined && <>
              {state?.phase === 'stopping' && <span role="status" className="text-xs text-muted-foreground">{t('codex.stopping')}</span>}
              {state?.phase === 'stopFailed' && <span role="alert" className="text-xs text-destructive">{t('codex.stopFailed')}</span>}
              {showResumeQueue && <button type="button" className={button} disabled={pending || state?.phase === 'stopping' || state?.phase === 'stopFailed'}
                onClick={() => void controls.control({ action: 'queue-resume' }).catch(() => {})}>{t('codex.resumeQueue')}</button>}
            </>}
          </>}
        </div>
        <button type="button" className={`${button} gap-1.5`} aria-expanded={runtimeOpen}
          aria-controls={runtimePanelId} onClick={() => setRuntimeOpen((open) => !open)}>
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          Codex
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${runtimeOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>
      {runtimeOpen && <section id={runtimePanelId} aria-label={t('codex.runtimeSettings')}
        className="min-w-0 rounded-xl border border-border bg-muted/20 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium sm:w-56">
            <span>{t('codex.runtime')}</span>
            <select disabled={pending || busy} value={state?.runtime ?? 'app-server'}
              className="h-9 w-full min-w-0 rounded-lg border border-input bg-background pl-3 pr-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
              onChange={(event) => void controls.control({ action: 'runtime', runtime: event.target.value as 'sdk' | 'app-server' }).catch(() => {})}>
              <option value="app-server">app-server</option><option value="sdk">SDK</option>
            </select>
          </label>
          <button type="button" className={cn(button, 'h-9 gap-2 self-start px-3 sm:self-auto')}
            disabled={pending || !state?.diagnostics?.running} onClick={() => void controls.control({ action: 'stop-app-server' }).catch(() => {})}>
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            {t('codex.stopAppServer')}
          </button>
        </div>
        {state?.diagnostics && <div className="mt-3 min-w-0 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.diagnostics.running ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} aria-hidden="true" />
                {t(state.diagnostics.running ? 'codex.processRunning' : 'codex.processIdle')}
              </span>
              {state.diagnostics.running && state.diagnostics.pid != null && <code title={t('codex.processId')} className="select-text whitespace-nowrap rounded-md bg-muted px-2 py-0.5 text-[11px]">PID {state.diagnostics.pid}</code>}
              {state.diagnostics.running && startedAt && <span className="inline-flex flex-wrap items-center gap-1">
                {t('codex.processStartedAt')}
                <time dateTime={startedAt.toISOString()} className="select-text whitespace-nowrap tabular-nums">
                  {startedAt.toLocaleString(i18n.language, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                </time>
              </span>}
            </div>
            {state.diagnostics.cliVersion && <code className="rounded-md bg-muted px-2 py-0.5 text-[11px]">v{state.diagnostics.cliVersion}</code>}
          </div>
          {state.diagnostics.launcherPath && <details className="mt-2 min-w-0">
            <summary className="cursor-pointer rounded py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('codex.launcherPath')}</summary>
            <code className="mt-1 block max-w-full select-text whitespace-pre-wrap break-all rounded-lg bg-background p-2 text-[11px] leading-relaxed">{state.diagnostics.launcherPath}</code>
          </details>}
        </div>}
      </section>}
      {native && controls.goalsEnabled && <details open={Boolean(goal) || controls.goalVisible} className="rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">{t('codex.goal')}{goal && ` · ${t(`codex.status.${goal.status}`)}`}</summary>
        {goal && <div className="mt-2 space-y-2">
          <p className="whitespace-pre-wrap break-words">{goal.objective}</p>
          <p className="text-xs text-muted-foreground">{t('codex.usage', { used: goal.tokensUsed.toLocaleString(), budget: goal.tokenBudget?.toLocaleString() ?? '∞', seconds: goal.timeUsedSeconds })}</p>
          <div className="flex flex-wrap gap-2">
            {goal.status === 'active' ? <button type="button" className={button} disabled={pending} onClick={() => void controls.control({ action: 'goal', operation: 'pause' }).catch(() => {})}>{t('codex.pause')}</button>
              : goal.status !== 'complete' && <button type="button" className={button} disabled={pending || state?.mode === 'plan'} onClick={() => void controls.control({ action: 'goal', operation: 'resume', ...(budget ? { tokenBudget: Number(budget) } : {}) }).catch(() => {})}>{t('codex.resume')}</button>}
            <button type="button" className={button} disabled={pending} onClick={() => void controls.control({ action: 'goal', operation: 'clear' }).catch(() => {})}>{t('codex.clear')}</button>
          </div>
        </div>}
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void controls.control({ action: 'goal', operation: 'set', objective, ...(budget ? { tokenBudget: Number(budget) } : {}) }).then(() => setObjective('')).catch(() => {}); }}>
          <input aria-label={t('codex.objective')} placeholder={t('codex.objective')} value={objective} maxLength={4000}
            onChange={(event) => setObjective(event.target.value)} className="min-w-32 flex-1 rounded border border-input bg-background px-2 py-1 text-xs" />
          <input aria-label={t('codex.budget')} placeholder={t('codex.budget')} type="number" min="1" step="1" value={budget}
            onChange={(event) => setBudget(event.target.value)} className="w-32 rounded border border-input bg-background px-2 py-1 text-xs" />
          <button type="submit" className={button} disabled={pending || !objective.trim()}>{t(goal ? 'codex.replaceGoal' : 'codex.createGoal')}</button>
        </form>
      </details>}
    </div>;

  const notices = <div className="min-w-0 space-y-2 text-sm">
      {settingsContainer !== undefined && native && (state?.phase === 'stopping' || state?.phase === 'stopFailed' || showResumeQueue) && (
        <div className="flex flex-wrap items-center gap-2">
          {state?.phase === 'stopping' && <span role="status" className="text-xs text-muted-foreground">{t('codex.stopping')}</span>}
          {state?.phase === 'stopFailed' && <span role="alert" className="text-xs text-destructive">{t('codex.stopFailed')}</span>}
          {showResumeQueue && <button type="button" className={button} disabled={pending || state?.phase === 'stopping' || state?.phase === 'stopFailed'}
            onClick={() => void controls.control({ action: 'queue-resume' }).catch(() => {})}>{t('codex.resumeQueue')}</button>}
        </div>
      )}
      {(error || state?.error) && <p role="alert" className="text-xs text-destructive">{error || state?.error}</p>}
      {state?.questions.map((request) => <NativeQuestion key={request.requestId} request={request} controls={controls} />)}
    </div>;

  // Desktop keeps the historical order and spacing; mobile only mounts the
  // notices when one exists, so an idle composer grows no extra toolbar.
  const hasNotices = Boolean(
    (settingsContainer !== undefined && native
      && (state?.phase === 'stopping' || state?.phase === 'stopFailed' || showResumeQueue))
      || error || state?.error || state?.questions.length,
  );
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
