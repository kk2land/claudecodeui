import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { api } from '@/shared/api';
import { CODEX_MODEL_PROVIDERS_CHANGED_EVENT } from '@/shared/constants';
import {
  CodexModelProviderEditor,
  isCodexModelProviderEditable,
} from '@/modules/settings/tabs/agents-settings/sections/content/CodexModelProviderEditor';
import type { CodexModelProviderPatch, CodexModelProviderSummary, CodexModelProviders } from '@/shared/types';

type CardError =
  | { kind: 'load'; message: string }
  | { kind: 'write'; message: string }
  /** The default-service write was stored but another config layer still decides it. */
  | { kind: 'overridden'; message: string };

/** Body of a model-provider write: the saved service, or the native failure reason. */
type WriteBody = {
  success: boolean;
  error?: { code?: string; message?: string };
};

/** Reads the full directory from the GET, PUT or write response envelope. */
async function readDirectory(response: Response): Promise<CodexModelProviders> {
  const body = await response.json() as {
    success: boolean;
    data: CodexModelProviders;
    error?: { code?: string; message?: string };
  };
  if (!response.ok || !body.success) {
    // Keep the server's code: some failures report that the write itself landed.
    throw Object.assign(new Error(body.error?.message ?? 'Could not read Codex model providers.'), {
      code: body.error?.code ?? null,
    });
  }
  return body.data;
}

/** Reads the `{ provider }` body a model-provider write returns, or its failure reason. */
async function readWriteBody(response: Response): Promise<WriteBody> {
  const body = await response.json() as WriteBody;
  if (!response.ok || !body.success) {
    throw new Error(body.error?.message ?? 'Could not save this model service.');
  }
  return body;
}

/** The native code for a default-service save that was written but does not take effect. */
const DEFAULT_OVERRIDDEN_CODE = 'CODEX_MODEL_PROVIDER_DEFAULT_OVERRIDDEN';

/**
 * Rendered by AccountContent for Codex: the global default model service used
 * by newly created conversations, plus the native service directory this user
 * layer allows writing. Existing conversations keep their own saved choice.
 */
export function CodexModelProviderCard() {
  const { t } = useTranslation('settings');
  // The server's directory is the confirmed value; it changes only after a successful save.
  const [directory, setDirectory] = useState<CodexModelProviders | null>(null);
  // Disables the default select until the directory has been read.
  const [loading, setLoading] = useState(true);
  // Disables the controls while a default or service write is in flight so stale choices cannot race.
  const [saving, setSaving] = useState(false);
  // The service whose edit form is open; kept open after a failed write so its values survive.
  const [editor, setEditor] = useState<CodexModelProviderSummary | null>(null);
  // A load, write or overridden-write failure shown as an alert; the previous confirmed value stays.
  const [error, setError] = useState<CardError | null>(null);

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

  const saveDefault = async (modelProvider: string) => {
    setSaving(true);
    setError(null);
    try {
      setDirectory(await readDirectory(await api.providers.setCodexDefaultModelProvider(modelProvider)));
      window.dispatchEvent(new Event(CODEX_MODEL_PROVIDERS_CHANGED_EVENT));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if ((cause as { code?: unknown } | null)?.code === DEFAULT_OVERRIDDEN_CODE) {
        // The saved value exists but this layer does not decide it: show the
        // effective directory and the server's own reason instead of a plain failure.
        window.dispatchEvent(new Event(CODEX_MODEL_PROVIDERS_CHANGED_EVENT));
        await confirmDirectory();
        setError({ kind: 'overridden', message });
      } else {
        setError({ kind: 'write', message });
      }
    } finally {
      setSaving(false);
    }
  };

  /** Re-reads the directory a write changed; a failed re-read keeps the previous confirmed one. */
  const confirmDirectory = async () => {
    try {
      setDirectory(await readDirectory(await api.providers.codexModelProviders()));
    } catch (cause) {
      // The write itself succeeded; only the confirming read failed.
      setError({ kind: 'load', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const saveProvider = async (patch: CodexModelProviderPatch) => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      await readWriteBody(await api.providers.updateCodexModelProvider(editor.id, patch));
      setEditor(null);
      // Mounted chat hooks re-read the directory and the edited service's models.
      window.dispatchEvent(new Event(CODEX_MODEL_PROVIDERS_CHANGED_EVENT));
      await confirmDirectory();
    } catch (cause) {
      // A rejected service write changed nothing, so the form keeps its values.
      setError({ kind: 'write', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  const providers = directory?.providers ?? [];
  const current = directory?.defaultProvider ?? 'openai';
  // Keep a server-supplied default visible even when the catalog no longer lists it.
  const currentMissing = directory !== null && !providers.some((provider) => provider.id === current);
  const defaultLocked = directory?.canChangeDefault === false;

  /** Short description of what this service needs, from its own safe settings. */
  const describe = (provider: CodexModelProviderSummary): string | null => {
    const settings = provider.settings;
    if (settings.type === 'customGateway') {
      if (settings.auth.mode === 'environmentVariable') return t('agents.modelProvider.describeEnvKey', { envKey: settings.auth.envKey });
      if (settings.auth.mode === 'externallyConfigured') return t('agents.modelProvider.envKeyExternallyConfigured');
      return t('agents.modelProvider.describeNoAuth');
    }
    if (settings.type === 'bedrock') {
      const parts = [settings.profile ? t('agents.modelProvider.describeProfile', { profile: settings.profile }) : null,
        settings.region ? t('agents.modelProvider.describeRegion', { region: settings.region }) : null].filter(Boolean);
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    if (settings.type === 'gcp') {
      const parts = [settings.projectId ? t('agents.modelProvider.describeProject', { projectId: settings.projectId }) : null,
        settings.location ? t('agents.modelProvider.describeLocation', { location: settings.location }) : null].filter(Boolean);
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    return null;
  };

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
        disabled={loading || saving || directory === null || defaultLocked}
        onChange={(event) => { void saveDefault(event.target.value); }}
      >
        {currentMissing && <option value={current}>{current}</option>}
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>{provider.name}</option>
        ))}
        {directory === null && !currentMissing && <option value="openai">OpenAI</option>}
      </select>

      {defaultLocked && (
        <div className="mt-2 text-sm text-muted-foreground">{t('agents.modelProvider.defaultLocked')}</div>
      )}

      {loading && directory === null && (
        <div className="mt-2 text-sm text-muted-foreground">{t('agents.modelProvider.loading')}</div>
      )}

      {error && (
        <div role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error.kind === 'load' && <>{t('agents.modelProvider.loadFailed')} {error.message}</>}
          {error.kind === 'write' && t('agents.modelProvider.saveFailed', { error: error.message })}
          {error.kind === 'overridden' && t('agents.modelProvider.writeOverridden', { error: error.message })}
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

      {directory !== null && (
        <div className="mt-4">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('agents.modelProvider.services')}
          </div>
          <ul className="mt-2 space-y-2">
            {providers.map((provider) => {
              const description = describe(provider);
              const editable = isCodexModelProviderEditable(provider);
              return (
                <li key={provider.id} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {provider.name}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">{provider.id}</span>
                      </div>
                      {provider.baseUrl && <div className="truncate text-muted-foreground">{provider.baseUrl}</div>}
                      {description && <div className="text-muted-foreground">{description}</div>}
                      {!editable && <div className="text-xs text-muted-foreground">{t('agents.modelProvider.readOnly')}</div>}
                    </div>
                    {editable && (
                      <Button
                        disabled={saving}
                        onClick={() => { setError(null); setEditor(provider); }}
                        size="sm"
                        variant="outline"
                      >
                        {t('agents.modelProvider.edit')}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {editor && (
        <CodexModelProviderEditor
          key={editor.id}
          provider={editor}
          saving={saving}
          onCancel={() => { setEditor(null); }}
          onSave={(patch) => { void saveProvider(patch); }}
        />
      )}
    </div>
  );
}
