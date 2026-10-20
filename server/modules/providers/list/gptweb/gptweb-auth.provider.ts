import { createRequire } from 'node:module';

import type { IProviderAuth, IProviderModels } from '@/shared/index.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

/** GPT Web reports its separately configured bridge connection without starting a default-home login flow. */
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
