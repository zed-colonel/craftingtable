import type { FinalizationView } from '@craftingtable/contracts';
import { controlFinalizationRequestSchema } from '@craftingtable/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FinalizationCheckpoint } from './FinalizationCheckpoint.js';

afterEach(cleanup);

const view = {
  finalization: { version: 5, policy: { maxRemediationRounds: 3 } },
  cycle: {
    version: 38,
    policy: { maxRemediationRounds: 3 },
    remediationRounds: 7,
    additionalRemediationRounds: 4,
  },
  canAuthorizeRemediation: true,
  checkpointFindings: [
    { id: 'F-051', severity: 'minor', title: 'Handle the throttle response', status: 'open' },
    { id: 'F-052', severity: 'nit', title: 'Clarify diagnostics', status: 'open' },
  ],
} as FinalizationView;

it('authorizes a selected batch and extra attempts together when the allowance is exhausted', () => {
  const onDecide = vi.fn();
  render(<FinalizationCheckpoint view={view} busy={false} onDecide={onDecide} />);
  const button = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Authorize focused remediation',
  });
  expect(button.disabled).toBe(true);
  expect(screen.getByText('Select at least one finding to continue.')).toBeDefined();
  fireEvent.click(screen.getByRole('checkbox', { name: /F-051/ }));
  expect(button.disabled).toBe(true);
  expect(screen.getByText('Enter a decision rationale to continue.')).toBeDefined();
  fireEvent.change(screen.getByLabelText('Decision rationale (required)'), {
    target: { value: 'Fix the CLI behavior before promotion.' },
  });
  fireEvent.change(screen.getByLabelText('Additional focused attempts'), {
    target: { value: '2' },
  });
  fireEvent.change(screen.getByLabelText('Answers and guidance (optional)'), {
    target: { value: 'Keep unrelated polish out of this batch.' },
  });
  expect(
    screen.getByText(/Used: 7. Current allowance: 7. New allowance: 9; 2 attempts available./),
  ).toBeDefined();
  expect(button.disabled).toBe(false);
  expect(screen.queryByRole('button', { name: 'Authorize more remediation' })).toBeNull();
  fireEvent.click(button);
  expect(onDecide).toHaveBeenCalledExactlyOnceWith({
    action: 'remediate-findings',
    findingIds: ['F-051'],
    additionalRounds: 2,
    rationale: 'Fix the CLI behavior before promotion.',
    instructions: 'Keep unrelated polish out of this batch.',
    expectedVersion: 5,
    expectedCycleVersion: 38,
  });
  expect(controlFinalizationRequestSchema.safeParse(onDecide.mock.calls[0]?.[0]).success).toBe(
    true,
  );
});

it('explains why higher-severity findings cannot be deferred and omits the budget for deferral', () => {
  const onDecide = vi.fn();
  render(<FinalizationCheckpoint view={view} busy={false} onDecide={onDecide} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select all findings' }));
  fireEvent.change(screen.getByLabelText('Next action'), { target: { value: 'defer-nits' } });
  expect(screen.getByText(/Only nits can be deferred./)).toBeDefined();
  const button = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Defer selected nits and review',
  });
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /F-051/ }));
  fireEvent.change(screen.getByLabelText('Decision rationale (required)'), {
    target: { value: 'Optional diagnostics follow-up.' },
  });
  fireEvent.click(button);
  expect(onDecide).toHaveBeenCalledExactlyOnceWith({
    action: 'defer-nits',
    findingIds: ['F-052'],
    rationale: 'Optional diagnostics follow-up.',
    instructions: '',
    expectedVersion: 5,
    expectedCycleVersion: 38,
  });
});

it('supports a review requiring remediation without selectable findings in the same form', () => {
  const onDecide = vi.fn();
  render(
    <FinalizationCheckpoint
      view={{ ...view, checkpointFindings: [] }}
      busy={false}
      onDecide={onDecide}
    />,
  );
  fireEvent.change(screen.getByLabelText('Additional remediation attempts'), {
    target: { value: '2' },
  });
  fireEvent.change(screen.getByLabelText('Answers and guidance (optional)'), {
    target: { value: 'Repair the failed verification gate.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize more remediation' }));
  expect(onDecide).toHaveBeenCalledExactlyOnceWith({
    action: 'authorize-remediation',
    additionalRounds: 2,
    instructions: 'Repair the failed verification gate.',
    expectedVersion: 5,
    expectedCycleVersion: 38,
  });
});

it('resumes incomplete runs with guidance without granting allowance or finding decisions', () => {
  const onDecide = vi.fn();
  render(
    <FinalizationCheckpoint
      view={{ ...view, canAuthorizeRemediation: false, checkpointFindings: [] }}
      busy={false}
      onDecide={onDecide}
    />,
  );
  fireEvent.change(screen.getByLabelText('Answers and guidance (optional)'), {
    target: { value: 'Collect the completed verification and finish reporting.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Resume finalization' }));
  expect(onDecide).toHaveBeenCalledExactlyOnceWith({
    action: 'resume',
    instructions: 'Collect the completed verification and finish reporting.',
    expectedVersion: 5,
    expectedCycleVersion: 38,
  });
});
