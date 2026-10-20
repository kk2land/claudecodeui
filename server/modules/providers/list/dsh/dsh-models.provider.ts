import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseDocument } from 'yaml';

import type { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import type { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type {
  IProviderModels,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/index.js';
import { readObjectRecord, readOptionalString } from '@/shared/index.js';

/**
 * Applies this file's static entry patches before collecting models. IDs not
 * declared in inserts or group configs are projected as bundle-owned roots:
 * their baseline is unknown, but overrides and disabled state apply in order.
 */
function composePatchEntries(patches: unknown[]): Record<string, unknown>[] {
  const roots: Record<string, unknown>[] = [];
  const entriesById = new Map<string, Record<string, unknown>>();
  const declaredIds = new Set<string>();
  const indexEntries = (rows: unknown[], collectIdsOnly = false): void => {
    for (const row of rows) {
      const entry = readObjectRecord(row);
      if (!entry) continue;
      const id = readOptionalString(entry.id);
      if (id) {
        if (collectIdsOnly) declaredIds.add(id);
        else entriesById.set(id, entry);
      }
      if (entry.group === true && Array.isArray(entry.config)) indexEntries(entry.config, collectIdsOnly);
    }
  };
  for (const patch of patches) {
    const entry = readObjectRecord(patch);
    const insert = entry?.insert;
    if (Array.isArray(insert)) indexEntries(insert, true);
    // Children in replacement group configs are local declarations too, not
    // unknown bundle roots. Cordis does not index them as patch targets.
    if (Array.isArray(entry?.config)) indexEntries(entry.config, true);
  }
  for (const patch of patches) {
    const entry = readObjectRecord(patch);
    const id = readOptionalString(entry?.id);
    if (!entry || Array.isArray(entry.insert) || !id || declaredIds.has(id) || entriesById.has(id)) continue;
    const root: Record<string, unknown> = { id, name: entry.name };
    roots.push(root);
    entriesById.set(id, root);
  }

  for (const patch of patches) {
    const entry = readObjectRecord(patch);
    if (!entry) continue;
    const id = readOptionalString(entry.id);
    if (Array.isArray(entry.insert)) {
      let destination = roots;
      if (id) {
        const group = entriesById.get(id);
        if (!group || group.group !== true) continue;
        if (!Array.isArray(group.config)) group.config = [];
        destination = group.config as Record<string, unknown>[];
      }
      const inserted = entry.insert.map(readObjectRecord).filter((row): row is Record<string, unknown> => row !== null);
      destination.push(...inserted);
      indexEntries(inserted);
      continue;
    }
    if (!id) continue;
    const target = entriesById.get(id);
    if (!target) continue;
    if (entry.name && entry.name !== target.name && (declaredIds.has(id) || target.name !== undefined)) continue;
    // `name` asserts identity rather than renaming an entry. A projected bundle
    // root can acquire that assertion when a later patch supplies it.
    target.name ??= entry.name;
    for (const key of ['config', 'disabled', 'group']) {
      if (Object.hasOwn(entry, key)) target[key] = entry[key];
    }
    // Cordis replaces the entire config, including a group's children. It
    // indexes inserted children only; replacement children are not new targets.
  }
  return roots;
}

/**
 * Projects static provider declarations from the headless patch into picker rows.
 * This does not execute Cordis expressions or resolve bundles/CLI patch overlays;
 * the selected runtime still validates availability before sending the prompt.
 */
function readPatchModels(entries: unknown[]): ProviderModelOption[] {
  const models = new Map<string, ProviderModelOption>();
  const effortLevels = providerCapabilitiesService.getProviderCapabilities('dsh').effortLevels;
  const visit = (rows: unknown[]): void => {
    for (const row of rows) {
      const entry = readObjectRecord(row);
      if (!entry || (entry.disabled !== undefined && entry.disabled !== false)) continue;
      if (entry.group === true) {
        if (Array.isArray(entry.config)) visit(entry.config);
        continue;
      }

      const providers = readObjectRecord(readObjectRecord(entry.config)?.providers);
      for (const [provider, value] of Object.entries(providers ?? {})) {
        const providerId = readOptionalString(provider);
        const configuredModels = readObjectRecord(value)?.models;
        if (!providerId || !Array.isArray(configuredModels)) continue;

        for (const configuredModel of configuredModels) {
          const model = readObjectRecord(configuredModel);
          const id = readOptionalString(model?.id);
          if (!id) continue;
          const reasoningEfforts = readObjectRecord(model?.reasoningEfforts);
          // Keys are DSH effort names; values are adapter wire mappings such as
          // off -> none, which must never become selectable effort identifiers.
          const values = effortLevels.filter((level) => {
            const wire = reasoningEfforts?.[level];
            return typeof wire === 'string' && wire.trim().length > 0
              || level === 'off' && wire === null;
          }).map((value) => ({ value }));
          const reference = `${providerId}/${id}`;
          models.set(reference, {
            value: reference,
            label: readOptionalString(model?.name) ?? id,
            description: providerId,
            ...(values.length ? { effort: { values } } : {}),
          });
        }
      }
    }
  };
  visit(composePatchEntries(entries));
  return [...models.values()];
}

/** Used by the Providers module to list configured DSH models and resolve session selections. */
export class DshModelsProvider implements IProviderModels {
  constructor(
    private readonly store: Pick<DshSessionStore, 'find'>,
    private readonly configuration: DshConfigurationProvider,
  ) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const definition: ProviderModelsDefinition = {
      DEFAULT: 'default',
      OPTIONS: [{
        value: 'default',
        label: 'Profile default',
        description: 'Use the model configured in the active DSH profile.',
      }],
    };
    const patchPath = path.join(this.configuration.read().home, 'profiles', 'headless', 'cordis.patch.yml');
    try {
      // Read on each catalog request so a profile edit appears on the next
      // refresh without restarting CloudCLI or copying models into SQLite.
      const document = parseDocument(await readFile(patchPath, 'utf8'));
      if (document.errors.length || document.warnings.length) throw new Error('Invalid DSH model patch.');
      const entries: unknown = document.toJS();
      if (entries !== null && !Array.isArray(entries)) throw new Error('Expected a DSH patch array.');
      definition.OPTIONS.push(...readPatchModels(entries ?? []));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // YAML diagnostics can contain source excerpts with API keys. Report
        // only the path and keep the default/custom model picker available.
        console.warn('[DSH] Could not read configured models from', patchPath);
      }
    }
    return definition;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId) {
      const log = await this.store.find(sessionId);
      const selected = log?.events.slice().reverse().find((event) => event.type === 'model/selection')?.data;
      if (selected?.provider && selected?.model) return { model: `${selected.provider}/${selected.model}` };
    }
    return { model: 'default' };
  }
}
