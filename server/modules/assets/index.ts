// Express router mounted at /api/assets by server/index.ts for uploading and
// serving chat attachments stored in the global ~/.cloudcli/assets folder.
export { default as assetsRoutes } from './assets.routes.js';
// copyFilesIntoChatAssets: used by Todos prepare to place private todo files into the chat asset store.
export { copyFilesIntoChatAssets } from './services/image-assets.service.js';
