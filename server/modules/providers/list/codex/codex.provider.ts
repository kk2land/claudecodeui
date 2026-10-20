import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';
import { CodexAppServerTransport, codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { createCodexAppServerClient, codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { createCodexSdkRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { getCodexProcessEnv } from '@/shared/index.js';
import { CodexForkProvider } from '@/modules/providers/list/codex/codex-fork.provider.js';
import { CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';
import { codexRuntimeRouter, createCodexRuntimeRouter } from '@/modules/providers/list/codex/codex-runtime-router.provider.js';
import { CodexMcpProvider } from '@/modules/providers/list/codex/codex-mcp.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { CodexSkillsProvider } from '@/modules/providers/list/codex/codex-skills.provider.js';
import type {
  CodexProviderId,
  IProviderAuth,
  IProviderFork,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/index.js';

/** Codex and GPT Web assemble the same adapters with profile-specific process and filesystem ownership. */
export class CodexProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime;
  readonly models: IProviderModels;
  readonly mcp: CodexMcpProvider;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly fork: IProviderFork;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;

  constructor(
    provider: CodexProviderId = 'codex',
    models: IProviderModels = new CodexProviderModels(provider),
    auth: IProviderAuth = new CodexProviderAuth(provider),
  ) {
    super(provider);
    const transport = provider === 'codex' ? codexAppServerTransport
      : new CodexAppServerTransport({ env: () => getCodexProcessEnv(provider) });
    const client = provider === 'codex' ? codexAppServer : createCodexAppServerClient(transport);
    this.models = models;
    this.sessions = new CodexSessionsProvider(provider, client);
    this.runtime = provider === 'codex' ? codexRuntimeRouter : createCodexRuntimeRouter({
      native: new CodexAppServerRuntime(transport, undefined, undefined, undefined,
        async sessionId => (await this.sessions.fetchHistory(sessionId)).messages, provider),
      sdk: createCodexSdkRuntime(provider),
      stop: () => transport.stop(),
      isStopping: () => transport.isStopping,
    }, provider);
    this.mcp = new CodexMcpProvider(provider);
    this.auth = auth;
    this.skills = new CodexSkillsProvider(provider);
    this.fork = new CodexForkProvider(client);
    this.sessionSynchronizer = new CodexSessionSynchronizer(provider);
  }
}
