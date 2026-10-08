import { expect, it } from 'vitest';
import type { NormalizedAgentEvent } from '../src/index.js';
import {
  STDERR_EVENT_LIMIT_BYTES,
  STDERR_RUN_BUDGET_BYTES,
  StderrJournal,
} from '../src/stderr-journal.js';

const texts = (events: readonly NormalizedAgentEvent[]) =>
  events.flatMap((event) => (event.kind === 'stderr' ? [event.payload.text] : []));

it('cuts events and the budget between characters, never inside one (R-G11)', () => {
  const journal = new StderrJournal();
  // Three-byte characters, so neither limit falls on a character boundary.
  const chunk = '€'.repeat(10_000);
  const events: NormalizedAgentEvent[] = [];
  let written = '';
  while (!events.some((event) => event.kind === 'notice')) {
    events.push(...journal.write(chunk));
    written += chunk;
  }
  events.push(...journal.write('after the notice'), ...journal.flush());
  const journaled = texts(events);
  for (const text of journaled) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(STDERR_EVENT_LIMIT_BYTES);
    expect(text).toMatch(/^€+$/);
  }
  const all = journaled.join('');
  expect(written.startsWith(all)).toBe(true);
  expect(Buffer.byteLength(all)).toBe(STDERR_RUN_BUDGET_BYTES - (STDERR_RUN_BUDGET_BYTES % 3));
  expect(events.filter((event) => event.kind === 'notice')).toHaveLength(1);
  expect(events.at(-1)?.kind).toBe('notice');
});

it('holds output below an event until the session ends, and drops blank output', () => {
  const journal = new StderrJournal();
  expect(journal.write('starting\n')).toEqual([]);
  expect(journal.flush()).toEqual([{ kind: 'stderr', payload: { text: 'starting\n' } }]);
  expect(journal.write(' \n')).toEqual([]);
  expect(journal.flush()).toEqual([]);
});
