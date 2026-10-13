import { useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider, ProviderCapabilityRow } from '@/shared/types';

/**
 * Cached at module scope because the matrix is static for the life of the
 * server process and more than one part of the UI asks for it. Without this,
 * opening the sidebar would refetch it on every mount.
 */
let cachedCapabilities: Partial<Record<LLMProvider, ProviderCapabilityRow>> | null = null;
let inFlightRequest: Promise<Partial<Record<LLMProvider, ProviderCapabilityRow>>> | null = null;

async function loadCapabilities(): Promise<Partial<Record<LLMProvider, ProviderCapabilityRow>>> {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }
  if (inFlightRequest) {
    return inFlightRequest;
  }

  inFlightRequest = (async () => {
    try {
      const response = await api.providers.capabilities();
      const body = (await response.json()) as { success?: boolean; data?: { providers?: ProviderCapabilityRow[] } };
      const rows = body.success && Array.isArray(body.data?.providers) ? body.data.providers : [];
      const byProvider: Partial<Record<LLMProvider, ProviderCapabilityRow>> = {};
      for (const row of rows) {
        byProvider[row.provider] = row;
      }
      cachedCapabilities = byProvider;
      return byProvider;
    } catch (error) {
      console.error('Error loading provider capabilities:', error);
      // Not cached: a transient failure should not disable affordances for the
      // rest of the session.
      return {};
    } finally {
      inFlightRequest = null;
    }
  })();

  return inFlightRequest;
}

/** Chat and sidebar use the server's capability matrix; unloaded capabilities grant no features. */
export function useProviderCapabilities(): Partial<Record<LLMProvider, ProviderCapabilityRow>> {
  // Keep feature entry points hidden until the backend advertises their support.
  const [capabilities, setCapabilities] = useState<Partial<Record<LLMProvider, ProviderCapabilityRow>>>({});
  useEffect(() => {
    let cancelled = false;
    void loadCapabilities().then((capabilities) => {
      if (!cancelled) setCapabilities(capabilities);
    });
    return () => { cancelled = true; };
  }, []);
  return capabilities;
}

/**
 * Reports which providers can branch a session's transcript.
 *
 * Empty until the matrix loads, so an affordance is never offered and then
 * withdrawn.
 */
export function useSessionForkingProviders(): Set<LLMProvider> {
  const capabilities = useProviderCapabilities();
  return useMemo(() => new Set(Object.values(capabilities)
    .filter((row) => row?.supportsSessionForking)
    .map((row) => row.provider)), [capabilities]);
}
