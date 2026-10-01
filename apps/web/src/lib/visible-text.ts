/**
 * Characters that change what a script or command does but show as nothing, or as something
 * else: zero-width and joiner characters, bidirectional controls, the byte order mark, the soft
 * hyphen, and control characters other than tab and newline (R-G13 increment 5 verification).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this marks.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** The text with each invisible character shown as `⟦U+XXXX⟧`, so a person can see it. */
export function visible(text: string): string {
  return text.replace(
    INVISIBLE,
    (c) => `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`,
  );
}

/** Whether the text holds a character `visible` would mark. */
export const hasInvisible = (text: string): boolean => new RegExp(INVISIBLE.source).test(text);
