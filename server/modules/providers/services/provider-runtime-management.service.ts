import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderRuntimeAction } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function resolveManagement(provider: LLMProvider, sessionId: string | null) {
  if (sessionId) {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) throw new AppError('Session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    if (session.provider !== provider) throw new AppError('Session belongs to a different provider.', { code: 'SESSION_PROVIDER_MISMATCH', statusCode: 400 });
  }
  const management = providerRegistry.resolveProvider(provider).runtime.management;
  if (!management) throw new AppError('Runtime management is unavailable for this provider.', { code: 'UNSUPPORTED_RUNTIME_CONTROL', statusCode: 400 });
  return management;
}

/** Provider routes use this service to validate managed-process and queue operations at the HTTP boundary. */
export const providerRuntimeManagementService = {
  getState(provider: LLMProvider, sessionId: string | null) {
    return resolveManagement(provider, sessionId).getState(sessionId);
  },
  control(provider: LLMProvider, sessionId: string, action: ProviderRuntimeAction) {
    return resolveManagement(provider, sessionId).control(sessionId, action);
  },
};
