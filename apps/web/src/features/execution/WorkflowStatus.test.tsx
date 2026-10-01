import type { WorkCycle, WorkspaceId } from '@craftingtable/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { WorkflowStatus } from './WorkflowStatus.js';

afterEach(cleanup);

const cycle = {
  id: 'c1',
  workspaceId: 'ws',
  step: 'implement',
  workflow: { questions: [{ destination: 'local', question: 'Which queue backs it?' }] },
} as unknown as WorkCycle;

it('points a question at the inbox item that decides the stop, when the page shows only a banner (R-A6 review M2)', () => {
  render(
    <WorkflowStatus
      cycle={cycle}
      decidedIn={{ name: 'inbox', workspaceId: 'ws' as WorkspaceId, itemId: 'item-9' }}
    />,
  );
  expect(screen.getByRole('link', { name: 'Answer in Needs you' }).getAttribute('href')).toContain(
    '/inbox/item-9',
  );
  cleanup();
  render(<WorkflowStatus cycle={cycle} />);
  expect(
    screen.getByRole('link', { name: 'Answer in this work item’s Continue with guidance form' }),
  ).toBeDefined();
});
