import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodexControls, CodexUserInputRequest } from '@/shared/types';

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

/** ChatComposer displays native Plan, Goal, runtime selection and request_user_input controls here. */
export function CodexControlPanel({ controls, onExecutePlan }: { controls: CodexControls; onExecutePlan(): void }) {
  const { t } = useTranslation('chat');
  const { state, error, pending } = controls;
  // The objective editor supports both creation and explicit replacement of a native goal.
  const [objective, setObjective] = useState('');
  // A blank budget means no user-specified cap; editing it never changes native usage by itself.
  const [budget, setBudget] = useState('');
  const goal = state?.goal;
  const busy = Boolean(state?.turnId || state?.goal?.status === 'active' || ['starting', 'stopping', 'stopFailed'].includes(state?.phase ?? ''));
  const native = state?.runtime !== 'sdk';
  const button = 'rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40';
  return (
    <div className="mx-auto mb-2 max-w-[54.25rem] space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {native && <>
          <button type="button" className={button} disabled={pending || state?.phase === 'stopping'}
            aria-pressed={state?.mode === 'plan'} onClick={() => void controls.control({ action: 'mode', mode: state?.mode === 'plan' ? 'default' : 'plan' }).catch(() => {})}>
            {t(state?.mode === 'plan' ? 'codex.planMode' : 'codex.executeMode')}
          </button>
          {state?.mode === 'plan' && <button type="button" className={button} disabled={pending || busy}
            onClick={() => void controls.control({ action: 'mode', mode: 'default' }).then(onExecutePlan).catch(() => {})}>{t('codex.executePlan')}</button>}
          {state?.phase === 'stopping' && <span role="status" className="text-xs text-muted-foreground">{t('codex.stopping')}</span>}
          {state?.phase === 'stopFailed' && <span role="alert" className="text-xs text-destructive">{t('codex.stopFailed')}</span>}
          {state?.queueHeld && <button type="button" className={button} disabled={pending || state.phase === 'stopping' || state.phase === 'stopFailed'}
            onClick={() => void controls.control({ action: 'queue-resume' }).catch(() => {})}>{t('codex.resumeQueue')}</button>}
        </>}
        <details className="ml-auto text-xs">
          <summary className="cursor-pointer rounded px-2 py-1 text-muted-foreground">Codex</summary>
          <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
            <label>{t('codex.runtime')} <select aria-label={t('codex.runtime')} disabled={pending || busy} value={state?.runtime ?? 'app-server'}
              className="rounded border border-input bg-background p-1" onChange={(event) => void controls.control({ action: 'runtime', runtime: event.target.value as 'sdk' | 'app-server' }).catch(() => {})}>
              <option value="app-server">app-server</option><option value="sdk">SDK</option>
            </select></label>
            <button type="button" className={button} disabled={pending || (busy && state?.phase !== 'failed')} onClick={() => void controls.control({ action: 'restart' }).catch(() => {})}>{t('codex.restart')}</button>
            {state?.diagnostics && <div className="w-full space-y-1 break-all text-muted-foreground">
              <p>{t(state.diagnostics.running ? 'codex.processRunning' : 'codex.processIdle')}{state.diagnostics.cliVersion && ` · v${state.diagnostics.cliVersion}`}</p>
              {state.diagnostics.launcherPath && <p>{state.diagnostics.launcherPath}</p>}
            </div>}
          </div>
        </details>
      </div>
      {native && <details open={Boolean(goal) || controls.goalVisible} className="rounded-lg border border-border px-3 py-2">
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
      {(error || state?.error) && <p role="alert" className="text-xs text-destructive">{error || state?.error}</p>}
      {state?.questions.map((request) => <NativeQuestion key={request.requestId} request={request} controls={controls} />)}
    </div>
  );
}
