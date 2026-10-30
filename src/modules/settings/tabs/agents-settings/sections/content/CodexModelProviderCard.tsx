import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { api } from '@/shared/api';
import { CODEX_MODEL_PROVIDERS_CHANGED_EVENT } from '@/shared/constants';
import type { CodexModelProviders } from '@/shared/types';

type LoadError = { kind: 'load'; message: string };
type SaveError = { kind: 'save'; message: string };

/** Reads the full directory from either the GET or the PUT envelope. */
async function readDirectory(response: Response): Promise<CodexModelProviders> {
  const body = await response.json() as {
    success: boolean;
    data: CodexModelProviders;
    error?: { message?: string };
  };
  if (!response.ok || !body.success) {
    throw new Error(body.error?.message ?? 'Could not read Codex model providers.');
  }
  return body.data;
}

/**
 * Rendered by AccountContent for Codex: the global default model service used
 * by newly created conversations. Editing it only writes the server's Codex
 * config; existing conversations keep their own saved choice.
 */
export function CodexModelProviderCard() {
  const { t } = useTranslation('settings');
  // The server's directory is the confirmed value; it changes only after a successful save.
  const [directory, setDirectory] = useState<CodexModelProviders | null>(null);
  // Disables the select until the directory has been read.
  const [loading, setLoading] = useState(true);
  // Disables the select while a save is in flight so stale choices cannot race.
  const [saving, setSaving] = useState(false);
  // A load or save failure shown as an alert; the previous confirmed value stays.
  const [error, setError] = useState<LoadError | SaveError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDirectory(await readDirectory(await api.providers.codexModelProviders()));
    } catch (cause) {
      setError({ kind: 'load', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (modelProvider: string) => {
    setSaving(true);
    setError(null);
    try {
      setDirectory(await readDirectory(await api.providers.setCodexDefaultModelProvider(modelProvider)));
      window.dispatchEvent(new Event(CODEX_MODEL_PROVIDERS_CHANGED_EVENT));
    } catch (cause) {
      setError({ kind: 'save', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  const providers = directory?.providers ?? [];
  const current = directory?.defaultProvider ?? 'openai';
  // Keep a server-supplied default visible even when the catalog no longer lists it.
  const currentMissing = directory !== null && !providers.some((provider) => provider.id === current);

  return (
    <div className="border-t border-border/50 pt-4" data-testid="codex-model-provider">
      <div className="font-medium text-gray-900 dark:text-gray-100">
        {t('agents.modelProvider.title')}
      </div>
      <div className="text-sm text-gray-700 dark:text-gray-300">
        {t('agents.modelProvider.description')}
      </div>

      <label htmlFor="codex-default-model-provider" className="sr-only">
        {t('agents.modelProvider.title')}
      </label>
      <select
        id="codex-default-model-provider"
        aria-label={t('agents.modelProvider.title')}
        className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
        value={current}
        disabled={loading || saving || directory === null}
        onChange={(event) => { void save(event.target.value); }}
      >
        {currentMissing && <option value={current}>{current}</option>}
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>{provider.name}</option>
        ))}
        {directory === null && !currentMissing && <option value="openai">OpenAI</option>}
      </select>

      {loading && directory === null && (
        <div className="mt-2 text-sm text-muted-foreground">{t('agents.modelProvider.loading')}</div>
      )}

      {error && (
        <div role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error.kind === 'load'
            ? t('agents.modelProvider.loadFailed')
            : t('agents.modelProvider.saveFailed', { error: error.message })}
          {error.kind === 'load' && (
            <Button
              onClick={() => { void load(); }}
              variant="outline"
              size="sm"
              className="ml-2"
            >
              {t('agents.modelProvider.retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
