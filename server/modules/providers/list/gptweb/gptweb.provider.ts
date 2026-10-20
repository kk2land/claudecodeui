import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { GptwebModelsProvider } from '@/modules/providers/list/gptweb/gptweb-models.provider.js';
import { GptwebAuthProvider } from '@/modules/providers/list/gptweb/gptweb-auth.provider.js';

/** The provider registry selects the shared Codex implementation with GPT Web's independent home and catalog. */
export class GptwebProvider extends CodexProvider {
  constructor() {
    const models = new GptwebModelsProvider();
    super('gptweb', models, new GptwebAuthProvider(models));
  }
}
