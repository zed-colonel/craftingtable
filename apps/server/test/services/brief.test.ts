import {
  parseDesignReport,
  parseWorkflowReport,
  reviewReportSchema,
} from '@craftingtable/contracts';
import { describe, expect, it } from 'vitest';
import {
  type BriefInput,
  briefRules,
  citedRunPaths,
  composeBrief,
  RUN_RECORDS,
} from '../../src/services/brief.js';
import { finalizationHasNoQuestions } from '../../src/services/finalization-policy.js';
import { assessReviewReport } from '../../src/services/review-report.js';
import { STEP_RULES } from '../../src/services/step-rules.js';
import { workflowRules } from '../../src/services/workflow-policy.js';

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
    expect(brief).toContain('TMPDIR, TMP, and TEMP point to `/runs/r1/scratch`');
    expect(brief).not.toContain('CARGO_TARGET_DIR');
    expect(brief).not.toContain('Cargo');
  });

  it("names Cargo's build directory for a worktree that builds with Cargo", () => {
    expect(
      composeBrief(briefInput({ temporaryDirectory: '/runs/r1/scratch', cargo: true })),
    ).toContain('CARGO_TARGET_DIR points to this run’s scratch/target build cache');
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
    expect(brief).toContain('CI receipts do not establish external native/Kata qualification');
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
      // Without a rules file the brief ends with the rules it refers to.
      'Rules',
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
      '- `/runs/r1/design-recovery/context.json`, `/runs/r1/design-recovery/manifest.json`: the recovery context; manifest.json lists its 32 sources',
    );
  });

  it('gives paths in the run directory relative to it, once it is named', () => {
    const brief = full({ runDirectory: '/runs/r1' });
    expect(brief).toContain('Your run directory is `/runs/r1`; paths below');
    expect(brief).toContain('TMPDIR, TMP, and TEMP point to `/runs/r1/scratch`');
    expect(brief).toContain('read-only in `plan/`');
    expect(brief).toContain(
      "- `plan/craftingtable-scope-evidence.json`: this scope's readiness and evidence",
    );
    expect(brief).not.toContain('`/runs/r1/plan');
  });

  it('names the rules file instead of ending with the rules, which it holds in full', () => {
    const input = briefInput({
      role: 'review',
      runDirectory: '/runs/r1',
      temporaryDirectory: '/runs/r1/scratch',
      workflow: {},
      cargo: true,
      environment: {
        pinned: {
          manifestPath: '/runs/r1/dependencies/manifest.json',
          binDirectory: '/runs/r1/dependencies/bin',
          verification: { mode: 'scoped-checks', reason: 'A slice.' },
          dependencies: [],
          adoptedChecks: false,
          declaredChecks: '',
          localCiImage: 'ci@sha256:1',
          kata: false,
        },
      },
    });
    const inline = composeBrief(input);
    const rules = briefRules(input)!;
    const brief = composeBrief({ ...input, rulesPath: '/runs/r1/plan/craftingtable-rules.md' });
    // The same rules, in the file or at the end, never both.
    expect(inline).toContain(`## Rules\n\n${rules}`);
    expect(brief).not.toContain('## Rules');
    for (const rule of [
      'Finding IDs start with a letter or digit',
      'Technical review and permission to merge are separate',
      'Do not override supplied sources',
      'CRAFTINGTABLE_DEPENDENCY_MANIFEST',
    ]) {
      expect(rules).toContain(rule);
      expect(brief).not.toContain(rule);
    }
    expect(brief).toContain(
      '- `plan/craftingtable-rules.md`: the rules this brief refers to: read it first',
    );
    expect(brief).toContain(
      'Read the rules for these blocks in `plan/craftingtable-rules.md` before you write them.',
    );
    expect(brief).toContain('Its rules are in `plan/craftingtable-rules.md`.');
    // The block shapes, the order and the build environment's data stay in the brief.
    expect(fenced(brief, 'craftingtable-review')).toHaveLength(1);
    expect(fenced(brief, 'craftingtable-workflow')).toHaveLength(1);
    expect(brief).toContain('Pinned dependency environment: dependencies/manifest.json');
    expect(brief).toContain('run cargo fetch first when dependencies must be downloaded');
  });
});

describe("composeBrief: the parent's final message as a bounded digest (R-G6, G6-2, AGT-53, AGT-57)", () => {
  const handoff = {
    manifestPath: '/runs/r2/handoff/manifest.json',
    finalMessagePath: '/runs/r2/handoff/0000-final.md',
    reportPath: '/runs/r2/handoff/0000-review.json',
    warnings: [],
  };
  const review = [
    'The queue drops a job on restart.',
    '',
    '## Open questions',
    '',
    'none',
    '',
    '## Review report',
    '',
    '```craftingtable-review',
    '{"version":1,"complete":true,"verdict":"changes-requested","exitGate":{"met":false,"evidence":"x"},"findings":[]}',
    '```',
    'VERDICT: changes-requested',
  ].join('\n');
  /** The brief's lines outside fenced blocks. */
  const unfenced = (brief: string) => {
    let fence = '';
    return brief.split('\n').filter((line) => {
      const opener = /^(`{3,})/.exec(line)?.[1];
      if (fence) {
        if (line.startsWith(fence) && line.trim() === fence) fence = '';
        return false;
      }
      if (opener) fence = opener;
      return !opener;
    });
  };

  it("lists a review's findings by id, severity and title, and points to the handoff for the rest", () => {
    const brief = composeBrief(
      briefInput({
        parentRun: {
          role: 'review',
          verdict: 'changes-requested',
          finalMessage: review,
          findings: [
            { id: 'F-001', severity: 'major', status: 'open', title: 'Restart drops a job' },
            { id: 'F-002', severity: 'nit', status: 'resolved', title: 'Typo' },
          ],
          handoff,
        },
      }),
    );
    const section = brief.split(
      '## Review findings to address (verdict: changes-requested)\n\n',
    )[1]!;
    expect(section).toContain('- F-001 (major): Restart drops a job');
    expect(section).toContain('Closed in that report: F-002 (resolved)');
    expect(section).toContain('(each explained in its review report)');
    expect(brief).toContain('its review report `/runs/r2/handoff/0000-review.json`');
    // Not the message itself: its prose, its headings and its verdict line stay in the handoff.
    expect(brief).not.toContain('The queue drops a job on restart.');
    expect(brief).not.toContain('VERDICT: changes-requested');
    expect(unfenced(brief)).not.toContain('## Open questions');
    expect(unfenced(brief)).not.toContain('## Review report');
  });

  it("quotes a bounded opening of an implementation's summary, with its headings demoted and blocks left out", () => {
    const summary = [
      'Committed the fix.',
      '',
      '## Verification',
      '',
      'All checks passed.',
      '',
      '```craftingtable-workflow',
      '{"version":1,"questions":[],"resolved":[],"securityReview":{"required":false,"sources":[]}}',
      '```',
      '',
      '## Open questions',
      '',
      'none',
      '',
      'x'.repeat(5000),
      'The last line.',
    ].join('\n');
    const brief = composeBrief(
      briefInput({
        role: 'review',
        parentRun: { role: 'implement', finalMessage: summary, handoff },
      }),
    );
    const section = brief
      .split("## The implementation run's own summary\n\n")[1]!
      .split('\n## ')[0]!;
    expect(section).toContain('Treat this as a claim to verify, not as evidence.');
    expect(section).toContain('> Committed the fix.');
    expect(section).toContain('> **Verification**');
    expect(section).not.toContain('craftingtable-workflow');
    expect(section).not.toContain('The last line.');
    expect(section).toContain('`/runs/r2/handoff/0000-final.md`');
    expect(Buffer.byteLength(section)).toBeLessThan(2600);
    expect(unfenced(brief)).not.toContain('## Open questions');
  });

  it('quotes an unstructured review, saying its findings are only in its message', () => {
    const brief = composeBrief(
      briefInput({
        parentRun: {
          role: 'review',
          finalMessage: 'F-1: the queue drops a job.\n\nVERDICT: changes-requested',
          reportIssues: ['No structured findings report.'],
          handoff,
        },
      }),
    );
    expect(brief).toContain('No structured findings report.');
    expect(brief).toContain('> F-1: the queue drops a job.');
    expect(unfenced(brief)).not.toContain('VERDICT: changes-requested');
  });

  it('keeps an accepted design whole, fenced so its headings and blocks stay inside it', () => {
    const proposal = [
      'Change queue.ts to hold a ring buffer.',
      '',
      '```craftingtable-design',
      '{"version":1,"items":[]}',
      '```',
      '',
      '## Open questions',
      '',
      'none',
    ].join('\n');
    const brief = composeBrief(
      briefInput({ parentRun: { role: 'design', finalMessage: proposal, handoff } }),
    );
    expect(brief).toContain(`\`\`\`\`markdown\n${proposal}\n\`\`\`\``);
    expect(unfenced(brief)).not.toContain('## Open questions');
  });

  it("marks the message's links into other runs' directories that no longer exist", () => {
    const brief = composeBrief(
      briefInput({
        role: 'review',
        parentRun: {
          role: 'implement',
          finalMessage:
            'Logs: [summary](/runs/r0/scratch/verification/summary.md) and /runs/r2/scratch/kept.md',
          expiredPaths: ['/runs/r0/scratch/verification/summary.md'],
          handoff,
        },
      }),
    );
    expect(brief).toContain('[expired: /runs/r0/scratch/verification/summary.md]');
    expect(brief).toContain('/runs/r2/scratch/kept.md');
  });

  it('finds the paths a message cites under the runs root', () => {
    expect(
      citedRunPaths(
        'See `/runs/r0/scratch/a.md`, [b](/runs/r1/plan/b.json) and /elsewhere/c, /runs/r9.',
        '/runs',
      ),
    ).toEqual(['/runs/r0/scratch/a.md', '/runs/r1/plan/b.json', '/runs/r9']);
    // A line or column after a path is not part of it, so an existing file is not expired.
    expect(citedRunPaths('At /runs/r0/a.rs:12 and /runs/r0/b.rs:3:7.', '/runs')).toEqual([
      '/runs/r0/a.rs',
      '/runs/r0/b.rs',
    ]);
  });

  it('names the handoff files once, and collapses repeated warnings', () => {
    const brief = composeBrief(
      briefInput({
        parentRun: {
          role: 'implement',
          finalMessage: 'Done.',
          handoff: {
            ...handoff,
            warnings: [
              ...Array.from(
                { length: 20 },
                () => 'r1: the agent exited before collecting background work.',
              ),
              'r2: 3 recorded message(s) were already truncated upstream.',
              'r3: no completed turn.',
              'r4: no completed turn either.',
            ],
          },
        },
      }),
    );
    const files = brief.split('## Files to read\n\n')[1]!.split('\n## ')[0]!;
    expect(files).toContain('`/runs/r2/handoff/manifest.json`');
    expect(files).toContain('`/runs/r2/handoff/0000-final.md`');
    expect(brief.split('the agent exited before collecting background work')).toHaveLength(2);
    expect(files).toContain('already truncated upstream');
    expect(files).toContain('Handoff warnings (4 different, all in the manifest)');
    expect(files).not.toContain('r4: no completed turn either.');
  });
});

/**
 * G6-5: a typical brief per role is at most 12 KB, and its goal and acceptance at least 10% of
 * it. The inputs have the shape and sizes of the median live run the snapshot measurement
 * rebuilt (`controller:replay --brief-sizes`), a WI slice's re-review: its obligations and
 * cases, its parent's fields, a 27-document plan bundle, the pinned environment with an adopted
 * check, the workflow contract, a handoff, and the step rules every cycle run gets.
 */
describe('composeBrief size per role (R-G6, G6-5)', () => {
  const run = '/mnt/workhorse/craftingtable/runs/0e2b5a4c-7d1f-4c55-9a8e-3f6b1d2c9e70';
  const sentence = (n: number, words: string) => `${words} `.repeat(n).trim();
  const handoff = {
    manifestPath: `${run}/handoff/manifest.json`,
    finalMessagePath: `${run}/handoff/0000-final.md`,
    reportPath: `${run}/handoff/0000-review.json`,
    warnings: [],
  };
  const review = (status: 'open' | 'resolved') => ({
    role: 'review' as const,
    verdict: 'changes-requested' as const,
    finalMessage: 'x',
    findings: Array.from({ length: 6 }, (_, i) => ({
      id: `F-00${i}`,
      severity: 'major',
      status: i < 3 ? status : 'resolved',
      title: sentence(4, 'A finding title'),
    })),
    handoff,
  });
  const scope = sentence(3, 'Implement the remaining production integration and source PR tests;');
  const typical = (role: BriefInput['role'], parentRun?: BriefInput['parentRun']): BriefInput =>
    briefInput({
      role,
      projectName: 'WorldInterface - WI-FABRIC-2',
      executionScope: {
        identity: {
          kind: 'slice',
          definitionId: '0ebcb7cf-9686-4bc1-9b9d-bb85a1d0b4c9',
          bindingRevision: 4,
          sourceId: 'wi/WI-04/integration',
        },
        title: 'Complete gated integration',
        scope,
        excludes: [sentence(2, 'Legacy adapters or duplicates.'), 'Claiming acceptance.'],
        requirements: [
          ...Array.from({ length: 5 }, (_, i) => sentence(4, `obligation ${i} evidence`)),
          sentence(4, 'Every assigned case has an independently reviewed passing result;'),
          scope,
        ],
        cases: ['AB-WI-002', 'AB-WI-003', 'AB-WI-004'],
      },
      workItem: {
        sourceId: 'wi/WI-04',
        title: 'Implement intent-first egress',
        risk: 'critical',
        primaryAreas: ['effect-admission', 'agency', 'resource-resolution', 'authorization'],
        exitGate: sentence(
          2,
          'Every outbound operation has durable intent and idempotent admission.',
        ),
        sourceFields: {
          id: 'WI-04',
          title: 'Implement intent-first egress, canonical resource resolution and authorization',
          depends_on: ['WI-02'],
          exit_gate: sentence(2, 'Every outbound operation has durable intent and admission.'),
          foundational_additions: [sentence(4, 'acting-capacity aware authorization')],
          aq_baseline_acceptance_cases: ['AB-WI-002', 'AB-WI-003', 'AB-WI-004'],
        },
      },
      worktree: {
        path: '/mnt/workhorse/craftingtable/worktrees/worldinterface/wi-04-15b36285',
        branchName: 'ct/wi-wi-04-integration-15b36285',
        baseBranch: 'wi-fabric-2',
        baseSha: '9e9297289ded1590c14591476566385330e2202c',
        integrationBranch: 'wi-fabric-2',
      },
      ...(role === 'review'
        ? {
            reviewBranchContext: {
              headSha: '80655c43b97ff20249f4a5f36a0f2061f3ef7ab6',
              targetBranch: 'wi-fabric-2',
              targetSha: '6f71472cdb8dc69811ced1868588fcbb66cb0b88',
            } as never,
          }
        : {}),
      runDirectory: run,
      temporaryDirectory: `${run}/scratch`,
      buildCacheDirectory: '/mnt/workhorse/craftingtable/runs/worktree-caches/15b36285-8fa1-4834',
      cargo: true,
      environment: {
        pinned: {
          manifestPath: `${run}/dependencies/manifest.json`,
          binDirectory: `${run}/dependencies/bin`,
          verification: {
            mode: 'current-upstream-build',
            reason: sentence(3, 'Every link moved.'),
          },
          dependencies: [
            {
              alias: 'aq',
              commitSha: '29e096c4f06985d1a9bd9d5fe5a3a6a5db8a6860',
              purpose: 'current-upstream',
              transition: { slice: 'wi/WI-02/integration', recordId: '628bf02c-5c9a-4e10' },
            },
          ],
          adoptedChecks: true,
          declaredChecks: `Adopted repository checks (version 3): ${sentence(6, 'the gate needs each.')}\n- ${run}/dependencies/bin/ct-check --declared fmt   (CraftingTable runs the adopted ["cargo","fmt","--check"]; running that yourself does not count)\n`,
          localCiImage: 'craftingtable-ci@sha256:4593631d9eb27be51f666a4b8e1e05b779a022bb3c6b',
          kata: false,
        },
      },
      planDirectory: `${run}/plan`,
      planDocuments: [
        {
          filename: 'implementation-plan.md',
          role: 'implementation-plan',
          path: `${run}/plan/a.md`,
        },
        { filename: 'work-breakdown.yaml', role: 'work-breakdown', path: `${run}/plan/b.yaml` },
        ...Array.from({ length: 25 }, (_, i) => ({
          filename: `s${i}.md`,
          role: 'supporting',
          path: `${run}/plan/s${i}.md`,
        })),
      ],
      records: (
        [
          'craftingtable-scope-evidence.json',
          'craftingtable-repository-policy.json',
          'craftingtable-operator-decisions.json',
          'craftingtable-controller-obligations.json',
        ] as const
      ).map((name) => ({ path: `${run}/plan/${name}`, about: RUN_RECORDS[name] })),
      workflow: {},
      rulesPath: `${run}/plan/craftingtable-rules.md`,
      controllerInstructions: [
        workflowRules(
          [
            { id: 'WI-ADR-004', accepted: true },
            { id: 'WI-AQ-G2', accepted: false },
          ],
          undefined,
        ),
        STEP_RULES.detach,
        STEP_RULES.automated,
      ].join('\n\n'),
      ...(parentRun ? { parentRun } : {}),
    });
  const goalShare = (brief: string) =>
    Buffer.byteLength(brief.split('\n## Goal and acceptance')[1]!.split('\n## ')[0]!) /
    Buffer.byteLength(brief);

  it.each([
    // A re-review after remediation, the median live run.
    { name: 'review', input: () => typical('review', review('resolved')) },
    { name: 'implement (remediation)', input: () => typical('implement', review('open')) },
    { name: 'design', input: () => typical('design') },
  ])(
    'keeps a typical $name brief at most 12 KB, its goal and acceptance at least 10%',
    ({ input }) => {
      const brief = composeBrief(input());
      expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(12_000);
      expect(goalShare(brief)).toBeGreaterThanOrEqual(0.1);
    },
  );
});

describe('composeBrief: code review fixes (R-G6)', () => {
  const scope = (kind: 'slice' | 'slice-verification' | 'parent-acceptance') =>
    composeBrief(
      briefInput({
        role: 'review',
        executionScope: {
          identity: {
            kind,
            definitionId: '0ebcb7cf-9686-4bc1-9b9d-bb85a1d0b4c9',
            bindingRevision: 1,
            sourceId: kind === 'parent-acceptance' ? 'wi/WI-1' : 'wi/WI-1/domain',
          },
          title: 'Domain',
          scope: 'Build the domain.',
          excludes: [],
          requirements: ['Build the domain.'],
          cases: [],
        },
      }),
    );

  it("tells a slice's verification review it judges the slice, never the parent's exit gate", () => {
    const verification = scope('slice-verification');
    expect(verification).toContain('the verification of a slice of AQ-01');
    expect(verification).toContain('never its parent');
    expect(verification).not.toContain('full original exit gate');
    expect(scope('parent-acceptance')).toContain('the acceptance of AQ-01');
    expect(scope('parent-acceptance')).toContain('full original exit gate');
    expect(scope('slice')).toContain('a slice of AQ-01');
  });

  it('says a pinned current-upstream build is required before merge or acceptance', () => {
    const brief = composeBrief(
      briefInput({
        cargo: true,
        environment: {
          pinned: {
            manifestPath: '/runs/r1/dependencies/manifest.json',
            binDirectory: '/runs/r1/dependencies/bin',
            verification: { mode: 'current-upstream-build', reason: 'Integration scope.' },
            dependencies: [],
            adoptedChecks: false,
            declaredChecks: '',
            kata: false,
          },
        },
      }),
    );
    expect(brief).toContain('required before merge/acceptance');
  });

  it("gives a remediation the review's exit gate when it was not met, even with no open finding", () => {
    const brief = composeBrief(
      briefInput({
        parentRun: {
          role: 'review',
          verdict: 'changes-requested',
          finalMessage: 'x',
          findings: [],
          exitGate: { met: false, evidence: 'The queue tests fail on restart.' },
        },
      }),
    );
    expect(brief).toContain("The review's report has 0 open findings");
    expect(brief).toContain('Its exit gate is not met: The queue tests fail on restart.');
  });

  it('marks an expired path once even when another expired path begins with it', () => {
    const brief = composeBrief(
      briefInput({
        role: 'review',
        parentRun: {
          role: 'implement',
          finalMessage: 'See /runs/A/scratch/review and /runs/A/scratch/review/report.md.',
          expiredPaths: ['/runs/A/scratch/review', '/runs/A/scratch/review/report.md'],
        },
      }),
    );
    expect(brief).toContain(
      'See [expired: /runs/A/scratch/review] and [expired: /runs/A/scratch/review/report.md].',
    );
  });

  it('gives TMPDIR as an absolute path and says the relative paths are not in the worktree', () => {
    const brief = composeBrief(
      briefInput({ runDirectory: '/runs/r1', temporaryDirectory: '/runs/r1/scratch' }),
    );
    expect(brief).toContain('TMPDIR, TMP, and TEMP point to `/runs/r1/scratch`');
    expect(brief).toContain('are inside it, never in the worktree');
  });
});
