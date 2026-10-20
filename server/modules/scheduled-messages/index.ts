// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from './scheduled-messages.routes.js';

// Server timer lifecycle and the dispatch entry used by provider queue integration tests.
export {
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
} from './services/scheduled-message-dispatcher.service.js';
