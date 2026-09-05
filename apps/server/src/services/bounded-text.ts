/**
 * Truncates to at most `maxBytes` of UTF-8, never splitting a code point, and
 * ends a truncated value with the marker so the cut is visible. Wire contracts
 * bound strings in bytes; JavaScript's `length` counts UTF-16 units, so a
 * character-based cut can still exceed the contract.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number, marker = '…'): string {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= maxBytes) {
    return text;
  }
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  // Back off to a code point boundary so the decoded prefix has no replacement character.
  let end = budget;
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${encoded.subarray(0, end).toString('utf8')}${marker}`;
}
