import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveInput,
  ProviderSkillSetEnabledInput,
  ProviderSkillSetEnabledResult,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export const providerSkillsService = {
  /**
   * Lists normalized skills visible to one provider.
   */
  async listProviderSkills(
    providerName: string,
    options?: ProviderSkillListOptions,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.listSkills(options);
  },

  /**
   * Writes one or more global skills for one provider.
   */
  async addProviderSkills(
    providerName: string,
    input: ProviderSkillCreateInput,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.addSkills(input);
  },

  async removeProviderSkill(
    providerName: string,
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: string; directoryName: string }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.removeSkill(input);
  },

  /**
   * Persists one skill's enabled flag for providers that support the toggle.
   *
   * Providers without a native per-skill setting reject the call explicitly so
   * the UI reports "unsupported" instead of pretending the change was stored.
   */
  async setProviderSkillEnabled(
    providerName: string,
    input: ProviderSkillSetEnabledInput,
  ): Promise<ProviderSkillSetEnabledResult> {
    const provider = providerRegistry.resolveProvider(providerName);
    if (!provider.skills.setSkillEnabled) {
      throw new AppError(`${providerName} does not support enabling or disabling skills.`, {
        code: 'PROVIDER_SKILL_ENABLED_UNSUPPORTED',
        statusCode: 400,
      });
    }

    return provider.skills.setSkillEnabled(input);
  },
};
