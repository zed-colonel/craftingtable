import type { JsonValue } from '@craftingtable/domain';

export const RAW_LINE_LIMIT_BYTES = 64 * 1024;
export const TOOL_INPUT_LIMIT_BYTES = 16 * 1024;
export const TOOL_RESULT_LIMIT_BYTES = 32 * 1024;
export const MESSAGE_TEXT_LIMIT_BYTES = 256 * 1024;

const TRUNCATION_MARKER = '\n…[truncated by CraftingTable]';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncateUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= limit) {
    return { text: value, truncated: false };
  }
  const marker = Buffer.from(TRUNCATION_MARKER).subarray(0, limit).toString('utf8');
  let end = Math.max(0, limit - Buffer.byteLength(marker));
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: `${bytes.subarray(0, end).toString('utf8')}${marker}`, truncated: true };
}

export function boundedRaw(line: string): string {
  return truncateUtf8(line, RAW_LINE_LIMIT_BYTES).text;
}

export function boundedJson(value: unknown, limit: number): JsonValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserialisable tool input]';
  }
  if (Buffer.byteLength(serialized, 'utf8') <= limit) {
    return JSON.parse(serialized) as JsonValue;
  }
  return truncateUtf8(serialized, limit).text;
}

export function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function firstLine(value: string, limit = 200): string {
  const line = value.split('\n')[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
