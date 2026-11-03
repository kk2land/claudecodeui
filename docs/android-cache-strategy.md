# Android / WebView cache strategy

Scope: the static file entry points (`server/index.ts` -> `server/modules/static-assets`),
`public/sw.js`, and what the Android shell (`W2`) and web app (`W3`) must do so a rebuilt
frontend is picked up on reconnect without clearing site data or losing the login token.
No provider, notification, database or bridge contract is involved.

## Server response headers

One policy is applied to `public/`, `dist/` and the SPA `index.html` fallback
(`server/modules/static-assets/static-assets.service.ts`):

| Resource | `Cache-Control` | Why |
| --- | --- | --- |
| `index.html`, SPA navigation fallback, any `.html` | `no-cache, no-store, must-revalidate` | The document names the current build's hashed assets, so it must come from the network every load. |
| `sw.js` / `service-worker.js` (in `public/` or `dist/`) | `no-cache` | Always revalidated (ETag/304), never `immutable`. An immutable worker script could stay pinned for up to a year. |
| Content-hashed build assets: `/assets/<name>-<hash8+>.<ext>` | `public, max-age=31536000, immutable` | The file name changes with every build. |
| Everything else: `manifest.json`, icons, sounds, non-hashed images/fonts | `no-cache` | Revalidated per load; unchanged files answer 304, so they are not re-downloaded. |

Caveat fixed here: the previous rule keyed on file extension, so an npm install (which ships
`dist/`, not `public/`) served `dist/sw.js` as `immutable` for a year. The policy now keys on
the file name and hash, not the extension.

## Service worker (`public/sw.js`)

- Cache name `claude-ui-v3`; precaches only `/manifest.json`.
- `navigate` requests: network only, `fetch(request, { cache: 'no-store' })`. No HTML is
  written to Cache Storage. On network failure it returns a plain "Offline" page — it does
  not serve an older document.
- `/assets/<hashed>` GETs: cache-first (safe because the name changes per build); a new
  build's asset is fetched and cached under its new name.
- Other same-origin GETs: network-first, with the existing `caches.match` fallback. Responses
  are not written to Cache Storage; HTTP revalidation owns freshness.
- `/api/*`, `/ws`, `/shell`, `/plugin-ws`, `*-notifications`, non-GET and cross-origin
  requests are not intercepted.
- `install`: precache manifest, then `skipWaiting()`. `activate`: delete only caches whose
  name starts with `claude-ui-` and is not current, then `clients.claim()`. It never clears
  `localStorage`, cookies, chat drafts or another app's caches.

The previous worker (`claude-ui-v2`) already used network-only navigation, so a WebView that
still has it is not blocked: its navigation reaches the server, which now sends the new HTML
and the new worker script is revalidated on the next registration update check. The first
public APK release has no still-installed older worker, so no legacy migration framework is
needed.

## W2 (Android only) — required behaviour, no data wipe

1. Create the `WebView` with `LOAD_DEFAULT` (not `LOAD_CACHE_ONLY`/`LOAD_NO_CACHE` globally)
   and keep the normal WebView HTTP cache: per-response headers above already force fresh
   HTML and revalidated `sw.js`.
2. On each cold start and when the user re-opens the site, load the root URL with
   `WebSettings.setCacheMode(WebSettings.LOAD_DEFAULT)`. Do not clear WebView/HTTP cache,
   cookies, `localStorage` or the app's token store to pick up an update.
3. When the app returns from warm background, do not auto-reload a WebView that has unsent
   composer content; a new cold start or explicit open is enough because every navigation
   re-fetches HTML with `no-store`.
4. If a manual refresh action exists, prefer `webView.reload()`; do not mutate storage.

## W3 (web only) — required behaviour, minimal

1. In `src/main.tsx`, change the existing registration to
   `navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })` so the worker
   script and its imports always bypass the HTTP cache, then call
   `registration.update()` once after registration resolves. This is the only web change
   needed; the bundle itself is refreshed because the fresh HTML references new asset hashes.
2. Do not force a page reload on `controllerchange`: `skipWaiting` + `clients.claim` are for
   the next navigation, and reloading would discard an active editor/composer state.
3. Keep the existing `notification:navigate` message handling unchanged.

## Verification

Unit / HTTP tests (this work):

```bash
node_modules/.bin/tsx --tsconfig server/tsconfig.json --test \
  server/modules/static-assets/tests/static-assets.service.test.ts \
  server/modules/static-assets/tests/service-worker-cache.test.ts
```

They cover the real static mount wiring for build A/B, HTML/SPA/worker/manifest headers,
304 revalidation, service-worker navigation freshness, hashed-asset reuse, offline behaviour
and old-cache cleanup.

End-to-end acceptance (after W2 integration; against a local build, never by wiping data):

1. Build and serve vA; open the site in the APK, log in, and note the bundle hash in the
   Network tab / devtools.
2. Build vB (change any UI string), restart only `dev`, then fully close the app and reopen
   it. The first document request must be a network 200 with `cache-control: no-cache,
   no-store` and reference vB's `/assets/index-<newhash>.js`; the old `/assets/index-<old>.js`
   must not appear in the loaded resources.
3. Confirm the login state and chat drafts are intact (no storage clear), and that the
   `sw.js` request revalidates (200 or 304, `cache-control: no-cache`) rather than returning
   a cached `immutable` copy.
4. Put the device offline, reload: HTML shows the "Offline" page while an already-loaded PWA
   shell does not claim to be an even newer build. Restore the network and reload: vB loads.
