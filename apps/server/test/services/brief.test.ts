import {
  parseDesignReport,
  parseWorkflowReport,
  reviewReportSchema,
} from '@craftingtable/contracts';
import { describe, expect, it } from 'vitest';
import { type BriefInput, composeBrief } from '../../src/services/brief.js';
import { finalizationHasNoQuestions } from '../../src/services/finalization-policy.js';
import { assessReviewReport } from '../../src/services/review-report.js';

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
        },
      }),
    );

  // LIVE-32: three reviews wrote scopeEvidence inside exitGate.evidence, so the report had none.
  it('shows scopeEvidence as a top-level field of the one report example', () => {
    const brief = scoped('review');
    const [shape, ...more] = fenced(brief, 'craftingtable-review');
    expect(more).toEqual([]);
    const parsed = reviewReportSchema.safeParse(JSON.parse(shape ?? 'null'));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.scopeEvidence).toMatchObject({ scope: identity, caseIds: ['EE-001'] });
    expect(brief).toContain('never inside exitGate or its evidence text');
    expect(brief).toContain('with the obligation’s text copied exactly as its requirement');
  });

  it('asks only a review for scope evidence', () => {
    expect(scoped('implement')).not.toContain('scopeEvidence');
  });
});

/** The bodies of the brief's fenced blocks in one language. */
function fenced(brief: string, language: string): string[] {
  return [...brief.matchAll(new RegExp(`^\`\`\`${language}\n([\\s\\S]*?)^\`\`\``, 'gm'))].map(
    (match) => match[1]!.trim(),
  );
}

/** The brief's final-message parts, in order. */
function finalMessageParts(brief: string): string[] {
  const section = brief.split('## Your final message\n\n')[1]?.split('\n## ')[0] ?? '';
  return [...section.matchAll(/^\d+\. (.*)$/gm)].map((match) => match[1]!);
}

describe('composeBrief output contracts, one module per role (R-G6, AGT-54)', () => {
  const scope = {
    identity: {
      kind: 'slice',
      definitionId: '0ebcb7cf-9686-4bc1-9b9d-bb85a1d0b4c9',
      bindingRevision: 1,
      sourceId: 'wi/WI-1/domain',
    },
    title: 'Domain',
    scope: 'Build the domain.',
    excludes: [],
    requirements: ['Build the domain.'],
    cases: ['C-1'],
  } as const;
  const blocks = ['craftingtable-review', 'craftingtable-workflow', 'craftingtable-design'];
  const count = (brief: string) =>
    Object.fromEntries(blocks.map((block) => [block, fenced(brief, block).length]));

  it('asks a cycle review for each block once, in one order its parsers accept', () => {
    const brief = composeBrief(
      briefInput({
        role: 'review',
        executionScope: scope,
        workflow: {},
        finalizationStage: { id: 'correctness', fullChecks: false },
      }),
    );
    expect(count(brief)).toEqual({
      'craftingtable-review': 1,
      'craftingtable-workflow': 1,
      'craftingtable-design': 0,
    });
    const parts = finalMessageParts(brief);
    const at = (text: string) => parts.findIndex((part) => part.includes(text));
    expect(at('`craftingtable-workflow`')).toBeGreaterThan(-1);
    expect(at('`craftingtable-workflow`')).toBeLessThan(at('`## Open questions`'));
    expect(at('`## Open questions`')).toBeLessThan(at('`## Review report`'));
    expect(at('`## Review report`')).toBeLessThan(at('VERDICT: mergeable'));
    expect(at('VERDICT: mergeable')).toBe(parts.length - 1);
    // A message built in that order from the brief's own examples is accepted.
    const report = JSON.parse(fenced(brief, 'craftingtable-review')[0]!);
    report.scopeEvidence.requirements = [{ requirement: 'Build the domain.', evidence: 'ok' }];
    report.finalization = {
      stageId: 'correctness',
      fullChecks: false,
      checks: [{ name: 'tests', status: 'passed', evidence: 'pnpm test' }],
      obligations: [],
    };
    const message = [
      'Conclusion.',
      `\`\`\`craftingtable-workflow\n${fenced(brief, 'craftingtable-workflow')[0]}\n\`\`\``,
      '## Open questions\n\nnone',
      `## Review report\n\n\`\`\`craftingtable-review\n${JSON.stringify(report)}\n\`\`\``,
      'VERDICT: changes-requested',
    ].join('\n\n');
    expect(assessReviewReport(message)).toMatchObject({ status: 'complete' });
    expect(parseWorkflowReport(message).status).toBe('complete');
    expect(finalizationHasNoQuestions(message)).toBe(true);
  });

  it('asks a design for its design block, then the workflow block, then Open questions', () => {
    const brief = composeBrief(
      briefInput({ role: 'design', workflow: {}, architectureDecisions: true }),
    );
    expect(count(brief)).toEqual({
      'craftingtable-review': 0,
      'craftingtable-workflow': 1,
      'craftingtable-design': 1,
    });
    // AGT-54: it said both blocks go "immediately before" Open questions.
    expect(brief).not.toContain('Immediately before');
    const parts = finalMessageParts(brief);
    expect(parts.map((part) => /`(craftingtable-\w+|## Open questions)`/.exec(part)?.[1])).toEqual([
      undefined,
      'craftingtable-design',
      'craftingtable-workflow',
      '## Open questions',
    ]);
    expect(
      parseDesignReport(
        `\`\`\`craftingtable-design\n${fenced(brief, 'craftingtable-design')[0]}\n\`\`\``,
      ).status,
    ).toBe('complete');
    expect(brief).toContain('decision:{checkpointId:');
  });

  it("gives a design the decision proposal's shape only where the map has architecture checkpoints", () => {
    expect(composeBrief(briefInput({ role: 'design' }))).not.toContain('decision:{checkpointId:');
  });

  it('tells an implementation nothing of review reports or verdicts', () => {
    const brief = composeBrief(briefInput({ role: 'implement', workflow: {} }));
    expect(count(brief)).toEqual({
      'craftingtable-review': 0,
      'craftingtable-workflow': 1,
      'craftingtable-design': 0,
    });
    expect(brief).not.toContain('VERDICT');
    expect(brief).not.toContain('review report');
    expect(finalMessageParts(brief).at(-1)).toContain('`## Open questions`');
  });

  it('adds a checkpoint attestation to the workflow block of a checkpoint review', () => {
    const brief = composeBrief(
      briefInput({ role: 'review', workflow: { checkpointId: 'WI-AQ-G3' } }),
    );
    expect(brief).toContain('Add checkpoint:{id:"WI-AQ-G3",passed:boolean');
  });

  it('ends an integration resolution with its status and an investigation with its block', () => {
    const resolution = composeBrief(briefInput({ resolvingIntegration: true, workflow: {} }));
    expect(finalMessageParts(resolution).at(-1)).toContain('`## Resolution status`');
    expect(count(resolution)['craftingtable-workflow']).toBe(0);
    const investigation = composeBrief(briefInput({ role: 'design', investigation: true }));
    expect(fenced(investigation, 'craftingtable-investigation')).toHaveLength(1);
    expect(investigation).not.toContain('craftingtable-design');
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

describe('composeBrief skeleton: the task first (R-G6, AGT-50, AGT-58)', () => {
  const headings = (brief: string) => [...brief.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
  const scope = {
    identity: {
      kind: 'slice',
      definitionId: '0ebcb7cf-9686-4bc1-9b9d-bb85a1d0b4c9',
      bindingRevision: 4,
      sourceId: 'wi/WI-03/integration',
    },
    title: 'Complete gated integration',
    scope: 'Implement the remaining production integration and all source PR tests.',
    excludes: ['Legacy adapters.'],
    requirements: [
      'candidate and merged implementation revision',
      'Implement the remaining production integration and all source PR tests.',
    ],
    cases: ['AB-WI-006'],
  } as const;
  const full = (overrides: Partial<BriefInput> = {}) =>
    composeBrief(
      briefInput({
        role: 'review',
        temporaryDirectory: '/runs/r1/scratch',
        planDirectory: '/runs/r1/plan',
        planDocuments: [
          { filename: 'plan.md', role: 'implementation-plan', path: '/runs/r1/plan/plan.md' },
          ...Array.from({ length: 12 }, (_, i) => ({
            filename: `notes-${i}.md`,
            role: 'supporting',
            path: `/runs/r1/plan/notes-${i}.md`,
          })),
        ],
        records: [
          {
            path: '/runs/r1/plan/craftingtable-scope-evidence.json',
            about: "this scope's readiness and evidence",
          },
        ],
        controllerInstructions: 'Do not merge.',
        instructions: 'Keep the API.',
        stepGuidance: 'Rerun the failing check.',
        ...overrides,
      }),
    );

  it('puts goal and acceptance first, then where the agent is, its role, files, rules and the operator', () => {
    expect(headings(full())).toEqual([
      'Goal and acceptance',
      'Where you are',
      'Your role',
      'Your final message',
      'Files to read',
      'Step rules (from the controller)',
      'Operator instructions',
      'Operator guidance for this step',
    ]);
  });

  it('states a scope once, with what is excluded, the evidence required and the cases', () => {
    const brief = full({ executionScope: scope });
    const goal = brief.split('## Goal and acceptance\n\n')[1]!.split('\n## ')[0]!;
    expect(goal).toContain('This run covers only wi/WI-03/integration, a slice of AQ-01.');
    expect(goal.split(scope.scope)).toHaveLength(2);
    expect(brief.split(scope.scope)).toHaveLength(2);
    expect(goal).toContain('- Legacy adapters.');
    expect(goal).toContain('- candidate and merged implementation revision');
    expect(goal).toContain('- The Scope line above, word for word.');
    expect(goal).toContain('Assigned cases: AB-WI-006');
    expect(goal).toContain("The parent's exit gate");
    expect(goal).toContain('Queue accepts and drains one job.');
    // AGT-58: internal identifiers stay in the evidence file.
    expect(brief).not.toContain('gateInterpretation');
    expect(brief).not.toContain('Exit gate: Implement the remaining');
  });

  it('lists the plan bundle as one directory and names each of CraftingTable’s records', () => {
    const brief = full();
    expect(brief).toContain('`/runs/r1/plan/`');
    expect(brief).toContain('implementation plan `plan.md`');
    expect(brief).toContain('12 supporting documents');
    expect(brief).not.toContain('/runs/r1/plan/notes-0.md');
    expect(brief).toContain(
      "- `/runs/r1/plan/craftingtable-scope-evidence.json`: this scope's readiness and evidence",
    );
  });

  it('names a small bundle’s documents and a supplied directory’s files', () => {
    const brief = full({
      planDocuments: [
        { filename: 'plan.md', role: 'implementation-plan', path: '/runs/r1/plan/plan.md' },
        { filename: 'notes.md', role: 'supporting', path: '/runs/r1/plan/notes.md' },
      ],
      directories: [
        {
          path: '/runs/r1/design-recovery',
          files: ['context.json', 'manifest.json'],
          about: 'the recovery context; manifest.json lists its 32 sources',
        },
      ],
    });
    expect(brief).toContain('implementation plan `plan.md`, supporting `notes.md`');
    expect(brief).toContain(
      '- `/runs/r1/design-recovery/`: `design-recovery/context.json`, `design-recovery/manifest.json`; the recovery context; manifest.json lists its 32 sources',
    );
  });

  it('gives the repository policy rules only with the policy file', () => {
    expect(full()).not.toContain('Repository policy:');
    expect(full({ repositoryPolicyGuidance: 'Repository policy: read it.' })).toContain(
      'Repository policy: read it.',
    );
  });
});
