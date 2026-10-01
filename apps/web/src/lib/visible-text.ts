/**
 * Every character outside printable ASCII, tab and newline (R-G13 increment 5, verification):
 * spaces other than ASCII's, format, control and combining characters, tags, and letters that
 * look like ASCII ones. Marking all of them, rather than a list of invisible ones, shows a
 * person exactly what a check runs. The daemon refuses the ones that do not show at merge.
 */
const MARKED = /[^\t\n\x20-\x7E]/gu;

/** The text with each character outside printable ASCII shown as `⟦U+XXXX⟧`. */
export function visible(text: string): string {
  return text.replace(
    MARKED,
    (c) => `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`,
  );
}

/** Whether the text holds a character `visible` would mark. */
export const hasMarked = (text: string): boolean => new RegExp(MARKED.source, 'u').test(text);
