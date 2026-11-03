# Android native bridge contract

Status: **decided contract for stage 1**. Server, Android and web implementations follow this
document; do not invent a second variant. Ownership after this document: **W1 owns the server
implementation, W2 owns `android/` only, W3 owns `src/` only**. The Android app is a self-use
APK (Kotlin, AndroidX WebKit, OkHttp, `minSdk 26`, `targetSdk 36`). There is **no FCM, no push
platform, no offline-message replay, and no extra queue/library**.

The app loads exactly one configured HTTP(S) root site in a `WebView`. A native foreground
service (`specialUse`) owns an independent WebSocket used only for server notifications. The
web app keeps using its existing REST, JWT, upload, download and draft code.

```
Android activity / WebView                         Android foreground service
  injected window.cloudcliAndroid  ── JSON + ArrayBuffer ── bridge
  web app (src/)                                           │
        │ REST/JWT                                         │ OkHttp WS + REST refresh
        └──────────────── server (server/) ────────────────┘
```

## 1. What already exists and what this contract reuses

Investigated on this branch (based on `main`, 543 files ahead; no existing Android bridge):

| Area | Existing behaviour reused |
| --- | --- |
| Notification transport | `server/modules/notifications/websocket/desktop-notifications-websocket.service.ts`: one `register` message, `registered` reply, `DEVICE_ID_REQUIRED` error then close, one-shot registration, unregister on close/error |
| Client registry | `server/modules/notifications/services/desktop-notification-clients.service.ts`: per-user map keyed by endpoint id, replaces an older socket for the same device, sends only endpoints enabled in the device table |
| Event/payload | `notification-orchestrator.service.js`: 20 s dedupe, `{title, body, data:{sessionId, code, provider, sessionName, tag}}`, notification id = `data.tag` or timestamp |
| Device table/preferences | generic `notification_channel_endpoints` table and `user_notification_preferences`; `POST /api/notifications/endpoints/current` upserts an endpoint and sets `channels.<channel>` from enabled endpoints; no migration needed |
| WS auth/heartbeat | upgrade-time `verifyWebSocketClient` (JWT from `?token=` or `Authorization`), 30 s server ping, terminate on missing pong, pathname routing in `websocket-server.service.ts` |
| JWT | 7 day expiry; `X-Refreshed-Token` after half-life; 401 with `X-Auth-Error: session-expired` / `invalid-token`; `POST /api/auth/refresh` returns `{token}` |
| Web token | `src/shared/authToken.ts`: `auth-token` in `localStorage`, 60 s expiry skew, refresh at half-life, refuses to store an expired/malformed token; `src/shared/api.ts` uses `cache:'no-store'` and only expires on a real 401 |
| Auth bootstrap | `AuthContext` reads `localStorage`, calls `/api/auth/status`, then `/api/auth/user`; a token refresh must not remount the workspace |
| Attachments | `POST /api/assets/files`: max 10 files, 10 MiB each; composer enforces the same limits (`MAX_ATTACHMENT_COUNT=10`, `MAX_ATTACHMENT_SIZE=10 MiB`) |
| Downloads/ZIP | binary stream `GET /api/file-tree/projects/:projectId/files/content`; single file and JSZip folder export both end in a `Blob` + anchor download (`useFileTreeOperations.ts`) |
| Desktop client | `electron/desktopNotifications.js`: header auth, `register`, `notification`, `notification_ack`, reconnect 1 s→30 s reset after `registered`. This is **not** a web/Android API and must not be used as a fallback |

Changes already present in this branch but outside this contract: provider/Codex/DSH work and
the `src/shared/api.ts` / `authToken.ts` cache hardening above. Keep those intact.

## 2. Server: `/android-notifications`

Add one WebSocket path, reusing the existing upgrade auth and heartbeat. The handler is the
existing registration protocol parameterised by channel; desktop behaviour must not change.

### 2.1 Route and channel

- Path: `/android-notifications` (exact match, next to `/desktop-notifications` in
  `createWebSocketServer`).
- Channel string in the device table and preferences: `android`.
- `verifyWebSocketClient` is unchanged. Android connects with
  `Authorization: Bearer <jwt>`; `?token=` remains accepted by the server for parity but is
  not used by the app (avoids tokens in URLs/logs).
- A rejected upgrade is an HTTP 401. There is no per-frame authentication.
- `request.user` can have `id`/`userId`; read it the same way as the desktop handler.

### 2.2 Registration frames

Client → server, once per connection:

```json
{"type":"register","deviceId":"<uuid>","label":"Android","platform":"android","appVersion":"1.0"}
```

Server → client:

```json
{"type":"registered","deviceId":"<same uuid>","enabled":true}
```

Rules, identical to desktop:

- `type` may be read from `type` or legacy `kind`.
- `register` is accepted only once. A second `register` and any unknown message are ignored.
- Missing/blank `deviceId`: send
  `{"type":"error","code":"DEVICE_ID_REQUIRED","message":"Android notification registration requires deviceId."}`
  then close with `1008` and reason `Missing deviceId`.
- Registration store failure: close `1011` (`Registration failed`).
- Missing authenticated user inside the handler: close `1008` (`Missing authenticated user`).
- `deviceId` is a UUID generated once by the app and stored privately. It is stable across
  service restarts and reconnects.
- A newly registered socket replaces an older open socket for the same user+device; the old
  socket is closed with `4000` (`Device reconnected`).
- Close/error unregisters the socket from the in-memory registry. The device-table row is
  not deleted.

### 2.3 Notifications and acknowledgement

Server → client, same payload as desktop:

```json
{
  "type": "notification",
  "id": "claude:session-1:run.stopped",
  "payload": {
    "title": "Session name or CloudCLI",
    "body": "Claude: Run Stopped: ...",
    "data": {
      "sessionId": "app-session-id-or-null",
      "code": "run.stopped",
      "provider": "claude",
      "sessionName": "Session name or null",
      "tag": "claude:app-session-id:run.stopped"
    }
  }
}
```

Client → server after the notification is posted (or intentionally suppressed):

```json
{"type":"notification_ack","id":"<message id>","action":"shown"}
```

The server ignores acknowledgements. No acknowledgement means no retry and no replay.

### 2.4 Heartbeat, close and reconnect

- The server pings every 30 s and terminates a socket that missed the previous pong.
- The Android client does **not** send an application-level `ping`; OkHttp answers protocol
  pings automatically.
- Network failure, timeout, DNS/TLS failure, reset, abnormal remote close, or close codes
  `1000`/`1001`/`1005`/`1006`/`1012`/`1013`: mark `connected=false`, set `lastError` to the
  actual connection failure, and keep reconnecting with the existing capped backoff:
  1 s, 2 s, 4 s, 8 s, 16 s, then 30 s, reset to 1 s after `registered`. Retries continue
  while the service is enabled; never count attempts or infer an old server from failures.
- Reconnect re-runs the registration sequence in §3.8. It does not request missed events.
- `1008` / `1011`: record the server's error and stop the service (configuration/auth
  problem).
- A **definitive** unsupported response only: an exact HTTP 404 from
  `POST /api/notifications/endpoints/current` or from the WS upgrade, or an explicit
  `{"type":"error","code":"UNSUPPORTED_SERVER"|"NOT_IMPLEMENTED"}` frame. Then set
  `lastError = "UNSUPPORTED_SERVER"` and stop; a user enable or new login starts a fresh
  attempt. A socket that merely closes before `registered` with no explicit response is not
  definitive and follows the reconnect rule above.
- `4000`: reconnect immediately (a newer socket for the same device replaced this one).
- User disable/logout/origin change: client closes with `1000` and does not reconnect.

### 2.5 Channel, endpoint registration, preferences

Reuse the generic table and routes. **No schema migration.**

- Native service, before opening the WS on every connect, calls
  `POST /api/notifications/endpoints/current` with the JWT:

```json
{
  "channel": "android",
  "endpointId": "<deviceId>",
  "label": "Android",
  "metadata": {"platform": "android", "appVersion": "1.0"},
  "enabled": true
}
```

  The existing route upserts the device row and sets `channels.android` from enabled
  endpoints. Only after a 2xx does the service open the WS.
- Disable calls
  `PATCH /api/notifications/endpoints/android/<deviceId>` with `{"enabled": false}`, then
  closes the WS and stops the service. A 404 on disable is ignored (endpoint already gone).
- A 401 on either REST call follows the auth-expired path (§4.2).
- `user_notification_preferences` gains only a default `channels.android: false`; the
  normaliser already preserves extra boolean channels, so stored values survive.
- The orchestrator channel list gains:

```js
{
  id: 'android',
  isEnabled: (preferences) => Boolean(preferences?.channels?.android),
  send: ({ userId, payload }) => sendNotificationToChannel(userId, payload, 'android')
}
```

- Delivery is best effort to open, enabled Android sockets only. `attempted`/`sent` follow
  the existing desktop semantics. No persistence, no offline delivery.
- Event preferences (`events.actionRequired/stop/error`) and the 20 s dedupe remain shared.

### 2.6 Server implementation boundary (W1)

Keep edits local and additive:

1. `desktop-notification-clients.service.ts`: add an optional `channel = 'desktop'` to the
   register input, store the channel with the socket, and add
   `sendNotificationToChannel(userId, payload, channel)`. Keep
   `sendDesktopNotification(...)` as a wrapper for `'desktop'`.
2. `desktop-notifications-websocket.service.ts`: extract the current body into
   `handleNotificationChannelConnection(ws, request, channel)`; keep
   `handleDesktopNotificationsConnection` as the `'desktop'` wrapper and export
   `handleAndroidNotificationsConnection` for `'android'`. Keep the desktop device-id error
   text unchanged (`Desktop notification registration requires deviceId.`); Android uses
   `Android notification registration requires deviceId.`. The `DEVICE_ID_REQUIRED` code and
   close behaviour stay exact.
3. `notification-orchestrator.service.js`: add the `android` channel and the default
   preference key.
4. `notification-preferences.ts`: add `android: false` to the default/type.
5. `websocket-server.service.ts`: route `/android-notifications`; export the handler from the
   notifications barrel.

No new REST route, table, column or migration.

## 3. Android app: origin, injection and bridge

### 3.1 Configured site

- One persisted `siteOrigin`: `scheme://host[:port]`, scheme is `http` or `https`, no path,
  query, fragment or credentials. Example `https://cloud.example.com:8443`.
- Root-path deployments only. A subpath deployment is not supported by this app.
- Origin change: clear the native token, stop the service, set
  `notificationsEnabled = false`, keep pending shares, then load the new origin.
- If no origin is configured, show the native configuration screen; do not inject the bridge.
- For an `http` origin, permit cleartext traffic for the configured site (manifest
  `usesCleartextTraffic` or a network-security config). `https` remains the normal case.

### 3.2 Injection

Use AndroidX WebKit only:

- `WebViewCompat.addDocumentStartJavaScript(webView, BRIDGE_JS, setOf(siteOrigin))`
- `WebViewCompat.addWebMessageListener(webView, "cloudcliAndroidNative", setOf(siteOrigin), listener)`

`BRIDGE_JS` embeds the configured origin string and installs the bridge only when:

```js
window.top === window && location.origin === "<siteOrigin>"
```

so iframes never see `window.cloudcliAndroid`. The native listener also rejects
`!isMainFrame` and any `sourceOrigin != siteOrigin`. Install both before loading the site;
remove the script handler when the WebView is destroyed.

The bridge is exposed only if `DOCUMENT_START_SCRIPT`, `WEB_MESSAGE_LISTENER` and
`WEB_MESSAGE_ARRAY_BUFFER` are supported. Otherwise expose nothing; the web app must show
"Android bridge unavailable", not a degraded desktop mode.

`addDocumentStartJavaScript` (allowed origin rules), `addWebMessageListener`, and
`WebMessageCompat` string/`byte[]` (ArrayBuffer) were checked against the official AndroidX
WebKit reference. `WebMessageCompat.TYPE_ARRAY_BUFFER` is the binary path.

### 3.3 Native ↔ JS transport

JS sends to native:

```js
window.cloudcliAndroidNative.postMessage(JSON.stringify(message))
```

Native sends to JS with the reply proxy (`WebMessageCompat` string or `byte[]`, which arrives
as a string or `ArrayBuffer`). The injected script uses `cloudcliAndroidNative.onmessage`
only; the app never calls the native object directly.

Four JSON message shapes:

```jsonc
// request, JS -> native
{"v":1,"id":"c-1","method":"getState","params":{}}
// response, native -> JS (exactly one per request id)
{"v":1,"id":"c-1","ok":true,"result":{}}
{"v":1,"id":"c-1","ok":false,"error":{"code":"CANCELLED","message":"..."}}
// event, native -> JS
{"v":1,"event":"state","data":{}}
// transfer control, either direction, no response
{"v":1,"type":"transfer.ack","transferId":"t-1","nextOffset":262144}
{"v":1,"type":"transfer.abort","transferId":"t-1","reason":"cancelled"}
```

`id` is generated by the JS wrapper per request (UUID or monotonically increasing string).
`transferId` is generated by native (UUID). Every request id is answered once, and native
never reuses an id.

### 3.4 Public web API

`window.cloudcliAndroid` is a plain object with exactly these members:

```ts
type AndroidBridgeState = {
  version: 1;
  siteOrigin: string;
  webBridgeReady: boolean;
  signedIn: boolean;
  notificationsEnabled: boolean;
  serviceRunning: boolean;
  connected: boolean;
  lastError: string | null;
  pendingShareCount: number;
};

type AndroidFile = { name: string; mimeType: string; size: number; blob: Blob };

type AndroidShare = {
  id: string;
  kind: 'text' | 'link' | 'image' | 'file';
  text: string | null;
  name: string | null;
  mimeType: string | null;
  size: number | null;
  createdAt: number;             // epoch ms
};

type AndroidBridge = {
  version: 1;
  getState(): Promise<AndroidBridgeState>;
  notify(input: {
    title: string;
    body: string;
    sessionId?: string | null;
    tag?: string | null;
  }): Promise<{ shown: boolean }>;
  setNotificationsEnabled(enabled: boolean): Promise<AndroidBridgeState>;
  getSession(): Promise<{ token: string } | null>;
  saveSession(token: string): Promise<{
    accepted: boolean;
    reason?: 'INVALID_TOKEN' | 'EXPIRED_TOKEN';
  }>;
  clearSession(): Promise<void>;
  listShares(): Promise<AndroidShare[]>;
  getShareContent(id: string): Promise<{ name: string; mimeType: string; size: number; blob: Blob }>;
  consumeShare(id: string): Promise<void>;
  discardShare(id: string): Promise<void>;
  pickFiles(options?: {
    multiple?: boolean;          // default false
    maxBytes?: number;           // default 10 * 1024 * 1024
    maxFiles?: number;           // default 10 when multiple, else 1
  }): Promise<AndroidFile[]>;
  saveFile(input: {
    name: string;
    mimeType?: string;           // default application/octet-stream
    blob: Blob;
  }): Promise<{ saved: boolean }>;
};
```

Promise rejection is an `Error` with `name = "AndroidBridgeError"` and a `code`:

`UNAVAILABLE`, `CANCELLED`, `INVALID_ARGUMENT`, `FILE_TOO_LARGE`, `TOO_MANY_FILES`,
`SHARE_NOT_FOUND`, `SHARE_NOT_FILE`, `TRANSFER_FAILED`, `INVALID_TOKEN`, `NOT_SIGNED_IN`,
`PERMISSION_DENIED`, `WEB_BRIDGE_NOT_READY`.

`AndroidBridgeState.lastError` is `null` while healthy and is cleared on `registered`.
Otherwise it carries the actual failure code: `NETWORK_ERROR`, `SOCKET_CLOSED`,
`REGISTER_FAILED`, `AUTH_EXPIRED`, `PERMISSION_DENIED`, `NOT_SIGNED_IN`,
`WEB_BRIDGE_NOT_READY`, or `UNSUPPORTED_SERVER`. `UNSUPPORTED_SERVER` is used only for the
definitive responses in §2.4. Network failures leave `connected=false`, set the actual
connection error, and keep the capped reconnect running; they never become
`UNSUPPORTED_SERVER`.

Semantics:

- `getState` is local and must not perform network I/O. `connected` means a `registered`
  frame was received, not merely an open socket.
- `notify` posts one local system notification. It does not start the service, persist
  anything or request permission. If permission is not granted, resolve
  `{shown:false}`. `sessionId` is only used for the click target. `tag` replaces an existing
  notification with the same tag; if absent use the request id.
- `setNotificationsEnabled(true)` requires `webBridgeReady` and `signedIn`; otherwise it
  makes no change and returns the state with `lastError` set
  (`WEB_BRIDGE_NOT_READY` / `NOT_SIGNED_IN`). It requests Android 13+
  `POST_NOTIFICATIONS`; denial returns `lastError: "PERMISSION_DENIED"` and leaves the
  setting false. Success sets the local preference, registers the endpoint and starts the
  service. It resolves after the first attempt has been queued/started, not after the socket
  is connected.
- `setNotificationsEnabled(false)` disables the endpoint (best effort), closes the socket,
  stops the service and clears the local preference.
- `getSession` returns `{token}` only when the stored token is non-expired for the current
  origin, otherwise `null`. No network.
- `saveSession` validates JWT shape and `exp`. An invalid/expired token is not stored and
  returns `accepted:false`. A valid token is authoritative (login/re-login may replace a
  stored token). If `notificationsEnabled` is true, a valid save starts the service.
- `clearSession` removes the native token and stops the service. It keeps
  `notificationsEnabled` (so the next login resumes) and keeps pending shares. It does not
  emit `session-expired`.
- `listShares` is oldest-first. Text/link items carry `text`; images/files carry
  `name/mimeType/size` and `text:null`.
- `getShareContent` is only for `image`/`file`; text/link reject `SHARE_NOT_FILE`. It streams
  bytes and leaves the item pending.
- `consumeShare` and `discardShare` remove the item and its cached bytes; both are idempotent
  for an unknown id. `consumeShare` is called only after the web has inserted the content.
- `pickFiles` cancel resolves `[]`. Count/size violations reject with no partial result.
  Files are read into memory and returned as `Blob`s.
- `saveFile` opens `ACTION_CREATE_DOCUMENT`; cancel rejects `CANCELLED`. `name` is
  sanitised (no path separators; fallback `download`).
- `webBridgeReady` becomes true when native receives its first valid JSON bridge request
  from the main frame. An old web build that never calls the bridge therefore cannot enable
  notifications. The first `getSession()` in web bootstrap is the handshake.

### 3.5 Events

Native events are dispatched on `window` by the injected script as `CustomEvent`s. W3 listens
once and must handle every event idempotently.

| Event | `detail` | When |
| --- | --- | --- |
| `cloudcliandroid:state` | `AndroidBridgeState` | Any state field changes |
| `cloudcliandroid:session` | `{token: string}` | Native background refresh stored a new token |
| `cloudcliandroid:session-expired` | `{}` | Native refresh/registration got 401; token cleared and service stopped |
| `cloudcliandroid:shares-changed` | `{count: number}` | A share arrived, or one was consumed/discarded |

`saveSession` of the same token must not emit `session` (prevents a web↔native loop).
`clearSession` emits `state`, not `session-expired`.

### 3.6 File transfer frames

No base64 and no JSON byte arrays. All file bytes travel as `ArrayBuffer` messages.

A binary frame is:

```
+----------------+---------------------------+----------------------+
| u32 BE header  | UTF-8 JSON header         | raw payload bytes    |
| length (4 B)   | exactly headerLen bytes   | exactly length bytes |
+----------------+---------------------------+----------------------+
```

Header JSON, exact keys:

```json
{"transferId":"t-1","offset":0,"length":262144}
```

- `offset` is the byte offset in the whole file; `length` is the payload byte count.
- `CHUNK_SIZE = 262144` (256 KiB); the last chunk may be smaller. `length` must never exceed
  `CHUNK_SIZE` except that the final payload is allowed to be 0 only for a zero-byte file.
- `headerLen` is unsigned 32-bit big-endian. `headerLen + length` must equal the remaining
  ArrayBuffer byte length; otherwise abort `TRANSFER_FAILED`.
- The first chunk has `offset = 0`. Each receiver acknowledges the highest contiguous byte:

```json
{"v":1,"type":"transfer.ack","transferId":"t-1","nextOffset":262144}
```

- The sender sends exactly one chunk and waits for that ack before the next chunk. After the
  receiver acknowledges `nextOffset === size`, the **web side** sends
  `transfer.finish` (request) and native finalises the transfer.

Requests that start transfers:

```jsonc
// web -> native: export a Blob
{"v":1,"id":"c-2","method":"file.save","params":{"name":"a.zip","mimeType":"application/zip","size":123}}
// native -> web
{"v":1,"id":"c-2","ok":true,"result":{"transferId":"t-1"}}
// then web uploads chunks, then:
{"v":1,"id":"c-3","method":"transfer.finish","params":{"transferId":"t-1"}}
// native -> web
{"v":1,"id":"c-3","ok":true,"result":{"saved":true}}
```

```jsonc
// web -> native: pick files
{"v":1,"id":"c-4","method":"file.pick","params":{"multiple":true,"maxBytes":10485760,"maxFiles":10}}
// native -> web; bytes for every transfer follow the same chunk/ack protocol
{"v":1,"id":"c-4","ok":true,"result":{"files":[
  {"transferId":"t-2","name":"a.png","mimeType":"image/png","size":1234},
  {"transferId":"t-3","name":"b.pdf","mimeType":"application/pdf","size":5678}
]}}
```

```jsonc
// web -> native: read an image/file share
{"v":1,"id":"c-5","method":"share.content","params":{"id":"<shareId>"}}
// native -> web
{"v":1,"id":"c-5","ok":true,"result":{"transferId":"t-4","name":"a.jpg","mimeType":"image/jpeg","size":1234}}
```

Finish for a read transfer returns `{"saved":false}`; the web wrapper ignores that field and
resolves the `Blob`.

Native must allow independent `transferId`s but stream chunks serially per transfer. It must
delete a partially written save target on `transfer.abort` or a failed finish. JS may start
another transfer while one is active; the header removes any ordering ambiguity.

### 3.7 Shares

- Activity handles `ACTION_SEND` and `ACTION_SEND_MULTIPLE`: `EXTRA_TEXT` (text, or `link`
  when the trimmed value is one `http(s)` URL) and `EXTRA_STREAM`/`ClipData` URI list.
- Copy incoming bytes immediately into app-private `filesDir/shares/` and keep an index
  there. Never rely on the share URI grant outliving the activity. This is what makes a share
  survive process death and remain pending while signed out.
- One intent with both text and a file creates two pending items. Each new intent is imported
  once; `onNewIntent` uses the same path.
- Emit `shares-changed` and update `pendingShareCount` whenever the index changes. Do not
  navigate, choose a session, create a draft or send anything natively.
- `consumeShare`/`discardShare` delete the indexed file; unknown ids resolve without error.
- Native enforces the known attachment boundary while importing a share, before copying:
  at most 10 files from one intent, and no file larger than 10 MiB. Files beyond the count or
  size limit are **not copied** (no oversized bytes enter the app); keep any accompanying
  text/link and show a clear native notice naming the skipped file and limit. The pending
  index contains only copied items.
- The web still applies the existing composer attachment limits when inserting; a rejected
  insert leaves the copied share pending.

### 3.8 Native auth and service lifecycle

- Token record: `{token, siteOrigin}` in private `SharedPreferences`
  (`allowBackup=false`). Decode `iat`/`exp` locally (no signature check); the server remains
  the authority. Use the same 60 s expiry skew as `src/shared/authToken.ts`.
- `saveSession` stores only a valid, non-expired token. Native refresh:
  - request `POST {siteOrigin}/api/auth/refresh` with the current token;
  - capture the token used for the request; on 2xx validate `{token}`, and store it **only if
    the currently stored token is still that captured token** (a web login in between wins);
  - on 401 clear token, stop service, emit `session-expired`;
  - on network error retry after 60 s while the service is enabled; stop scheduling if the
    token is now expired.
  - schedule the next refresh at `iat + (exp - iat) / 2`, matching the web.
- Service start (only when `notificationsEnabled && signedIn`):
  1. if the token is expired, clear/emit `session-expired` and stop;
  2. if past half-life, refresh first;
  3. `POST /api/notifications/endpoints/current` (channel `android`) with the token;
  4. open the same authority as `siteOrigin` with `http`→`ws` / `https`→`wss` and path
     `/android-notifications`, with `Authorization: Bearer`; send `register` after open; mark
     `connected` only after `registered`.
- If the endpoint registration or WS upgrade returns an exact HTTP 404, or the server sends
  an explicit `error` frame with `UNSUPPORTED_SERVER`/`NOT_IMPLEMENTED`, set
  `lastError = "UNSUPPORTED_SERVER"` and stop. All other network failures/timeouts/abnormal
  closes keep the capped reconnect from §2.4 running and report the actual failure; do not
  infer an old server from the number of failed attempts.
- Manifest: `INTERNET`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_SPECIAL_USE`; the service declares
  `android:foregroundServiceType="specialUse"` with its subtype property.
- Foreground notification channel: low-importance `cloudcli-service`; user notifications:
  `cloudcli-events` (default importance). Android 13+ requires `POST_NOTIFICATIONS`.
- Notification click: `PendingIntent` opens the activity with the `sessionId` extra. The
  activity loads `siteOrigin + "/session/" + encodeURIComponent(sessionId)` (or
  `siteOrigin + "/"` when absent). A full load is intentional and deterministic; the SPA
  route already handles `/session/:sessionId`. No web event is required for a click.
- The notification tag is `payload.data.tag ?? message.id`; the body/title are used as sent.
  There is no message persistence and no replay after reconnect.
- No boot receiver, no FCM, no offline store, no notification actions.

## 4. Web (`src/`) adapter

### 4.1 Capability boundary — check once

Add one adapter module (W3 owns `src/`; suggested `src/modules/android-bridge/` with an
`index.ts` barrel). It exports a memoised `getAndroidBridge()` that returns the injected
object only when `version === 1` and every required method is a function. Everything else
returns `null`.

- `null` means **Android bridge unavailable**: Settings shows that message and does not show
  Android controls. Do not probe `window.cloudcliDesktop*`, do not use browser push as a
  fallback, and do not pretend to be the desktop app.
- The bridge is not the Electron/desktop bridge. `IS_PLATFORM` is unrelated.

### 4.2 Bootstrap order (must be before React renders)

Modify the entry point (`src/main.tsx`) to await one idempotent
`initializeAndroidBridge()` before `ReactDOM.createRoot(...).render(...)`:

1. `const bridge = getAndroidBridge()`. If null, continue to render.
2. `const session = await bridge.getSession()`.
   - token present: `storeAuthToken(session.token)`. It re-validates and dispatches the
     normal refreshed event; if it returns false, remove `auth-token`.
   - token absent: `localStorage.removeItem('auth-token')`. On Android the native store is
     authoritative; a stale web token must not be used.
3. Register listeners once (module-level, idempotent):
   - `AUTH_TOKEN_REFRESHED_EVENT` → `bridge.saveSession(token)`; ignore
     `{accepted:false}` (log only).
   - `AUTH_SESSION_EXPIRED_EVENT` → `bridge.clearSession()`.
   - `cloudcliandroid:session` → `storeAuthToken(event.detail.token)`.
   - `cloudcliandroid:session-expired` → `expireAuthSession()` (then the auth-event listener
     clears native idempotently).
   - `cloudcliandroid:state` → update the adapter's cached state for consumers.
   - `cloudcliandroid:shares-changed` → refresh the pending-share count and inbox.
4. Optionally call `bridge.listShares()` so pending shares can be shown after login.
5. Render. `AuthContext` then runs its existing bootstrap and `/api/auth/user` with the
   native-restored token.

Logout must explicitly call `getAndroidBridge()?.clearSession()` (the existing `logout` only
clears local state and emits no event). Do not call `clearSession` on a token refresh.

Because `saveSession` is fed by `AUTH_TOKEN_REFRESHED_EVENT`, login/register and every
`X-Refreshed-Token` reach native without changing `AuthContext`'s refresh logic. The 60 s
expiry rule and `storeAuthToken`'s refusal to store expired tokens are the only overwrite
guards; native applies the same rules plus the captured-token check in §3.8.

### 4.3 Settings and notifications

- Add `android: boolean` to `NotificationPreferencesState` (`src/shared/types.ts`), the
  settings defaults and the settings normaliser. The server normaliser already preserves the
  key; missing server values mean `false`.
- Add an Android section to `NotificationsSettingsTab` only when the bridge is present and
  `webBridgeReady`. Use the bridge state, not a client-side copy:
  - toggle → `setNotificationsEnabled(next)`;
  - show `connected`, `serviceRunning`, `lastError`;
  - if `lastError === 'PERMISSION_DENIED'`, explain that Android notification permission was
    denied; if `lastError === 'UNSUPPORTED_SERVER'`, say the server does not support Android
    notifications.
- Do not reuse the desktop state/update props and do not write `channels.android` through a
  separate preferences PUT as the source of truth. The native endpoint registration already
  updates it; mirror the value returned by `setNotificationsEnabled` into local preference
  state so later whole-object saves stay consistent.
- `channels.android` is device/service-derived, not a web push subscription.

### 4.4 File download / picker / share insertion

- Add one shared helper (e.g. `saveBlob(blob, fileName)`) used by file-tree single-file
  download and the JSZip folder export:
  - bridge present → `bridge.saveFile({name, mimeType: blob.type, blob})`;
  - otherwise → the existing object-URL + anchor click.
  - Do not base64 the Blob; the bridge wrapper slices it into 256 KiB `ArrayBuffer` chunks.
- File picker in the composer: if bridge present, call
  `bridge.pickFiles({multiple:true, maxBytes:10*1024*1024, maxFiles:10})`, convert each
  result to `new File([blob], name, {type: mimeType})`, and pass it through the existing
  composer add-files path (which still enforces 10/10 MiB). Drag/drop and paste stay as-is.
- Share inbox (W3 UI; no server change):
  - show pending shares after bootstrap and on `shares-changed`; while signed out, keep them
    pending and show them after login;
  - user picks a session; never auto-select or auto-send;
  - navigate to the target session when it is not open, then append to that session's
    composer draft. Text/link appends to existing text separated by `\n\n` (never replace).
    Image/file calls `getShareContent`, converts to `File`, and adds it to the composer
    attachments through the existing add-files path; if the current composer cannot accept
    it, keep the share pending and show an error. The native share importer has already
    enforced the 10 MiB / 10-file copy boundary, and this insertion still goes through the
    existing composer add-files limits.
  - only after the content is in the draft/composer call `consumeShare(id)`. "Discard"
    calls `discardShare(id)`. Never create a queued message and never send.
- Draft persistence remains web-owned; no new server draft fields. Text survives through the
  existing draft store. A file share is inserted only into the live composer after
  navigation, matching the existing unsent-attachment behaviour.

## 5. Downstream checks

W1 (server):

1. `/android-notifications` registration/error/close behaves exactly like
   `/desktop-notifications`; desktop tests unchanged.
2. Endpoint row is `channel=android`; `channels.android` follows enabled endpoints; no
   migration.

W2 (Android only):

1. Service survives WebView suspension; reconnect/backoff/heartbeat and 401 handling match
   §2.4/§3.8; network/abnormal closes keep retrying, and only definitive unsupported
   responses stop the service. No FCM or replay.
2. Bridge injects only for the configured main-frame origin; file frames are
   `[u32 headerLen][JSON header][bytes]` with no base64; shares survive process death and
   login.
3. Share import copies at most 10 files per intent and skips any file over 10 MiB before
   copying, with a clear user notice.

W3 (web):

1. Bootstrap restores native token before `AuthProvider`; logout clears native; native
   refresh updates web storage; 401 ends at the login screen.
2. Missing bridge → explicit unsupported UI; no desktop fallback.
3. Android settings use only the native bridge; `android` survives settings normalisation.
4. Blob/ZIP save and picker use the bridge; share import appends (never overwrites/sends) and
   consumes only after insertion.

## 6. Explicit non-goals

No FCM or other push service, no offline notification store/replay, no web-push reuse for
Android, no Android SDK runtime for providers, no native steer/plan, no server draft schema
change, no subpath site support, no multi-site support, no general file-sync or background
upload framework.
