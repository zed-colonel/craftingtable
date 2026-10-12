import type { ProjectSummary } from '@craftingtable/contracts';
import type { ProjectId } from '@craftingtable/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ProjectCards } from './ProjectCards.js';

afterEach(cleanup);

const project: ProjectSummary = {
  id: 'project-1' as ProjectId,
  name: 'ActionQueue',
  slug: 'actionqueue',
  versionCount: 1,
  warningCount: 0,
  createdAt: '2026-10-12T00:00:00.000Z',
  proposedCount: 5,
  admittedCount: 4,
  completedCount: 3,
  planningReadyCount: 2,
  dependencyBlockedCount: 1,
  riskCounts: { low: 0, medium: 0, high: 0, critical: 0, unspecified: 0 },
};

it('labels its counts with the glossary states, never a bare Ready or Blocked (R-I7, docs/ui/glossary.md)', () => {
  render(<ProjectCards projects={[project]} onOpen={() => {}} onImport={() => {}} />);
  const counts = within(screen.getByRole('region', { name: 'Projects' }));
  const count = (label: string) =>
    counts.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
  expect(count('Ready for admission')).toBe('2');
  expect(count('Dependency-blocked')).toBe('1');
  expect(count('In agenda')).toBe('4');
  expect(count('Completed')).toBe('3');
  expect(count('Proposed')).toBe('5');
  expect(counts.queryByText('Ready')).toBeNull();
  expect(counts.queryByText('Blocked')).toBeNull();
});
