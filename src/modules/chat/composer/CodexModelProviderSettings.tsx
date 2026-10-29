import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import type { CodexModelProviderControls } from '@/shared/types';

/** CodexControlPanel owns this editor so service changes stay in the current conversation's settings. */
export function CodexModelProviderSettings({ controls, blocked }: { controls: CodexModelProviderControls; blocked: boolean }) {
  const { t } = useTranslation('chat');
  // Service changes wait for the server to confirm whether the current model still exists.
  const [saving, setSaving] = useState(false);
  // Failed requests leave the confirmed conversation settings untouched and allow another attempt.
  const [error, setError] = useState<string | null>(null);
  const disabled = saving || controls.pending || blocked;
  const pendingSelection = controls.selection && (!controls.activeSelection
    || controls.selection.modelProvider !== controls.activeSelection.modelProvider
    || controls.selection.model !== controls.activeSelection.model);
  const selectClass = 'h-9 w-full min-w-0 rounded-lg border border-input bg-background pl-3 pr-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';

  const chooseProvider = async (id: string) => {
    setError(null);
    setSaving(true);
    try {
      await controls.select(id, controls.model || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };

  return <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
    <p className="text-xs text-muted-foreground">{t('composer.serviceSessionScope')}</p>
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium sm:w-56">
      <span>{t('composer.modelService')}</span>
      <select className={selectClass} value={controls.modelProvider} disabled={disabled}
        onChange={(event) => void chooseProvider(event.target.value)}>
        {!controls.providers.some((provider) => provider.id === controls.modelProvider)
          && <option value={controls.modelProvider}>{controls.modelProvider}</option>}
        {controls.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
      </select>
    </label>
    {blocked && <p className="text-xs text-muted-foreground">{t('codex.serviceSwitchBlocked')}</p>}
    {(saving || controls.loading) && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />{t(saving ? 'composer.applyingService' : 'composer.loadingModels', { defaultValue: 'Loading models…' })}
    </p>}
    {(error || controls.error) && <p role="alert" className="break-words text-xs text-destructive">{error || controls.error}</p>}
    {pendingSelection && controls.activeSelection && <p className="break-words text-xs text-muted-foreground">
      {t('composer.serviceCurrentSelection', { provider: controls.providers.find((provider) => provider.id === controls.activeSelection!.modelProvider)?.name ?? controls.activeSelection.modelProvider, model: controls.activeSelection.model })}
    </p>}
    {controls.selection?.model === null ? <p role="status" className="text-xs text-muted-foreground">{t('codex.modelRequired')}</p>
      : pendingSelection && <p role="status" className="break-words text-xs text-muted-foreground">
      {t('composer.serviceNextTurn', { provider: controls.providers.find((provider) => provider.id === controls.selection!.modelProvider)?.name ?? controls.selection!.modelProvider, model: controls.selection!.model })}
    </p>}
  </div>;
}
