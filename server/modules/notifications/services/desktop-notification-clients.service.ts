import type { WebSocket } from 'ws';

import { notificationChannelEndpointsDb } from '@/modules/database/index.js';

const DEFAULT_CHANNEL = 'desktop';

type NotificationClientRegistration = {
  userId: number;
  channel: string;
  endpointId: string;
};

// Each user keeps one map per notification channel so a device id can exist for
// several channels at once (a browser desktop socket and an Android service).
const clientsByUserId = new Map<number, Map<string, Map<string, WebSocket>>>();
const clientBySocket = new WeakMap<WebSocket, NotificationClientRegistration>();

function normalizeUserId(userId: unknown): number | null {
  const numeric = Number(userId);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeEndpointId(endpointId: unknown): string {
  if (typeof endpointId !== 'string') return '';
  return endpointId.trim();
}

function getUserChannelClients(
  userId: unknown,
  channel: string,
  create = false
): Map<string, WebSocket> | null {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return null;
  let channels = clientsByUserId.get(normalizedUserId);
  if (!channels && create) {
    channels = new Map();
    clientsByUserId.set(normalizedUserId, channels);
  }
  if (!channels) return null;
  let clients = channels.get(channel);
  if (!clients && create) {
    clients = new Map();
    channels.set(channel, clients);
  }
  return clients || null;
}

/**
 * Used by the desktop and Android notification websocket handlers to store the
 * live socket for a user/channel/device and to (re)enable its endpoint row.
 */
export function registerDesktopNotificationClient({
  userId,
  deviceId,
  channel = DEFAULT_CHANNEL,
  label = null,
  platform = null,
  appVersion = null,
  ws,
}: {
  userId: number;
  deviceId: string;
  channel?: string;
  label?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  ws: WebSocket;
}) {
  const normalizedUserId = normalizeUserId(userId);
  const endpointId = normalizeEndpointId(deviceId);
  if (!normalizedUserId || !endpointId) {
    return false;
  }

  const endpoint = notificationChannelEndpointsDb.upsertEndpoint({
    userId: normalizedUserId,
    channel,
    endpointId,
    label,
    metadata: { platform, appVersion },
    enabled: true,
  });

  const clients = getUserChannelClients(normalizedUserId, channel, true)!;
  const previous = clients.get(endpointId);
  clients.set(endpointId, ws);
  clientBySocket.set(ws, {
    userId: normalizedUserId,
    channel,
    endpointId,
  });

  // Registering before closing keeps the same-device replacement in place when
  // the old socket's close handler unregisters it.
  if (previous && previous !== ws && previous.readyState === previous.OPEN) {
    previous.close(4000, 'Device reconnected');
  }
  return endpoint;
}

/**
 * Used by the desktop and Android notification websocket handlers on close and
 * error, and by delivery when a socket is found to be no longer open.
 */
export function unregisterDesktopNotificationClient(ws: WebSocket): void {
  const registration = clientBySocket.get(ws);
  if (!registration) return;

  const clients = getUserChannelClients(registration.userId, registration.channel);
  if (clients?.get(registration.endpointId) === ws) {
    clients.delete(registration.endpointId);
    if (clients.size === 0) {
      const channels = clientsByUserId.get(registration.userId);
      channels?.delete(registration.channel);
      if (channels?.size === 0) {
        clientsByUserId.delete(registration.userId);
      }
    }
  }
  clientBySocket.delete(ws);
}

/**
 * Used by the notification orchestrator to deliver a payload to the open,
 * enabled sockets of one channel.
 */
export function sendNotificationToChannel(
  userId: unknown,
  payload: unknown,
  channel: string
): { attempted: number; sent: number } {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return { attempted: 0, sent: 0 };

  const clients = getUserChannelClients(normalizedUserId, channel);
  if (!clients?.size) return { attempted: 0, sent: 0 };

  const enabledEndpointIds = new Set(
    notificationChannelEndpointsDb
      .getEnabledEndpoints(normalizedUserId, channel)
      .map((endpoint) => endpoint.endpoint_id)
  );

  const message = JSON.stringify({
    type: 'notification',
    id: typeof (payload as any)?.data?.tag === 'string' ? (payload as any).data.tag : `${Date.now()}`,
    payload,
  });

  let attempted = 0;
  let sent = 0;
  for (const [endpointId, ws] of clients.entries()) {
    if (!enabledEndpointIds.has(endpointId)) continue;
    attempted += 1;
    if (ws.readyState !== ws.OPEN) {
      unregisterDesktopNotificationClient(ws);
      continue;
    }
    try {
      ws.send(message);
      notificationChannelEndpointsDb.touchEndpoint(normalizedUserId, channel, endpointId);
      sent += 1;
    } catch {
      unregisterDesktopNotificationClient(ws);
    }
  }

  return { attempted, sent };
}

/**
 * Used by the notification orchestrator for the desktop channel and kept for
 * callers that predate channel-aware delivery.
 */
export function sendDesktopNotification(
  userId: unknown,
  payload: unknown
): { attempted: number; sent: number } {
  return sendNotificationToChannel(userId, payload, DEFAULT_CHANNEL);
}
