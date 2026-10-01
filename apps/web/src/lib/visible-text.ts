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

/**
 * A definition file's text as the review shows it: `visible`, and also each tab as `→` before
 * the tab and each trailing space as `·`, since a tab and spaces, or a line with and without
 * trailing spaces, read the same and can change what a script does. A literal `→` or `·` in
 * the file is outside ASCII and so is shown as `⟦U+…⟧`: these marks can only be ours.
 */
export function visibleDefinition(text: string): string {
  return visible(text)
    .replace(/\t/g, '→\t')
    .replace(/ +$/gm, (spaces) => '·'.repeat(spaces.length));
}

/** Whether two texts differ only in spaces, tabs and line ends. */
export const differsOnlyInWhitespace = (a: string, b: string): boolean =>
  a !== b && a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
