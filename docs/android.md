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
messages, **nothing is exposed** (no partial bridge). The native shell reports this with a Toast
("Android bridge unavailable"); the web app can only observe that the bridge object is absent and
falls back to its normal browser behaviour, so the absence of the object does not by itself prove
which platform the page is running on.

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

### First-run notification enablement

Notification channels/sockets are native, but they are only started once the user has enabled them.
On the first meaningful sign-in (a valid native `saveSession`, or a cold-start `getSession` that
returns a valid native token) the shell enables them **once** when no notification preference has
ever been stored: it records `false` first (so the decision is remembered), then asks for the
Android 13+ notification permission and, if granted, sets the preference to `true` and starts the
foreground service through the same path as the web toggle. A denial keeps the preference `false`
with `lastError = PERMISSION_DENIED`; the web settings page can still enable it manually.

An existing explicit `false` is never auto-reversed: `Stop`, disable, a denied permission request
and changing the server all leave a stored `false`, and ordinary token refreshes never prompt again.
No valid native token means no automatic start. The automatic completion is reported through the
existing `cloudcliandroid:state` events; the public bridge API stays at the same 12 methods.

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

`applicationId` = `ai.cloudcli.android`, label `CloudCLI`, `versionCode` 2, `versionName` 0.1.1
(`versionCode` 1 / `0.1.0` was the first real-device build; `0.1.1` is the in-place update).
`allowBackup="false"`, so the token, device id and pending shares stay on the device.

## Shell UI

- **Launcher icon** is the project's own CloudCLI mark, reused read-only from
  `public/icons/icon-512x512.svg` (dark `hsl(240 5.9% 10%)` square, white message-square outline).
  `res/drawable/ic_launcher_foreground.xml` keeps that geometry on a 512 viewport in a 108dp
  adaptive foreground (art ≈67dp, inside the 72dp safe zone),
  `res/drawable/ic_launcher_monochrome.xml` is the Android 13+ themed variant (same geometry,
  alpha only), and `mipmap-anydpi-v26`/`mipmap-anydpi-v33` `ic_launcher`/`ic_launcher_round` are the
  adaptive icons. `res/drawable/ic_notification.xml` stays a white, single-colour status-bar
  silhouette as Android requires. No generated/approximated logo artwork is used.
- **System bars** never paint a Material grey strip: the system contrast scrim is explicitly
  disabled at runtime (`window.isStatusBarContrastEnforced`/`isNavigationBarContrastEnforced = false`,
  Android 10+; no API-29-only theme attribute is used) and the shell background always matches the web
  page's **actual** computed background colour (`getComputedStyle(document.body).backgroundColor`,
  falling back to the root element), not `<meta name="theme-color">` — the meta can drift from the
  CSS (e.g. `#f6f4ef` vs the real light `hsl(44 22% 96%)`). The injected script normalizes it to
  `#rrggbb` and reports it through a private `native.theme` message (not part of the public bridge
  API); `onPageFinished`/`onResume` read it directly as a fallback when the bridge is unavailable.
  `Theme.CloudCLI` itself sets `windowBackground=@color/window_background` (`#F8F7F2`, the same
  value as `MainActivity.DEFAULT_PAGE_BACKGROUND`), transparent `statusBarColor`/
  `navigationBarColor` and `windowLightStatusBar`, so the first frame before the page reports its
  background already matches the light theme. Light navigation-bar icons are set at runtime
  (`windowLightNavigationBar` is API 27 while minSdk is 26, so it is not used as a theme item).
  Live light/dark switches are picked up with a `MutationObserver` on the root/body class and style,
  and a `transitionend` listener on the body/root waits for their 200ms `background-color`
  transition to finish before re-reading (so a class toggle is not reported with the old colour).
  API split: on **API 35/36** (edge-to-edge enforced for target 36) the bars stay transparent and
  the root background shows through; on **API 26-34** the window still paints
  `statusBarColor`/`navigationBarColor` with the same colour (a transparent colour there would fall
  back to the theme's grey bar). Status/navigation icon appearance follows the background
  luminance, so light theme gets dark icons and dark theme gets light icons.
- **Insets**: top/left/right use `systemBars() | displayCutout()`. The bottom uses the IME inset
  while the keyboard is visible and the `tappableElement()` navigation inset otherwise — zero in
  gesture navigation. The web page already reserves its own bottom safe area
  (`px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]` in the chat composer), so reserving the
  full navigation-bar inset natively as well counted the same space twice. Gesture navigation now
  keeps only the page's own gesture-handle clearance, while a three-button navigation bar still
  reserves its tappable height. This is a code-level fix; the actual `env()` value and the visual
  result on a device are still to be measured (the earlier ~16 px figure came from a screenshot
  estimate, not a device probe). No screen height or fixed padding is hard-coded, and closing the
  keyboard never leaves the IME inset behind.
- **Native shell entry points**: the in-page floating overflow button was removed (user feedback:
  it sat over the web header and was unreliable). There is no replacement overlay or hidden
  gesture. Native actions are static launcher shortcuts (`res/xml/shortcuts.xml`): long-press the
  app icon → **Change server** (the existing setup screen, which clears the native session like
  before) or **Reload page**. The web app keeps its own in-page settings (server configuration,
  notifications) reachable through its own sidebar; the app does not add a native settings screen.

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
`adb install -r release/android/cloudcli-android-0.1.1-release.apk`, then enter the server origin on
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

## 0.1.1 build status

`0.1.0` (code 1) was the first real-device build; `0.1.1` (code 2) is the in-place update for the
five real-device findings (status-bar strip, removed overflow button, bottom inset duplication,
launcher icon, first-run notification enablement). Built from this tree with
`./scripts/build-android-release.sh`:

- `lintDebug` — success (0 errors; warnings only, e.g. the pre-existing `ImplicitSamInstance` note).
- `testDebugUnitTest` — success, 29 JVM tests, 0 failures.
- `assembleRelease` + `apksigner verify` — success.

After a review fix in `android/app/src/main/assets/bridge.js` (theme re-read after the body
`background-color` transition), only `assembleRelease` + `apksigner verify` were rerun; lint and the
29 JVM tests were not rerun for that asset-only patch, which was covered by a targeted Node VM
harness instead.

Artifact: `release/android/cloudcli-android-0.1.1-release.apk`, 1,446,315 B, SHA-256
`4e5ebdb5a36cbeab777c1046fb8a330097dfed68009504a2293ed6f6627d6c87`, signer certificate SHA-256
`4da7c681f9101309af64e432b1d58658920fb4965f6ccc8cc3738497e2e7a5e8` (APK Signature Scheme v2 —
same certificate as `0.1.0`, so it installs as an update). The previous
`release/android/cloudcli-android-0.1.0-release.apk` is left untouched.

0.1.1 is **build-verified only** (the gates above). Device QA is still pending and no 0.1.1
behaviour is claimed as accepted here: the visual result of the status-bar colour/icon contrast and
bottom inset changes, keyboard open/close behaviour, the launcher icon on a real launcher, the
launcher-shortcut entry points, and the first-run permission/enable flow end to end (including
denial and a later explicit `Stop`, which must not be auto-reversed). The 0.1.0 emulator acceptance
below describes the previous build (overflow menu, no shortcuts, no first-run enablement) and does
not transfer to 0.1.1.

## Verification status (0.1.0 emulator acceptance)

Accepted on the API 36 emulator (`emulator-5582`, `CloudCLI_Test_API36`, WebView
133.0.6943.137) with the signed **release** APK (not debuggable) — no device/real-hardware run was
part of this acceptance.

Release artifact: `release/android/cloudcli-android-0.1.0-release.apk`, 1,440,719 B, SHA-256
`7962654f03bcefb357d327e3ef257c0226cf5963d0108b76a0cd0d4b6a5d3587`, signer certificate SHA-256
`4da7c681f9101309af64e432b1d58658920fb4965f6ccc8cc3738497e2e7a5e8` (APK Signature Scheme v2).

Bridge and notifications (fixture origin `http://127.0.0.1:3110` unless stated):

- bridge v1 with all 12 methods; `getState` returns `webBridgeReady`/`signedIn`/`connected` correctly;
- Android 13+ notification permission denial keeps the setting off with
  `lastError = PERMISSION_DENIED`; after granting, enabling performs the real
  `POST /api/notifications/endpoints/current` (channel `android`, stable device id), opens the WS,
  `register` → `registered`, and shows the `cloudcli-service` foreground notification;
- repeated `setNotificationsEnabled(true)` and `saveSession` keep exactly one live socket;
- `notify()` posts a `cloudcli-events` notification and tapping it opens `/session/<id>`; a
  server/fixture-pushed notification while the app is backgrounded is shown and acknowledged
  (`notification_ack … action:shown`); the foreground notification `Stop` action closes the socket
  and notification immediately and nothing restarts it;
- refresh handoff: a token saved while a half-life refresh is in flight (both while connecting and
  while connected) is used for `register`, and the current token gets its own next refresh with a
  single retry chain; `clearSession` during an in-flight refresh clears the token, stops the service
  and restores neither;
- overflow menu / Change site / Reload are reachable, target-36 edge-to-edge insets keep the WebView
  and overflow button clear of the status and navigation bars and of the IME, and Back from a newly
  configured origin no longer lands on a blank page (the previous origin and `about:blank` are
  dropped from WebView history).

Real backend (dev server proxied at `http://127.0.0.1:3100`): real login, native `saveSession` sync
(enabling only succeeds with the native token), real endpoint registration, real
`/android-notifications` upgrade authenticated by the server, settings showing connected/running, and
the foreground notification. After switching the A/B fixtures from build A to build B (different
Vite hash, no server restart, no storage clear), a force-stop and explicit user reopen show
`Runtime build B`, keep the login and the unsent draft in the same session scope, and resume the
notification connection (the web bootstrap's `getSession` handshake resumes the service when the
preference is enabled; there is no boot receiver, watchdog or polling).

Files and shares (release APK): `ACTION_SEND` text/link and `ACTION_SEND_MULTIPLE` with a real
`ParcelableArrayList<Uri>` import into the pending index, `getShareContent` returns byte-identical
data (sha256 verified), consume/discard remove items, and an 11 MiB file is refused by the 10 MiB
boundary; `saveFile` writes byte-identical 300000 B and 0 B files; `pickFiles` cancel resolves `[]`
and a real multi-select returns correct 300000 B and 0 B Blobs (sha256 verified); `saveFile` cancel
rejects `CANCELLED`; a plain HTML `<input type="file">` delivers correct bytes; the web share inbox
appends `\n\n`-separated text to an existing session draft without sending it, and a 25 B
attachment plus the draft survive backgrounding and returning to the app.

Calling `notify` from the page (the same call the web app uses):

```js
await window.cloudcliAndroid.notify({
  title: 'Build finished',
  body: 'Session "release" stopped',
  sessionId: 'app-session-id',   // click target, optional
  tag: 'claude:app-session-id:run.stopped', // replaces an equal tag, optional
});
```

Compatibility note: the app requires the WebView to support `DOCUMENT_START_SCRIPT`,
`WEB_MESSAGE_LISTENER` and `WEB_MESSAGE_ARRAY_BUFFER`; when a provider lacks
`WEB_MESSAGE_ARRAY_BUFFER` (observed with the API 34 image's WebView 113.0.5672.136) the app
deliberately exposes **no** bridge and logs
`bridge disabled, unsupported WebView features: [WEB_MESSAGE_ARRAY_BUFFER]`, and the native shell
shows a Toast reporting that the bridge is unavailable instead of degrading. Update the
WebView/system image to use the bridge.

Scope of these guarantees: this acceptance ran on an emulator. Real devices may apply Doze and
vendor battery management, so the foreground notification connection is best effort — it is not
claimed to be immune to being killed by the system; reopening the app after a force-stop/user stop
resumes it only when the user has notifications enabled.

First run: install the APK, enter the server root origin, sign in on the web page, then enable
"Android notifications" in the web notification settings (granting the Android permission when
asked). After the server's web frontend is updated, opening the app cold fetches the new HTML and
hashed assets while login and drafts are preserved; returning to a warm app does not force a reload,
so unsent attachments are kept.

Also verified without a device: 29 JVM unit tests (`SiteOrigin`, `Jwt`, `TransferFrame`,
`ReconnectPolicy`, `RefreshGuard`), the injected bridge under a Node VM (zero-byte transfer, finish
failure rejection, 256 KiB chunking, events), `lintDebug` (0 errors) and `apksigner verify`.

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
