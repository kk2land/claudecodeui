import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ProviderSkill, ProviderSkillCreateEntryPayload, SkillsProject, SkillsProvider, SkillsScope } from '@/shared/types';

type ProviderSkillCreatePayload = {
  entries: ProviderSkillCreateEntryPayload[];
};

type ProviderSkillsResponse = {
  provider: SkillsProvider;
  skills: Array<Partial<ProviderSkill>>;
};

type ApiSuccessResponse<T> = {
  success: true;
  data: T;
};

type ApiErrorResponse = {
  success: false;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

type SkillsCacheEntry = {
  skills: ProviderSkill[];
  updatedAt: number;
};

type ProjectTarget = {
  projectId: string;
  displayName: string;
  path: string;
};

const SKILLS_CACHE_TTL_MS = 5 * 60_000;
const skillsCache = new Map<string, SkillsCacheEntry>();

const SKILL_SCOPE_ORDER: Record<SkillsScope, number> = {
  user: 0,
  plugin: 1,
  repo: 2,
  project: 3,
  admin: 4,
  system: 5,
};

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  const details = record.details;
  if (typeof details === 'string' && details.trim()) {
    return details;
  }

  return fallback;
};

const isSkillsScope = (value: unknown): value is SkillsScope => (
  value === 'user'
  || value === 'project'
  || value === 'plugin'
  || value === 'repo'
  || value === 'admin'
  || value === 'system'
);

const normalizeScope = (value: unknown): SkillsScope => (
  isSkillsScope(value) ? value : 'user'
);

const createProjectTargets = (projects: SkillsProject[]): ProjectTarget[] => {
  const seenPaths = new Set<string>();

  const targets = projects.reduce<ProjectTarget[]>((acc, project) => {
    const projectPath = project.fullPath || project.path || '';
    if (!projectPath || seenPaths.has(projectPath)) {
      return acc;
    }

    seenPaths.add(projectPath);
    acc.push({
      projectId: project.projectId,
      displayName: project.displayName || project.projectId,
      path: projectPath,
    });
    return acc;
  }, []);

  return targets.sort((left, right) => left.path.localeCompare(right.path));
};

const normalizeSkill = (
  provider: SkillsProvider,
  skill: Partial<ProviderSkill>,
  project?: ProjectTarget,
): ProviderSkill => {
  const scope = normalizeScope(skill.scope);
  const shouldAttachProject = scope === 'project' || scope === 'repo';

  return {
    provider,
    name: String(skill.name ?? ''),
    description: String(skill.description ?? ''),
    command: String(skill.command ?? ''),
    scope,
    sourcePath: String(skill.sourcePath ?? ''),
    pluginName: typeof skill.pluginName === 'string' ? skill.pluginName : undefined,
    pluginId: typeof skill.pluginId === 'string' ? skill.pluginId : undefined,
    // Only an explicit boolean means the provider persists enablement; the UI
    // renders a switch exactly when this is a boolean.
    enabled: typeof skill.enabled === 'boolean' ? skill.enabled : undefined,
    projectDisplayName: shouldAttachProject
      ? project?.displayName ?? skill.projectDisplayName
      : skill.projectDisplayName,
    projectPath: shouldAttachProject
      ? project?.path ?? skill.projectPath
      : skill.projectPath,
  };
};

const getSkillIdentity = (skill: ProviderSkill): string => (
  [
    skill.provider,
    skill.scope,
    skill.command,
    skill.sourcePath || 'no-source-path',
    skill.projectPath || 'global',
  ].join(':')
);

const sortSkills = (skills: ProviderSkill[]): ProviderSkill[] => (
  [...skills].sort((left, right) => {
    const scopeDelta = SKILL_SCOPE_ORDER[left.scope] - SKILL_SCOPE_ORDER[right.scope];
    if (scopeDelta !== 0) {
      return scopeDelta;
    }

    const projectDelta = (left.projectDisplayName || '').localeCompare(right.projectDisplayName || '');
    if (projectDelta !== 0) {
      return projectDelta;
    }

    return left.command.localeCompare(right.command);
  })
);

const mergeSkills = (
  existingSkills: ProviderSkill[],
  incomingSkills: ProviderSkill[],
): ProviderSkill[] => {
  const skillsById = new Map<string, ProviderSkill>();
  existingSkills.forEach((skill) => {
    skillsById.set(getSkillIdentity(skill), skill);
  });
  incomingSkills.forEach((skill) => {
    skillsById.set(getSkillIdentity(skill), skill);
  });

  return sortSkills([...skillsById.values()]);
};

const fetchProviderSkills = async (
  provider: SkillsProvider,
  project?: ProjectTarget,
): Promise<ProviderSkill[]> => {
  const response = await api.providers.skills(provider, { workspacePath: project?.path });
  const data = await toResponseJson<ApiResponse<ProviderSkillsResponse>>(response);
  if (!response.ok || !data.success) {
    throw new Error(getApiErrorMessage(data, `Failed to load ${provider} skills`));
  }

  return (data.data.skills || []).map((skill) => normalizeSkill(provider, skill, project));
};

const saveProviderSkills = async (
  provider: SkillsProvider,
  payload: ProviderSkillCreatePayload,
): Promise<ProviderSkill[]> => {
  const response = await api.providers.saveSkills(provider, payload);
  const data = await toResponseJson<ApiResponse<ProviderSkillsResponse>>(response);
  if (!response.ok || !data.success) {
    throw new Error(getApiErrorMessage(data, 'Failed to save skills'));
  }

  return (data.data.skills || []).map((skill) => normalizeSkill(provider, skill));
};

const getCacheKey = (provider: SkillsProvider, projects: ProjectTarget[]): string => {
  const projectKey = JSON.stringify(projects);
  return `${provider}:${projectKey}`;
};

const clearProviderSkillCache = (provider: SkillsProvider): void => {
  for (const cacheKey of [...skillsCache.keys()]) {
    if (cacheKey.startsWith(`${provider}:`)) {
      skillsCache.delete(cacheKey);
    }
  }
};

/**
 * Writes one skill's enabled flag and returns the normalized result.
 *
 * The server echoes the skill file path it wrote, which the hook uses to
 * update only that row instead of refetching every scope.
 */
const saveSkillEnabled = async (
  provider: SkillsProvider,
  sourcePath: string,
  enabled: boolean,
): Promise<{ sourcePath: string; enabled: boolean }> => {
  const response = await api.providers.setSkillEnabled(provider, { sourcePath, enabled });
  const data = await toResponseJson<ApiResponse<{
    provider: SkillsProvider;
    sourcePath: string;
    enabled: boolean;
  }>>(response);
  if (!response.ok || !data.success) {
    throw new Error(getApiErrorMessage(data, 'Failed to update the skill'));
  }

  return { sourcePath: data.data.sourcePath, enabled: data.data.enabled };
};

type UseProviderSkillsArgs = {
  selectedProvider: SkillsProvider;
  currentProjects: SkillsProject[];
};

export function useProviderSkills({ selectedProvider, currentProjects }: UseProviderSkillsArgs) {
  const [skills, setSkills] = useState<ProviderSkill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingProjectScopes, setIsLoadingProjectScopes] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  // Holds both enablement transient states: the skill files whose request is in
  // flight (their switch is disabled, which prevents duplicate submissions) and
  // the last failure so the affected row can explain why it kept its value.
  const [skillToggleState, setSkillToggleState] = useState<{ updatingPaths: string[]; error: string | null }>({
    updatingPaths: [],
    error: null,
  });
  const activeLoadIdRef = useRef(0);
  // Mirrors the provider the rendered state belongs to; requests started under
  // a previous provider compare against it before touching state or cache.
  const activeProviderRef = useRef(selectedProvider);
  useEffect(() => {
    activeProviderRef.current = selectedProvider;
  }, [selectedProvider]);
  // Bumped by every completed toggle. A list load captures the value when it
  // starts and refuses to publish anything once it changed, which keeps a late
  // response from overwriting the just-written enablement in state and cache.
  const skillsVersionRef = useRef(new Map<SkillsProvider, number>());
  // Names the load currently allowed to publish, so a toggle knows whether it
  // has to schedule a fresh load to recover data the invalidated one dropped.
  const inFlightLoadRef = useRef<{ loadId: number; provider: SkillsProvider } | null>(null);
  // Counts in-flight toggles per provider-scoped pending key. Counting (rather
  // than a flag) keeps one settled request from clearing the marker of another
  // request for the same path, even after a provider switch and switch back.
  const pendingToggleCountsRef = useRef(new Map<string, number>());
  // Always points at the newest `refreshSkills`, whose identity changes when
  // the project set changes. A toggle that settles later must recover the lost
  // load with the current projects, not the ones captured when it started.
  const latestRefreshSkillsRef = useRef<((options?: { force?: boolean }) => Promise<void>) | null>(null);

  const serializedProjectTargets = JSON.stringify(createProjectTargets(currentProjects));
  const projectTargets = useMemo<ProjectTarget[]>(
    () => JSON.parse(serializedProjectTargets) as ProjectTarget[],
    [serializedProjectTargets],
  );
  const cacheKey = useMemo(() => getCacheKey(selectedProvider, projectTargets), [projectTargets, selectedProvider]);

  const refreshSkills = useCallback(async (options: { force?: boolean } = {}) => {
    const loadId = activeLoadIdRef.current + 1;
    activeLoadIdRef.current = loadId;
    const providerAtLoad = selectedProvider;
    const versionAtLoad = skillsVersionRef.current.get(providerAtLoad) ?? 0;
    inFlightLoadRef.current = { loadId, provider: providerAtLoad };

    // A load may publish only while it is both the newest one and still based
    // on the enablement version it started with.
    const isCurrentLoad = (): boolean => (
      activeLoadIdRef.current === loadId
      && (skillsVersionRef.current.get(providerAtLoad) ?? 0) === versionAtLoad
    );
    const finishLoad = (): void => {
      if (inFlightLoadRef.current?.loadId === loadId) {
        inFlightLoadRef.current = null;
      }
    };

    const cachedEntry = skillsCache.get(cacheKey);
    const canUseCache = !options.force && cachedEntry && Date.now() - cachedEntry.updatedAt < SKILLS_CACHE_TTL_MS;
    if (canUseCache) {
      finishLoad();
      setSkills(cachedEntry.skills);
      setIsLoading(false);
      setIsLoadingProjectScopes(false);
      setLoadError(null);
      return;
    }

    if (cachedEntry) {
      setSkills(cachedEntry.skills);
    } else {
      setSkills([]);
    }

    setIsLoading(Boolean(options.force) || !cachedEntry);
    setIsLoadingProjectScopes(false);
    setLoadError(null);

    let nextSkills = cachedEntry && !options.force ? cachedEntry.skills : [];
    let firstError: string | null = null;

    try {
      const globalSkills = await fetchProviderSkills(selectedProvider);
      if (!isCurrentLoad()) {
        finishLoad();
        return;
      }

      nextSkills = mergeSkills(nextSkills, globalSkills);
      setSkills(nextSkills);
    } catch (error) {
      firstError = error instanceof Error ? error.message : 'Failed to load skills';
    }

    if (!isCurrentLoad()) {
      finishLoad();
      return;
    }

    setIsLoading(false);

    if (projectTargets.length === 0) {
      const finalSkills = sortSkills(nextSkills);
      skillsCache.set(cacheKey, { skills: finalSkills, updatedAt: Date.now() });
      setSkills(finalSkills);
      setLoadError(firstError);
      finishLoad();
      return;
    }

    setIsLoadingProjectScopes(true);

    await Promise.all(projectTargets.map(async (project) => {
      try {
        const projectSkills = await fetchProviderSkills(selectedProvider, project);
        if (!isCurrentLoad()) {
          return;
        }

        nextSkills = mergeSkills(nextSkills, projectSkills);
        setSkills(nextSkills);
      } catch (error) {
        firstError = firstError || (error instanceof Error ? error.message : 'Failed to load skills');
      }
    }));

    if (!isCurrentLoad()) {
      finishLoad();
      return;
    }

    const finalSkills = sortSkills(nextSkills);
    skillsCache.set(cacheKey, { skills: finalSkills, updatedAt: Date.now() });
    setSkills(finalSkills);
    setLoadError(firstError);
    setIsLoadingProjectScopes(false);
    finishLoad();
  }, [cacheKey, projectTargets, selectedProvider]);

  // Assigned from an effect, not during render (refs must not be touched while
  // rendering). Effects flush before any awaited response can resume, so a
  // toggle settling after a project-set change still recovers the dropped load
  // with the newest targets rather than the ones captured when it started.
  useEffect(() => {
    latestRefreshSkillsRef.current = refreshSkills;
  }, [refreshSkills]);

  const addSkills = useCallback(async (payload: ProviderSkillCreatePayload) => {
    try {
      const createdSkills = await saveProviderSkills(selectedProvider, payload);
      clearProviderSkillCache(selectedProvider);
      await refreshSkills({ force: true });
      setSaveStatus('success');
      return createdSkills;
    } catch (error) {
      setSaveStatus('error');
      throw error;
    }
  }, [refreshSkills, selectedProvider]);

  /**
   * Persists one skill's enabled flag.
   *
   * The write is committed to that provider's cache even when the user has
   * switched providers meanwhile, so switching back cannot show the old value.
   * Visible state, the error message and the pending marker are only touched
   * while the request's provider is still the selected one. A concurrent list
   * load is invalidated by bumping the provider's version; the hook then starts
   * a fresh, load-id-guarded fetch so the visible list reflects the write.
   */
  const setSkillEnabled = useCallback(async (sourcePath: string, enabled: boolean) => {
    const providerAtRequest = selectedProvider;
    const pendingKey = `${providerAtRequest}:${sourcePath}`;
    const pendingCounts = pendingToggleCountsRef.current;
    // A second toggle for the same row is ignored, not queued: the first write
    // is still authoritative and a duplicate would only race it in the config.
    if ((pendingCounts.get(pendingKey) ?? 0) > 0) {
      return;
    }
    pendingCounts.set(pendingKey, 1);
    setSkillToggleState((previous) => ({
      updatingPaths: previous.updatingPaths.includes(pendingKey)
        ? previous.updatingPaths
        : [...previous.updatingPaths, pendingKey],
      error: null,
    }));

    try {
      const result = await saveSkillEnabled(providerAtRequest, sourcePath, enabled);

      const applyEnabled = (skill: ProviderSkill): ProviderSkill => (
        skill.provider === providerAtRequest && skill.sourcePath === result.sourcePath
          ? { ...skill, enabled: result.enabled }
          : skill
      );

      // Bump first: any list response already in flight for this provider was
      // based on the pre-write state and must never be published.
      skillsVersionRef.current.set(
        providerAtRequest,
        (skillsVersionRef.current.get(providerAtRequest) ?? 0) + 1,
      );
      for (const [cacheKey, entry] of skillsCache.entries()) {
        if (cacheKey.startsWith(`${providerAtRequest}:`)) {
          skillsCache.set(cacheKey, {
            skills: entry.skills.map(applyEnabled),
            updatedAt: Date.now(),
          });
        }
      }

      if (activeProviderRef.current !== providerAtRequest) {
        // Not the visible list; nothing else to schedule. The cache write above
        // is what keeps the next switch back correct.
        return;
      }

      setSkills((previous) => previous.map(applyEnabled));

      // The invalidated response was dropped, so recover its data with the
      // newest loader (current projects), which can never request the provider
      // that was switched away from.
      if (inFlightLoadRef.current?.provider === providerAtRequest) {
        void (latestRefreshSkillsRef.current ?? refreshSkills)({ force: true });
      }
    } catch (error) {
      if (activeProviderRef.current === providerAtRequest) {
        setSkillToggleState((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : 'Failed to update the skill',
        }));
      }
      throw error;
    } finally {
      // Duplicates return before registering, so this key has exactly one
      // in-flight request. Deleting it is safe even while another provider is
      // selected: keys carry the provider and the marker is rebuilt on switch.
      pendingCounts.delete(pendingKey);
      setSkillToggleState((previous) => ({
        ...previous,
        updatingPaths: previous.updatingPaths.filter((path) => path !== pendingKey),
      }));
    }
  }, [refreshSkills, selectedProvider]);

  useEffect(() => {
    void refreshSkills();

    return () => {
      activeLoadIdRef.current += 1;
    };
  }, [refreshSkills]);

  useEffect(() => {
    setSaveStatus(null);
    // Pending markers belong to the visible provider: rebuild them from the
    // in-flight registry so switching away and back re-locks rows whose write
    // has not settled yet instead of letting them be toggled twice.
    const providerPrefix = `${selectedProvider}:`;
    setSkillToggleState({
      updatingPaths: [...pendingToggleCountsRef.current.keys()]
        .filter((key) => key.startsWith(providerPrefix)),
      error: null,
    });
  }, [selectedProvider]);

  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 6000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  return {
    skills,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    saveStatus,
    updatingSkillPaths: skillToggleState.updatingPaths,
    skillToggleError: skillToggleState.error,
    addSkills,
    refreshSkills,
    setSkillEnabled,
  };
}
