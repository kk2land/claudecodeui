import { useEffect } from 'react';
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
 * components. These tests drive the real host with a tiny fake plugin: the controller must replace
 * rows in place, clear only its own mount when disposed, and reject malformed input once at the
 * boundary instead of letting a plugin hand the view arbitrary data.
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
};

// The host renders the mounted view itself, so a stub at the chat module boundary is what lets the
// test see exactly which rows and scroll container the host handed it.
vi.mock('@/modules/chat', async importOriginal => {
  const actual = await importOriginal<typeof ChatModule>();
  return {
    ...actual,
    // The stub is the real mount point: it records what the host rendered and clears the record on
    // unmount, so "disposed" and "still mounted" are distinguishable at the module boundary.
    ConversationOutput: (props: CapturedViewProps) => {
      useEffect(() => () => {
        (globalThis as Record<string, unknown>).__conversationViewProps = null;
      }, []);
      (globalThis as Record<string, unknown>).__conversationViewProps = props;
      return null;
    },
  };
});

function capturedViewProps(): CapturedViewProps | null {
  return ((globalThis as Record<string, unknown>).__conversationViewProps ?? null) as CapturedViewProps | null;
}

const pluginSource = `
  export function mount(_container, host) {
    globalThis.__workerHost = host;
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

function renderHost() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <PluginsProvider>
          <PluginTabContent pluginName="worker" selectedProject={project} selectedSession={null} />
        </PluginsProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

async function mountHostAndHarness(): Promise<{ host: Host; view: ReturnType<typeof renderHost> }> {
  stubAssetsAndPlugins();
  const view = renderHost();
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
  vi.stubGlobal('__conversationViewProps', null);
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

    await waitFor(() => expect(capturedViewProps()?.messages).toEqual([ROW]));
    expect(capturedViewProps()?.provider).toBe('pi');
    // The plugin's own container is the scroller, so the view is told which element it owns.
    expect(capturedViewProps()?.scrollContainer).toBe(container);

    const streamed: WorkerConversationMessage[] = [
      { ...ROW, text: '第一段输出，仍在写入', streaming: true },
      { id: 'tool-1', role: 'tool', text: '', toolId: 'call-1', toolName: 'Bash', toolInput: { command: 'ls' } },
    ];
    act(() => controller!.update(streamed));
    await waitFor(() => expect(capturedViewProps()?.messages).toEqual(streamed));

    act(() => controller!.dispose());
    await waitFor(() => expect(capturedViewProps()).toBeNull());
    container.remove();
  });

  it('keeps a stale controller from updating or clearing a newer mount', async () => {
    const { host } = await mountHostAndHarness();
    const first = document.createElement('div');
    const second = document.createElement('div');

    let stale: ConversationController | undefined;
    let current: ConversationController | undefined;
    act(() => {
      stale = host.mountConversationOutput!(first, { provider: 'pi', messages: [ROW] });
      current = host.mountConversationOutput!(second, {
        provider: 'dsh',
        messages: [{ id: 'b-1', role: 'assistant', text: '新挂载的输出' }],
      });
    });
    await waitFor(() => expect(capturedViewProps()?.provider).toBe('dsh'));
    expect(capturedViewProps()?.scrollContainer).toBe(second);

    // Rows and disposal of the replaced mount must not touch the view now on screen.
    act(() => stale!.update([{ id: 'a-2', role: 'assistant', text: '被替换的旧输出' }]));
    act(() => stale!.dispose());
    await waitFor(() => expect(capturedViewProps()?.provider).toBe('dsh'));
    expect(capturedViewProps()?.messages).toEqual([{ id: 'b-1', role: 'assistant', text: '新挂载的输出' }]);

    act(() => current!.dispose());
    await waitFor(() => expect(capturedViewProps()).toBeNull());
  });

  it('removes the view when the plugin tab unmounts, without a late controller breaking', async () => {
    const { host, view } = await mountHostAndHarness();
    const container = document.createElement('div');

    let controller: ConversationController | undefined;
    act(() => {
      controller = host.mountConversationOutput!(container, { provider: 'pi', messages: [ROW] });
    });
    await waitFor(() => expect(capturedViewProps()?.messages).toEqual([ROW]));

    view.unmount();
    expect(() => controller!.dispose()).not.toThrow();
    expect(capturedViewProps()).toBeNull();
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
    expect(capturedViewProps()).toBeNull();

    // A later update is validated the same way the initial mount was.
    let controller: ConversationController | undefined;
    act(() => {
      controller = host.mountConversationOutput!(container, { provider: 'pi', messages: [] });
    });
    await waitFor(() => expect(capturedViewProps()).not.toBeNull());
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
    await waitFor(() => expect(capturedViewProps()?.messages).toEqual([
      { id: 'tool-1', role: 'tool', text: '', toolName: 'Bash', thinking: true },
    ]));
    expect(() => controller!.update(null as unknown as WorkerConversationMessage[])).toThrow(/messages array/);
  });
});
