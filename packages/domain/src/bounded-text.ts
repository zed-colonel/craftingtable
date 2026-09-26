/**
 * Stored text bounds are counted in UTF-8 bytes, as the database and wire contracts count
 * them. JavaScript's `length` counts UTF-16 units, so a character-based cut can still exceed
 * a byte bound.
 */

/** The run's outcome summary: the start of the last final message, bounded for lists and handoffs. */
export const OUTCOME_SUMMARY_LIMIT_BYTES = 4000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Truncates to at most `maxBytes` of UTF-8, never splitting a code point, and ends a
 * truncated value with the marker so the cut is visible.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number, marker = '…'): string {
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - encoder.encode(marker).byteLength);
  // Back off to a code point boundary so the decoded prefix has no replacement character.
  let end = budget;
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${decoder.decode(encoded.subarray(0, end))}${marker}`;
}

/** Whether `text` fits in `maxBytes` of UTF-8. */
export function fitsUtf8Bytes(text: string, maxBytes: number): boolean {
  return encoder.encode(text).byteLength <= maxBytes;
}

/**
 * Truncates to at most `maxUnits` UTF-16 units, the unit a zod `.max` counts, never splitting
 * a surrogate pair, and ends a truncated value with the marker (R-A4 review).
 */
export function truncateUtf16(text: string, maxUnits: number, marker = '…'): string {
  if (text.length <= maxUnits) return text;
  let end = Math.max(0, maxUnits - marker.length);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}
