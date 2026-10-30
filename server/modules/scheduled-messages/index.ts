// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from './scheduled-messages.routes.js';

// Server timer lifecycle, plus the immediate enqueue/dispatch entries consumed
// by the User module, the chat gateway, and provider queue integration tests.
export {
  dispatchQueuedMessages,
  requestQueuedMessageDispatch,
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
} from './services/scheduled-message-dispatcher.service.js';
