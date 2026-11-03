// Static asset cache policy: used by the server entrypoint for `public/`, `dist/` and the
// SPA index.html fallback, and by its tests to verify the real mount wiring.
export { applyStaticAssetCacheHeaders, createStaticAssetsMiddleware } from './static-assets.service.js';
