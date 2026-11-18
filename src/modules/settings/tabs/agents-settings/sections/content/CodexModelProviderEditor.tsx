import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import type { CodexModelProviderPatch, CodexModelProviderSummary } from '@/shared/types';

/** Every text field the editor can render for any native service kind. */
type EditorValues = {
  name: string;
  baseUrl: string;
  envKey: string;
  profile: string;
  region: string;
  projectId: string;
  location: string;
  credentialFile: string;
};

type CodexModelProviderEditorProps = {
  /** Provider being edited, or null when creating a custom gateway. */
  provider: CodexModelProviderSummary | null;
  /** A write is in flight; the form stays visible so a failure keeps its values. */
  saving: boolean;
  onSave(patch: CodexModelProviderPatch): void;
  onCancel(): void;
};

/**
 * Whether this card may write the service at all. Codex's built-in `openai`
 * service has no patch form, and a user layer that reports `canEdit: false`
 * stays read-only, so neither gets an edit action.
 */
export function isCodexModelProviderEditable(provider: CodexModelProviderSummary): boolean {
  if (!provider.canEdit) return false;
  if (provider.settings.type === 'customGateway') return true;
  if (provider.settings.type === 'bedrock') return bedrockTarget(provider.id) !== null;
  return provider.settings.type === 'gcp' && provider.id === 'gcp';
}

/** Bedrock patches may only name one of Codex's own two Bedrock service ids. */
function bedrockTarget(id: string): 'amazon-bedrock' | 'amazon-bedrock-runtime' | null {
  return id === 'amazon-bedrock' || id === 'amazon-bedrock-runtime' ? id : null;
}

/** Stored values the form starts from; a create starts empty. */
function initialValues(provider: CodexModelProviderSummary | null): EditorValues {
  const values: EditorValues = { name: '', baseUrl: '', envKey: '', profile: '', region: '', projectId: '', location: '', credentialFile: '' };
  if (!provider) return values;
  values.name = provider.name;
  values.baseUrl = provider.baseUrl ?? '';
  const settings = provider.settings;
  if (settings.type === 'customGateway') {
    // An externally configured credential has no editable value here; its
    // `envKey` is only shown as a hint and is sent only if the user types one.
    values.envKey = settings.auth.mode === 'none' ? '' : settings.auth.envKey ?? '';
  } else if (settings.type === 'bedrock') {
    values.profile = settings.profile ?? '';
    values.region = settings.region ?? '';
  } else if (settings.type === 'gcp') {
    values.projectId = settings.projectId ?? '';
    values.location = settings.location ?? '';
    values.credentialFile = settings.credentialFile ?? '';
  }
  return values;
}

/**
 * Native writes treat an omitted field as "keep" and `null` as "clear", so an
 * untouched field must be left out and an emptied one must be sent as null.
 */
function changedField(initial: string, next: string): string | null | undefined {
  const value = next.trim();
  if (value === initial.trim()) return undefined;
  return value === '' ? null : value;
}

/** Only the fields the user actually edited reach the native write request. */
function buildPatch(provider: CodexModelProviderSummary | null, values: EditorValues): CodexModelProviderPatch | null {
  const initial = initialValues(provider);
  if (!provider) {
    const patch: Extract<CodexModelProviderPatch, { type: 'customGateway' }> = { type: 'customGateway' };
    if (values.name.trim()) patch.name = values.name.trim();
    if (values.baseUrl.trim()) patch.baseUrl = values.baseUrl.trim();
    if (values.envKey.trim()) patch.envKey = values.envKey.trim();
    return patch;
  }
  if (provider.settings.type === 'customGateway') {
    const patch: Extract<CodexModelProviderPatch, { type: 'customGateway' }> = { type: 'customGateway', providerId: provider.id };
    const name = changedField(initial.name, values.name);
    if (name) patch.name = name;
    const baseUrl = changedField(initial.baseUrl, values.baseUrl);
    if (baseUrl !== undefined) patch.baseUrl = baseUrl;
    const envKey = changedField(initial.envKey, values.envKey);
    if (envKey !== undefined) patch.envKey = envKey;
    return patch;
  }
  if (provider.settings.type === 'bedrock') {
    const target = bedrockTarget(provider.id);
    if (!target) return null;
    const patch: Extract<CodexModelProviderPatch, { type: 'bedrock' }> = { type: 'bedrock', providerId: target };
    const profile = changedField(initial.profile, values.profile);
    if (profile !== undefined) patch.profile = profile;
    const region = changedField(initial.region, values.region);
    if (region !== undefined) patch.region = region;
    return patch;
  }
  if (provider.settings.type === 'gcp' && provider.id === 'gcp') {
    const patch: Extract<CodexModelProviderPatch, { type: 'gcp' }> = { type: 'gcp', providerId: 'gcp' };
    const projectId = changedField(initial.projectId, values.projectId);
    if (projectId !== undefined) patch.projectId = projectId;
    const location = changedField(initial.location, values.location);
    if (location !== undefined) patch.location = location;
    const credentialFile = changedField(initial.credentialFile, values.credentialFile);
    if (credentialFile !== undefined) patch.credentialFile = credentialFile;
    return patch;
  }
  return null;
}

/**
 * Rendered by CodexModelProviderCard to create a custom gateway or edit the
 * fields Codex permits on one native model service. It submits only changed
 * fields and never re-sends a credential it was not asked to change.
 */
export function CodexModelProviderEditor({ provider, saving, onSave, onCancel }: CodexModelProviderEditorProps) {
  const { t } = useTranslation('settings');
  // The form's own draft; the confirmed provider stays in the card's directory.
  const [values, setValues] = useState<EditorValues>(() => initialValues(provider));
  // A custom gateway needs a name, which Codex rejects instead of defaulting.
  const [nameMissing, setNameMissing] = useState(false);
  const isCredentialHint = provider?.settings.type === 'customGateway' && provider.settings.auth.mode === 'externallyConfigured';
  const kind = provider?.settings.type ?? 'customGateway';

  const field = (key: keyof EditorValues, label: string, options: { hint?: string; readOnly?: boolean } = {}) => (
    <label className="block text-sm">
      <span className="font-medium text-gray-900 dark:text-gray-100">{label}</span>
      <Input
        aria-label={label}
        className="mt-1"
        disabled={saving || options.readOnly}
        onChange={(event) => { setValues((old) => ({ ...old, [key]: event.target.value })); setNameMissing(false); }}
        value={values[key]}
      />
      {options.hint && <span className="mt-1 block text-xs text-muted-foreground">{options.hint}</span>}
    </label>
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === 'customGateway' && !values.name.trim()) {
      setNameMissing(true);
      return;
    }
    const patch = buildPatch(provider, values);
    if (!patch) return;
    // Nothing changed: closing is enough, and it skips a pointless config write.
    if (Object.keys(patch).every((key) => key === 'type' || key === 'providerId')) {
      onCancel();
      return;
    }
    onSave(patch);
  };

  return (
    <form className="mt-3 space-y-3 rounded-md border border-border/60 p-3" data-testid="codex-model-provider-editor" onSubmit={submit}>
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {provider ? t('agents.modelProvider.editTitle', { name: provider.name }) : t('agents.modelProvider.createTitle')}
      </div>

      {kind === 'customGateway' && field('name', t('agents.modelProvider.name'))}
      {kind === 'customGateway' && field('baseUrl', t('agents.modelProvider.baseUrl'))}
      {kind === 'customGateway' && field('envKey', t('agents.modelProvider.envKey'), {
        // An externally configured credential belongs to another layer: it is
        // shown for context and stays unchanged, while every other field edits.
        readOnly: isCredentialHint,
        hint: isCredentialHint
          ? t('agents.modelProvider.envKeyExternallyConfigured')
          : provider === null ? t('agents.modelProvider.envKeyOptional') : undefined,
      })}

      {kind === 'bedrock' && field('profile', t('agents.modelProvider.profile'))}
      {kind === 'bedrock' && field('region', t('agents.modelProvider.region'))}

      {kind === 'gcp' && field('projectId', t('agents.modelProvider.projectId'))}
      {kind === 'gcp' && field('location', t('agents.modelProvider.location'))}
      {kind === 'gcp' && field('credentialFile', t('agents.modelProvider.credentialFile'))}

      {nameMissing && <div className="text-sm text-red-600 dark:text-red-400">{t('agents.modelProvider.nameRequired')}</div>}

      <div className="flex gap-2">
        <Button disabled={saving} size="sm" type="submit">
          {saving ? t('agents.modelProvider.saving') : t('agents.modelProvider.save')}
        </Button>
        <Button disabled={saving} onClick={onCancel} size="sm" type="button" variant="outline">
          {t('agents.modelProvider.cancel')}
        </Button>
      </div>
    </form>
  );
}
