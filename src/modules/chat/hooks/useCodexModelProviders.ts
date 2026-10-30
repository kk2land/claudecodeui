import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import { CODEX_MODEL_PROVIDERS_CHANGED_EVENT } from '@/shared/constants';
import type { CodexControls, CodexModelProviderControls, CodexModelProviders, ProviderModelOption } from '@/shared/types';

/** ChatInterface exposes the saved service and its model catalog to Codex settings and the composer. */
export function useCodexModelProviders({ enabled, controls, model, knownModels }: {
  enabled: boolean;
  controls: CodexControls;
  model: string;
  knownModels: ProviderModelOption[];
}): CodexModelProviderControls {
  // The directory determines whether this installation has any extra services to expose.
  const [directory, setDirectory] = useState<CodexModelProviders | null>(null);
  // Loaded ids supply the active selector; HTTP freshness is owned by the server's 60-second cache.
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});
  // Loading belongs to a service so a late response cannot repaint another service's menu.
  const [loadingProviders, setLoadingProviders] = useState<Set<string>>(new Set());
  // Endpoint failures leave the selected service/model unchanged and appear inside the model menu.
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const selection = enabled ? controls.state?.modelSelection : undefined;
  const activeSelection = enabled ? controls.state?.activeModelSelection : undefined;
  const modelProvider = selection?.modelProvider ?? activeSelection?.modelProvider ?? directory?.defaultProvider ?? 'openai';
  const available = enabled && directory?.hasCustomProviders === true;

  const refresh = useCallback(async () => {
    const response = await api.providers.codexModelProviders();
    const body = await response.json() as { success: boolean; data: CodexModelProviders; error?: { message?: string } };
    if (!response.ok || !body.success) throw new Error(body.error?.message ?? 'Could not read Codex model providers.');
    setDirectory(body.data);
  }, []);

  const loadModels = useCallback(async (id: string) => {
    setLoadingProviders((old) => new Set(old).add(id));
    setErrors((old) => ({ ...old, [id]: null }));
    try {
      const response = await api.providers.codexModelProviderModels(id);
      const body = await response.json() as { success: boolean; data: { models: string[] }; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? 'Could not load this service’s models.');
      setCatalogs((old) => ({ ...old, [id]: body.data.models }));
      return body.data.models;
    } catch (error) {
      setErrors((old) => ({ ...old, [id]: error instanceof Error ? error.message : String(error) }));
      throw error;
    } finally {
      setLoadingProviders((old) => { const next = new Set(old); next.delete(id); return next; });
    }
  }, []);

  // Session changes re-read the directory so a new conversation uses the latest
  // global default, while saved session selections still win over it below.
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active && enabled) void refresh().catch(() => setDirectory(null)); });
    return () => { active = false; };
  }, [enabled, controls.sessionId, refresh]);

  // Settings saves announce the new default; re-read it so the next new
  // conversation follows the value the server confirmed.
  useEffect(() => {
    if (!enabled) return;
    const onChanged = () => { void refresh().catch(() => setDirectory(null)); };
    window.addEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, onChanged);
  }, [enabled, refresh]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active && available) void loadModels(modelProvider).catch(() => {}); });
    return () => { active = false; };
  }, [available, modelProvider, loadModels]);

  const modelOptions = useMemo(() => {
    const ids = catalogs[modelProvider];
    if (!available || !ids) return null;
    // Keep remote ids intact and reuse known display metadata. The shared
    // provider-state controller resolves reasoning options, including fallback levels.
    return ids.map((id) => knownModels.find((option) => option.value === id) ?? { value: id, label: id });
  }, [available, catalogs, modelProvider, knownModels]);

  const control = controls.control;
  const select = useCallback((id: string, nextModel: string | null) => control({
    action: 'model-provider', modelProvider: id, model: nextModel,
  }), [control]);

  return { available, providers: directory?.providers ?? [], modelProvider, selection, activeSelection,
    model: selection ? selection.model ?? '' : model, modelOptions, loading: loadingProviders.has(modelProvider),
    pending: controls.pending, error: errors[modelProvider] ?? null, refresh, loadModels, select };
}
