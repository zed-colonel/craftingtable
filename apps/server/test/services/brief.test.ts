import { reviewReportSchema } from '@craftingtable/contracts';
import { describe, expect, it } from 'vitest';
import { type BriefInput, composeBrief } from '../../src/services/brief.js';

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

describe('composeBrief build environment (R-F2 part 6, AGT-55)', () => {
  const pinned = (kata: boolean) =>
    ({
      manifestPath: '/runs/r1/dependencies/manifest.json',
      binDirectory: '/runs/r1/dependencies/bin',
      verification: { mode: 'current-upstream-build', reason: 'Integration scope.' },
      dependencies: [
        { alias: 'aq', commitSha: '29e096c4f06985d1a9bd', purpose: 'current-upstream' },
      ],
      adoptedChecks: false,
      declaredChecks: '',
      localCiImage: 'craftingtable-ci@sha256:4593',
      nativeApprovalId: 'approval-1',
      kata,
    }) as const;

  it('says nothing of Cargo in a worktree that does not build with it', () => {
    const brief = composeBrief(briefInput({ temporaryDirectory: '/runs/r1/scratch' }));
    expect(brief).toContain('TMPDIR, TMP, and TEMP point to /runs/r1/scratch');
    expect(brief).not.toContain('CARGO_TARGET_DIR');
    expect(brief).not.toContain('Cargo');
  });

  it("names Cargo's build directory for a worktree that builds with Cargo", () => {
    expect(
      composeBrief(briefInput({ temporaryDirectory: '/runs/r1/scratch', cargo: true })),
    ).toContain('CARGO_TARGET_DIR points to this run’s scratch/target build cache.');
  });

  it('renders the pinned environment from its data, under its own heading', () => {
    const brief = composeBrief(
      briefInput({
        temporaryDirectory: '/runs/r1/scratch',
        buildCacheDirectory: '/runs/worktree-caches/w1',
        cargo: true,
        environment: { pinned: pinned(false) },
      }),
    );
    expect(brief).toContain(
      '## Build environment\n\nPinned dependency environment: /runs/r1/dependencies/manifest.json',
    );
    expect(brief).toContain('Use the controller Cargo launcher /runs/r1/dependencies/bin/cargo');
    expect(brief).toContain('- aq: current pin 29e096c4f069');
    // LIVE-26's wording, in both places that speak of the build directory.
    expect(brief).toContain(
      "Builds and checks CraftingTable runs for you (the Cargo launcher's builds, ct-check, ct-act, ct-native) use a build directory CraftingTable chooses",
    );
    expect(brief).toContain(
      'The supplied Cargo launcher and CraftingTable’s checks use their own build directories instead',
    );
    // R-G14: builds have no network, so dependencies are fetched first.
    expect(brief).toContain('run cargo fetch first when dependencies must be downloaded');
    expect(brief).toContain('Local CI: configured with image craftingtable-ci@sha256:4593.');
    // No stale incident note, no toolchain version the daemon does not know, no Kata.
    expect(brief).not.toContain('Earlier reports describing rejection');
    expect(brief).not.toContain('Rust 1.89');
    expect(brief).not.toMatch(/kata/i);
  });

  it('speaks of Kata only for a scope with Kata cases', () => {
    const brief = composeBrief(briefInput({ cargo: true, environment: { pinned: pinned(true) } }));
    expect(brief).toContain('Do not use live service credentials or claim Kata observations');
    expect(brief).toContain('CI receipts do not establish external native/Kata qualification.');
  });
});
