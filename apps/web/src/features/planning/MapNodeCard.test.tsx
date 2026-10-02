import type { CrossProjectView } from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { revealElement } from '../../lib/reveal-element.js';
import { MapNodeCard } from './MapNodeCard.js';

vi.mock('../../lib/reveal-element.js', async (original) => {
  const actual = await original<typeof import('../../lib/reveal-element.js')>();
  return { ...actual, revealElement: vi.fn() };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const node = (fields: Partial<CrossProjectView['nodes'][number]>) =>
  ({
    key: 'slice:wi/WI-01/core:verified',
    kind: 'slice',
    sourceId: 'wi/WI-01/core',
    state: 'verified',
    title: 'Core provider',
    repository: 'wi',
    included: true,
    priority: true,
    satisfied: false,
    status: 'Waiting for review',
    requirements: [],
    blockers: [],
    action: 'work-item',
    ...fields,
  }) as CrossProjectView['nodes'][number];
const card = (n: CrossProjectView['nodes'][number], prioritized = false) => {
  const onTrace = vi.fn();
  render(
    <MapNodeCard
      node={n}
      prioritized={prioritized}
      workspaceId={asWorkspaceId('ws')}
      panelKey="roadmap-r"
      runtimePanelId="runtime-evidence-roadmap-r"
      onTrace={onTrace}
    />,
  );
  return onTrace;
};

// R-D4 4c review F4: what the extracted milestone card shows and does.
it('traces its own requirements and reveals its evidence or adoption step', () => {
  const onTrace = card(node({ action: 'evidence' }), true);
  expect(screen.getByText(/Target priority/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Trace requirements' }));
  expect(onTrace).toHaveBeenCalledWith('slice:wi/WI-01/core:verified');
  fireEvent.click(screen.getByRole('button', { name: 'Submit or review checkpoint evidence' }));
  expect(revealElement).toHaveBeenCalledWith('runtime-evidence-roadmap-r-evidence');
  cleanup();
  card(node({ action: 'adopt' }));
  expect(screen.queryByText(/Target priority/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review scheduling proposals' }));
  expect(revealElement).toHaveBeenCalledWith('map-adoption-roadmap-r');
});
