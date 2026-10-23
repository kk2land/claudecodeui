import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { CODEX_PREDEFINED_MODELS } from '@/modules/providers/list/codex/codex-models.provider.js';
import { CURSOR_PREDEFINED_MODELS } from '@/modules/providers/list/cursor/cursor-models.provider.js';
import { OPENCODE_PREDEFINED_MODELS } from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types.js';

/**
 * The full curated catalogs, before OpenCode narrows its list to the upstream
 * providers a machine has connected.
 */
const CURATED_CATALOGS: Record<LLMProvider, ProviderModelsDefinition> = {
  claude: CLAUDE_PREDEFINED_MODELS,
  codex: CODEX_PREDEFINED_MODELS,
  cursor: CURSOR_PREDEFINED_MODELS,
  opencode: OPENCODE_PREDEFINED_MODELS,
  dsh: { DEFAULT: 'default', OPTIONS: [{ value: 'default', label: 'Profile default' }] },
};

test('DSH advertises image attachments for both supported transports', () => {
  const capabilities = providerCapabilitiesService.getProviderCapabilities('dsh');
  assert.equal(capabilities.supportsImages, true);
  assert.equal(capabilities.supportsFiles, true);
  assert.deepEqual(capabilities.runtimeManagement?.modes, ['acp', 'headless']);
});

test('provider visibility normalizes environment entries without removing capabilities', () => {
  const original = process.env.CLOUDCLI_HIDDEN_PROVIDERS;
  try {
    process.env.CLOUDCLI_HIDDEN_PROVIDERS = ' Cursor, CODEX, cursor \n opencode,unknown, ';
    const rows = providerCapabilitiesService.listAllProviderCapabilities();
    assert.equal(rows.length, Object.keys(CURATED_CATALOGS).length);
    assert.deepEqual(rows.filter((row) => row.hiddenFromModelPicker).map((row) => row.provider).sort(),
      ['codex', 'cursor', 'opencode']);
    assert.equal(providerCapabilitiesService.getProviderCapabilities('codex').hiddenFromModelPicker, true);
    assert.equal(providerCapabilitiesService.getProviderCapabilities('codex').nativeControls?.plan, true);
    assert.equal(providerCapabilitiesService.getProviderCapabilities('claude').hiddenFromModelPicker, false);

    for (const value of [undefined, '', ' , \n ', 'unknown']) {
      if (value === undefined) delete process.env.CLOUDCLI_HIDDEN_PROVIDERS;
      else process.env.CLOUDCLI_HIDDEN_PROVIDERS = value;
      assert.equal(providerCapabilitiesService.listAllProviderCapabilities().some((row) => row.hiddenFromModelPicker), false);
    }
  } finally {
    if (original === undefined) delete process.env.CLOUDCLI_HIDDEN_PROVIDERS;
    else process.env.CLOUDCLI_HIDDEN_PROVIDERS = original;
  }
});

test('capability effort levels cover every level a curated model declares', () => {
  // Custom models may declare only these levels, so a level added to a curated
  // model has to be added here too, or users could not give it to their own.
  for (const [provider, catalog] of Object.entries(CURATED_CATALOGS) as Array<[LLMProvider, ProviderModelsDefinition]>) {
    const { effortLevels, supportsEffort } = providerCapabilitiesService.getProviderCapabilities(provider);

    assert.equal(supportsEffort, effortLevels.length > 0, `${provider}: supportsEffort disagrees with effortLevels`);
    assert.equal(new Set(effortLevels).size, effortLevels.length, `${provider}: effortLevels lists a level twice`);

    const declaredLevels = new Set(
      catalog.OPTIONS.flatMap((option) => option.effort?.values.map((level) => level.value) ?? []),
    );
    const missingLevels = [...declaredLevels].filter((level) => !effortLevels.includes(level));
    assert.deepEqual(missingLevels, [], `${provider}: effortLevels misses curated levels`);
  }
});

test('Goals require an explicit environment opt-in in both capability endpoints', () => {
  const original = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  try {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'true']) {
      if (value === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
      else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = value;
      const expected = value === 'true';
      assert.equal(providerCapabilitiesService.getProviderCapabilities('codex').nativeControls?.goal, expected);
      assert.equal(providerCapabilitiesService.listAllProviderCapabilities().find((row) => row.provider === 'codex')?.nativeControls?.goal, expected);
      assert.equal(providerCapabilitiesService.getProviderCapabilities('codex').nativeControls?.plan, true);
      assert.equal(providerCapabilitiesService.getProviderCapabilities('codex').nativeControls?.steer, true);
    }
  } finally {
    if (original === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
    else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = original;
  }
});

test('Codex account rate limits require an explicit environment opt-in', () => {
  const original = process.env.CLOUDCLI_CODEX_RATE_LIMITS_ENABLED;
  try {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'true']) {
      if (value === undefined) delete process.env.CLOUDCLI_CODEX_RATE_LIMITS_ENABLED;
      else process.env.CLOUDCLI_CODEX_RATE_LIMITS_ENABLED = value;
      const expected = value === 'true';
      assert.equal(providerCapabilitiesService.getProviderCapabilities('codex').accountRateLimits, expected);
      assert.equal(
        providerCapabilitiesService.listAllProviderCapabilities().find((row) => row.provider === 'codex')?.accountRateLimits,
        expected,
      );
      // No other provider ever exposes a Codex quota card.
      assert.equal(providerCapabilitiesService.getProviderCapabilities('claude').accountRateLimits, undefined);
    }
  } finally {
    if (original === undefined) delete process.env.CLOUDCLI_CODEX_RATE_LIMITS_ENABLED;
    else process.env.CLOUDCLI_CODEX_RATE_LIMITS_ENABLED = original;
  }
});
