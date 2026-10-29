import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Loader2 } from 'lucide-react';

import { api } from '@/shared/api';
import { MCP_PROVIDER_NAMES } from '@/shared/constants';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { LLMProvider, ProviderCapabilityRow, ProviderModelsDefinition, SessionForkResult, SessionForkSource } from '@/shared/types';

type Target = {
  provider: LLMProvider;
  models: ProviderModelsDefinition;
  installed: boolean;
};

type ApiResult<T> = { success?: boolean; data?: T; error?: { message?: string }; message?: string };

type SessionForkDialogProps = {
  source: SessionForkSource;
  onClose(): void;
  onForked(result: SessionForkResult): void;
};

/** Chat and Sidebar render this shared provider/model chooser for whole-session and message-level forks. */
export function SessionForkDialog({ source, onClose, onForked }: SessionForkDialogProps) {
  const { t } = useTranslation('chat');
  // Catalogs and installation checks belong to this invocation, not the active composer's selections.
  const [targets, setTargets] = useState<Target[]>([]);
  // One selection keeps provider, model and effort consistent when the provider changes.
  const [selection, setSelection] = useState({ provider: source.provider, model: '', effort: '' });
  // Compact context is an explicit user choice; the saved transcript always remains complete.
  const [contextMode, setContextMode] = useState<'full' | 'compact'>('full');
  // Loading and submission have different affordances: only submission prevents closing the dialog.
  const [loading, setLoading] = useState(true);
  // Persist the failed request's error so the user can adjust the target or context size and retry.
  const [error, setError] = useState<string | null>(null);
  // Block repeated submissions while the server is creating the fork.
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.providers.capabilities();
        const body = await response.json() as ApiResult<{ providers: ProviderCapabilityRow[] }>;
        if (!response.ok || !body.success || !body.data?.providers) throw new Error(t('fork.loadError'));
        const candidates = body.data.providers.filter((row) =>
          (row.supportsSessionForking || row.supportsSessionTransfer)
          && (!row.hiddenFromModelPicker || row.provider === source.provider));
        const loaded = await Promise.all(candidates.map(async (row): Promise<Target> => {
          try {
            const [modelResponse, authResponse] = await Promise.all([
              api.providers.models(row.provider), api.providers.authStatus(row.provider),
            ]);
            const models = await modelResponse.json() as ApiResult<{ models: ProviderModelsDefinition }>;
            const auth = await authResponse.json() as ApiResult<{ installed?: boolean }>;
            if (!modelResponse.ok || !models.data?.models || !authResponse.ok || !auth.success) throw new Error('Unavailable');
            return { provider: row.provider, models: models.data.models, installed: auth.data?.installed !== false };
          } catch {
            return { provider: row.provider, models: { OPTIONS: [], DEFAULT: '' }, installed: false };
          }
        }));
        if (!cancelled) setTargets(loaded);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('fork.loadError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [source.provider, source.sessionId, t]);

  const target = targets.find((entry) => entry.provider === selection.provider);
  const selectedModel = target?.models.OPTIONS.find((entry) => entry.value === selection.model);
  const canSubmit = !loading && !saving && Boolean(target?.installed)
    && (selection.provider === source.provider || Boolean(selectedModel));

  const submit = async () => {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await api.forkSession(source.sessionId, {
        targetProvider: selection.provider,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { effort: selection.effort } : {}),
        ...(source.upToAnchorId ? { upToAnchorId: source.upToAnchorId } : {}),
        ...(source.upToMessageId ? { upToMessageId: source.upToMessageId } : {}),
        contextMode,
      });
      const body = await response.json() as ApiResult<SessionForkResult>;
      if (!response.ok || !body.success || !body.data?.sessionId || !body.data.provider) {
        throw new Error(body.error?.message || body.message || t('fork.createError'));
      }
      onForked(body.data);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('fork.createError'));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  const fieldClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting.current) onClose(); }}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto p-5 sm:p-6" aria-labelledby="session-fork-title">
        <DialogTitle id="session-fork-title" className="not-sr-only flex items-center gap-2 text-lg font-semibold">
          <GitBranch className="h-5 w-5" />{t('fork.title')}
        </DialogTitle>
        <p className="mb-5 mt-2 text-sm text-muted-foreground">{t(source.upToMessageId || source.upToAnchorId ? 'fork.fromMessage' : 'fork.description')}</p>
        {loading ? <p role="status" className="flex items-center gap-2 py-4 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t('fork.loading')}</p> : (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label className="block space-y-1 text-sm">
              <span>{t('fork.provider')}</span>
              <select className={fieldClass} aria-label={t('fork.provider')} value={selection.provider} disabled={saving} onChange={(event) => {
                const provider = event.target.value as LLMProvider;
                const next = targets.find((entry) => entry.provider === provider);
                setSelection({ provider, model: provider === source.provider ? '' : next?.models.DEFAULT || next?.models.OPTIONS[0]?.value || '', effort: '' });
                setError(null);
              }}>
                {targets.map((entry) => <option key={entry.provider} value={entry.provider} disabled={!entry.installed}>
                  {MCP_PROVIDER_NAMES[entry.provider]}{entry.installed ? '' : ` (${t('fork.unavailable')})`}
                </option>)}
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t('fork.model')}</span>
              <select className={fieldClass} aria-label={t('fork.model')} value={selection.model} disabled={saving || !target?.installed} onChange={(event) => setSelection({ ...selection, model: event.target.value, effort: '' })}>
                {selection.provider === source.provider && <option value="">{t('fork.inheritModel')}</option>}
                {target?.models.OPTIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
            </label>
            {Boolean(selectedModel?.effort?.values.length) && <label className="block space-y-1 text-sm">
              <span>{t('fork.effort')}</span>
              <select className={fieldClass} aria-label={t('fork.effort')} value={selection.effort} disabled={saving} onChange={(event) => setSelection({ ...selection, effort: event.target.value })}>
                <option value="">{t('fork.defaultEffort')}</option>
                {selectedModel?.effort?.values.map((entry) => <option key={entry.value} value={entry.value}>{entry.value}</option>)}
              </select>
            </label>}
            <label className="block space-y-1 text-sm">
              <span>{t('fork.context')}</span>
              <select className={fieldClass} aria-label={t('fork.context')} value={contextMode} disabled={saving} onChange={(event) => setContextMode(event.target.value as 'full' | 'compact')}>
                <option value="full">{t('fork.full')}</option>
                <option value="compact">{t('fork.compact')}</option>
              </select>
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">{t(contextMode === 'compact' ? 'fork.compactHelp' : 'fork.contextHelp')}</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {!target?.installed && !error && <p role="alert" className="text-sm text-muted-foreground">{t('fork.installTarget')}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t('fork.cancel')}</Button>
              <Button type="submit" disabled={!canSubmit}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('fork.create')}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
