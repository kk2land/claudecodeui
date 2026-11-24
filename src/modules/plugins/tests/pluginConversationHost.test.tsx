import { useEffect, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import '@/modules/i18n';
import type * as ChatModule from '@/modules/chat';
import PluginTabContent from '@/modules/plugins/PluginTabContent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { PluginsProvider } from '@/modules/plugins/context/PluginsContext';
import type { Plugin, Project, WorkerConversationMessage } from '@/shared/types';

/**
 * The optional conversation capability is how a Worker panel shows a run with the main transcript
 * components. These tests drive the real host with a tiny fake plugin: every container gets its
 * own view, a re-mount replaces only that container's view, a disposal never clears a newer mount,
 * malformed input is rejected once at the boundary, and the app's display preferences reach every
 * view without reloading the plugin.
 */

const PLUGIN = {
  name: 'worker',
  displayName: 'Worker',
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
  dirName: 'worker',
  repoUrl: '',
} as unknown as Plugin;

const project = {
  projectId: 'project-a',
  name: 'Project A',
  path: '/tmp/project-a',
  fullPath: '/tmp/project-a',
} as unknown as Project;

type ConversationController = {
  update(messages: WorkerConversationMessage[]): void;
  dispose(): void;
};

type Host = {
  mountConversationOutput?: (
    container: HTMLElement,
    options: { provider: string; messages: WorkerConversationMessage[] },
  ) => ConversationController;
};

type CapturedViewProps = {
  provider: string;
  messages: WorkerConversationMessage[];
  scrollContainer?: HTMLElement | null;
  showThinking?: boolean;
  showRawParameters?: boolean;
};

type CapturedView = {
  token: object;
  props: CapturedViewProps;
};

// The host renders the mounted view itself, so a stub at the chat module boundary is what lets the
// test see exactly which rows, scroll container and preferences the host handed it. Views are
// recorded per container, so several simultaneous mounts stay distinguishable.
vi.mock('@/modules/chat', async importOriginal => {
  const actual = await importOriginal<typeof ChatModule>();
  return {
    ...actual,
    ConversationOutput: (props: CapturedViewProps) => {
      const tokenRef = useRef<object | null>(null);
      if (!tokenRef.current) tokenRef.current = {};
      const token = tokenRef.current;
      const container = props.scrollContainer as HTMLElement;
      viewRegistry().set(container, { token, props });
      // Clearing only this instance's entry keeps a stale unmount from deleting a newer view that
      // the same plugin container now owns.
      useEffect(() => () => {
        const registry = viewRegistry();
        if (registry.get(container)?.token === token) registry.delete(container);
      }, [container, token]);
      return null;
    },
  };
});

function viewRegistry(): Map<HTMLElement, CapturedView> {
  const globals = globalThis as Record<string, unknown>;
  if (!(globals.__conversationViews instanceof Map)) {
    globals.__conversationViews = new Map<HTMLElement, CapturedView>();
  }
  return globals.__conversationViews as Map<HTMLElement, CapturedView>;
}

function viewFor(container: HTMLElement): CapturedViewProps | null {
  return viewRegistry().get(container)?.props ?? null;
}

function viewCount(): number {
  return viewRegistry().size;
}

const pluginSource = `
  export function mount(_container, host) {
    globalThis.__workerHost = host;
    globalThis.__workerMountCount = (globalThis.__workerMountCount || 0) + 1;
  }
  export function unmount() {}
`;

// jsdom implements no Blob URL factory; the host only needs a URL whose import evaluates, so the
// same module text is used as a data URL.
const pluginUrl = 'data:text/javascript,' + encodeURIComponent(pluginSource);

function stubAssetsAndPlugins() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/plugins/worker/assets/index.js')) {
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

type HostDisplayPreferences = {
  showThinking?: boolean;
  showRawParameters?: boolean;
};

function renderHost(preferences: HostDisplayPreferences = {}) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <PluginsProvider>
          <PluginTabContent
            pluginName="worker"
            selectedProject={project}
            selectedSession={null}
            showThinking={preferences.showThinking}
            showRawParameters={preferences.showRawParameters}
          />
        </PluginsProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

async function mountHostAndHarness(preferences?: HostDisplayPreferences): Promise<{
  host: Host;
  view: ReturnType<typeof renderHost>;
}> {
  stubAssetsAndPlugins();
  const view = renderHost(preferences);
  let host: Host | null = null;
  await waitFor(() => {
    host = ((globalThis as Record<string, unknown>).__workerHost ?? null) as Host | null;
    expect(host).toBeTruthy();
  });
  return { host: host as unknown as Host, view };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('__workerHost', null);
  vi.stubGlobal('__conversationViews', new Map<HTMLElement, CapturedView>());
  vi.stubGlobal('__workerMountCount', 0);
  (URL as unknown as Record<string, unknown>).createObjectURL = () => pluginUrl;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
});

const ROW: WorkerConversationMessage = { id: 'a-1', role: 'assistant', text: '第一段输出' };

describe('PluginTabContent conversation output mount', () => {
  it('renders the rows it was mounted with and replaces them through update', async () => {
    const { host } = await mountHostAndHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);

    let controller: ConversationController | undefined;
    act(() => {
      controller = host.mountConversationOutput!(container, {
        provider: 'pi',
        messages: [ROW],
      });
    });

    await waitFor(() => expect(viewFor(container)?.messages).toEqual([ROW]));
    expect(viewFor(container)?.provider).toBe('pi');
    // The plugin's own container is the scroller, so the view is told which element it owns.
    expect(viewFor(container)?.scrollContainer).toBe(container);

    const streamed: WorkerConversationMessage[] = [
      { ...ROW, text: '第一段输出，仍在写入', streaming: true },
      { id: 'tool-1', role: 'tool', text: '', toolId: 'call-1', toolName: 'Bash', toolInput: { command: 'ls' } },
    ];
    act(() => controller!.update(streamed));
    await waitFor(() => expect(viewFor(container)?.messages).toEqual(streamed));

    act(() => controller!.dispose());
    await waitFor(() => expect(viewFor(container)).toBeNull());
    container.remove();
  });

  it('keeps a stale controller from updating or clearing a newer mount in the same container', async () => {
    const { host } = await mountHostAndHarness();
    const container = document.createElement('div');

    const staleRow: WorkerConversationMessage = { id: 'a-0', role: 'assistant', text: '被替换的旧输出' };
    const currentRow: WorkerConversationMessage = { id: 'a-1', role: 'assistant', text: '新挂载的输出' };

    let stale: ConversationController | undefined;
    let current: ConversationController | undefined;
    act(() => {
      stale = host.mountConversationOutput!(container, { provider: 'pi', messages: [staleRow] });
      current = host.mountConversationOutput!(container, { provider: 'codex', messages: [currentRow] });
    });
    await waitFor(() => expect(viewFor(container)?.provider).toBe('codex'));
    expect(viewFor(container)?.scrollContainer).toBe(container);
    expect(viewCount()).toBe(1);

    // Rows and disposal of the replaced mount must not touch the view now on screen.
    act(() => stale!.update([{ id: 'a-2', role: 'assistant', text: '旧控制器迟到的更新' }]));
    act(() => stale!.dispose());
    await waitFor(() => expect(viewFor(container)?.provider).toBe('codex'));
    expect(viewFor(container)?.messages).toEqual([currentRow]);

    act(() => current!.dispose());
    await waitFor(() => expect(viewFor(container)).toBeNull());
  });

  it('shows simultaneous Pi, agy and Codex views in their own containers without interference', async () => {
    const { host } = await mountHostAndHarness();
    const piContainer = document.createElement('div');
    const agyContainer = document.createElement('div');
    const codexContainer = document.createElement('div');
    document.body.append(piContainer, agyContainer, codexContainer);

    const piRow: WorkerConversationMessage = { id: 'pi-1', role: 'assistant', text: 'Pi 的运行输出' };
    const agyRow: WorkerConversationMessage = { id: 'agy-1', role: 'assistant', text: 'agy 的运行输出' };
    const codexRow: WorkerConversationMessage = { id: 'codex-1', role: 'assistant', text: 'Codex 的运行输出' };

    let pi: ConversationController | undefined;
    let agy: ConversationController | undefined;
    let codex: ConversationController | undefined;
    act(() => {
      pi = host.mountConversationOutput!(piContainer, { provider: 'pi', messages: [piRow] });
      agy = host.mountConversationOutput!(agyContainer, { provider: 'agy', messages: [agyRow] });
      codex = host.mountConversationOutput!(codexContainer, { provider: 'codex', messages: [codexRow] });
    });

    await waitFor(() => expect(viewCount()).toBe(3));
    expect(viewFor(piContainer)?.provider).toBe('pi');
    expect(viewFor(agyContainer)?.provider).toBe('agy');
    expect(viewFor(codexContainer)?.provider).toBe('codex');
    expect(viewFor(piContainer)?.scrollContainer).toBe(piContainer);
    expect(viewFor(agyContainer)?.scrollContainer).toBe(agyContainer);
    expect(viewFor(codexContainer)?.scrollContainer).toBe(codexContainer);
    expect(viewFor(piContainer)?.messages).toEqual([piRow]);
    expect(viewFor(agyContainer)?.messages).toEqual([agyRow]);
    expect(viewFor(codexContainer)?.messages).toEqual([codexRow]);

    // Updating one run leaves the others exactly as they were.
    const piNext: WorkerConversationMessage[] = [
      piRow,
      { id: 'pi-2', role: 'assistant', text: 'Pi 的后续输出', streaming: true },
    ];
    act(() => pi!.update(piNext));
    await waitFor(() => expect(viewFor(piContainer)?.messages).toEqual(piNext));
    expect(viewFor(agyContainer)?.messages).toEqual([agyRow]);
    expect(viewFor(codexContainer)?.messages).toEqual([codexRow]);

    // Disposing one run removes only its portal.
    act(() => agy!.dispose());
    await waitFor(() => expect(viewFor(agyContainer)).toBeNull());
    expect(viewCount()).toBe(2);
    expect(viewFor(piContainer)?.messages).toEqual(piNext);
    expect(viewFor(codexContainer)?.messages).toEqual([codexRow]);

    act(() => {
      pi!.dispose();
      codex!.dispose();
    });
    await waitFor(() => expect(viewCount()).toBe(0));

    piContainer.remove();
    agyContainer.remove();
    codexContainer.remove();
  });

  it('removes every view when the plugin tab unmounts, without a late controller breaking', async () => {
    const { host, view } = await mountHostAndHarness();
    const first = document.createElement('div');
    const second = document.createElement('div');

    let firstController: ConversationController | undefined;
    let secondController: ConversationController | undefined;
    act(() => {
      firstController = host.mountConversationOutput!(first, { provider: 'pi', messages: [ROW] });
      secondController = host.mountConversationOutput!(second, { provider: 'codex', messages: [ROW] });
    });
    await waitFor(() => expect(viewCount()).toBe(2));

    view.unmount();
    expect(viewCount()).toBe(0);
    expect(() => firstController!.dispose()).not.toThrow();
    expect(() => secondController!.dispose()).not.toThrow();
    expect(viewCount()).toBe(0);
  });

  it('forwards display preferences to every view without reloading the plugin', async () => {
    const { host, view } = await mountHostAndHarness({ showThinking: true, showRawParameters: false });
    const piContainer = document.createElement('div');
    const codexContainer = document.createElement('div');

    act(() => {
      host.mountConversationOutput!(piContainer, { provider: 'pi', messages: [ROW] });
      host.mountConversationOutput!(codexContainer, { provider: 'codex', messages: [ROW] });
    });
    await waitFor(() => expect(viewCount()).toBe(2));
    expect(viewFor(piContainer)?.showThinking).toBe(true);
    expect(viewFor(piContainer)?.showRawParameters).toBe(false);
    expect(viewFor(codexContainer)?.showThinking).toBe(true);
    expect(viewFor(codexContainer)?.showRawParameters).toBe(false);

    const globals = globalThis as Record<string, unknown>;
    const mountsAfterLoad = globals.__workerMountCount as number;
    expect(mountsAfterLoad).toBe(1);

    // A preference change updates the already mounted views; it must not re-run the plugin load.
    view.rerender(
      <MemoryRouter>
        <ThemeProvider>
          <PluginsProvider>
            <PluginTabContent
              pluginName="worker"
              selectedProject={project}
              selectedSession={null}
              showThinking={false}
              showRawParameters={true}
            />
          </PluginsProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(viewFor(piContainer)?.showThinking).toBe(false));
    expect(viewFor(piContainer)?.showRawParameters).toBe(true);
    expect(viewFor(codexContainer)?.showThinking).toBe(false);
    expect(viewFor(codexContainer)?.showRawParameters).toBe(true);
    expect(globals.__workerMountCount).toBe(mountsAfterLoad);
  });

  it('rejects malformed input at the boundary and never mounts it', async () => {
    const { host } = await mountHostAndHarness();
    const container = document.createElement('div');

    expect(() => host.mountConversationOutput!(null as unknown as HTMLElement, {
      provider: 'pi',
      messages: [],
    })).toThrow(/DOM container/);
    expect(() => host.mountConversationOutput!(container, {
      provider: '   ',
      messages: [],
    })).toThrow(/requires a provider/);
    expect(() => host.mountConversationOutput!(container, {
      provider: 'pi',
      messages: 'not-an-array' as unknown as WorkerConversationMessage[],
    })).toThrow(/messages array/);
    expect(() => host.mountConversationOutput!(container, {
      provider: 'pi',
      messages: [null as unknown as WorkerConversationMessage],
    })).toThrow(/invalid message/);
    expect(() => host.mountConversationOutput!(container, {
      provider: 'pi',
      messages: [{ role: 'assistant', text: '' } as unknown as WorkerConversationMessage],
    })).toThrow(/requires a message id/);
    expect(() => host.mountConversationOutput!(container, {
      provider: 'pi',
      messages: [{ id: 'x', role: 'assistant' } as unknown as WorkerConversationMessage],
    })).toThrow(/requires message text/);
    expect(() => host.mountConversationOutput!(container, {
      provider: 'pi',
      messages: [{ id: 'x', role: 'system', text: '' } as unknown as WorkerConversationMessage],
    })).toThrow(/unsupported message role/);
    expect(viewFor(container)).toBeNull();

    // A later update is validated the same way the initial mount was.
    let controller: ConversationController | undefined;
    act(() => {
      controller = host.mountConversationOutput!(container, { provider: 'pi', messages: [] });
    });
    await waitFor(() => expect(viewFor(container)).not.toBeNull());
    expect(() => controller!.update([
      { id: 'x', role: 'assistant', text: 42 } as unknown as WorkerConversationMessage,
    ])).toThrow(/requires message text/);

    // Optional fields are normalized once: a wrong type is dropped, a right one is kept.
    act(() => controller!.update([
      {
        id: 'tool-1',
        role: 'tool',
        text: '',
        toolName: 'Bash',
        toolInput: 'not-an-object',
        thinking: true,
      } as unknown as WorkerConversationMessage,
    ]));
    await waitFor(() => expect(viewFor(container)?.messages).toEqual([
      { id: 'tool-1', role: 'tool', text: '', toolName: 'Bash', thinking: true },
    ]));
    expect(() => controller!.update(null as unknown as WorkerConversationMessage[])).toThrow(/messages array/);
  });
});
