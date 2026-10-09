import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MapCapabilities } from './MapCapabilities.js';

afterEach(cleanup);

it('lists each typed gap in plain words, and every slice’s build classification (R-F2 part 5)', () => {
  render(
    <MapCapabilities
      capabilities={{
        gaps: [
          { code: 'resource-adapter-missing', resourceId: 'kata-host' },
          {
            code: 'resource-adapter-unusable',
            resourceId: 'native-host',
            adapter: 'native-test-host',
            fields: ['requires_hardware_virtualization'],
          },
          { code: 'plan-contract-changed', checkpointId: 'PLAN-OK', fields: ['pass_criteria'] },
          {
            code: 'decision-contract-changed',
            checkpointId: 'WI-ADR-012',
            profileId: 'decision-review',
            fields: ['reviewer_roles'],
          },
        ],
        builds: [
          { sliceId: 'wi/WI-01/domain', mode: 'scoped-checks' },
          { sliceId: 'wi/WI-01/integration', mode: 'current-upstream-build' },
          { sliceId: 'exo/EXO-01/domain', mode: 'scoped-checks' },
        ],
      }}
    />,
  );
  const gaps = within(screen.getByRole('list', { name: 'Capability gaps' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);
  expect(gaps).toEqual([
    'No daemon adapter runs kata-host: work that needs it waits for evidence submitted by hand.',
    'native-host asks for what its native-test-host adapter cannot provide (requires_hardware_virtualization).',
    "PLAN-OK's contract differs from the attested one (pass_criteria): plan evidence is submitted and reviewed by hand.",
    'WI-ADR-012 is reviewed under decision-review, which differs (reviewer_roles): it is not prepared or decided as a shared decision.',
  ]);
  screen.getByText('What CraftingTable cannot automate here (4) · build classification');
  screen.getByText('Builds: 2 slices with scoped checks, 1 against the current upstream pins.');
  expect(
    within(screen.getByRole('list', { name: 'Build classification' })).getAllByRole('listitem')[1]
      ?.textContent,
  ).toBe('wi/WI-01/integration · current upstream build');
});

it('says so when everything is recognized', () => {
  render(<MapCapabilities capabilities={{ gaps: [], builds: [] }} />);
  screen.getByText('Every contract, role and resource of this map is recognized.');
});
