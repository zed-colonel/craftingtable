import { describe, expect, it } from 'vitest';
import {
  designHasNoOpenQuestions,
  noOpenQuestions,
  openQuestionsSection,
  raisesOpenQuestions,
  resolutionReady,
} from '../src/open-questions.js';

/**
 * One open-questions rule (R-B4, decision 13). Each row is a report and how the rule reads it:
 * its checkpoint, whether it raises questions, and whether a design may conclude on it. The rows
 * marked "was" are reports the eight readers before R-B4 disagreed on; their old readings are
 * named so a change of classification is visible here, not only on the corpus.
 */

const rows: readonly {
  readonly name: string;
  readonly text: string;
  readonly status: 'none' | 'questions' | 'malformed';
  readonly raises: boolean;
  readonly design: boolean;
}[] = [
  {
    name: 'one section, none',
    text: 'Done.\n\n## Open questions\nnone',
    status: 'none',
    raises: false,
    design: true,
  },
  {
    name: 'none in any case, CRLF',
    text: '## Open questions\r\nNone\r\n',
    status: 'none',
    raises: false,
    design: true,
  },
  {
    name: 'trailing blanks after the heading',
    text: '## Open questions \t\nnone',
    status: 'none',
    raises: false,
    design: true,
  },
  {
    name: 'questions listed',
    text: 'Done.\n\n## Open questions\n- Pick storage',
    status: 'questions',
    raises: true,
    design: false,
  },
  {
    name: 'none, followed by the review report (a review, not a design)',
    text: '## Open questions\nnone\n\n## Review report\n```craftingtable-review\n{}\n```',
    status: 'none',
    raises: false,
    design: false,
  },
  // A missing section raises nothing; the steps that require one read it as malformed.
  {
    name: 'no section',
    text: 'Implemented and checks passed.',
    status: 'malformed',
    raises: false,
    design: false,
  },
  {
    name: 'an empty section',
    text: '## Open questions\n\n## Notes\nx',
    status: 'malformed',
    raises: true,
    design: false,
  },
  // Was: the presence test and the section slicers took the first section.
  {
    name: 'two sections',
    text: '## Open questions\nnone\n## Open questions\nnone',
    status: 'malformed',
    raises: true,
    design: false,
  },
  // Was: the presence test found the fenced heading and stopped for questions.
  {
    name: 'a heading only inside a fence',
    text: 'Example:\n```md\n## Open questions\n- Q\n```',
    status: 'malformed',
    raises: false,
    design: false,
  },
  // Was: the section slicers read "None." as none.
  {
    name: 'None. with a full stop',
    text: '## Open questions\nNone.',
    status: 'malformed',
    raises: true,
    design: false,
  },
  {
    name: 'none followed by more text',
    text: '## Open questions\nnone, probably',
    status: 'malformed',
    raises: true,
    design: false,
  },
  // Was: the design-recovery reader folded the heading's case.
  {
    name: 'a heading in another case',
    text: '## open questions\nWhich queue?',
    status: 'malformed',
    raises: false,
    design: false,
  },
  // Was: the finalization reader toggled on a fence indented four spaces, or of the other kind.
  {
    name: 'a fence of the other kind does not close it',
    text: '```\n~~~\n## Open questions\n- fenced\n```\n## Open questions\nnone',
    status: 'none',
    raises: false,
    design: true,
  },
  {
    name: 'four spaces of indentation open no fence',
    text: '    ```\n## Open questions\nnone',
    status: 'none',
    raises: false,
    design: true,
  },
  {
    name: 'a fenced heading inside the section is its text',
    text: '## Open questions\n- Which?\n```\n## Not a heading\n```',
    status: 'questions',
    raises: true,
    design: false,
  },
];

describe('openQuestionsSection', () => {
  it.each(rows)('$name', ({ text, status, raises, design }) => {
    expect(openQuestionsSection(text).status).toBe(status);
    expect(noOpenQuestions(text)).toBe(status === 'none');
    expect(raisesOpenQuestions(text)).toBe(raises);
    expect(designHasNoOpenQuestions(text)).toBe(design);
  });

  it('pauses a truncated design whatever it says', () =>
    expect(designHasNoOpenQuestions('## Open questions\nnone', true)).toBe(false));

  it('reads the section as its items, or its whole text', () => {
    expect(
      openQuestionsSection(
        'Intro.\n\n## Open questions\n- Which queue?\n  It owns retries.\n1. Who reviews?\n```\n- fenced\n```\n\n## Review report\nx',
      ),
    ).toMatchObject({
      count: 1,
      last: false,
      items: ['Which queue?\nIt owns retries.', 'Who reviews?\n```\n- fenced\n```'],
    });
    expect(openQuestionsSection('## Open questions\nShould we keep the cache?').items).toEqual([
      'Should we keep the cache?',
    ]);
    expect(openQuestionsSection('## Open questions\nnone').items).toEqual([]);
    expect(openQuestionsSection('none here')).toMatchObject({ count: 0, body: '', last: false });
  });
});

describe('resolutionReady', () => {
  it.each([
    ['the last section says ready', 'Resolved.\n\n## Resolution status\nready', true],
    ['in any case, with blank lines', 'x\n## Resolution status\n\nReady\n', true],
    ['blocked', 'x\n## Resolution status\nblocked', false],
    // Was: the regex accepted the heading in any case.
    ['a heading in another case', 'x\n## resolution status\nready', false],
    ['not the last section', '## Resolution status\nready\n## Notes\nx', false],
    ['only inside a fence', '```\n## Resolution status\nready\n```', false],
    ['twice', '## Resolution status\nblocked\n## Resolution status\nready', false],
  ])('%s', (_name, text, ready) => expect(resolutionReady(text)).toBe(ready));
});
