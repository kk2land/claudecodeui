import { getAndroidBridge, isAndroidBridgeErrorCode } from '@/modules/android-bridge/androidBridge';
import { downloadBlob } from '@/shared/utils';

/**
 * Saves one Blob through the Android system document picker when the native
 * bridge is present, and through the browser's object-URL anchor otherwise.
 * Resolves false when the user cancels; other failures reject with the real
 * error so the caller can show it. Used by file-tree downloads, chat
 * attachment downloads and transcript exports.
 */
export async function saveBlob(blob: Blob, fileName: string): Promise<boolean> {
  const bridge = getAndroidBridge();

  if (bridge) {
    try {
      const result = await bridge.saveFile({
        name: fileName,
        mimeType: blob.type || 'application/octet-stream',
        blob,
      });
      return Boolean(result?.saved);
    } catch (error) {
      // Cancelling the system picker is a normal outcome, not a download error.
      if (isAndroidBridgeErrorCode(error, 'CANCELLED')) {
        return false;
      }
      throw error;
    }
  }

  // Browser path reuses the shared download helper, including its deferred
  // object-URL revoke, which Firefox and Safari need after click().
  downloadBlob(blob, fileName);
  return true;
}
