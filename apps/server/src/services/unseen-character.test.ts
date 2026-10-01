import { expect, it } from 'vitest';
import { unseenCharacter } from './repository-checks-service.js';

it('allows only what a person can see: ASCII, tab, newline and visible letters, numbers, punctuation and symbols (R-G13)', () => {
  expect(unseenCharacter('#!/bin/sh\n\tcargo test # naïve — ok €\n')).toBeUndefined();
  for (const [text, codePoint, line] of [
    ['a\u{E0020}', 'U+E0020', 1],
    ['ok\n﻿x', 'U+FEFF', 2],
    ['x y', 'U+00A0', 1],
    ['x​y', 'U+200B', 1],
    ['set -e\r\n', 'U+000D', 1],
    ['é', 'U+0301', 1],
    ['a️', 'U+FE0F', 1],
    // A letter that renders as nothing: default-ignorable though it is a letter.
    ['aㅤb', 'U+3164', 1],
    ['a b', 'U+2028', 1],
  ] as const)
    expect(unseenCharacter(text), codePoint).toEqual({ codePoint, line });
});
