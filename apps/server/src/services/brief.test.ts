import { reviewReportSchema } from '@craftingtable/contracts';
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

describe('composeBrief instruction provenance', () => {
  it('keeps controller rules, operator instructions and one-shot guidance apart', () => {
    const brief = composeBrief(
      briefInput({
        controllerInstructions: 'Do not merge. Complete this step.',
        instructions: 'Keep the public API.',
        stepGuidance: 'For this attempt only, rerun the failing check.',
      }),
    );
    const section = (heading: string) =>
      brief.split(`## ${heading}\n\n`)[1]?.split('\n## ')[0]?.trim();
    expect(section('Step rules (from the controller)')).toBe('Do not merge. Complete this step.');
    expect(section('Operator instructions')).toBe('Keep the public API.');
    expect(section('Operator guidance for this step')).toBe(
      'For this attempt only, rerun the failing check.',
    );
  });

  it('omits empty sections', () => {
    const brief = composeBrief(briefInput({ controllerInstructions: ' ', stepGuidance: '' }));
    expect(brief).not.toContain('## Step rules');
    expect(brief).not.toContain('## Operator guidance');
  });
});

describe('composeBrief scoped review report', () => {
  const identity = {
    kind: 'slice',
    definitionId: '0ebcb7cf-9686-4bc1-9b9d-bb85a1d0b4c9',
    bindingRevision: 4,
    sourceId: 'exo/EXO-18/instance-design',
  } as const;
  const scoped = (role: BriefInput['role']) =>
    composeBrief(
      briefInput({
        role,
        executionScope: {
          identity,
          title: 'Instance design',
          scope: 'Prepare the instance design.',
          excludes: [],
          requirements: ['Prepare the instance design.', 'Local test results'],
          cases: ['EE-001'],
          context: '',
        },
      }),
    );

  // LIVE-32: three reviews wrote scopeEvidence inside exitGate.evidence, so the report had none.
  it('shows scopeEvidence as a top-level field of a complete report', () => {
    const brief = scoped('review');
    const lines = brief.split('\n');
    const shape =
      lines[
        lines.findIndex((line) =>
          line.endsWith('A complete report for this scope has this shape:'),
        ) + 1
      ];
    const parsed = reviewReportSchema.safeParse(JSON.parse(shape ?? 'null'));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.scopeEvidence).toEqual({
      scope: identity,
      requirements: [
        { requirement: 'Prepare the instance design.', evidence: expect.any(String) },
        { requirement: 'Local test results', evidence: expect.any(String) },
      ],
      caseIds: ['EE-001'],
    });
    expect(brief).toContain('never inside exitGate or its evidence text');
    // The generic report shape, read after the scope section, points back to it.
    expect(brief).toContain(
      'Only when this brief has a "Controller-owned execution scope" section, also add the top-level scopeEvidence field it shows',
    );
  });

  it('asks only a review for scope evidence', () => {
    expect(scoped('implement')).not.toContain('scopeEvidence');
  });
});
