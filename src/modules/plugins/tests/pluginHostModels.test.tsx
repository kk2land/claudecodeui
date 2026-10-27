import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import PluginTabContent from '@/modules/plugins/PluginTabContent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { PluginsProvider } from '@/modules/plugins/context/PluginsContext';
import type { Plugin, Project } from '@/shared/types';

/**
 * The plugin host surface is built inside PluginTabContent and handed to whatever
 * module the plugin asset fetch returns. These tests mount a tiny fake plugin
 * module and drive the real host: the models capability must stay allowlisted
 * and read the authenticated provider catalog endpoint.
 */

const PLUGIN = {
  name: 'project-scheduler',
  displayName: 'Project Scheduler',
  version: '1.0.0',
  description: '',
  author: '',
  icon: '',
  type: 'module',
  slot: 'tab',
  entry: 'index.js',
  server: 'server.mjs',
  permissions: [],
  enabled: true,
  serverRunning: true,
  dirName: 'project-scheduler',
  repoUrl: '',
} as unknown as Plugin;

const project = {
  projectId: 'project-a',
  name: 'Project A',
  path: '/tmp/project-a',
  fullPath: '/tmp/project-a',
} as unknown as Project;

type Host = {
  models?: (provider: 'codex' | 'dsh') => Promise<unknown>;
};

/** The host object the fake plugin received from the real host component. */
let harness: Host | null = null;

// The blob/data URL import must resolve to this stub, which captures the host.
const pluginSource = `
  export function mount(_container, host) {
    globalThis.__schedulerHost = host;
  }
  export function unmount() {}
`;

function stubAssetsAndPlugins() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/plugins/project-scheduler/assets/index.js')) {
        return new Response(pluginSource, {
          status: 200,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
      return new Response(JSON.stringify({ plugins: [PLUGIN] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

// jsdom implements neither Blob URL factory; the host only needs a URL that a
// dynamic import can evaluate, so point it at the same module as a data URL.
const pluginUrl = 'data:text/javascript,' + encodeURIComponent(pluginSource);

beforeEach(() => {
  harness = null;
  vi.unstubAllGlobals();
  vi.stubGlobal('__schedulerHost', null);
  (URL as unknown as Record<string, unknown>).createObjectURL = () => pluginUrl;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
});

describe('PluginTabContent host models capability', () => {
  it('unwraps the authenticated provider catalog for an allowlisted provider', async () => {
    stubAssetsAndPlugins();
    const models = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            provider: 'codex',
            models: {
              DEFAULT: 'gpt-6-sol',
              OPTIONS: [
                {
                  value: 'gpt-6-sol',
                  label: 'GPT-6 Sol',
                  effort: { default: 'medium', values: [{ value: 'high' }] },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const { api } = await import('@/shared/api');
    vi.spyOn(api.providers, 'models').mockImplementation(models as never);
    try {
      renderHost();
      await waitFor(() => {
        harness = ((globalThis as Record<string, unknown>).__schedulerHost ?? null) as Host | null;
        expect(harness).toBeTruthy();
      });
      const catalog = await harness!.models!('codex');
      expect(models).toHaveBeenCalledWith('codex');
      expect(catalog).toEqual({
        DEFAULT: 'gpt-6-sol',
        OPTIONS: [
          {
            value: 'gpt-6-sol',
            label: 'GPT-6 Sol',
            effort: { default: 'medium', values: [{ value: 'high' }] },
          },
        ],
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses providers outside the allowlist and reports HTTP failures', async () => {
    stubAssetsAndPlugins();
    const { api } = await import('@/shared/api');
    const models = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: false }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.spyOn(api.providers, 'models').mockImplementation(models as never);
    try {
      renderHost();
      await waitFor(() => {
        harness = ((globalThis as Record<string, unknown>).__schedulerHost ?? null) as Host | null;
        expect(harness).toBeTruthy();
      });
      // A plugin cannot smuggle an arbitrary provider through the host surface.
      await expect(
        harness!.models!('claude' as unknown as 'codex'),
      ).rejects.toThrow(/Unsupported provider/);
      expect(models).not.toHaveBeenCalled();
      // A failed upstream response rejects instead of returning a bogus catalog.
      await expect(harness!.models!('dsh')).rejects.toThrow(/HTTP 503/);
      expect(models).toHaveBeenCalledWith('dsh');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

/** Mounts the host inside the providers PluginTabContent depends on. */
function renderHost() {
  return render(
    <ThemeProvider>
      <PluginsProvider>
        <PluginTabContent
          pluginName="project-scheduler"
          selectedProject={project}
          selectedSession={null}
        />
      </PluginsProvider>
    </ThemeProvider>,
  );
}
