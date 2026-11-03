import type { AndroidBridge, AndroidBridgeErrorCode } from '@/shared/types';

/** The method set a version-1 bridge must expose before we treat it as usable. */
const REQUIRED_METHODS: (keyof AndroidBridge)[] = [
  'getState',
  'notify',
  'setNotificationsEnabled',
  'getSession',
  'saveSession',
  'clearSession',
  'listShares',
  'getShareContent',
  'consumeShare',
  'discardShare',
  'pickFiles',
  'saveFile',
];

type AndroidBridgeWindow = Window & { cloudcliAndroid?: unknown };

let probedObject: unknown;
let cachedBridge: AndroidBridge | null = null;

const readInjectedBridge = (): unknown => (
  typeof window === 'undefined' ? undefined : (window as AndroidBridgeWindow).cloudcliAndroid
);

const hasBridgeApi = (value: unknown): value is AndroidBridge => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) {
    return false;
  }

  return REQUIRED_METHODS.every((method) => typeof candidate[method] === 'function');
};

/**
 * Returns the injected Android bridge exactly once per injected object. A
 * different object (for example after a WebView reload) is re-probed; anything
 * that is not a complete version-1 API resolves to null so the web app never
 * silently degrades into a desktop or browser-push mode.
 */
export function getAndroidBridge(): AndroidBridge | null {
  const injected = readInjectedBridge();
  if (injected === probedObject) {
    return cachedBridge;
  }

  probedObject = injected;
  cachedBridge = hasBridgeApi(injected) ? injected : null;
  return cachedBridge;
}

/** Extracts the contract error code from a rejected bridge call without hiding the real message. */
export function readAndroidBridgeErrorCode(error: unknown): AndroidBridgeErrorCode | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? (code as AndroidBridgeErrorCode) : null;
}

/** True when a bridge rejection matches one contract code, so callers can keep cancellations quiet. */
export function isAndroidBridgeErrorCode(error: unknown, code: AndroidBridgeErrorCode): boolean {
  return readAndroidBridgeErrorCode(error) === code;
}
