import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import type {
  CodexModelCatalog,
  CodexModelProviderPatch,
  CodexModelProviderSettings,
  CodexModelProviderSummary,
  CodexModelProviders,
  CodexRpcClient,
  ProviderModelOption,
} from '@/shared/index.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/index.js';

/** Catalog row as the picker renders it: native metadata plus Codex's own marks. */
type CodexModelCatalogItem = ProviderModelOption & { isDefault: boolean; hidden: boolean };

/**
 * One config-write rejection reason app-server reports in `error.data`. The
 * published protocol schemas omit this error payload, so the mapping accepts the
 * observed serde spelling (`configValidationError`) as well as the protocol's
 * Rust variant name, and only for reasons this service can explain.
 */
type ConfigWriteErrorMapping = { code: string; statusCode: number; message: string };

const CONFIG_WRITE_ERROR_MAPPINGS: Record<string, ConfigWriteErrorMapping> = {
  validationerror: {
    code: 'CODEX_MODEL_PROVIDER_INVALID',
    statusCode: 400,
    message: 'Codex rejected this model provider configuration.',
  },
  pathnotfound: {
    code: 'CODEX_MODEL_PROVIDER_NOT_FOUND',
    statusCode: 404,
    message: 'This model provider is no longer configured in Codex.',
  },
  versionconflict: {
    code: 'CODEX_MODEL_PROVIDER_VERSION_CONFLICT',
    statusCode: 409,
    message: 'Codex config.toml changed while saving this model provider. Reload and try again.',
  },
  layerreadonly: {
    code: 'CODEX_MODEL_PROVIDER_READONLY',
    statusCode: 409,
    message: 'The Codex configuration layer that defines this model provider is read-only.',
  },
  requirementreadonly: {
    code: 'CODEX_MODEL_PROVIDER_READONLY',
    statusCode: 409,
    message: 'Codex requirements make this model provider read-only.',
  },
};

/**
 * Normalizes one `config_write_error_code` value: serde emits
 * `configValidationError`, the protocol enum is `ConfigValidationError`, so the
 * leading `config` prefix and case are not part of the identity.
 */
const configWriteErrorKey = (value: string): string => value.toLowerCase().replace(/^config/, '');

/** Reads a nullable string, keeping an explicit `null` apart from an absent field. */
const readNullableString = (value: unknown): string | null => readOptionalString(value) ?? null;

const invalidDirectory = (message: string): AppError => new AppError(message, {
  code: 'CODEX_MODEL_PROVIDERS_INVALID', statusCode: 502,
});

const invalidCatalog = (message: string): AppError => new AppError(message, {
  code: 'CODEX_MODEL_CATALOG_INVALID', statusCode: 502,
});

/** Maps app-server's credential-free `ProviderSettings` union onto the safe DTO. */
function normalizeSettings(value: unknown, providerId: string): CodexModelProviderSettings {
  const settings = readObjectRecord(value);
  switch (settings?.type) {
    case 'openai':
      return { type: 'openai' };
    case 'customGateway': {
      const auth = readObjectRecord(settings.auth);
      const envKey = readOptionalString(auth?.envKey);
      if (auth?.mode === 'none') return { type: 'customGateway', auth: { mode: 'none' } };
      if (auth?.mode === 'environmentVariable' && envKey) {
        return { type: 'customGateway', auth: { mode: 'environmentVariable', envKey } };
      }
      if (auth?.mode === 'externallyConfigured') {
        return { type: 'customGateway', auth: { mode: 'externallyConfigured', envKey: envKey ?? null } };
      }
      break;
    }
    case 'bedrock':
      return {
        type: 'bedrock',
        region: readNullableString(settings.region),
        profile: readNullableString(settings.profile),
      };
    case 'gcp':
      return {
        type: 'gcp',
        location: readNullableString(settings.location),
        projectId: readNullableString(settings.projectId),
        credentialFile: readNullableString(settings.credentialFile),
      };
    default:
      break;
  }
  // An unknown service kind cannot be described honestly, so the directory fails
  // instead of mislabeling the provider or hiding it from the user.
  throw invalidDirectory(`Codex reported unsupported settings for model provider "${providerId}".`);
}

/** Normalizes one `ModelProviderSummary`, dropping anything the DTO does not name. */
function normalizeProviderSummary(value: unknown): CodexModelProviderSummary {
  const summary = readObjectRecord(value);
  const id = readOptionalString(summary?.id);
  if (!summary || !id) throw invalidDirectory('Codex returned a model provider without an id.');
  return {
    id,
    name: readOptionalString(summary.name) ?? id,
    baseUrl: readNullableString(summary.baseUrl),
    canEdit: summary.canEdit === true,
    settings: normalizeSettings(summary.settings, id),
  };
}

/** Normalizes one `modelProvider/list` response into the safe directory DTO. */
function normalizeDirectory(value: unknown): CodexModelProviders {
  const result = readObjectRecord(value);
  const defaultProvider = readOptionalString(result?.defaultProviderId);
  if (!result || !defaultProvider || !Array.isArray(result.data)) {
    throw invalidDirectory('Codex returned an unreadable model provider directory.');
  }
  const providers = result.data.map(normalizeProviderSummary);
  return {
    defaultProvider,
    // app-server's list response carries no such flag; the safe settings tell
    // whether anything beyond Codex's built-in service is configured.
    hasCustomProviders: providers.some((provider) => provider.settings.type !== 'openai'),
    canChangeDefault: result.canChangeDefault === true,
    providers,
  };
}

/** Normalizes one native `Model` into the catalog row the picker renders. */
function normalizeModelItem(value: unknown): CodexModelCatalogItem {
  const model = readObjectRecord(value);
  // `model` is the slug a turn submits; `id` is only its catalog identity.
  const id = readOptionalString(model?.model);
  if (!model || !id) throw invalidCatalog('Codex returned a model without an id.');
  const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
  const description = readOptionalString(model.description);
  const defaultEffort = readOptionalString(model.defaultReasoningEffort);
  return {
    value: id,
    label: readOptionalString(model.displayName) ?? id,
    ...(description ? { description } : {}),
    effort: {
      ...(defaultEffort ? { default: defaultEffort } : {}),
      values: efforts.map((entry) => {
        const option = readObjectRecord(entry);
        const effort = readOptionalString(option?.reasoningEffort);
        if (!effort) throw invalidCatalog(`Codex returned an unreadable reasoning effort for model "${id}".`);
        const description = readOptionalString(option?.description);
        return description ? { value: effort, description } : { value: effort };
      }),
    },
    isDefault: model.isDefault === true,
    hidden: model.hidden === true,
  };
}

/**
 * Model-provider directory, default-service selection and model catalogs for
 * Codex, all read and written through the native app-server protocol.
 *
 * This service owns no configuration file parsing and no inference requests:
 * `modelProvider/list`, `model/list`, `modelProvider/config/write` and
 * `config/value/write` run on the shared transport, so app-server's own
 * layering, validation, readonly rules and catalog cache stay authoritative.
 * Only credential-free data is normalized into the shared DTOs.
 *
 * Consumers: the providers routes (GET/PUT/POST/PATCH model providers, GET
 * models) and the native runtime/fork adapters that resolve a thread's default
 * service and validate a model selection. Reading this directory starts the
 * app-server when it is not running; nothing is cached here.
 */
export class CodexModelProviderService {
  constructor(private readonly client: CodexRpcClient = codexAppServerTransport) {}

  /**
   * Sends one RPC and maps app-server's config-write rejections onto AppErrors
   * with an actionable status. Transport failures (stopped, timeout, missing
   * launcher) and network/endpoint failures reach the caller unchanged so they
   * stay visible instead of being flattened into a config error.
   */
  private async request<T>(method: string, params?: unknown): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'CODEX_APP_SERVER_REJECTED') throw error;
      throw this.mapRejection(method, error);
    }
  }

  private mapRejection(method: string, error: AppError): AppError {
    const data = readObjectRecord((error.details as { rpcData?: unknown } | undefined)?.rpcData);
    const writeErrorCode = readOptionalString(data?.config_write_error_code);
    const mapping = writeErrorCode ? CONFIG_WRITE_ERROR_MAPPINGS[configWriteErrorKey(writeErrorCode)] : undefined;
    if (mapping) {
      const message = writeErrorCode && configWriteErrorKey(writeErrorCode) === 'validationerror' ? error.message : mapping.message;
      return new AppError(message, { code: mapping.code, statusCode: mapping.statusCode });
    }
    if (data?.type === 'modelProviderMismatch' || data?.type === 'modelProviderPolicyConflict') {
      return new AppError(error.message, { code: 'CODEX_MODEL_PROVIDER_CONFLICT', statusCode: 409 });
    }
    if (data?.type === 'modelProviderNotConfigured' || (method === 'model/list' && data?.modelProvider)) {
      // `model/list` names the provider when its configuration disappeared
      // between the directory read and the catalog request.
      return new AppError('This model provider is no longer configured in Codex.', {
        code: 'CODEX_MODEL_PROVIDER_NOT_FOUND', statusCode: 404,
      });
    }
    // An unrecognized rejection keeps its native message and names the operation
    // that failed, rather than pretending it was a write or losing the cause.
    const fallbackCode = method === 'model/list'
      ? 'CODEX_MODEL_CATALOG_FAILED'
      : method === 'modelProvider/list' ? 'CODEX_MODEL_PROVIDERS_FAILED' : 'CODEX_MODEL_PROVIDER_WRITE_REJECTED';
    return new AppError(error.message, { code: fallbackCode, statusCode: 502 });
  }

  /** Reads the credential-free directory; the runtime also uses it for the global default. */
  async list(): Promise<CodexModelProviders> {
    return normalizeDirectory(await this.request('modelProvider/list', {}));
  }

  /**
   * Saves the default service for new Codex threads and returns the directory
   * that is now in effect.
   *
   * The provider must exist before the write: app-server accepts an unknown id
   * in `config/value/write` and would leave a config.toml that cannot be read.
   * A write that a managed layer overrides is reported as a conflict naming the
   * value actually in effect, because the file was written but did not apply.
   */
  async setDefault(modelProvider: string): Promise<CodexModelProviders> {
    const before = await this.list();
    if (!before.providers.some((provider) => provider.id === modelProvider)) {
      throw new AppError('This model provider is no longer configured in Codex.', {
        code: 'CODEX_MODEL_PROVIDER_NOT_FOUND', statusCode: 404,
      });
    }
    if (!before.canChangeDefault) {
      throw new AppError('Codex configuration does not allow changing the default model provider.', {
        code: 'CODEX_MODEL_PROVIDER_DEFAULT_READONLY', statusCode: 409,
      });
    }
    if (before.defaultProvider === modelProvider) return before;

    const result = await this.request<Record<string, unknown>>('config/value/write', {
      keyPath: 'model_provider',
      value: modelProvider,
      mergeStrategy: 'replace',
    });
    if (result?.status === 'okOverridden') {
      const effective = await this.list();
      const overriding = readObjectRecord(result.overriddenMetadata);
      const layer = readOptionalString(readObjectRecord(overriding?.overridingLayer?.name)?.type);
      const reason = readOptionalString(overriding?.message);
      throw new AppError(
        `Codex wrote model_provider = "${modelProvider}" to config.toml, but it is not in effect: `
        + `the effective default is "${effective.defaultProvider}"`
        + `${layer ? ` from the ${layer} configuration layer` : ' from a higher-priority configuration layer'}`
        + `${reason ? ` (${reason})` : ''}.`,
        { code: 'CODEX_MODEL_PROVIDER_DEFAULT_OVERRIDDEN', statusCode: 409 },
      );
    }
    return this.list();
  }

  /**
   * Reads one provider's complete model catalog across app-server pages.
   *
   * `includeHidden` is requested so hidden rows keep their metadata for a saved
   * selection, but `models` only names picker-visible rows: hidden models never
   * surface as ordinary menu entries. app-server caches the underlying catalog,
   * so this service adds no cache of its own.
   */
  async models(modelProvider: string): Promise<CodexModelCatalog> {
    const items: CodexModelCatalogItem[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params: Record<string, unknown> = { modelProvider, includeHidden: true };
      if (cursor) params.cursor = cursor;
      const page = await this.request<Record<string, unknown>>('model/list', params);
      if (!page || !Array.isArray(page.data)) throw invalidCatalog('Codex returned an unreadable model catalog.');
      items.push(...page.data.map(normalizeModelItem));
      cursor = readOptionalString(page.nextCursor) ?? null;
      if (!cursor) break;
    }
    const visible = new Set<string>();
    for (const item of items) if (!item.hidden) visible.add(item.value);
    return { modelProvider, models: [...visible], items };
  }

  /** Creates a custom gateway. Only a caller-chosen built-in service has a patch id. */
  async create(settings: CodexModelProviderPatch): Promise<CodexModelProviderSummary> {
    if (settings.type !== 'customGateway' || settings.providerId) {
      throw new AppError('New Codex model providers must be custom gateways without a provider id.', {
        code: 'CODEX_MODEL_PROVIDER_CREATE_UNSUPPORTED', statusCode: 400,
      });
    }
    const result = await this.request<Record<string, unknown>>('modelProvider/config/write', {
      settings: { ...settings, providerId: null },
    });
    return normalizeProviderSummary(readObjectRecord(result)?.provider);
  }

  /**
   * Patches one provider. The route id is the only identity this service accepts,
   * so a payload that names a different provider is rejected before any write.
   */
  async update(modelProvider: string, settings: CodexModelProviderPatch): Promise<CodexModelProviderSummary> {
    if (settings.providerId != null && settings.providerId !== modelProvider) {
      throw new AppError('The provider id in the body must match the id in the path.', {
        code: 'CODEX_MODEL_PROVIDER_ID_MISMATCH', statusCode: 400,
      });
    }
    const existing = (await this.list()).providers.find((provider) => provider.id === modelProvider);
    if (!existing) {
      throw new AppError('This model provider is no longer configured in Codex.', {
        code: 'CODEX_MODEL_PROVIDER_NOT_FOUND', statusCode: 404,
      });
    }
    if (!existing.canEdit) {
      throw new AppError('The active Codex configuration does not allow editing this model provider.', {
        code: 'CODEX_MODEL_PROVIDER_READONLY', statusCode: 409,
      });
    }
    const result = await this.request<Record<string, unknown>>('modelProvider/config/write', {
      settings: { ...settings, providerId: modelProvider },
    });
    return normalizeProviderSummary(readObjectRecord(result)?.provider);
  }
}

/** Providers routes and the native runtime share this RPC-backed service. */
export const codexModelProviderService = new CodexModelProviderService();
