import { expect, it } from 'vitest';
import { hasInvisible, visible } from './visible-text.js';

it('marks characters that show as nothing, and leaves tabs, newlines and text alone', () => {
  expect(visible('﻿#!/bin/sh -e\n')).toBe('⟦U+FEFF⟧#!/bin/sh -e\n');
  expect(visible('false || exit​ 1')).toBe('false || exit⟦U+200B⟧ 1');
  expect(visible('set -e\r\n')).toBe('set -e⟦U+000D⟧\n');
  expect(visible('a‮b⁦c')).toBe('a⟦U+202E⟧b⟦U+2066⟧c');
  expect(visible('\tindented\nplain €')).toBe('\tindented\nplain €');
  expect(hasInvisible('plain')).toBe(false);
  expect(hasInvisible('a‍b')).toBe(true);
});
