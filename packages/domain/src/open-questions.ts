/**
 * A final report's sections, read one way everywhere (R-B4, decision 13).
 *
 * An agent ends its final message with a `## Open questions` checkpoint: only `none` when nothing
 * needs the operator, otherwise the questions. Before R-B4 eight readers parsed it eight ways
 * (fence-blind or fence-aware, the first section or exactly one, "None." accepted or not, case
 * folded or not, the section ending at the next heading or at the end of the text). Every reader
 * now asks `openQuestionsSection`, which applies R-C2's checkpoint rule:
 *
 * - a section is a line `## Open questions` (trailing blanks allowed) outside fenced blocks, and
 *   it runs to the next `## ` heading outside fenced blocks, or to the end of the text;
 * - a fence opens with three or more backticks or tildes after at most three characters of
 *   whitespace, and closes with the same character at least as long, whatever follows it
 *   (CommonMark's rule, but for tabs and a closer's trailing text);
 * - the checkpoint is `none` only when there is exactly one section and its text, trimmed and in
 *   any case, is `none`; `questions` when there is exactly one section with any other text that
 *   does not begin with `none`; anything else is `malformed` (no section, several, an empty one,
 *   or `none` followed by more text), a format fault the agent can repair (R-C2).
 *
 * What a missing section means is the reader's: a step whose brief requires the checkpoint
 * (design, staged finalization, a scope review) treats it as malformed, and an implementation or
 * a slice review, whose report raises questions only through a section, as none raised
 * (`raisesOpenQuestions`).
 */

interface ReportSection {
  /** How many sections with this heading the report has, outside fenced blocks. */
  readonly count: number;
  /** The first such section's text, trimmed; `''` when there is none. */
  readonly body: string;
  /** The first section's lines, each with whether it lies in a fenced block. */
  readonly lines: readonly { readonly text: string; readonly fenced: boolean }[];
  /** No `## ` heading follows the first section outside fenced blocks. */
  readonly last: boolean;
  /** A line with this heading lies inside a fence still open at the end of the report. */
  readonly hidden: boolean;
}

/** The `## <heading>` sections of a report, read with the fences rule above. */
function reportSection(text: string, heading: string): ReportSection {
  const title = `## ${heading}`;
  let fence: string | undefined;
  let count = 0;
  let collecting = false;
  let last = true;
  // A heading line seen inside the fence that is open now.
  let hidden = false;
  const lines: { text: string; fenced: boolean }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const fenced = fence !== undefined || marker !== undefined;
    if (marker !== undefined) {
      if (fence === undefined) {
        fence = marker;
        hidden = false;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (fenced && line.replace(/[ \t]+$/, '') === title) hidden = true;
    else if (!fenced && line.startsWith('## ')) {
      // Any heading ends the first section; only the first is collected.
      if (collecting) last = false;
      const opens = line.replace(/[ \t]+$/, '') === title;
      if (opens) count += 1;
      collecting = opens && count === 1;
      continue;
    }
    if (collecting) lines.push({ text: line, fenced });
  }
  return {
    count,
    body: lines
      .map((l) => l.text)
      .join('\n')
      .trim(),
    lines,
    last: count > 0 && last,
    hidden: fence !== undefined && hidden,
  };
}

interface OpenQuestionsSection {
  /** How many `## Open questions` sections the report has, outside fenced blocks. */
  readonly count: number;
  /** The first section's text, trimmed; `''` when there is none. */
  readonly body: string;
  /** No `## ` heading follows the first section outside fenced blocks. */
  readonly last: boolean;
  /**
   * A section heading lies inside a fence left open to the end of the report: an unclosed
   * snippet swallowed it, so it is not a section, but it is not nothing either.
   */
  readonly hidden: boolean;
  /**
   * `none`: exactly one section, containing only "none". `questions`: exactly one section
   * listing something. `malformed`: no section, several, an empty one, or "none" followed by
   * more text.
   */
  readonly status: 'none' | 'questions' | 'malformed';
  /**
   * The questions of a `questions` section: its list items (indented lines, sub-bullets
   * included, belong to their item; fenced lines are text), or its whole text if it has no list.
   */
  readonly items: readonly string[];
}

export function openQuestionsSection(text: string): OpenQuestionsSection {
  const section = reportSection(text, 'Open questions');
  const content = section.body.toLowerCase();
  const status =
    section.count !== 1 || !content
      ? 'malformed'
      : content === 'none'
        ? 'none'
        : /^none\b/.test(content)
          ? 'malformed'
          : 'questions';
  const items: string[] = [];
  if (status === 'questions') {
    for (const { text: line, fenced } of section.lines) {
      const item = fenced ? null : /^ ?(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (item) items.push(item[1]!.trim());
      else if (items.length && line.trim()) items[items.length - 1] += `\n${line.trim()}`;
    }
    if (!items.length) items.push(section.body);
  }
  return {
    count: section.count,
    body: section.body,
    last: section.last,
    hidden: section.hidden,
    status,
    items: items.filter((q) => q.trim()),
  };
}

/** The checkpoint says no question needs the operator. */
export function noOpenQuestions(text: string): boolean {
  return openQuestionsSection(text).status === 'none';
}

/**
 * The report raises questions for the operator: it has a checkpoint and the checkpoint is not
 * `none` alone, or a fence left open swallowed its checkpoint's heading (R-B4 increment 3
 * review). A report without the section raises none; the step that requires it reads that as
 * `malformed` instead.
 */
export function raisesOpenQuestions(text: string): boolean {
  const section = openQuestionsSection(text);
  return (section.count > 0 && section.status !== 'none') || section.hidden;
}

/**
 * A design's conclusion: its checkpoint is `none` and is the report's last section, so nothing
 * follows it. Missing, ambiguous or truncated conclusions pause automation.
 */
export function designHasNoOpenQuestions(text: string, truncated = false): boolean {
  if (truncated) return false;
  const section = openQuestionsSection(text);
  return section.status === 'none' && section.last;
}

/**
 * An integration resolution's final report says it is ready: exactly one `## Resolution status`
 * section, last in the report, containing only `ready` in any case.
 */
export function resolutionReady(text: string): boolean {
  const section = reportSection(text, 'Resolution status');
  return section.count === 1 && section.last && section.body.toLowerCase() === 'ready';
}
