import { expect, it } from 'vitest';
import { type AgentModel, modelSpelling } from '../src/agent-models.js';

const CATALOG: readonly AgentModel[] = [
  { id: 'opus', label: 'Opus (current)', section: 'alias', hidden: false },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', section: 'main', hidden: false },
  { id: 'gpt-5.5', label: 'GPT-5.5', section: 'main', hidden: true },
];

it.each([
  ['an exact id', 'gpt-6.1-sol', { kind: 'listed' }],
  ['a hidden id, which is still valid', 'gpt-5.5', { kind: 'listed' }],
  // LIVE-34: the display name the operator typed.
  ['a display name', 'GPT-6.1-Sol', { kind: 'misnamed', id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }],
  [
    'an id in other case',
    'GPT-6.1-SOL',
    { kind: 'misnamed', id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
  ],
  ['an alias in other case', 'Opus', { kind: 'misnamed', id: 'opus', label: 'Opus (current)' }],
  [
    'an alias display name',
    'opus (CURRENT)',
    { kind: 'misnamed', id: 'opus', label: 'Opus (current)' },
  ],
  ['an id the catalog does not list', 'gpt-7-preview', { kind: 'unlisted' }],
] as const)('reads %s (R-G15)', (_case, typed, expected) => {
  expect(modelSpelling(CATALOG, typed)).toEqual(expected);
});

it('prefers an id match over a display-name match (R-G15)', () => {
  const models: AgentModel[] = [
    { id: 'beta', label: 'ALPHA', section: 'main', hidden: false },
    { id: 'alpha', label: 'Alpha model', section: 'main', hidden: false },
  ];
  expect(modelSpelling(models, 'Alpha')).toMatchObject({ kind: 'misnamed', id: 'alpha' });
});
