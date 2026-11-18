import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import { CODEX_MODEL_PROVIDERS_CHANGED_EVENT } from '@/shared/constants';
import type {
  CodexBranchForkResult,
  CodexControls,
  CodexModelCatalog,
  CodexModelProviderControls,
  CodexModelProviders,
  ProviderModelOption,
} from '@/shared/types';

/** Body of a fork request; only the fields this hook reads are typed. */
type ForkResponseBody = {
  data?: { sessionId?: unknown };
  error?: { code?: unknown; message?: unknown };
  message?: unknown;
};

/** ChatInterface exposes the saved service and its model catalog to Codex settings and the composer. */
export function useCodexModelProviders({ enabled, controls, model, onSessionForked }: {
  enabled: boolean;
  controls: CodexControls;
  model: string;
  /** The app's own catalog for this provider; native metadata is authoritative, so it is accepted but not consulted. */
  knownModels: ProviderModelOption[];
  /** ChatInterface opens the new branch; the source conversation is never navigated away from on failure. */
  onSessionForked: (sessionId: string) => void;
}): CodexModelProviderControls {
  // The directory determines whether this installation has any extra services to expose.
  const [directory, setDirectory] = useState<CodexModelProviders | null>(null);
  // A directory read failure is reported without discarding the last confirmed directory.
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  // Native catalogs supply model ids with their own label, description and
  // reasoning-effort choices; HTTP freshness is owned by the server's cache.
  const [catalogs, setCatalogs] = useState<Record<string, CodexModelCatalog>>({});
  // Loading belongs to a service so a late response cannot repaint another service's menu.
  const [loadingProviders, setLoadingProviders] = useState<Set<string>>(new Set());
  // Endpoint failures leave the selected service/model unchanged and appear inside the model menu.
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const selection = enabled ? controls.state?.modelSelection : undefined;
  const activeSelection = enabled ? controls.state?.activeModelSelection : undefined;
  // A saved selection naming another service can only be a branch target: the
  // native thread keeps its own route, so the composer shows what really runs
  // and the settings recover the target from `selection`.
  const pendingBranchTarget = Boolean(selection && activeSelection && selection.modelProvider !== activeSelection.modelProvider);
  const appliedSelection = pendingBranchTarget ? activeSelection : selection;
  const modelProvider = appliedSelection?.modelProvider ?? activeSelection?.modelProvider ?? directory?.defaultProvider ?? 'openai';
  const available = enabled && directory?.hasCustomProviders === true;

  const refresh = useCallback(async () => {
    try {
      const response = await api.providers.codexModelProviders();
      const body = await response.json() as { success: boolean; data: CodexModelProviders; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? 'Could not read Codex model providers.');
      setDirectory(body.data);
      setDirectoryError(null);
    } catch (cause) {
      // Keep the confirmed directory so a failed refresh cannot blank the
      // selected service or its models; the reason stays visible instead.
      setDirectoryError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, []);

  const loadModels = useCallback(async (id: string) => {
    setLoadingProviders((old) => new Set(old).add(id));
    setErrors((old) => ({ ...old, [id]: null }));
    try {
      const response = await api.providers.codexModelProviderModels(id);
      const body = await response.json() as { success: boolean; data: CodexModelCatalog; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? 'Could not load this service’s models.');
      // A service with no models is a real, empty catalog: keep it so the menu
      // can say so instead of staying on "loading" forever.
      setCatalogs((old) => ({ ...old, [id]: { modelProvider: id, models: body.data.models, items: body.data.items ?? [] } }));
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
    queueMicrotask(() => { if (active && enabled) void refresh().catch(() => {}); });
    return () => { active = false; };
  }, [enabled, controls.sessionId, refresh]);

  // Settings saves announce the new default; re-read it so the next new
  // conversation follows the value the server confirmed. The same service's
  // catalog is re-read too, so an edited endpoint is not left on stale models.
  useEffect(() => {
    if (!enabled) return;
    const onChanged = () => {
      void refresh().catch(() => {});
      void loadModels(modelProvider).catch(() => {});
    };
    window.addEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, onChanged);
  }, [enabled, refresh, loadModels, modelProvider]);

  // The built-in OpenAI service also has a native catalog, so this loads for
  // every native Codex session; extra services only widen the picker. The
  // directory is read first because it owns which service a new chat starts on.
  const directoryLoaded = directory !== null;
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active && enabled && directoryLoaded) void loadModels(modelProvider).catch(() => {}); });
    return () => { active = false; };
  }, [enabled, directoryLoaded, modelProvider, loadModels]);

  // The model the composer really shows: a saved or applied selection, else the
  // caller's current model. It decides whether a hidden catalog row is needed.
  const shownModel = appliedSelection ? appliedSelection.model ?? '' : model;

  const modelOptionsFor = useCallback((id: string) => {
    // Outside native Codex nothing here is rendered; a stale catalog must never
    // leak another provider's models or effort levels into the composer.
    if (!enabled) return null;
    const catalog = catalogs[id];
    if (!catalog) return null;
    const described = new Map(catalog.items.map((item) => [item.value, item]));
    // Native metadata is authoritative per service: two services listing the
    // same model id keep their own label, description and effort levels, and an
    // empty native effort list stays empty rather than borrowing fallback levels.
    const options = catalog.models.map((modelId) => {
      const item = described.get(modelId);
      // An id without a catalog row shows the id itself; no label or effort is invented for it.
      if (!item) return { value: modelId, label: modelId };
      return { value: item.value, label: item.label, description: item.description, effort: item.effort };
    });
    // A saved conversation can keep running a model the service has since hidden
    // from its picker. Only this service's current selection is described here,
    // so the composer can still show its label and effort; no other hidden row
    // and no other service's hidden row becomes selectable.
    if (id === modelProvider && shownModel && !catalog.models.includes(shownModel)) {
      const item = described.get(shownModel);
      if (item?.hidden) options.push({ value: item.value, label: item.label, description: item.description, effort: item.effort });
    }
    return options;
  }, [enabled, catalogs, modelProvider, shownModel]);

  const modelOptions = useMemo(() => modelOptionsFor(modelProvider), [modelOptionsFor, modelProvider]);

  const control = controls.control;
  const select = useCallback((id: string, nextModel: string | null) => control({
    action: 'model-provider', modelProvider: id, model: nextModel,
  }), [control]);

  const sourceSessionId = controls.sessionId;
  const forkWithHistory = useCallback(async (target: { modelProvider: string; model: string }): Promise<CodexBranchForkResult> => {
    if (!sourceSessionId) return { ok: false, code: null, message: 'Open a saved conversation before branching.' };
    try {
      // Full history: no anchor is sent, so the copy carries every turn. The
      // source's saved selection stays exactly as it is.
      const response = await api.forkSession(sourceSessionId, { codexModelSelection: target });
      const body = await response.json().catch(() => null) as ForkResponseBody | null;
      const forkedSessionId = body?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        const failureCode = body?.error?.code;
        const failureMessage = body?.error?.message ?? body?.message;
        return {
          ok: false,
          code: typeof failureCode === 'string' && failureCode ? failureCode : null,
          message: typeof failureMessage === 'string' && failureMessage ? failureMessage : `HTTP ${response.status}`,
        };
      }
      onSessionForked(forkedSessionId);
      return { ok: true, sessionId: forkedSessionId };
    } catch (error) {
      return { ok: false, code: null, message: error instanceof Error ? error.message : String(error) };
    }
  }, [onSessionForked, sourceSessionId]);

  return { available, providers: directory?.providers ?? [], modelProvider, selection, appliedSelection, activeSelection,
    model: appliedSelection ? appliedSelection.model ?? '' : model, modelOptions, modelOptionsFor, loading: loadingProviders.has(modelProvider),
    pending: controls.pending, error: errors[modelProvider] ?? directoryError, refresh, loadModels, select, forkWithHistory };
}
