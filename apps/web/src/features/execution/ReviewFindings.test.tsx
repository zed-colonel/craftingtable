import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewFindings } from './ReviewFindings.js';

afterEach(cleanup);

it('counts only open findings while retaining withdrawn findings and their reasons', () => {
  const finding = {
    id: 'F-001',
    severity: 'minor' as const,
    status: 'open' as const,
    title: 'Boundary coverage',
    explanation: 'Test the boundary.',
    recommendation: 'Add the regression.',
  };
  render(
    <ReviewFindings
      assessment={{
        status: 'complete',
        issues: [],
        report: {
          version: 1,
          complete: true,
          verdict: 'mergeable',
          exitGate: { met: true, evidence: 'Checks pass.' },
          findings: [
            finding,
            {
              ...finding,
              id: 'F-002',
              severity: 'major',
              status: 'withdrawn',
              disposition: 'Existing coverage verified.',
            },
          ],
        },
      }}
    />,
  );
  expect(screen.getByText('0 blocking · 0 major · 1 minor · 0 nit')).toBeTruthy();
  expect(screen.getByText('Reviewer disposition: Existing coverage verified.')).toBeTruthy();
  expect(screen.getByText('F-002')).toBeTruthy();
});

it('presents invalid and legacy reports as needing reconciliation, never as zero findings', () => {
  const { rerender } = render(
    <ReviewFindings
      assessment={{ status: 'invalid', issues: ['Previously recorded finding F-001 is missing.'] }}
    />,
  );
  expect(screen.getByText('Review report needs attention')).toBeTruthy();
  expect(screen.getByText('Previously recorded finding F-001 is missing.')).toBeTruthy();
  expect(screen.queryByText('No findings reported.')).toBeNull();
  rerender(
    <ReviewFindings assessment={{ status: 'unstructured', issues: ['No structured report.'] }} />,
  );
  expect(screen.getByText('Unstructured review')).toBeTruthy();
});

it('shows a message the report repeats once, without colliding keys', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <ReviewFindings
        assessment={{
          status: 'invalid',
          issues: ['Repository path does not exist', 'Repository path does not exist', 'Other'],
        }}
      />,
    );
    expect(screen.getAllByText('Repository path does not exist')).toHaveLength(1);
    expect(screen.getByText('Other')).toBeDefined();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
});
