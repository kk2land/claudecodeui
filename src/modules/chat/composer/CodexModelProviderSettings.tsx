import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import type { CodexModelProviderControls } from '@/shared/types';

/**
 * Fork failures this panel can explain without the server's English message;
 * any other code falls back to that message, so a new backend reason still
 * reaches the user without a UI release.
 */
const BRANCH_ERROR_KEYS: Record<string, string> = {
  CODEX_MODEL_PROVIDER_FORK_REQUIRED: 'codex.branchError.providerChange',
  CODEX_MODEL_PROVIDER_FORK_UNSUPPORTED: 'codex.branchError.unsupported',
  CODEX_MODEL_PROVIDER_FORK_BUSY: 'codex.branchError.busy',
  FORK_NOT_SUPPORTED: 'codex.branchError.unsupported',
  FORK_SOURCE_NOT_READY: 'codex.branchError.sourceNotReady',
  FORK_MODEL_PROVIDER_MISMATCH: 'codex.branchError.mismatch',
  CODEX_MODEL_NOT_AVAILABLE: 'codex.branchError.modelUnavailable',
  CODEX_MODEL_PROVIDER_NOT_FOUND: 'codex.branchError.serviceMissing',
};

/** CodexControlPanel owns this editor so service changes stay in the current conversation's settings. */
export function CodexModelProviderSettings({ controls, blocked }: { controls: CodexModelProviderControls; blocked: boolean }) {
  const { t } = useTranslation('chat');
  // One request slot for both saving a selection and creating a branch, so a
  // second click can never submit the same change twice. The kind only picks
  // the right pending label.
  const [pendingAction, setPendingAction] = useState<'select' | 'branch' | null>(null);
  // A failure keeps the conversation on its saved service and stays here so the
  // user can retry; `code` is preferred over the English server message.
  const [failure, setFailure] = useState<{ code: string | null; message: string } | null>(null);
  // Target staged for a history-preserving branch. It is deliberately local:
  // the source conversation keeps its own selection, queue and drafts.
  const [branch, setBranch] = useState<{ provider: string; model: string } | null>(null);
  // The target's catalog is still loading, so an empty model list is not final.
  const [loadingBranchModels, setLoadingBranchModels] = useState(false);
  const { loadModels, modelOptionsFor } = controls;

  // The active route only exists once the source conversation has a native
  // thread, which is also what makes its history copyable.
  const source = controls.activeSelection;
  // A saved selection naming another service is the pending branch target the
  // user saved earlier; it is never an applied route (`appliedSelection`).
  const savedTarget = controls.selection && source && controls.selection.modelProvider !== source.modelProvider
    ? controls.selection
    : null;
  const targetProvider = branch ? branch.provider : savedTarget?.modelProvider ?? controls.modelProvider;
  const targetModel = branch ? branch.model : savedTarget ? savedTarget.model ?? '' : controls.model ?? '';
  // A different service can never be applied to an existing native thread in
  // place; it is only expressible by branching the transcript.
  const crossProvider = Boolean(source && targetProvider !== source.modelProvider);
  // Previewing a target reads its catalog without saving anything to the source.
  const targetOptions = crossProvider ? modelOptionsFor(targetProvider) : null;
  // A branch may only name a model that service really offers right now; a
  // removed or unloaded model must be chosen again instead of being assumed.
  const targetModelAvailable = Boolean(targetModel && targetOptions?.some((option) => option.value === targetModel));
  const canCreateBranch = crossProvider && targetModelAvailable && !loadingBranchModels;
  const disabled = pendingAction !== null || controls.pending || blocked;
  const pendingSelection = Boolean(controls.selection && (!controls.activeSelection
    || controls.selection.modelProvider !== controls.activeSelection.modelProvider
    || controls.selection.model !== controls.activeSelection.model));
  const selectClass = 'h-9 w-full min-w-0 rounded-lg border border-input bg-background pl-3 pr-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  const providerName = (id: string) => controls.providers.find((provider) => provider.id === id)?.name ?? id;

  // The one preview path: fetch a target's catalog when it is not loaded yet.
  // The form itself derives what is selectable, so a late response cannot
  // overwrite a choice the user already made. `branch` is a dependency so
  // re-staging a target retries a catalog load that failed.
  useEffect(() => {
    if (!crossProvider || targetOptions) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setLoadingBranchModels(true);
      void loadModels(targetProvider)
        .catch((error: unknown) => {
          if (active) setFailure({ code: null, message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => { if (active) setLoadingBranchModels(false); });
    });
    return () => { active = false; };
  }, [branch, crossProvider, loadModels, targetOptions, targetProvider]);

  const stageBranch = (id: string) => {
    // Re-selecting the saved target keeps its saved model; a fresh target offers
    // the model this conversation already runs, and the availability gate below
    // only accepts it once the target catalog confirms it.
    setBranch({ provider: id, model: (savedTarget?.modelProvider === id ? savedTarget.model ?? '' : source?.model) || '' });
  };

  const describeFailure = (cause: { code: string | null; message: string }) => {
    const key = cause.code ? BRANCH_ERROR_KEYS[cause.code] : undefined;
    return key ? t(key) : cause.message;
  };
  // A panel-local failure wins; otherwise the catalog error the hook already
  // reports for this conversation's own service must stay visible.
  const shownFailure = failure ?? (controls.error ? { code: null, message: controls.error } : null);

  const chooseProvider = async (id: string) => {
    setFailure(null);
    // An existing thread keeps its service: stage the choice as a branch target
    // instead of writing it back to the conversation.
    if (source && id !== source.modelProvider) {
      stageBranch(id);
      return;
    }
    setBranch(null);
    setPendingAction('select');
    try {
      // Returning to the source service also restores the model it already
      // runs, instead of keeping a target model that service may not offer.
      await controls.select(id, id === source?.modelProvider ? source.model : controls.model || null);
    } catch (cause) {
      setFailure({
        code: (cause as { code?: string } | null)?.code ?? null,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally { setPendingAction(null); }
  };

  const createBranch = async () => {
    if (!canCreateBranch || !targetModel) return;
    setFailure(null);
    setPendingAction('branch');
    try {
      const result = await controls.forkWithHistory({ modelProvider: targetProvider, model: targetModel });
      // Success navigates to the new chat through the hook, which leaves this
      // conversation, its selection and its queue untouched.
      if (!result.ok) setFailure({ code: result.code, message: result.message });
    } finally { setPendingAction(null); }
  };

  return <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
    <p className="text-xs text-muted-foreground">{t('composer.serviceSessionScope')}</p>
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium sm:w-56">
      <span>{t('composer.modelService')}</span>
      <select className={selectClass} value={targetProvider} disabled={disabled}
        onChange={(event) => void chooseProvider(event.target.value)}>
        {!controls.providers.some((provider) => provider.id === targetProvider)
          && <option value={targetProvider}>{targetProvider}</option>}
        {controls.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
      </select>
    </label>
    {blocked && <p className="text-xs text-muted-foreground">{t('codex.serviceSwitchBlocked')}</p>}
    {pendingAction && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />{t(pendingAction === 'branch' ? 'composer.branching' : 'composer.applyingService')}
    </p>}
    {!pendingAction && controls.loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />{t('composer.loadingModels', { defaultValue: 'Loading models…' })}
    </p>}
    {shownFailure && <p role="alert" className="break-words text-xs text-destructive">{describeFailure(shownFailure)}</p>}
    {(pendingSelection || crossProvider) && source && <p className="break-words text-xs text-muted-foreground">
      {t('composer.serviceCurrentSelection', { provider: providerName(source.modelProvider), model: source.model })}
    </p>}
    {crossProvider ? <div className="min-w-0 space-y-2 rounded-lg border border-border/60 p-3">
      <p className="text-xs text-muted-foreground">{t('composer.branchHint')}</p>
      <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium sm:w-56">
        <span>{t('composer.branchModel')}</span>
        <select className={selectClass} aria-label={t('composer.branchModel')} value={targetModelAvailable ? targetModel : ''}
          disabled={disabled || loadingBranchModels}
          onChange={(event) => setBranch({ provider: targetProvider, model: event.target.value })}>
          <option value="">{t('composer.branchModelPlaceholder')}</option>
          {(targetOptions ?? []).map((option) =>
            <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {loadingBranchModels && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />{t('composer.loadingModels', { defaultValue: 'Loading models…' })}
      </p>}
      {!loadingBranchModels && !targetModel && <p role="status" className="text-xs text-muted-foreground">{t('composer.branchModelRequired')}</p>}
      {!loadingBranchModels && targetModel && !targetModelAvailable && <p role="status" className="break-words text-xs text-muted-foreground">
        {t('composer.branchModelUnavailable', { model: targetModel })}
      </p>}
      <button type="button" className="inline-flex h-9 items-center justify-center rounded-lg border border-border/60 bg-background px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
        disabled={disabled || !canCreateBranch} onClick={() => void createBranch()}>
        {t(pendingAction === 'branch' ? 'composer.branching' : 'composer.branchWithHistory')}
      </button>
    </div> : controls.selection?.model === null ? <p role="status" className="text-xs text-muted-foreground">{t('codex.modelRequired')}</p>
      : pendingSelection && <p role="status" className="break-words text-xs text-muted-foreground">
      {t('composer.serviceNextTurn', { provider: providerName(controls.selection!.modelProvider), model: controls.selection!.model })}
    </p>}
  </div>;
}
