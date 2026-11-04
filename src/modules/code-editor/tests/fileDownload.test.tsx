import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

/**
 * Regression guard for the corrupt APK download: the editor used to load every
 * file through the text endpoint, so an APK's bytes were decoded as UTF-8
 * (invalid bytes becoming U+FFFD) and the title-bar download wrote that lossy
 * string back out — a 1.44 MB APK arrived as ~2.5 MB.
 *
 * Non-text files now show only an explanation plus a download button, and every
 * title-bar download saves the file's original bytes from the content endpoint.
 * Text files stay editable; unsaved edits remain in the editor until saved.
 */

const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: '' }) }));
const saveFile = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
const readFileBlob = vi.fn();
const saveBlob = vi.fn(async (_blob: Blob, _fileName: string) => true);

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile, readFileBlob },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/modules/android-bridge', () => ({
  saveBlob,
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

// A textarea is enough of CodeMirror here: the download tests only need typing
// to reach the editor buffer.
vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
    return (
      <textarea
        data-testid="editor"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  }

  return { default: CodeMirrorStub };
});

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

const textFile: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };
const apkFile: CodeEditorFile = {
  name: 'cloudcli-android-0.1.0-release.apk',
  path: '/repo/release/cloudcli-android-0.1.0-release.apk',
  projectId: 'p1',
};

// Real APK bytes contain every kind of invalid UTF-8: 0xFF/0xFE are never valid
// lead bytes, 0x80 is a continuation byte and 0x00 is a NUL. Decoding and
// re-encoding these is exactly what inflated the download.
const APK_LIKE_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xed, 0xa0,
]);

// jsdom's Blob predates arrayBuffer(); FileReader reads it the same way.
const bytesOf = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

const serveBytes = (bytes: Uint8Array, type = 'application/octet-stream') => {
  readFileBlob.mockResolvedValue({
    ok: true,
    blob: async () => new Blob([bytes as Uint8Array<ArrayBuffer>], { type }),
  });
};

const assertOriginalBytesDownloaded = async (file: CodeEditorFile, bytes: Uint8Array) => {
  fireEvent.click(await screen.findByTitle('actions.download'));
  await waitFor(() => assert.equal(saveBlob.mock.calls.length, 1));

  // The text endpoint would decode the bytes; the download must never use it.
  assert.equal(readFile.mock.calls.length, 0);
  assert.deepEqual(readFileBlob.mock.calls[0], [file.projectId, file.path]);

  const [savedBlob, savedName] = saveBlob.mock.calls[0] as [Blob, string];
  assert.equal(savedName, file.name);
  assert.equal(savedBlob.size, bytes.byteLength);
  assert.deepEqual(Array.from(await bytesOf(savedBlob)), Array.from(bytes));
};

beforeEach(() => {
  readFile.mockClear();
  saveFile.mockClear();
  readFileBlob.mockReset();
  saveBlob.mockClear();
});

test('an APK shows a notice instead of source and downloads its original bytes', async () => {
  serveBytes(APK_LIKE_BYTES, 'application/vnd.android.package-archive');

  render(<CodeEditor file={apkFile} onClose={() => undefined} />);

  // An explanation instead of mojibake source in the editor.
  assert.equal(screen.queryByTestId('editor'), null);
  await screen.findByText(/cannot be displayed/i);

  await assertOriginalBytesDownloaded(apkFile, APK_LIKE_BYTES);

  // Binary files never enter the text read or save paths.
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 0));
});

test('an image shows a notice instead of inline media and still downloads its bytes', async () => {
  const imageFile: CodeEditorFile = { name: 'screenshot.png', path: '/repo/assets/screenshot.png', projectId: 'p1' };
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8]);
  serveBytes(imageBytes, 'image/png');

  const { container } = render(<CodeEditor file={imageFile} onClose={() => undefined} />);

  await screen.findByText(/cannot be displayed/i);
  // The source pane no longer embeds the image itself.
  assert.equal(container.querySelector('img'), null);
  assert.equal(screen.queryByTestId('editor'), null);
  // Opening the file alone must not fetch bytes; only the download does.
  assert.equal(readFileBlob.mock.calls.length, 0);

  await assertOriginalBytesDownloaded(imageFile, imageBytes);
});

test('a ZIP archive shows a notice and downloads its original bytes', async () => {
  const zipFile: CodeEditorFile = { name: 'release.zip', path: '/repo/release.zip', projectId: 'p1' };
  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff, 0x00]);
  serveBytes(zipBytes, 'application/zip');

  render(<CodeEditor file={zipFile} onClose={() => undefined} />);
  await screen.findByText(/cannot be displayed/i);

  await assertOriginalBytesDownloaded(zipFile, zipBytes);
});

test('an empty binary file downloads a zero-byte original', async () => {
  const emptyFile: CodeEditorFile = { name: 'empty.bin', path: '/repo/empty.bin', projectId: 'p1' };
  serveBytes(new Uint8Array([]));

  render(<CodeEditor file={emptyFile} onClose={() => undefined} />);
  await screen.findByText(/cannot be displayed/i);

  await assertOriginalBytesDownloaded(emptyFile, new Uint8Array([]));
});

test('a failed download shows an error and saves nothing', async () => {
  readFileBlob.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', blob: async () => new Blob(['denied']) });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  render(<CodeEditor file={apkFile} onClose={() => undefined} />);
  fireEvent.click(await screen.findByTitle('actions.download'));

  const alert = await screen.findByRole('alert');
  assert.ok(alert.textContent?.trim().length);
  assert.equal(saveBlob.mock.calls.length, 0);
});

test('a text file keeps its unsaved edit while downloading the original disk bytes', async () => {
  const diskBytes = new TextEncoder().encode('on disk\n');
  readFile.mockResolvedValue({ ok: true, json: async () => ({ content: 'on disk' }) });
  serveBytes(diskBytes, 'text/plain');

  render(<CodeEditor file={textFile} onClose={() => undefined} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'on disk'));

  fireEvent.change(editor, { target: { value: 'unsaved edit' } });
  fireEvent.click(screen.getByTitle('actions.download'));

  await waitFor(() => assert.equal(saveBlob.mock.calls.length, 1));
  const [savedBlob] = saveBlob.mock.calls[0] as [Blob, string];
  // The download is the file on disk, not the unsaved buffer re-encoded.
  assert.deepEqual(Array.from(await bytesOf(savedBlob)), Array.from(diskBytes));
  assert.equal(readFileBlob.mock.calls[0][1], textFile.path);

  // The edit is still in the editor, and saving still writes the buffer.
  assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, 'unsaved edit');
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
  assert.deepEqual(saveFile.mock.calls[0], ['p1', textFile.path, 'unsaved edit']);
});
