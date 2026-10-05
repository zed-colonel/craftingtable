import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SavedModelNotes, savedModelNote } from './SavedModelNotes.js';

afterEach(cleanup);

const codex = (
  catalog: ExecutionStatusResponse['backends'][number]['catalog'],
  available = true,
): ExecutionStatusResponse['backends'] => [
  {
    kind: 'codex',
    label: 'Codex',
    available,
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', section: 'main', hidden: false },
      { id: 'gpt-5.5', label: 'GPT-5.5', section: 'main', hidden: true },
    ],
    catalog,
  },
];
const read = codex({ source: 'catalog', listedAt: '2026-10-05T16:00:00.000Z' });

it('warns about a saved model that left the catalog, and says runs still send it (R-G15)', () => {
  expect(savedModelNote(read, { backend: 'codex', model: 'gpt-6-sol' })).toBe(
    'gpt-6-sol is no longer in Codex’s model list; runs still send it',
  );
  // So does an operator's own list.
  expect(
    savedModelNote(codex({ source: 'environment' }), { backend: 'codex', model: 'gpt-6-sol' }),
  ).toBeDefined();
  // The release's own list may only be older than the model: no warning.
  expect(
    savedModelNote(codex({ source: 'fallback', issue: 'catalog-request-failed' }), {
      backend: 'codex',
      model: 'gpt-6-sol',
    }),
  ).toBeUndefined();
});

it('names the id for a saved display name, which is not started (LIVE-34)', () => {
  expect(savedModelNote(read, { backend: 'codex', model: 'GPT-6.1-Sol' })).toBe(
    'GPT-6.1-Sol is Codex’s name for gpt-6.1-sol, and runs that name it are not started; choose gpt-6.1-sol',
  );
});

it('says nothing of a listed or hidden id, the backend default, or a missing backend (R-G15)', () => {
  expect(savedModelNote(read, { backend: 'codex', model: 'gpt-6.1-sol' })).toBeUndefined();
  expect(savedModelNote(read, { backend: 'codex', model: 'gpt-5.5' })).toBeUndefined();
  expect(savedModelNote(read, { backend: 'codex' })).toBeUndefined();
  expect(
    savedModelNote(codex({ source: 'catalog' }, false), { backend: 'codex', model: 'gone' }),
  ).toBeUndefined();
});

it('lists one note per saved selection that has one (R-G15)', () => {
  render(
    <SavedModelNotes
      backends={read}
      selections={[
        ['Design', { backend: 'codex', model: 'gpt-6.1-sol' }],
        ['Review', { backend: 'codex', model: 'gpt-6-sol' }],
        ['Security review', undefined],
      ]}
    />,
  );
  expect(screen.getByRole('note').textContent).toBe(
    'Review: gpt-6-sol is no longer in Codex’s model list; runs still send it.',
  );
});
