import type { CraftingTableStorage } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { rebuildBrief, replayBriefSizes } from '../src/brief-size-replay.js';
import { STEP_RULES } from '../src/services/step-rules.js';
import {
  cleanupExecutionFixtures,
  fixtureRepository,
  ready,
  registerAndWorktree,
  runToFinish,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

it('reads the runs since a moment through storage, oldest first, as stored (R-I7)', async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const first = await runToFinish(state, worktree.id, { instructions: 'First run.' });
  const second = await runToFinish(state, worktree.id, { instructions: 'Second run.' });
  const runs = state.context.storage.execution.runs;
  const all = runs.listBriefsSince('1970-01-01T00:00:00.000Z');
  expect(all.map((run) => run.id)).toEqual([first, second]);
  expect(all[1]).toMatchObject({ workspaceId: state.workspaceId, worktreeId: worktree.id });
  expect(all[1]?.brief).toContain('Second run.');
  const since = runs.find(state.workspaceId, second)?.createdAt as string;
  expect(runs.listBriefsSince(since).map((run) => run.id)).toEqual([second]);
  // The replay reads them the same way: each run is rebuilt or named as skipped.
  const report = replayBriefSizes(state.context.storage, since);
  expect([
    ...report.runs.map((run) => run.runId),
    ...report.skipped.map((run) => run.runId),
  ]).toEqual([second]);
});

/**
 * The brief-size replay (R-G6, G6-5) rebuilds a stored brief from its own inputs with today's
 * code. This one is in the format the daemon wrote before R-G6: a manual-plan review with the
 * workflow contract, the pinned environment, plan documents and the old step rules.
 */
const run = '/runs/9f0c';
const stored = `# Work item AQ-01: Queue accepts jobs

Project: ActionQueue
Role: review

## Repository policy and operator decisions

Read craftingtable-repository-policy.json before interpreting branch protection.

## Your role

You are an independent reviewer for this work item.

## Findings continuity

Reconcile ALL findings.

## Objective and exit gate

Exit gate: Queue accepts and drains one job.

Risk: low
Primary areas: queue, storage

## Dependencies

Required predecessors:
- AQ-00: Bootstrap (completed)

Recommended predecessors:
- none

## Working environment

You are in a dedicated Git worktree at \`/worktrees/aq-01\` on branch \`ct/aq-01-abcd\`,
created from \`main\` at \`0123456789abcdef0123456789abcdef01234567\`.
This is the only place you may change files. The primary checkout and other worktrees
of this repository are off limits.

Review baseline: item commit aaaa; integration branch main at bbbb. Verify this combined state and report the checks you ran. Do not move either branch during review.

## Temporary files

TMPDIR, TMP, and TEMP point to ${run}/scratch. Use this controller-owned directory.

## Plan documents

The plan bundle this work item came from is available read-only at these paths.
Read the parts that concern this work item before starting.

- implementation-plan: \`${run}/plan/plan.md\`
- supporting: \`${run}/plan/notes.md\`
- supporting: \`${run}/plan/craftingtable-repository-policy.json\`

## Source definition

Every field of this work item as written in the plan:

\`\`\`json
{
  "id": "AQ-01"
}
\`\`\`

## Step rules (from the controller)

Controller workflow contract: technical candidate review and permission to merge are separate.
Before ## Open questions, include exactly one fenced craftingtable-workflow JSON block:
Current controller obligations (required states are not successful evidence): {"checkpoints":[{"id":"AQ-G1","accepted":false}]}

Keep verification commands owned by the agent session. Do not use nohup, disown, or setsid to detach work. Wait for background commands to finish, collect their results, and stop any monitors you started before emitting the final outcome.

This run is one step of an operator-authorized automated cycle. Do not merge. Complete this step and provide a final message; the controller handles the next step.

## Operator instructions

Keep the public API.


Pinned dependency environment: ${run}/dependencies/manifest.json

Verification policy: scoped-checks. A domain slice.
Upstream sources, chosen per link by the roadmap's declared transitions:
- wi: historical development source 0123456789ab
Build against exactly these sources.
Use the controller Cargo launcher ${run}/dependencies/bin/cargo for Cargo checks (also supplied on PATH).
Local CI: not configured; use ct-check and the supplied Cargo launcher for local checks. Rust 1.89.
`;

it('rebuilds a stored brief from its own inputs with the current code (R-G6, G6-5)', () => {
  const storage = {
    execution: { worktrees: { find: () => undefined } },
  } as unknown as CraftingTableStorage;
  const after = rebuildBrief(storage, {
    id: 'r1',
    workspace_id: 'w1',
    role: 'review',
    brief: stored,
    worktree_id: 't1',
    work_item_id: 'i1',
    parent_run_id: null,
  });
  // The task, from the stored brief, first.
  expect(after).toMatch(/^# Work item AQ-01: Queue accepts jobs\n/);
  expect(after.split('\n## ')[1]).toMatch(/^Goal and acceptance\n\nExit gate: Queue accepts/);
  expect(after).toContain('Predecessors: required AQ-00: Bootstrap (completed); recommended none.');
  // Paths in the run directory, relative to it; the policy file as a record.
  expect(after).toContain(`Your run directory is \`${run}\``);
  expect(after).toContain(
    'read-only in `plan/`: implementation plan `plan.md`, supporting `notes.md`',
  );
  expect(after).toContain('- `plan/craftingtable-repository-policy.json`:');
  // The step rules: the workflow contract as the new code writes it, its JSON in a record, the
  // reworded rules, and the operator's words as they were.
  expect(after).toContain('The checkpoints its merge requires: AQ-G1 (not accepted).');
  expect(after).not.toContain('Current controller obligations');
  expect(after).not.toContain('Before ## Open questions');
  expect(after).toContain(STEP_RULES.detach);
  expect(after).toContain(STEP_RULES.automated);
  expect(after).toContain('## Operator instructions\n\nKeep the public API.');
  // The environment, from the old trailer's data.
  expect(after).toContain('Pinned dependency environment: dependencies/manifest.json');
  expect(after).toContain('- wi: historical development source 0123456789ab');
  expect(after).not.toContain('Rust 1.89');
  // The review's final message, from the role module, with the workflow block.
  expect(after).toContain('One fenced `craftingtable-workflow` block');
  expect(after).toContain('`plan/craftingtable-rules.md`');
});

it("rebuilds a checkpoint review's workflow rules with its checkpoint's whole id (R-G6 review)", () => {
  const storage = {
    execution: { worktrees: { find: () => undefined } },
  } as unknown as CraftingTableStorage;
  const checkpoint = stored.replace(
    '{"checkpoints":[{"id":"AQ-G1","accepted":false}]}\n',
    '{"checkpoints":[{"id":"AQ-11.CP-2","accepted":false}]}\nThis is a separate checkpoint review. Source run: r0. Responsibilities: maintainer. Read the full lineage and verify the exact candidate without source edits. Independently assess checkpoint AQ-11.CP-2. Add checkpoint:{id:"AQ-11.CP-2",passed:boolean} to the workflow report. Required claims: ["Claim one."]. Required cases: ["C-1"]. Never infer a passing case from eligibility or a plan hash.\n',
  );
  const after = rebuildBrief(storage, {
    id: 'r1',
    workspace_id: 'w1',
    role: 'review',
    brief: checkpoint,
    worktree_id: 't1',
    work_item_id: 'i1',
    parent_run_id: null,
  });
  expect(after).toContain('Independently assess checkpoint AQ-11.CP-2 and attest it');
  expect(after).toContain('Required claims: ["Claim one."]. Required cases: ["C-1"].');
  expect(after).toContain('Add checkpoint:{id:"AQ-11.CP-2",passed:boolean');
});

it('keeps the build environment of a stored brief without step rules (R-G6 review L1)', () => {
  const storage = {
    execution: { worktrees: { find: () => undefined } },
  } as unknown as CraftingTableStorage;
  const start = stored.indexOf('\n## Step rules');
  const end = stored.indexOf('\n\nPinned dependency environment:');
  const after = rebuildBrief(storage, {
    id: 'r1',
    workspace_id: 'w1',
    role: 'review',
    brief: stored.slice(0, start) + stored.slice(end),
    worktree_id: 't1',
    work_item_id: 'i1',
    parent_run_id: null,
  });
  expect(after).toContain('Pinned dependency environment: dependencies/manifest.json');
});

it('leaves out, with its reason, a stored brief whose pinned environment it cannot parse (R-G6 re-check R2)', () => {
  const storage = {
    execution: { worktrees: { find: () => undefined } },
  } as unknown as CraftingTableStorage;
  // The trailer joined to the operator's section by one newline instead of a blank line.
  const damaged = stored.replace(
    '\n\n\nPinned dependency environment: ',
    '\nPinned dependency environment: ',
  );
  expect(damaged).not.toBe(stored);
  expect(() =>
    rebuildBrief(storage, {
      id: 'r1',
      workspace_id: 'w1',
      role: 'review',
      brief: damaged,
      worktree_id: 't1',
      work_item_id: 'i1',
      parent_run_id: null,
    }),
  ).toThrow('its pinned environment was not parsed');
});
