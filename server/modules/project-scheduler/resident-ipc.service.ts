import {
  getPluginPort,
  onPluginExit,
  onPluginMessage,
  onPluginReady,
  sendPluginMessage,
} from '@/modules/plugins/index.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';
import type {
  ResidentBindingView,
  ResidentError,
  ResidentIpcChannel,
  ResidentIpcEvent,
} from '@/shared/index.js';

import type { ResidentHostService } from './resident-host.service.js';

/** Bundled plugin name fixed by the scheduler manifest. */
const SCHEDULER_PLUGIN = 'project-scheduler';
const CHANNEL: ResidentIpcChannel = 'cloudcli-scheduler-resident';
const ACTIONS = new Set([
  'adopt',
  'status',
  'setEnabled',
  'setVisible',
  'stop',
  'continue',
  'remove',
]);
const ERROR_CODES = new Set<ResidentError['code']>([
  'invalid_request',
  'not_found',
  'already_resident',
  'unsupported_provider',
  'not_running',
  'session_unavailable',
  'active_execution',
  'stop_failed',
  'continue_failed',
]);

function readError(error: unknown): ResidentError {
  if (error instanceof AppError && ERROR_CODES.has(error.code as ResidentError['code'])) {
    return { code: error.code as ResidentError['code'], message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'invalid_request', message };
}

/**
 * The one IPC bridge between the host resident service and the bundled
 * scheduler plugin.
 *
 * Direction: the plugin sends `kind: "request"` (its HTTP handlers), the host
 * answers with `kind: "response"`; the host pushes `sync`/`terminal`/`changed`
 * events. Request shapes are validated once here, and every semantic check
 * (real active run, provider, native id, uniqueness) stays in the host service.
 */
export function createResidentIpcService(host: ResidentHostService) {
  let unsubscribeMessage: (() => void) | null = null;
  let unsubscribeReady: (() => void) | null = null;
  let unsubscribeExit: (() => void) | null = null;

  function send(message: ResidentIpcEvent | Record<string, unknown>): void {
    sendPluginMessage(SCHEDULER_PLUGIN, message);
  }

  /** Pushed after every plugin (re)start: reconcile stored tasks, never resume a turn. */
  function sync(): void {
    if (!getPluginPort(SCHEDULER_PLUGIN)) return;
    const { bindings } = host.snapshot();
    send({ channel: CHANNEL, kind: 'event', event: 'sync', value: { bindings } });
  }

  async function handleMessage(raw: unknown): Promise<void> {
    const message = readObjectRecord(raw);
    if (!message || message.channel !== CHANNEL || message.kind !== 'request') return;
    const id = typeof message.id === 'string' ? message.id : '';
    const action = typeof message.action === 'string' ? message.action : '';
    if (!id || !ACTIONS.has(action)) {
      if (id) {
        send({
          channel: CHANNEL,
          id,
          kind: 'response',
          ok: false,
          error: { code: 'invalid_request', message: 'Unknown resident request.' },
        });
      }
      return;
    }
    const payload = readObjectRecord(message.payload) ?? {};
    try {
      const value = await host.handleRequest(action, payload);
      send({ channel: CHANNEL, id, kind: 'response', ok: true, value });
    } catch (error) {
      send({ channel: CHANNEL, id, kind: 'response', ok: false, error: readError(error) });
    }
  }

  return {
    /** Pushes one contract event; exported for the host service's emit hook. */
    emit(event: ResidentIpcEvent): void {
      send(event);
    },

    start(): void {
      if (unsubscribeMessage) return;
      unsubscribeMessage = onPluginMessage(SCHEDULER_PLUGIN, (message: unknown) => {
        void handleMessage(message);
      });
      // A plugin restart (or first ready) only reconciles; the host owns any
      // restart recovery and never re-sends continue because of this event.
      unsubscribeReady = onPluginReady(SCHEDULER_PLUGIN, () => sync());
      unsubscribeExit = onPluginExit(SCHEDULER_PLUGIN, () => {
        // Bindings stay authoritative in the host; the plugin's cursor catches
        // up on the next ready through `sync`.
      });
    },

    stop(): void {
      unsubscribeMessage?.();
      unsubscribeReady?.();
      unsubscribeExit?.();
      unsubscribeMessage = null;
      unsubscribeReady = null;
      unsubscribeExit = null;
    },
  };
}
