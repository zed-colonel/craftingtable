import { inflateRawSync } from 'node:zlib';
import { sha256Hex } from './digest.js';

/** In-memory ZIP profile: stored/deflated, single disk, UTF-8/ASCII names, no ZIP64. */
export const ARCHIVE_LIMITS = {
  maxCompressedBytes: 8 * 1024 * 1024,
  maxExpandedBytes: 32 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
  maxEntries: 512,
  maxPathLength: 400,
} as const;
export class ArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface ArchiveEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}
function fail(message: string): never {
  throw new ArchiveError('invalid-archive', message);
}
export function safeArchivePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= ARCHIVE_LIMITS.maxPathLength &&
    !path.includes('\\') &&
    !path.includes(':') &&
    !Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !path.startsWith('/') &&
    path
      .split('/')
      .every((part) => part.length > 0 && part !== '.' && part !== '..' && part.trim() === part)
  );
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ArchiveError('invalid-utf8', 'A planning document is not valid UTF-8.');
  }
}

/** No extraction, filesystem access, imported code or uploaded schema execution. */
export function readArchive(input: Uint8Array): readonly ArchiveEntry[] {
  if (input.byteLength > ARCHIVE_LIMITS.maxCompressedBytes)
    fail('ZIP exceeds the 8 MiB upload limit.');
  const data = Buffer.from(input);
  const need = (offset: number, count: number) => {
    if (offset < 0 || count < 0 || offset + count > data.length)
      fail('ZIP contains truncated records.');
  };
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) {
      end = i;
      break;
    }
  }
  if (end < 0) fail('ZIP end record is missing.');
  if (data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0)
    fail('Multi-disk ZIPs are unsupported.');
  const count = data.readUInt16LE(end + 10);
  const centralSize = data.readUInt32LE(end + 12);
  const centralStart = data.readUInt32LE(end + 16);
  if (!count || count > ARCHIVE_LIMITS.maxEntries || count !== data.readUInt16LE(end + 8))
    fail('ZIP entry count is invalid or exceeds 512.');
  if (
    centralSize === 0xffffffff ||
    centralStart === 0xffffffff ||
    centralStart + centralSize !== end
  )
    fail('ZIP64 or inconsistent central directory is unsupported.');
  need(centralStart, centralSize);
  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  let expanded = 0;
  let cursor = centralStart;
  for (let i = 0; i < count; i++) {
    need(cursor, 46);
    if (data.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid ZIP central record.');
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16);
    const compressed = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    const nameSize = data.readUInt16LE(cursor + 28);
    const extraSize = data.readUInt16LE(cursor + 30);
    const commentSize = data.readUInt16LE(cursor + 32);
    const mode = data.readUInt32LE(cursor + 38) >>> 16;
    const offset = data.readUInt32LE(cursor + 42);
    if ((flags & ~0x080e) !== 0 || ![0, 8].includes(method) || data.readUInt16LE(cursor + 34) !== 0)
      fail('Encrypted ZIPs or this compression format are unsupported.');
    if ([compressed, size, offset].includes(0xffffffff)) fail('ZIP64 is unsupported.');
    need(cursor + 46, nameSize + extraSize + commentSize);
    const rawName = data.subarray(cursor + 46, cursor + 46 + nameSize);
    if (!(flags & 0x800) && rawName.some((b) => b > 127))
      fail('Non-ASCII ZIP names must declare UTF-8.');
    const name = decodeUtf8(rawName);
    const directory = name.endsWith('/');
    const path = directory ? name.slice(0, -1) : name;
    if (!safeArchivePath(path) || path !== path.normalize('NFC'))
      fail(`Unsafe archive path: ${path.slice(0, 100)}`);
    const key = path.toLowerCase();
    if (names.has(key)) fail(`Duplicate archive path: ${path}`);
    names.add(key);
    const fileType = mode & 0xf000;
    if (fileType && fileType !== (directory ? 0x4000 : 0x8000))
      fail(`Links or special files are unsupported: ${path}`);
    if (size > ARCHIVE_LIMITS.maxEntryBytes || expanded + size > ARCHIVE_LIMITS.maxExpandedBytes)
      fail('ZIP exceeds the 2 MiB entry or 32 MiB expanded limit.');
    expanded += size;
    need(offset, 30);
    if (offset >= centralStart || data.readUInt32LE(offset) !== 0x04034b50)
      fail('Invalid ZIP local record.');
    const localNameSize = data.readUInt16LE(offset + 26);
    const localExtraSize = data.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameSize + localExtraSize;
    need(offset + 30, localNameSize + localExtraSize);
    if (
      data.readUInt16LE(offset + 6) !== flags ||
      data.readUInt16LE(offset + 8) !== method ||
      !data.subarray(offset + 30, offset + 30 + localNameSize).equals(rawName)
    )
      fail('ZIP local and central records disagree.');
    if (
      !(flags & 8) &&
      (data.readUInt32LE(offset + 14) !== crc ||
        data.readUInt32LE(offset + 18) !== compressed ||
        data.readUInt32LE(offset + 22) !== size)
    )
      fail('ZIP local sizes or checksum disagree.');
    let rangeEnd = start + compressed;
    if (flags & 8) {
      need(rangeEnd, 12);
      const descriptor = data.readUInt32LE(rangeEnd) === 0x08074b50 ? rangeEnd + 4 : rangeEnd;
      need(descriptor, 12);
      if (
        data.readUInt32LE(descriptor) !== crc ||
        data.readUInt32LE(descriptor + 4) !== compressed ||
        data.readUInt32LE(descriptor + 8) !== size
      )
        fail('ZIP data descriptor disagrees.');
      rangeEnd = descriptor + 12;
    }
    if (rangeEnd > centralStart) fail('ZIP entries overlap the central directory.');
    need(start, compressed);
    if (ranges.some((range) => offset < range.end && rangeEnd > range.start))
      fail('ZIP entries overlap.');
    ranges.push({ start: offset, end: rangeEnd });
    let bytes: Buffer;
    try {
      bytes =
        method === 0
          ? data.subarray(start, start + compressed)
          : inflateRawSync(data.subarray(start, start + compressed), {
              maxOutputLength: Math.max(1, size),
            });
    } catch {
      fail(`Invalid or oversized compressed entry: ${path}`);
    }
    if (bytes.length !== size || crc32(bytes) !== crc || (directory && size !== 0))
      fail(`ZIP size/checksum mismatch: ${path}`);
    if (!directory) entries.push({ path, bytes: bytes, sha256: sha256Hex(bytes) });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end) fail('ZIP central directory length is inconsistent.');
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split('/');
    parts.pop();
    while (parts.length) {
      if (entries.some((other) => other.path.toLowerCase() === parts.join('/')))
        fail('A ZIP file is also used as a directory.');
      parts.pop();
    }
  }
  return entries;
}
