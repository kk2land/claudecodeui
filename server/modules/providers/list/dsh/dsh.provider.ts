import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshAuthProvider } from '@/modules/providers/list/dsh/dsh-auth.provider.js';
import { DshModelsProvider } from '@/modules/providers/list/dsh/dsh-models.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshSkillsProvider } from '@/modules/providers/list/dsh/dsh-skills.provider.js';
import { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';
import { DshSessionSynchronizer } from '@/modules/providers/list/dsh/dsh-session-synchronizer.provider.js';
import { DshRuntimeProvider } from '@/modules/providers/list/dsh/dsh-runtime.provider.js';

/** Independent DSH provider registered alongside the existing coding agents. */
export class DshProvider extends AbstractProvider {
  private readonly configuration = new DshConfigurationProvider();
  private readonly store = new DshSessionStore(this.configuration);
  private readonly events = new DshEventsProvider();
  readonly auth = new DshAuthProvider(this.configuration);
  readonly models = new DshModelsProvider(this.store);
  readonly mcp = new DshMcpProvider(this.configuration);
  readonly skills = new DshSkillsProvider(this.configuration);
  readonly sessions = new DshSessionsProvider(this.store, this.events);
  readonly sessionSynchronizer = new DshSessionSynchronizer(this.store);
  readonly runtime = new DshRuntimeProvider(this.configuration, this.events, this.mcp, this.sessionSynchronizer);
  constructor() { super('dsh'); }
}
