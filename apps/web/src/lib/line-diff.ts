/** One line of a diff: kept, removed from the old text, or added in the new one. */
export interface DiffLine {
  readonly kind: 'same' | 'removed' | 'added';
  readonly text: string;
}

/** Above this many line pairs the diff is not computed; both texts are shown instead. */
const LIMIT = 4_000_000;

/**
 * A line diff of two short texts by longest common subsequence, or undefined when they are
 * too long to compare here.
 */
export function lineDiff(before: string, after: string): DiffLine[] | undefined {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > LIMIT) return undefined;
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      lines.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) lines.push({ kind: 'removed', text: a[i]! });
  for (; j < b.length; j += 1) lines.push({ kind: 'added', text: b[j]! });
  return lines;
}
