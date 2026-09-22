import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { WorkCycle } from '@craftingtable/domain';
import { WorkflowStatus } from './WorkflowStatus.js';
afterEach(cleanup);
it('routes shared architecture and local questions to different named controls', () => {
  const cycle = {
    id: 'cycle',
    workspaceId: 'workspace',
    executionScope: { definitionId: 'map' },
    workflow: {
      reassessments: 1,
      questions: [
        {
          question: 'Approve the identity boundary?',
          destination: 'shared-decision',
          checkpointId: 'EXO-ADR-004',
        },
        { question: 'Which retention period?', destination: 'work-item' },
      ],
    },
  } as unknown as WorkCycle;
  render(<WorkflowStatus cycle={cycle} />);
  expect(screen.getByRole('link', { name: /Resolve EXO-ADR-004/ }).getAttribute('href')).toBe(
    '/workspaces/workspace/roadmaps#architecture-decisions-map',
  );
  expect(screen.getByRole('link', { name: /Answer in this work item/ }).getAttribute('href')).toBe(
    '#cycle-guidance-cycle',
  );
});
it('shows controller waits as prerequisites rather than unanswered questions', () => {
  render(
    <WorkflowStatus
      cycle={
        {
          workspaceId: 'workspace',
          workflow: { reassessments: 0, questions: [], waiting: 'WI-09/domain must be verified.' },
        } as unknown as WorkCycle
      }
    />,
  );
  expect(screen.getByRole('status').textContent).toContain('WI-09/domain must be verified');
  expect(screen.queryByRole('heading', { name: 'Questions needing your decision' })).toBeNull();
});

it('keeps design questions on design recovery instead of the implementation guidance action', () => {
  render(
    <WorkflowStatus
      cycle={
        {
          id: 'cycle',
          workspaceId: 'workspace',
          step: 'design',
          workflow: {
            reassessments: 0,
            questions: [{ question: 'Which constraint?', destination: 'work-item' }],
          },
        } as unknown as WorkCycle
      }
    />,
  );
  expect(screen.getByRole('link', { name: /Resolve design questions/ }).getAttribute('href')).toBe(
    '#cycle-design-cycle',
  );
});
