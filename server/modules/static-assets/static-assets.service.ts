import path from 'node:path';
import type { ServerResponse } from 'node:http';

import express from 'express';
import type { RequestHandler } from 'express';

// Cache policy for the two directories the server exposes as static files:
// `public/` (manifest, icons, sounds, sw.js) and `dist/` (the Vite build).
//
// The policy exists so a rebuilt frontend is picked up on the next load without
// clearing site data (Android WebView cold start / foreground resume included):
// - HTML (index.html and the SPA fallback) is never stored, so the document that
//   names the current build's hashed assets always comes from the network.
// - The service worker script is always revalidated and is never immutable: an
//   immutable sw.js would pin an old worker for up to a year.
// - Content-hashed build assets (`assets/*-<hash>.js|css|…`) are immutable for a
//   year because a new build changes their file name.
// - Everything else (manifest, icons, fonts, non-hashed files) is revalidated via
//   ETag/Last-Modified, so unchanged files answer 304 instead of re-downloading.
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE_CONTROL = 'no-cache';
const HTML_CACHE_CONTROL = 'no-cache, no-store, must-revalidate';

const HASHED_FILE_NAME = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const SERVICE_WORKER_FILE_NAMES = new Set(['sw.js', 'service-worker.js']);

/** Returns true for Vite-style content-hashed build files inside an `assets` directory. */
function isContentHashedAsset(filePath: string): boolean {
  const normalizedPath = filePath.split(path.sep).join('/');
  return normalizedPath.includes('/assets/') && HASHED_FILE_NAME.test(path.posix.basename(normalizedPath));
}

/**
 * Sets the cache headers for one static file. Used by `createStaticAssetsMiddleware` for
 * `public/` and `dist/`, and by the server entrypoint for the SPA `index.html` fallback so
 * documents, the service worker, hashed assets and revalidated assets share one policy.
 */
export function applyStaticAssetCacheHeaders(response: ServerResponse, filePath: string): void {
  const fileName = path.basename(filePath).toLowerCase();

  if (path.extname(fileName) === '.html') {
    response.setHeader('Cache-Control', HTML_CACHE_CONTROL);
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
    return;
  }

  if (SERVICE_WORKER_FILE_NAMES.has(fileName)) {
    // Revalidate on every load: browsers may otherwise reuse a worker script for up
    // to 24 hours (and forever if a CDN marked it immutable).
    response.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
    return;
  }

  if (isContentHashedAsset(filePath)) {
    response.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
    return;
  }

  response.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
}

/**
 * Serves `public/` first and `dist/` second, exactly like two `express.static` mounts,
 * with the shared cache policy applied to both. Used by the server entrypoint; keeping
 * the mount order here lets the cache tests exercise the real wiring instead of a copy.
 */
export function createStaticAssetsMiddleware(options: {
  publicDirectory: string;
  distDirectory: string;
}): RequestHandler {
  const publicFiles = express.static(options.publicDirectory, { setHeaders: applyStaticAssetCacheHeaders });
  const distFiles = express.static(options.distDirectory, { setHeaders: applyStaticAssetCacheHeaders });

  return function staticAssetsMiddleware(request, response, next) {
    publicFiles(request, response, (publicFilesError?: unknown) => {
      if (publicFilesError) {
        next(publicFilesError);
        return;
      }
      distFiles(request, response, next);
    });
  };
}
