import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ProviderSkill, SkillsProject } from '@/shared/types';

/**
 * The skills settings screen persists Codex enablement through this hook. The
 * tests pin three behaviours the UI depends on: the enabled flag survives
 * normalization, a successful toggle updates only the affected rows, and a
 * failure or a provider switch never rewrites the visible list.
 */

const listSkills = vi.fn();
const setSkillEnabled = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      skills: (...args: unknown[]) => listSkills(...args),
      setSkillEnabled: (...args: unknown[]) => setSkillEnabled(...args),
    },
  },
}));

const jsonResponse = (body: unknown, ok = true) => ({ ok, json: async () => body });

const skill = (overrides: Partial<ProviderSkill> = {}): ProviderSkill => ({
  provider: 'codex',
  name: 'review',
  description: 'Review code',
  command: '$review',
  scope: 'user',
  sourcePath: '/home/me/.agents/skills/review/SKILL.md',
  ...overrides,
});

const listResponse = (skills: ProviderSkill[]) => jsonResponse({
  success: true,
  data: { provider: 'codex', skills },
});

beforeEach(() => {
  listSkills.mockReset();
  setSkillEnabled.mockReset();
  vi.resetModules();
});

async function renderSkills(provider: 'codex' | 'claude' = 'codex') {
  const { useProviderSkills } = await import('@/modules/skills/hooks/useProviderSkills');
  const view = renderHook(
    ({ selectedProvider }: { selectedProvider: 'codex' | 'claude' }) => useProviderSkills({
      selectedProvider,
      currentProjects: [],
    }),
    { initialProps: { selectedProvider: provider } },
  );
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

describe('useProviderSkills enablement', () => {
  test('keeps the provider enabled flag and omits it when the provider has no setting', async () => {
    listSkills.mockResolvedValue(listResponse([
      skill({ enabled: false }),
      skill({ name: 'commit', command: '$commit', sourcePath: '/skills/commit/SKILL.md', enabled: true }),
    ]));
    const codex = await renderSkills('codex');
    const byName = new Map(codex.result.current.skills.map((entry) => [entry.name, entry.enabled]));
    expect([byName.get('review'), byName.get('commit')]).toEqual([false, true]);

    listSkills.mockResolvedValue(listResponse([skill({ provider: 'claude', command: '/review' })]));
    const claude = await renderSkills('claude');
    expect(claude.result.current.skills[0]?.enabled).toBeUndefined();
  });

  test('updates the affected skill after a successful toggle without refetching', async () => {
    listSkills.mockResolvedValue(listResponse([skill({ enabled: true })]));
    const view = await renderSkills('codex');
    setSkillEnabled.mockResolvedValue(jsonResponse({
      success: true,
      data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
    }));

    await act(async () => {
      await view.result.current.setSkillEnabled(skill().sourcePath, false);
    });

    expect(setSkillEnabled).toHaveBeenCalledWith('codex', {
      sourcePath: skill().sourcePath,
      enabled: false,
    });
    expect(view.result.current.skills[0]?.enabled).toBe(false);
    expect(view.result.current.updatingSkillPaths).toEqual([]);
    expect(view.result.current.skillToggleError).toBeNull();
    // The list already reflects the write, so no second fetch was needed.
    expect(listSkills).toHaveBeenCalledTimes(1);
  });

  test('marks the row saving while the request is in flight', async () => {
    listSkills.mockResolvedValue(listResponse([skill({ enabled: true })]));
    const view = await renderSkills('codex');
    let resolveRequest: (value: unknown) => void = () => undefined;
    setSkillEnabled.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = view.result.current.setSkillEnabled(skill().sourcePath, false);
    });
    await waitFor(() => expect(view.result.current.updatingSkillPaths).toEqual([`codex:${skill().sourcePath}`]));

    await act(async () => {
      resolveRequest(jsonResponse({
        success: true,
        data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
      }));
      await pending;
    });
    expect(view.result.current.updatingSkillPaths).toEqual([]);
  });

  test('keeps the previous value and exposes the error when the write fails', async () => {
    listSkills.mockResolvedValue(listResponse([skill({ enabled: true })]));
    const view = await renderSkills('codex');
    setSkillEnabled.mockResolvedValue(jsonResponse(
      { success: false, error: { code: 'CODEX_SKILLS_CONFIG_INVALID', message: 'Codex config is not valid TOML' } },
      false,
    ));

    await act(async () => {
      await expect(view.result.current.setSkillEnabled(skill().sourcePath, false))
        .rejects.toThrow('Codex config is not valid TOML');
    });

    expect(view.result.current.skills[0]?.enabled).toBe(true);
    expect(view.result.current.skillToggleError).toBe('Codex config is not valid TOML');
    expect(view.result.current.updatingSkillPaths).toEqual([]);
  });

  test('keeps the visible list untouched by a toggle that completes after a provider switch', async () => {
    listSkills.mockResolvedValue(listResponse([skill({ enabled: true })]));
    const view = await renderSkills('codex');
    let resolveRequest: (value: unknown) => void = () => undefined;
    setSkillEnabled.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = view.result.current.setSkillEnabled(skill().sourcePath, false);
    });

    listSkills.mockResolvedValue(listResponse([
      skill({ provider: 'claude', command: '/review', enabled: undefined }),
    ]));
    view.rerender({ selectedProvider: 'claude' });
    await waitFor(() => expect(view.result.current.skills[0]?.provider).toBe('claude'));

    await act(async () => {
      resolveRequest(jsonResponse({
        success: true,
        data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
      }));
      await pending;
    });

    // The late Codex result must not stamp enablement onto Claude's list.
    expect(view.result.current.skills[0]?.provider).toBe('claude');
    expect(view.result.current.skills[0]?.enabled).toBeUndefined();
    expect(view.result.current.skillToggleError).toBeNull();
  });

  test('commits a completed toggle to its own cache and shows it after switching back', async () => {
    listSkills.mockResolvedValueOnce(listResponse([skill({ enabled: true })]));
    const view = await renderSkills('codex');
    let resolveRequest: (value: unknown) => void = () => undefined;
    setSkillEnabled.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = view.result.current.setSkillEnabled(skill().sourcePath, false);
    });

    // Switch away while the Codex write is still in flight.
    listSkills.mockResolvedValue(listResponse([
      skill({ provider: 'claude', command: '/review', enabled: undefined }),
    ]));
    view.rerender({ selectedProvider: 'claude' });
    await waitFor(() => expect(view.result.current.skills[0]?.provider).toBe('claude'));

    await act(async () => {
      resolveRequest(jsonResponse({
        success: true,
        data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
      }));
      await pending;
    });

    // Switching back must read the committed cache, not the stale list.
    view.rerender({ selectedProvider: 'codex' });
    await waitFor(() => expect(view.result.current.skills[0]?.provider).toBe('codex'));
    expect(view.result.current.skills[0]?.enabled).toBe(false);
  });

  test('a late toggle from the previous provider cannot clear the new provider pending marker', async () => {
    listSkills.mockResolvedValue(listResponse([skill({ enabled: true })]));
    const view = await renderSkills('codex');
    const resolvers: Array<(value: unknown) => void> = [];
    setSkillEnabled.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));

    let codexPending: Promise<void> = Promise.resolve();
    act(() => {
      codexPending = view.result.current.setSkillEnabled(skill().sourcePath, false);
    });
    await waitFor(() => expect(view.result.current.updatingSkillPaths).toEqual([`codex:${skill().sourcePath}`]));

    listSkills.mockResolvedValue(listResponse([
      skill({ provider: 'claude', command: '/review', enabled: true }),
    ]));
    view.rerender({ selectedProvider: 'claude' });
    await waitFor(() => expect(view.result.current.skills[0]?.provider).toBe('claude'));

    let claudePending: Promise<void> = Promise.resolve();
    act(() => {
      claudePending = view.result.current.setSkillEnabled(skill().sourcePath, false);
    });
    await waitFor(() => expect(view.result.current.updatingSkillPaths).toEqual([`claude:${skill().sourcePath}`]));

    // The Codex write settles first; Claude's row must stay locked.
    await act(async () => {
      resolvers[0](jsonResponse({
        success: true,
        data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
      }));
      await codexPending;
    });
    expect(view.result.current.updatingSkillPaths).toEqual([`claude:${skill().sourcePath}`]);

    await act(async () => {
      resolvers[1](jsonResponse({
        success: true,
        data: { provider: 'claude', sourcePath: skill().sourcePath, enabled: false },
      }));
      await claudePending;
    });
    expect(view.result.current.updatingSkillPaths).toEqual([]);
  });

  test('does not let a late load overwrite a toggle that already succeeded', async () => {
    // Call 1 is the initial load; call 2 is the refresh racing the toggle and
    // call 3 is the recovery load the toggle schedules after winning.
    let resolveStaleList: (value: unknown) => void = () => undefined;
    const staleList = new Promise((resolve) => { resolveStaleList = resolve; });
    let call = 0;
    listSkills.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(listResponse([skill({ enabled: true })]));
      if (call === 2) return staleList;
      return Promise.resolve(listResponse([skill({ enabled: false })]));
    });

    const view = await renderSkills('codex');

    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = view.result.current.refreshSkills({ force: true });
    });
    await waitFor(() => expect(call).toBe(2));

    setSkillEnabled.mockResolvedValue(jsonResponse({
      success: true,
      data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
    }));
    await act(async () => {
      await view.result.current.setSkillEnabled(skill().sourcePath, false);
    });
    // The recovery load resolves with the persisted value.
    await waitFor(() => expect(call).toBe(3));
    expect(view.result.current.skills[0]?.enabled).toBe(false);

    // The stale response arrives last; it must be discarded, exactly like the
    // cache entry it would otherwise have overwritten.
    await act(async () => {
      resolveStaleList(listResponse([skill({ enabled: true })]));
      await refreshing;
    });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    expect(view.result.current.skills[0]?.enabled).toBe(false);
    expect(call).toBe(3);
  });

  test('a toggle that settles after the project set changes recovers with the new projects', async () => {
    const projectA: SkillsProject = { projectId: 'a', displayName: 'A', fullPath: '/work/a' };
    let toggled = false;
    let resolveStaleProject: (value: unknown) => void = () => undefined;
    let projectCalls = 0;
    listSkills.mockImplementation((_provider: unknown, options?: { workspacePath?: string }) => {
      if (!options?.workspacePath) {
        return Promise.resolve(listResponse([skill({ enabled: !toggled })]));
      }

      projectCalls += 1;
      if (projectCalls === 1) {
        // The first project load is the one the toggle invalidates.
        return new Promise((resolve) => { resolveStaleProject = resolve; });
      }
      return Promise.resolve(listResponse([skill({
        name: 'project-skill',
        command: '$project-skill',
        sourcePath: '/work/a/.agents/skills/project-skill/SKILL.md',
        scope: 'project',
        enabled: true,
      })]));
    });

    const { useProviderSkills } = await import('@/modules/skills/hooks/useProviderSkills');
    const view = renderHook(
      ({ projects }: { projects: SkillsProject[] }) => useProviderSkills({
        selectedProvider: 'codex',
        currentProjects: projects,
      }),
      { initialProps: { projects: [] as SkillsProject[] } },
    );
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));

    // Same provider, new project set: this load is in flight when the toggle
    // succeeds and must be replaced by a load for the *new* project set.
    view.rerender({ projects: [projectA] });
    await waitFor(() => expect(projectCalls).toBe(1));

    setSkillEnabled.mockImplementation(async () => {
      toggled = true;
      return jsonResponse({
        success: true,
        data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
      });
    });
    await act(async () => {
      await view.result.current.setSkillEnabled(skill().sourcePath, false);
    });

    await waitFor(() => expect(projectCalls).toBe(2));
    await waitFor(() => expect(view.result.current.isLoadingProjectScopes).toBe(false));
    const names = view.result.current.skills.map((entry) => entry.name);
    expect(names).toContain('project-skill');
    expect(view.result.current.skills.find((entry) => entry.name === 'review')?.enabled).toBe(false);

    // The invalidated response lands last and must not drop the project rows.
    await act(async () => {
      resolveStaleProject(listResponse([skill({ enabled: true })]));
    });
    await waitFor(() => expect(view.result.current.isLoadingProjectScopes).toBe(false));
    expect(view.result.current.skills.map((entry) => entry.name)).toContain('project-skill');
  });

  test('ignores a second toggle for a row that is still saving', async () => {
    listSkills.mockResolvedValue(listResponse([skill({ enabled: true })]));
    const view = await renderSkills('codex');
    let resolveRequest: (value: unknown) => void = () => undefined;
    setSkillEnabled.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));

    let first: Promise<void> = Promise.resolve();
    let duplicate: Promise<void> = Promise.resolve();
    act(() => {
      first = view.result.current.setSkillEnabled(skill().sourcePath, false);
      duplicate = view.result.current.setSkillEnabled(skill().sourcePath, true);
    });
    await waitFor(() => expect(view.result.current.updatingSkillPaths).toEqual([`codex:${skill().sourcePath}`]));

    // The duplicate is dropped instead of racing the first write.
    expect(setSkillEnabled).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest(jsonResponse({
        success: true,
        data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
      }));
      await Promise.all([first, duplicate]);
    });
    expect(view.result.current.updatingSkillPaths).toEqual([]);
    expect(setSkillEnabled).toHaveBeenCalledTimes(1);
  });

  test('re-locks a row that is still saving after switching away and back', async () => {
    listSkills.mockResolvedValue(listResponse([skill({ enabled: true })]));
    const view = await renderSkills('codex');
    let resolveRequest: (value: unknown) => void = () => undefined;
    setSkillEnabled.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = view.result.current.setSkillEnabled(skill().sourcePath, false);
    });
    await waitFor(() => expect(view.result.current.updatingSkillPaths).toEqual([`codex:${skill().sourcePath}`]));

    view.rerender({ selectedProvider: 'claude' });
    await waitFor(() => expect(view.result.current.updatingSkillPaths).toEqual([]));

    // Switching back must restore the marker from the in-flight registry: the
    // write is still running, so the row cannot accept a second toggle.
    view.rerender({ selectedProvider: 'codex' });
    await waitFor(() => expect(view.result.current.updatingSkillPaths).toEqual([`codex:${skill().sourcePath}`]));

    await act(async () => {
      resolveRequest(jsonResponse({
        success: true,
        data: { provider: 'codex', sourcePath: skill().sourcePath, enabled: false },
      }));
      await pending;
    });
    expect(view.result.current.updatingSkillPaths).toEqual([]);
  });
});
