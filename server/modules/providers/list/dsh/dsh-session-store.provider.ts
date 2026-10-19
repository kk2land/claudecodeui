import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import type { DshSessionLog } from '@/shared/types.js';
import { sanitizeLeafDirectoryName } from '@/shared/utils.js';

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
      const logs = entries.filter((entry) => entry.isFile() && /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(entry.name));
      // Retain only the newest committed generation; historical generations
      // remain next to it and must not be indexed as duplicate conversations.
      logs.sort((a, b) => Number(b.name.match(/\.v(\d+)/)?.[1] ?? 0) - Number(a.name.match(/\.v(\d+)/)?.[1] ?? 0));
      if (logs[0]) files.push(path.join(directory, logs[0].name));
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
