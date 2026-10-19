import { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderCurrentActiveModel, ProviderModelsDefinition } from '@/shared/types.js';

/** DSH model facet; exact ACP choices are resolved and validated at run time. */
export class DshModelsProvider implements IProviderModels {
  constructor(private readonly store: DshSessionStore) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return { DEFAULT: 'default', OPTIONS: [{ value: 'default', label: 'Profile default', description: 'Use the model configured in the DSH profile.' }] };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId) {
      const log = await this.store.find(sessionId);
      const selected = log?.events.slice().reverse().find((event) => event.type === 'model/selection')?.data;
      if (selected?.provider && selected?.model) return { model: `${selected.provider}/${selected.model}` };
    }
    return { model: 'default' };
  }
}
