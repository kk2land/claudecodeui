export { WS_OPEN_STATE, connectedClients, broadcastToConnectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
// filterAttachmentsToUploadStore: the single upload-store boundary a chat send
// and the User module's draft meta both use, so neither can point a run at an
// arbitrary file.
export { filterAttachmentsToUploadStore } from './services/chat-websocket.service.js';
// onChatRunCompleted: injected by the server composition root into the
// scheduled-messages dispatcher, so a terminal turn starts the next queued
// user prompt without a deep import into this module.
export { onChatRunCompleted } from './services/chat-run-registry.service.js';
// Consumed by the providers module's sessions watcher, which announces the
// sessions it (re)indexed from disk through the same builder the chat gateway
// uses, so both paths put the identical delta on the wire.
export { broadcastSessionUpserted, broadcastSessionUpsertedBatch, broadcastSessionRemoved, setResidentProjectionReader } from './services/session-upsert-broadcast.service.js';
// runDetachedChatTurn: used by the scheduled-messages module to run a turn
// from a timer, with no socket to stream to or report errors on.
export { runDetachedChatTurn } from './services/chat-websocket.service.js';
// startResidentContinueTurn: the trusted continue entry used by the resident
// host; it reuses dispatchRun and reports admission before the turn settles.
export { startResidentContinueTurn } from './services/chat-websocket.service.js';
export type { ResidentContinueAdmission } from '@/shared/types.js';
export { onChatRunStarted } from './services/chat-run-registry.service.js';
export type { ChatRunSnapshot, ChatRunDispatch } from '@/shared/types.js';
// Consumed by the server bootstrap to publish Codex account quota updates on
// the existing authenticated chat sockets instead of a second transport.
export { broadcastCodexRateLimits } from './services/codex-rate-limits-broadcast.service.js';
export type { ProviderRuntimeGateway } from '@/shared/types.js';
