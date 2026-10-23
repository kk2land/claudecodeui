import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { CodexRateLimitsState } from '@/shared/types.js';

/**
 * Fans one `codex_rate_limits_updated` frame out to every open, already
 * authenticated chat socket. The server bootstrap registers it as the Codex
 * rate-limit service's listener, so the settings account card updates without
 * polling and without a second socket. The frame is the plain cache state, so it
 * carries no credential or account identity.
 *
 * Consumed by `server/index.ts` startup wiring and by this module's broadcast
 * tests, which assert the payload shape and fan-out.
 */
export function broadcastCodexRateLimits(state: CodexRateLimitsState): void {
  const payload = JSON.stringify({ kind: 'codex_rate_limits_updated', ...state });
  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) return;
    try {
      client.send(payload);
    } catch {
      // A socket that closed after the readyState check, or a broken transport,
      // must not stop the remaining clients from receiving the frame.
    }
  });
}
