#!/usr/bin/env bash
# Build the signed CloudCLI Android release APK.
#
# Gates: `lintDebug`, `testDebugUnitTest`, then `assembleRelease` + `apksigner verify`.
#
# Signing material is private and lives outside the repository:
#   ${CLOUDCLI_ANDROID_SIGNING_DIR:-$HOME/.cloudcli/android-signing}
#     cloudcli-release.p12     (PKCS12, RSA 3072, SHA256withRSA, 10000 days)
#     signing.properties       (storeFile/storeType/keyAlias/storePassword/keyPassword)
# The keystore is created once and reused forever; an existing keystore is never overwritten.
# Secrets are passed to keytool/Gradle through environment and files only (never argv/logs).
#
# Output: release/android/cloudcli-android-<versionName>-release.apk (gitignored)
#
# Environment:
#   JAVA_HOME                     required or discoverable (>= 17)
#   ANDROID_SDK_ROOT/ANDROID_HOME required or discoverable (platform 36 + build-tools 36)
#   CLOUDCLI_ANDROID_SIGNING_DIR  optional signing directory override
#   GRADLE_CMD                    optional Gradle command override (defaults to ./android/gradlew)
#   GRADLE_ARGS                   optional extra Gradle arguments
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$REPO_ROOT/android"

log() { printf '[android-release] %s\n' "$*"; }
die() { printf '[android-release] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- toolchain discovery
find_java_home() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/keytool" ] && [ -x "${JAVA_HOME}/bin/javac" ]; then
    printf '%s' "$JAVA_HOME"
    return 0
  fi
  if [ -x /usr/libexec/java_home ]; then
    local detected
    detected="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home 2>/dev/null || true)"
    if [ -n "$detected" ] && [ -x "$detected/bin/keytool" ]; then
      printf '%s' "$detected"
      return 0
    fi
  fi
  local javac_path
  javac_path="$(command -v javac || true)"
  if [ -n "$javac_path" ]; then
    printf '%s' "$(cd "$(dirname "$javac_path")/.." && pwd)"
    return 0
  fi
  return 1
}

JAVA_HOME="$(find_java_home)" || die "JDK 17 not found; set JAVA_HOME"
if ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -q 'version "17\.'; then
  log "warning: JAVA_HOME does not report 17 ($JAVA_HOME)"
fi
export JAVA_HOME
PATH="$JAVA_HOME/bin:$PATH"
export PATH

find_sdk_root() {
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then printf '%s' "$ANDROID_SDK_ROOT"; return 0; fi
  if [ -n "${ANDROID_HOME:-}" ]; then printf '%s' "$ANDROID_HOME"; return 0; fi
  if [ -f "$ANDROID_DIR/local.properties" ]; then
    local configured
    configured="$(sed -n 's/^sdk\.dir=//p' "$ANDROID_DIR/local.properties" | head -1)"
    if [ -n "$configured" ]; then printf '%s' "$configured"; return 0; fi
  fi
  local sdkmanager
  sdkmanager="$(command -v sdkmanager || true)"
  if [ -n "$sdkmanager" ]; then
    # <sdk>/cmdline-tools/<version>/bin/sdkmanager -> <sdk>
    local resolved
    resolved="$(cd "$(dirname "$sdkmanager")/../../.." && pwd)"
    if [ -d "$resolved/platforms" ]; then printf '%s' "$resolved"; return 0; fi
  fi
  return 1
}

SDK_ROOT="$(find_sdk_root)" || die "Android SDK not found; set ANDROID_SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"
[ -d "$SDK_ROOT/platforms/android-36" ] || die "Android platform 36 missing under $SDK_ROOT"

GRADLE_CMD="${GRADLE_CMD:-$ANDROID_DIR/gradlew}"
[ -x "$GRADLE_CMD" ] || die "Gradle command not executable: $GRADLE_CMD"
EXTRA_GRADLE_ARGS=()
if [ -n "${GRADLE_ARGS:-}" ]; then
  read -r -a EXTRA_GRADLE_ARGS <<< "$GRADLE_ARGS"
fi

# ---------------------------------------------------------------- signing setup
SIGNING_DIR="${CLOUDCLI_ANDROID_SIGNING_DIR:-$HOME/.cloudcli/android-signing}"
export CLOUDCLI_ANDROID_SIGNING_DIR="$SIGNING_DIR"
KEYSTORE="$SIGNING_DIR/cloudcli-release.p12"
PROPS="$SIGNING_DIR/signing.properties"
ALIAS="cloudcli-android"

umask 077
mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"

if [ -f "$KEYSTORE" ] || [ -f "$PROPS" ]; then
  [ -f "$KEYSTORE" ] && [ -f "$PROPS" ] || die "incomplete signing state in $SIGNING_DIR; fix manually"
  chmod 600 "$KEYSTORE" "$PROPS"
  log "reusing existing keystore $KEYSTORE"
else
  log "creating new keystore $KEYSTORE"
  STOREPASS="$(openssl rand -hex 32)"
  export STOREPASS
  "$JAVA_HOME/bin/keytool" -genkeypair \
    -keystore "$KEYSTORE" -storetype PKCS12 \
    -alias "$ALIAS" -keyalg RSA -keysize 3072 -sigalg SHA256withRSA \
    -validity 10000 -dname "CN=CloudCLI Android" \
    -storepass:env STOREPASS -keypass:env STOREPASS >/dev/null 2>&1 \
    || die "keytool -genkeypair failed"
  cat > "$PROPS" <<EOF
storeFile=cloudcli-release.p12
storeType=PKCS12
keyAlias=$ALIAS
storePassword=$STOREPASS
keyPassword=$STOREPASS
EOF
  chmod 600 "$KEYSTORE" "$PROPS"
fi

# Verify the keystore opens and contains the expected entry, without printing secrets.
STOREPASS="$(sed -n 's/^storePassword=//p' "$PROPS")"
[ -n "$STOREPASS" ] || die "storePassword missing in $PROPS"
export STOREPASS
"$JAVA_HOME/bin/keytool" -list -keystore "$KEYSTORE" -storepass:env STOREPASS -alias "$ALIAS" >/dev/null \
  || die "keystore verification failed for alias $ALIAS"
unset STOREPASS
log "keystore verified (alias $ALIAS)"

# ---------------------------------------------------------------- gates
if [ ! -f "$ANDROID_DIR/local.properties" ]; then
  printf 'sdk.dir=%s\n' "$SDK_ROOT" > "$ANDROID_DIR/local.properties"
fi

gradle() {
  "$GRADLE_CMD" -p "$ANDROID_DIR" --console=plain ${EXTRA_GRADLE_ARGS[@]+"${EXTRA_GRADLE_ARGS[@]}"} "$@"
}

log "lintDebug"
gradle lintDebug
log "testDebugUnitTest"
gradle testDebugUnitTest
log "assembleRelease"
gradle assembleRelease

VERSION_NAME="$(sed -n 's/^[[:space:]]*versionName = "\(.*\)"/\1/p' "$ANDROID_DIR/app/build.gradle.kts" | head -1)"
[ -n "$VERSION_NAME" ] || VERSION_NAME="0.0.0"

APK_SOURCE="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK_SOURCE" ] || die "release APK not produced at $APK_SOURCE"

OUT_DIR="$REPO_ROOT/release/android"
mkdir -p "$OUT_DIR"
APK="$OUT_DIR/cloudcli-android-$VERSION_NAME-release.apk"
cp "$APK_SOURCE" "$APK"

# ---------------------------------------------------------------- verify
BUILD_TOOLS="$(ls -1d "$SDK_ROOT"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
[ -n "$BUILD_TOOLS" ] || die "no build-tools under $SDK_ROOT"
APKSIGNER="${BUILD_TOOLS%/}/apksigner"
[ -x "$APKSIGNER" ] || die "apksigner not found in ${BUILD_TOOLS%/}"

"$APKSIGNER" verify --verbose --print-certs "$APK" > "$OUT_DIR/apksigner-verify.txt" 2>&1 \
  || { cat "$OUT_DIR/apksigner-verify.txt" >&2; die "apksigner verification failed"; }

log "APK: $APK"
log "SHA-256: $(shasum -a 256 "$APK" | awk '{print $1}')"
log "size: $(stat -f '%z' "$APK") bytes"
log "signer (public only):"
grep -E 'Signer #1 certificate (DN|SHA-256)|Verified using' "$OUT_DIR/apksigner-verify.txt" | sed 's/^/  /'
log "done"
