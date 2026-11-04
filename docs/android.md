# CloudCLI Android app

Self-hosted Android client for one CloudCLI server. The APK is built and signed locally and is not
distributed through any store.

Implemented (native, `android/`):

- One natively configured HTTP/HTTPS **root origin** per install (`scheme://host[:port]`, no path,
  credentials, query or fragment). `http` origins work via `usesCleartextTraffic`.
- A single `WebView` with the **injected bridge** (`window.cloudcliAndroid`, version 1) at document
  start, restricted to that origin and to the main frame.
- A foreground **`specialUse` service** owning the `/android-notifications` WebSocket, endpoint
  registration, half-life JWT refresh and user notifications. No FCM, no offline replay.
- Share intake (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`) into an app-private pending index with the
  10 files / 10 MiB copy boundary, plus system file pick and save via the bridge and for plain
  `<input type="file">` pages.
- Network-first shell loading on cold start, new WebView, user open/reload and notification deep
  links (`LOAD_DEFAULT` + explicit `Cache-Control: no-cache`).

Not in this app (by contract): FCM or any push platform, offline notification store/replay, subpath
or multi-site deployments, native model/plan/permission UIs (the web app owns those), Android SDK
runtime for providers, background upload/sync frameworks.

## Bridge API

`window.cloudcliAndroid` (version `1`) exposes exactly:

`getState`, `notify`, `setNotificationsEnabled`, `getSession`, `saveSession`, `clearSession`,
`listShares`, `getShareContent`, `consumeShare`, `discardShare`, `pickFiles`, `saveFile`.

- Requests/responses are JSON (`{v:1,id,method,params}` / `{v:1,id,ok,result|error}`), one response
  per request id.
- Events are `CustomEvent`s on `window`: `cloudcliandroid:state`, `cloudcliandroid:session`,
  `cloudcliandroid:session-expired`, `cloudcliandroid:shares-changed`.
- Rejections are `Error` with `name === 'AndroidBridgeError'` and a contract `code`
  (`UNAVAILABLE`, `CANCELLED`, `INVALID_ARGUMENT`, `FILE_TOO_LARGE`, `TOO_MANY_FILES`,
  `SHARE_NOT_FOUND`, `SHARE_NOT_FILE`, `TRANSFER_FAILED`, `INVALID_TOKEN`, `NOT_SIGNED_IN`,
  `PERMISSION_DENIED`, `WEB_BRIDGE_NOT_READY`).
- File bytes never use base64: `[u32 BE headerLen][UTF-8 JSON header][payload]` frames of at most
  256 KiB, one chunk outstanding per transfer with `transfer.ack`, finished by `transfer.finish`.
  Zero-byte files send exactly one empty chunk so both sides complete.

If the WebView does not support document-start scripts, web message listeners or ArrayBuffer
messages, **nothing is exposed** (no partial bridge); the web app then shows "Android bridge
unavailable".

`getState` fields: `version`, `siteOrigin`, `webBridgeReady`, `signedIn`, `notificationsEnabled`,
`serviceRunning`, `connected` (true only after the server's `registered` frame), `lastError`,
`pendingShareCount`.

## Notification connection

- Endpoint registration: `POST /api/notifications/endpoints/current` (`channel: android`,
  `endpointId` = stable device UUID), then the `/android-notifications` WebSocket with
  `Authorization: Bearer`.
- One live connection per service: enabling again while a socket exists (or a connect is in flight)
  keeps it; a newer token is picked up by the next handshake. Socket callbacks are bound to the
  attempt that created the socket, so a replaced socket cannot reconnect or stop the current one.
- Reconnect backoff 1, 2, 4, 8, 16, then 30 s, reset after `registered`. `4000` reconnects
  immediately. `1008`/`1011` stop the service. Only an exact 404 on the endpoint registration or WS
  upgrade, or an explicit `UNSUPPORTED_SERVER`/`NOT_IMPLEMENTED` error frame, sets
  `lastError = UNSUPPORTED_SERVER` and stops; every other failure keeps retrying.
- A half-life refresh that is superseded by a newer token (web `saveSession` while the refresh is in
  flight, or a reconnect happening at the same moment) never applies the stale response, and the
  token that is current takes over the single refresh schedule; `connect` continues with the current
  credentials instead of leaving the service enabled without a socket or a retry.
- JWT: decoded locally (`iat`/`exp`, 60 s skew), refreshed at half-life via
  `POST /api/auth/refresh`. A response is applied only while the captured origin **and** token are
  still current (logout, site change or a newer login wins). One 60 s retry chain on failure; a 401
  clears the token, stops the service and emits `session-expired`.
- Stop/disable is immediate and local: state flips, socket invalidated, foreground notification
  removed, service stopped; the endpoint `PATCH` is a detached best-effort call. Stopping never
  starts a foreground service just to close a socket.
- Channels: `cloudcli-service` (low importance, ongoing, "Stop" action disables notifications) and
  `cloudcli-events` (default importance). Android 13+ `POST_NOTIFICATIONS` is requested on first
  enable; denial leaves the setting off with `lastError = PERMISSION_DENIED`.
- Notification click opens the activity and loads `siteOrigin + /session/<id>` (or `/`). No
  notification persistence or replay.

## Shares and files

- Incoming text/link and file URIs are copied into app-private `filesDir/shares/` with an index, so
  they survive process death and stay pending while signed out. One intent is imported once (the
  delivered intent is consumed; a restored activity does not import it again).
- Import boundary before copying: at most 10 files per intent and at most 10 MiB per file; skipped
  files are named in a native notice and never copied. `ACTION_SEND_MULTIPLE` reads the standard
  `ParcelableArrayList<Uri>` `EXTRA_STREAM` and merges `ClipData`.
- `pickFiles` uses `ACTION_OPEN_DOCUMENT` (`maxFiles`/`maxBytes` enforced before streaming);
  cancel resolves `[]`. `saveFile` uses `ACTION_CREATE_DOCUMENT`, cancel rejects `CANCELLED`.
- Plain `<input type="file">` uploads keep working through `WebChromeClient.onShowFileChooser` using
  the same document picker (single and multiple, honouring the page's `accept` types).

## Cache behaviour

Top-level loads the app initiates set `Cache-Control: no-cache` (with `LOAD_DEFAULT`, never
`LOAD_CACHE_ELSE_NETWORK`), so reopening the app fetches the current HTML and the JS/CSS hashes it
references without clearing login or drafts. The service worker and HTML `no-store`/revalidation are
the server/web side's responsibility (already handled upstream); the app does not force reloads on
`onResume`, so unsent composer attachments and drafts are never discarded.

## Toolchain

| Component | Version |
| --- | --- |
| JDK | 17 |
| Gradle | 8.13 (wrapper in `android/`) |
| Android Gradle Plugin | 8.10.1 |
| Kotlin | 2.1.21 |
| compileSdk / targetSdk | 36 |
| minSdk | 26 |
| build-tools | 36.0.0 |
| Libraries | `androidx.webkit:webkit:1.12.1`, `com.squareup.okhttp3:okhttp:4.12.0` |
| Tests | JUnit 4.13.2 (+ `org.json` for JVM JWT tests) |

`applicationId` = `ai.cloudcli.android`, label `CloudCLI`, `versionCode` 1, `versionName` 0.1.0.
`allowBackup="false"`, so the token, device id and pending shares stay on the device.

## Build and install

Requirements: JDK 17 (`JAVA_HOME` or discovered via `/usr/libexec/java_home`), Android SDK with
`platforms/android-36` and `build-tools/36.0.0` (`ANDROID_SDK_ROOT`/`ANDROID_HOME`, or the existing
`android/local.properties`, or a discovered `sdkmanager`). No path is hard-coded.

```bash
./scripts/build-android-release.sh
```

The script verifies/reuses the keystore, then runs the real gates in order:

1. `lintDebug` — lint failures fail the build (`abortOnError = true`); release-only lint vitals are
   skipped so an offline release build does not need the lint artifacts.
2. `testDebugUnitTest` — JVM unit tests.
3. `assembleRelease` — signed release APK.
4. `apksigner verify --print-certs`, then prints the APK SHA-256 and public signer.

Output: `release/android/cloudcli-android-<versionName>-release.apk` (gitignored).

Install on a device/emulator with
`adb install -r release/android/cloudcli-android-0.1.0-release.apk`, then enter the server origin on
the setup screen and open the site.

## Release signing

Private, outside the repository: `/Users/agent/workspaces/tap/.cloudcli/android-signing`
(directory `700`, files `600`, overridable with `CLOUDCLI_ANDROID_SIGNING_DIR`; the default is
`$HOME/.cloudcli/android-signing` and `HOME`, not the JVM `user.home`, is authoritative).

- `cloudcli-release.p12` — PKCS12, alias `cloudcli-android`, RSA 3072, `SHA256withRSA`,
  validity 10000 days, self-signed `CN=CloudCLI Android`.
  Certificate SHA-256: `4da7c681f9101309af64e432b1d58658920fb4965f6ccc8cc3738497e2e7a5e8`.
- `signing.properties` — `storeFile`, `storeType`, `keyAlias`, `storePassword`, `keyPassword`.

Keep this key: Android only accepts updates signed with the same certificate. Passwords are only
read from that private file/environment by keytool and Gradle; they are never printed, committed, or
packaged into the APK. `*.p12`, `*.jks`, `signing.properties` and `release/android/` are gitignored.

## Verification status

Verified in this repository: 29 JVM unit tests (`SiteOrigin`, `Jwt`, `TransferFrame`,
`ReconnectPolicy`, `RefreshGuard`), the bridge itself under a Node VM (zero-byte transfer, finish
failure rejection, 256 KiB chunking, error/event dispatch), `lintDebug` (0 errors), signed
`assembleRelease` and `apksigner verify`.

**Phase 1 verified on the API 36 emulator (`emulator-5582`, WebView 133.0.6943.137)** with the
release APK (not debuggable), against the `/tmp` fixture on `http://127.0.0.1:3110`:

- bridge v1 with all 12 methods, `getState` answering `webBridgeReady: true`;
- notification permission denial → `notificationsEnabled:false` / `lastError:PERMISSION_DENIED`;
- permission granted → real `POST /api/notifications/endpoints/current` (channel `android`, stable
  device id, `appVersion` from the build) → WS `register` → `registered` → `serviceRunning:true`,
  `connected:true`, foreground `cloudcli-service` notification;
- repeated `setNotificationsEnabled(true)` + `saveSession` keep exactly one live socket;
- `notify()` → system notification (`cloudcli-events`, tag from the request) and tapping it opens
  `/session/<id>`; a fixture-pushed notification while backgrounded is shown and acknowledged
  (`notification_ack … action:shown`);
- the foreground notification `Stop` action closes the socket and notification immediately with no
  auto-restart;
- refresh ownership (connecting phase): a token saved while the 4 s delayed refresh is in flight is
  used for `register`, and the current token gets its own next refresh (~60 s later) with a single
  chain — the service never dead-ends;
- target-36 edge-to-edge: content and the overflow menu are inset below the status bar and above the
  navigation bar/IME (`applyEdgeToEdgeInsets`, no new dependency).

- refresh ownership (connected phase): a token saved while the **connected** half-life refresh is in
  flight again gets its own next refresh (~60 s) with one live socket and `connected:true`;
  `clearSession` during an in-flight refresh clears the token, stops the service and never restores
  either (no retry, no re-register, sockets stay 0).

Also verified through the real backend reverse-proxied at `http://127.0.0.1:3100`: real login,
native `saveSession` sync (enable only succeeds with the native token), real
`POST /api/notifications/endpoints/current`, real `/android-notifications` upgrade authenticated by
the dev server, `已连接服务器`/`后台服务运行中` in the settings UI and the `cloudcli-service`
foreground notification. Switching the A/B fixture from build A to build B (new Vite hash) with a
force-stop and explicit user reopen shows `Runtime build B`, still signed in, and reconnects the
notification socket **after** the fix described below (no boot receiver/watchdog added: the web
bootstrap's `getSession` handshake now resumes the service when the preference is enabled).

- Cache A→B with the real Vite builds behind `http://127.0.0.1:3100`: unsent draft in the same
  new-session scope survives `switch.sh B`, a force-stop and an explicit user reopen — `Runtime build B`,
  still signed in, draft intact and unsent (the new bundle comes from the immutable HTTP cache when the
  hash was fetched before; the executed bundle is verified by the runtime badge, and `/sw.js` shows a
  fresh 304 revalidation).
- Site change no longer leaves `about:blank` in WebView history: Back from the newly configured origin
  exits instead of showing a blank page (history is cleared after the unload and after the first page
  of the new origin; in-site history is untouched).
- `ACTION_SEND` text/link and `ACTION_SEND_MULTIPLE` (real `ParcelableArrayList<Uri>`, 2 files) import
  into the pending index; `getShareContent` returns byte-identical data (sha256 checked), consume and
  discard remove the items, and an 11 MiB file is not imported (10 MiB boundary).
- `saveFile` writes byte-identical data: 300000 B (>256 KiB, sha256 checked) and 0 B both report
  `saved:true` and land in `Download`.

Still unverified natively: `pickFiles` (cancel/success), `saveFile` cancel, plain HTML
`<input type="file">`, and inserting a share into a real session draft through the web share inbox.

Earlier API 34 run (`emulator-5580`) with the **release** APK (not debuggable):
the setup screen accepts `http://127.0.0.1:3000`, the real dev site loads in the app's WebView, real
credentials log in successfully, the session survives force-stop/relaunch, and the new overflow menu
exposes *Change site* / *Reload* (the `NoActionBar` theme previously left the options menu
unreachable). Back with no WebView history exits the activity.

Blocked on the emulator's WebView: the installed provider (`com.google.android.webview`
113.0.5672.136) reports `DOCUMENT_START_SCRIPT` and `WEB_MESSAGE_LISTENER` supported but
**`WEB_MESSAGE_ARRAY_BUFFER` unsupported**, so by contract the app exposes no bridge
(`W CloudCLIBridge: bridge disabled, unsupported WebView features: [WEB_MESSAGE_ARRAY_BUFFER]` and
the test page shows `window.cloudcliAndroid` absent). Until the WebView is updated to a provider
that advertises `WEB_MESSAGE_ARRAY_BUFFER`, none of the bridge-dependent flows can be exercised:
notification registration/`registered`, permission deny/grant, system notification + `/session/:id`
click, background fixture delivery/ack, immediate stop / single-socket enable, share intake,
`pickFiles`/`saveFile` (cancel, 0-byte, >256 KiB), plain HTML file upload, and the refresh-ownership
scenarios with the delayed fixture. These are **not** verified natively and the unit/VM tests are not
a substitute. The test fixture used for those scenarios lives at `/tmp/w2-fixture/` (port 3110) and
the emulator has `adb reverse tcp:3110 tcp:3110`; evidence is in `/tmp/w2-emulator-*.log|json`.

## Sandboxed build hosts

If a sandboxed shell kills long network-bound Gradle processes, pre-seed the Kotlin compiler and lint
artifacts into a local Maven repository and pass it with an init script:

```bash
GRADLE_ARGS="--offline -I /path/to/local-repo.init.gradle.kts" ./scripts/build-android-release.sh
# init script body:
# settingsEvaluated { dependencyResolutionManagement { repositories { maven { url = uri("<dir>") } } } }
```

Give Gradle a stdin that is not already at EOF (for example `< <(sleep 900)`); an immediately-EOF
stdin makes the single-use Gradle daemon cancel the build. Interactive terminals are unaffected.
