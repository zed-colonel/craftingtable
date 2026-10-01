import { expect, it } from 'vitest';
import { differsOnlyInWhitespace, hasMarked, visible, visibleDefinition } from './visible-text.js';

it('marks every character outside printable ASCII, and leaves tabs, newlines and ASCII alone', () => {
  expect(visible('﻿#!/bin/sh -e\n')).toBe('⟦U+FEFF⟧#!/bin/sh -e\n');
  expect(visible('false || exit​ 1')).toBe('false || exit⟦U+200B⟧ 1');
  expect(visible('set -e\r\n')).toBe('set -e⟦U+000D⟧\n');
  // Tags, variation selectors, a no-break space and a look-alike letter all show.
  expect(visible('TODO\u{E0020}')).toBe('TODO⟦U+E0020⟧');
  expect(visible('a️b c')).toBe('a⟦U+FE0F⟧b⟦U+00A0⟧c');
  expect(visible('tеst')).toBe('t⟦U+0435⟧st');
  expect(visible('\tindented\nplain ascii ~')).toBe('\tindented\nplain ascii ~');
  expect(hasMarked('plain')).toBe(false);
  expect(hasMarked('naïve')).toBe(true);
});

it('shows tabs and trailing spaces in a definition, which marks can only be ours', () => {
  expect(visibleDefinition('\tEOF\n      EOF   \n')).toBe('→\tEOF\n      EOF···\n');
  expect(visibleDefinition('literal → ·')).toBe('literal ⟦U+2192⟧ ⟦U+00B7⟧');
  expect(differsOnlyInWhitespace('a\tb', 'a  b')).toBe(true);
  expect(differsOnlyInWhitespace('a b', 'a c')).toBe(false);
});
