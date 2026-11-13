import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import type { DshSessionLog } from '@/shared/types.js';
import { sanitizeLeafDirectoryName } from '@/shared/utils.js';

const DSH_SESSION_LOG_PATTERN = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/;

/** Newest committed generation first; historical generations stay on disk but are not served. */
function newestGenerations<T extends { name: string }>(entries: T[]): T[] {
  const logs = entries.filter((entry) => DSH_SESSION_LOG_PATTERN.test(entry.name));
  return logs.sort(
    (a, b) => Number(b.name.match(/\.v(\d+)/)?.[1] ?? 0) - Number(a.name.match(/\.v(\d+)/)?.[1] ?? 0),
  );
}

/** Read-only native DSH history access used by sessions, models, and indexing. */
export class DshSessionStore {
  constructor(private readonly configuration: DshConfigurationProvider) {}

  async files(): Promise<string[]> {
    const files: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      // Retain only the newest committed generation; historical generations
      // remain next to it and must not be indexed as duplicate conversations.
      const [latest] = newestGenerations(entries.filter((entry) => entry.isFile()));
      if (latest) files.push(path.join(directory, latest.name));
      if (depth < 2) for (const entry of entries) if (entry.isDirectory()) await walk(path.join(directory, entry.name), depth + 1);
    };
    await walk(this.configuration.sessionsRoot, 0);
    return files;
  }

  async find(id: string): Promise<DshSessionLog | null> {
    const safeId = sanitizeLeafDirectoryName(id, 'DSH session id');
    for (const file of await this.files()) {
      if (path.basename(path.dirname(file)) !== safeId) continue;
      const log = await this.read(file);
      if (log.header.id === id) return log;
    }
    return null;
  }

  async read(filePath: string): Promise<DshSessionLog> {
    const root = await realpath(this.configuration.sessionsRoot);
    const target = await realpath(filePath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('DSH transcript is outside its configured root.');
    return this.decode(target);
  }

  /**
   * Reads the newest committed generation of an indexed conversation even when its directory is
   * outside the currently configured root: a scheduled task may run with its own DSH home. The
   * header id is still the identity check, so a wrong or compressed file cannot be served as the
   * requested conversation. Used by native history; the directory comes from the host's own
   * session row, never from a caller-supplied transcript path.
   */
  async readIndexed(filePath: string, expectedId: string): Promise<DshSessionLog | null> {
    const target = await realpath(filePath);
    const directory = path.dirname(target);
    const entries = await readdir(directory, { withFileTypes: true });
    const [latest] = newestGenerations(entries.filter((entry) => entry.isFile()));
    if (!latest) return null;
    try {
      const log = await this.decode(await realpath(path.join(directory, latest.name)));
      return log.header.id === expectedId ? log : null;
    } catch {
      return null;
    }
  }

  private async decode(target: string): Promise<DshSessionLog> {
    const info = await stat(target);
    if (info.size > 256 * 1024 * 1024) throw new Error('DSH transcript exceeds the 256 MiB reader limit.');
    let bytes = await readFile(target);
    if (target.endsWith('.zstd')) {
      if (!zlib.zstdDecompress) throw new Error('Reading compressed DSH history requires Node.js 22.15 or newer.');
      // Node's one-shot decoder stops after the first frame. DSH appends
      // independent frames, so decode each complete frame and ignore only an
      // unfinished final append; complete-frame checksums are still verified.
      const decoded: Buffer[] = [];
      let length = 0;
      for (const frame of this.frames(bytes)) {
        const part = await promisify(zlib.zstdDecompress)(frame, { maxOutputLength: 256 * 1024 * 1024 - length });
        length += part.length;
        decoded.push(part);
      }
      bytes = Buffer.concat(decoded, length);
    }
    const text = bytes.toString('utf8');
    const complete = text.slice(0, text.lastIndexOf('\n'));
    const rows = complete.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
    if (rows.length === 0) throw new Error('DSH transcript has no complete header.');
    const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog');
    const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'recoverable', validation: 'transformed' });
    for (const row of rows.slice(1)) restore.decodeRow(row);
    const artifact = restore.finish();
    return { filePath: target, header: artifact.header, events: artifact.events.map((event) => ({ ...event })) };
  }

  private frames(bytes: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;
    // Parse Zstandard framing only; the public Node decoder validates the
    // compressed blocks and checksum. A torn tail is never passed to it.
    outer: while (offset < bytes.length) {
      const start = offset;
      if (bytes.length - offset < 4) break;
      if (bytes.readUInt32LE(offset) !== 0xFD2FB528) throw new Error('Corrupt DSH Zstandard frame magic.');
      offset += 4;
      if (offset === bytes.length) break;
      const descriptor = bytes[offset++];
      if (descriptor & 0x18) throw new Error('Corrupt DSH Zstandard frame header.');
      const sizeFlag = descriptor >>> 6;
      const single = Boolean(descriptor & 0x20);
      const dictionary = descriptor & 3;
      const headerLength = (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag);
      if (bytes.length - offset < headerLength) break;
      offset += headerLength;
      while (true) {
        if (bytes.length - offset < 3) break outer;
        const block = bytes.readUIntLE(offset, 3);
        offset += 3;
        const kind = (block >>> 1) & 3;
        if (kind === 3) throw new Error('Corrupt DSH Zstandard block.');
        const blockLength = kind === 1 ? 1 : block >>> 3;
        if (bytes.length - offset < blockLength) break outer;
        offset += blockLength;
        if (block & 1) break;
      }
      const checksum = descriptor & 4 ? 4 : 0;
      if (bytes.length - offset < checksum) break;
      offset += checksum;
      frames.push(bytes.subarray(start, offset));
    }
    return frames;
  }
}

/**
 * Resolves a scheduled DSH run's native id to the generation its history reader will serve.
 *
 * Used by the project-scheduler host to map `session.jsonl_path` at attach time. It reuses the
 * store's own generation selection, root containment, decompression and header validation instead
 * of duplicating the DSH file format. An optional indexed file narrows the search to its directory,
 * which is how a resumed run follows a compaction from `session.vN` to `session.vN+1`.
 */
export async function resolveDshTranscript(input: {
  sessionsRoot: string;
  nativeSessionId: string;
  filePath?: string;
}): Promise<string | null> {
  const configuration = new DshConfigurationProvider({
    CLOUDCLI_DSH_SESSIONS_DIR: input.sessionsRoot,
  });
  const store = new DshSessionStore(configuration);
  const root = await realpath(input.sessionsRoot);
  if (input.filePath) {
    const target = await realpath(input.filePath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const log = await store.readIndexed(target, input.nativeSessionId);
    return log?.filePath ?? null;
  }
  for (const file of await store.files()) {
    if (path.basename(path.dirname(file)) !== input.nativeSessionId) continue;
    const log = await store.read(file);
    if (log.header.id === input.nativeSessionId) return log.filePath;
  }
  return null;
}
