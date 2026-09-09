import { describe, expect, it } from 'vitest';
import { type BriefInput, composeBrief } from './brief.js';

function briefInput(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    role: 'implement',
    projectName: 'ActionQueue',
    workItem: {
      sourceId: 'AQ-01',
      title: 'Queue accepts jobs',
      risk: 'low',
      primaryAreas: ['queue'],
      exitGate: 'Queue accepts and drains one job.',
      sourceFields: { id: 'AQ-01' },
    },
    requiredDependencies: [],
    recommendedDependencies: [],
    worktree: {
      path: '/data/worktrees/aq-01',
      branchName: 'ct/aq-01-abcd1234',
      baseBranch: 'main',
      baseSha: '0123456789abcdef0123456789abcdef01234567',
    },
    planDocuments: [],
    ...overrides,
  };
}

describe('composeBrief design handoff', () => {
  it('asks a design run to end with its open questions', () => {
    const brief = composeBrief(briefInput({ role: 'design' }));
    expect(brief).toContain('## Open questions');
    expect(brief).toContain('`none`');
  });

  it('hands an accepted design to an implement run as its plan', () => {
    const brief = composeBrief(
      briefInput({
        role: 'implement',
        parentRun: {
          role: 'design',
          finalMessage: 'Change queue.ts to hold a ring buffer.\n\n## Open questions\n\nnone',
        },
      }),
    );
    expect(brief).toContain('## Accepted design');
    expect(brief).toContain('Implement this design.');
    expect(brief).toContain('Change queue.ts to hold a ring buffer.');
    expect(brief).not.toContain('## Previous design run');
  });

  it('keeps the generic section for other lineages', () => {
    const brief = composeBrief(
      briefInput({
        role: 'review',
        parentRun: { role: 'design', finalMessage: 'A proposal.' },
      }),
    );
    expect(brief).toContain('## Previous design run');
    expect(brief).not.toContain('## Accepted design');
  });
});
