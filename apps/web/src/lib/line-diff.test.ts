import { expect, it } from 'vitest';
import { lineDiff } from './line-diff.js';

it('marks removed and added lines around the lines both texts keep', () => {
  expect(lineDiff('a\nb\nc\n', 'a\nx\nc\nd\n')).toEqual([
    { kind: 'same', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'added', text: 'x' },
    { kind: 'same', text: 'c' },
    { kind: 'added', text: 'd' },
    { kind: 'same', text: '' },
  ]);
  expect(lineDiff('same\n', 'same\n')?.every((l) => l.kind === 'same')).toBe(true);
});

it('declines texts too long to compare in the browser', () => {
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
  expect(lineDiff(long, `${long}\nmore`)).toBeUndefined();
});
