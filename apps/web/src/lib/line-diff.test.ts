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
  const long = (tag: string) => Array.from({ length: 3000 }, (_, i) => `${tag} ${i}`).join('\n');
  expect(lineDiff(long('old'), long('new'))).toBeUndefined();
});

it('compares only the lines between those both texts share, so a long file with one change still diffs', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[1500] = 'line changed';
  const diff = lineDiff(lines.join('\n'), changed.join('\n'))!;
  expect(diff.filter((l) => l.kind !== 'same')).toEqual([
    { kind: 'removed', text: 'line 1500' },
    { kind: 'added', text: 'line changed' },
  ]);
  expect(diff).toHaveLength(3001);
  // Changed at either end, the shared lines are trimmed from the other.
  const end = [...lines];
  end[2999] = 'last changed';
  expect(lineDiff(lines.join('\n'), end.join('\n'))?.filter((l) => l.kind !== 'same')).toHaveLength(
    2,
  );
  const start = [...lines];
  start[0] = 'first changed';
  expect(
    lineDiff(lines.join('\n'), start.join('\n'))?.filter((l) => l.kind !== 'same'),
  ).toHaveLength(2);
});
