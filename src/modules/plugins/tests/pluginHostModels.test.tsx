import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import '@/modules/i18n';
import type * as ChatModule from '@/modules/chat';
import PluginTabContent from '@/modules/plugins/PluginTabContent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { PluginsProvider } from '@/modules/plugins/context/PluginsContext';
import type { Plugin, Project } from '@/shared/types';

/**
 * The plugin host surface is built inside PluginTabContent and handed to whatever
 * module the plugin asset fetch returns. These tests mount a tiny fake plugin
 * module and drive the real host: the models capability must stay allowlisted
 * and read the authenticated provider catalog endpoint, and a mounted session
 * viewer must receive the options the host was called with verbatim.
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
  codexModelProviders?: () => Promise<unknown>;
  codexModelProviderModels?: (modelProvider: string) => Promise<unknown>;
  mountSessionOutput?: (
    container: HTMLElement,
    options: { sessionId: string; pollIntervalMs?: number },
  ) => () => void;
};

/** The viewer props the host rendered, captured at the chat module boundary. */
type CapturedViewerProps = { sessionId: string; pollIntervalMs?: number };

// The host renders the mounted viewer itself, so standing a fake viewer in at the
// module boundary is what lets the test assert on forwarding. Only the session
// viewer is replaced; the rest of the chat module stays real.
vi.mock('@/modules/chat', async importOriginal => {
  const actual = await importOriginal<typeof ChatModule>();
  return {
    ...actual,
    SessionOutput: (props: CapturedViewerProps) => {
      (globalThis as Record<string, unknown>).__sessionViewerProps = props;
      return null;
    },
  };
});

function capturedViewerProps(): CapturedViewerProps | null {
  return ((globalThis as Record<string, unknown>).__sessionViewerProps ?? null) as CapturedViewerProps | null;
}

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
  vi.stubGlobal('__sessionViewerProps', null);
  (URL as unknown as Record<string, unknown>).createObjectURL = () => pluginUrl;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
});

async function mountHostAndHarness(): Promise<Host> {
  stubAssetsAndPlugins();
  renderHost();
  await waitFor(() => {
    harness = ((globalThis as Record<string, unknown>).__schedulerHost ?? null) as Host | null;
    expect(harness).toBeTruthy();
  });
  return harness as Host;
}

describe('PluginTabContent session output mount', () => {
  it('forwards the poll cadence to the viewer and keeps old plugins unpolled', async () => {
    const host = await mountHostAndHarness();
    const container = document.createElement('div');

    let dispose: (() => void) | undefined;
    act(() => {
      dispose = host.mountSessionOutput!(container, { sessionId: ' session-1 ', pollIntervalMs: 1000 });
    });
    await waitFor(() => expect(capturedViewerProps()?.sessionId).toBe('session-1'));
    expect(capturedViewerProps()?.pollIntervalMs).toBe(1000);

    // A plugin that omits the option keeps the viewer's own no-poll default.
    act(() => dispose!());
    act(() => {
      host.mountSessionOutput!(document.createElement('div'), { sessionId: 'session-2' });
    });
    await waitFor(() => expect(capturedViewerProps()?.sessionId).toBe('session-2'));
    expect(capturedViewerProps()?.pollIntervalMs).toBeUndefined();
  });

  it('rejects a cadence that is not a positive finite number', async () => {
    const host = await mountHostAndHarness();
    const container = document.createElement('div');

    for (const pollIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => host.mountSessionOutput!(container, { sessionId: 'session-1', pollIntervalMs }))
        .toThrow(/positive finite pollIntervalMs/);
    }
    expect(capturedViewerProps()).toBeNull();
  });
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

describe('PluginTabContent Codex provider directory capabilities', () => {
  it('reads the provider directory and one provider model list from authenticated endpoints', async () => {
    stubAssetsAndPlugins();
    const { api } = await import('@/shared/api');
    const providers = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            defaultProvider: 'openai',
            providers: [{ id: 'openai', name: 'OpenAI' }],
            hasCustomProviders: false,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const providerModels = vi.fn(async (modelProvider: string) =>
      new Response(
        JSON.stringify({
          success: true,
          data: { modelProvider, models: ['gpt-6-sol'] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(providers as never);
    vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(providerModels as never);
    try {
      renderHost();
      await waitFor(() => {
        harness = ((globalThis as Record<string, unknown>).__schedulerHost ?? null) as Host | null;
        expect(harness).toBeTruthy();
      });
      await expect(harness!.codexModelProviders!()).resolves.toEqual({
        defaultProvider: 'openai',
        providers: [{ id: 'openai', name: 'OpenAI' }],
        hasCustomProviders: false,
      });
      expect(providers).toHaveBeenCalledTimes(1);
      await expect(harness!.codexModelProviderModels!('openai')).resolves.toEqual({
        modelProvider: 'openai',
        models: ['gpt-6-sol'],
      });
      expect(providerModels).toHaveBeenCalledWith('openai');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects a blank provider id and upstream failures without inventing a directory', async () => {
    stubAssetsAndPlugins();
    const { api } = await import('@/shared/api');
    const providers = vi.fn(async () =>
      new Response(JSON.stringify({ success: false }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const providerModels = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(providers as never);
    vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(providerModels as never);
    try {
      renderHost();
      await waitFor(() => {
        harness = ((globalThis as Record<string, unknown>).__schedulerHost ?? null) as Host | null;
        expect(harness).toBeTruthy();
      });
      // A blank id never reaches the network.
      await expect(harness!.codexModelProviderModels!('   ')).rejects.toThrow(
        /model provider id is required/i,
      );
      expect(providerModels).not.toHaveBeenCalled();
      await expect(harness!.codexModelProviders!()).rejects.toThrow(/HTTP 502/);
      await expect(harness!.codexModelProviderModels!('openai')).rejects.toThrow(
        /Failed to load models for "openai"/,
      );
      expect(providers).toHaveBeenCalledTimes(1);
      expect(providerModels).toHaveBeenCalledWith('openai');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

/**
 * Mounts the host inside the providers PluginTabContent depends on. `MemoryRouter` is one of
 * them: the component now opens sessions through the app router (`openSession`), and the real
 * app always renders it inside a route, so the fixture must too.
 */
function renderHost() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <PluginsProvider>
          <PluginTabContent
            pluginName="project-scheduler"
            selectedProject={project}
            selectedSession={null}
          />
        </PluginsProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}
