import { createRequire } from 'node:module';

import type { IProviderAuth, IProviderModels } from '@/shared/index.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

/** GPT Web checks model-service credentials; bridge_catalog does not verify the browser login or Full harness. */
export class GptwebAuthProvider implements IProviderAuth {
  constructor(private readonly models: IProviderModels) {}

  async getStatus(): Promise<ProviderAuthStatus> {
    let installed = false;
    try {
      createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
      installed = true;
      await this.models.getSupportedModels();
      return { provider: 'gptweb', installed, authenticated: true, email: null, method: 'bridge_catalog' };
    } catch (error) {
      return { provider: 'gptweb', installed, authenticated: false, email: null, method: null,
        error: error instanceof Error ? error.message : 'GPT Web is unavailable.' };
    }
  }
}
