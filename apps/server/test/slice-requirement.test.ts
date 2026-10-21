import { randomUUID } from 'node:crypto';
import {
  type AgentRun,
  asAgentRunId,
  asProjectId,
  asWorktreeId,
  type ConcurrencyRequirement,
  type ConcurrencySource,
  type ExecutionScope,
  type Worktree,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scopePhaseBlockers } from '../src/services/execution-scope.js';
import { milestoneMet } from '../src/services/milestone-policy.js';
import { cleanupExecutionFixtures, present, slicedFixture } from './execution-test-support.js';

/**
 * R-B7 scheduler half, increment 1 (characterization; tests only): the slice requirement's
 * satisfaction, written twice (CTRL-14), on one table. `milestoneMet`'s slice branch
 * (`milestone-policy.ts`) and `scopePhaseBlockers`' slice-requirement branch
 * (`execution-scope.ts`) answer whether slice `local/AQ-01/a` is started, merged or verified,
 * and agree on every row of a normal binding. The parent's required-slices check (a third copy
 * of `verified`, `required-slice-unmerged` and `-unverified`) is pinned on the same rows. The one
 * row where the copies differ, a binding revision that does not bind the slice's work item
 * (which the API cannot write), was flipped by R-B7 decision 3 A for the phase gate.
 *
 * The map is the local scope map with a second work item, `local/AQ-02`, whose slice
 * `local/AQ-02/a` must not start before `local/AQ-01/a` is started, merged and verified. Slice
 * a's worktrees, runs, merges and receipts are written into storage by hand. Whether slice
 * evidence is accepted and whether a receipt is current are the evidence policy's own rules
 * (with their own tests): here each row says so through a stub of exactly those two answers,
 * for slice a only, and both copies read the same stub.
 */

afterEach(() => {
  evidence.accepted = false;
  evidence.receiptCurrent = undefined;
  return cleanupExecutionFixtures();
});

const SLICE = 'local/AQ-01/a';
const evidence = vi.hoisted(() => ({
  /** Slice a's evidence is accepted. */
  accepted: false,
  /** Whether slice a's receipts are current; `undefined` asks the policy. */
  receiptCurrent: undefined as boolean | undefined,
}));
vi.mock('../src/services/runtime-evidence-policy.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/services/runtime-evidence-policy.js')>();
  // Each stub finds its subject by shape, not by argument position (review NIT-4), so a rule
  // that passes it elsewhere still reads the row's answer: the evidence subject is the argument
  // with a kind and a source id but no definition (an execution scope has one), and the receipt
  // the argument with a scope and an integration sha. (`SLICE` is not yet defined here.)
  const field = (a: unknown, key: string) =>
    typeof a === 'object' && a !== null && key in a
      ? (a as Record<string, unknown>)[key]
      : undefined;
  const subjectIsSliceA = (args: readonly unknown[]) =>
    args.some(
      (a) =>
        field(a, 'kind') === 'slice' &&
        field(a, 'sourceId') === 'local/AQ-01/a' &&
        field(a, 'definitionId') === undefined,
    );
  const receiptIsSliceA = (args: readonly unknown[]) =>
    args.some(
      (a) =>
        field(a, 'integrationSha') !== undefined &&
        field(field(a, 'scope'), 'sourceId') === 'local/AQ-01/a',
    );
  return {
    ...original,
    acceptedEvidence: (...args: Parameters<typeof original.acceptedEvidence>) =>
      subjectIsSliceA(args)
        ? evidence.accepted
          ? ({ id: 'accepted-slice-evidence' } as unknown as ReturnType<
              typeof original.acceptedEvidence
            >)
          : undefined
        : original.acceptedEvidence(...args),
    currentScopeReceipt: (...args: Parameters<typeof original.currentScopeReceipt>) =>
      receiptIsSliceA(args) && evidence.receiptCurrent !== undefined
        ? evidence.receiptCurrent
        : original.currentScopeReceipt(...args),
  };
});

const STATES = ['started', 'merged', 'verified'] as const;
type State = (typeof STATES)[number];

/** The local map, with `local/AQ-02/a` requiring slice a in each state before it starts. */
const withConsumer = (source: ConcurrencySource): ConcurrencySource => ({
  ...source,
  work_items: [
    ...source.work_items,
    {
      ...source.work_items[0]!,
      id: 'local/AQ-02',
      source_item_id: 'AQ-02',
      planning_order: 2,
      source_exit_gate: 'Done',
      source_profile_case_ids: [],
      depends_on: ['local/AQ-01'],
      required_slices: ['local/AQ-02/a'],
      acceptance_requires: [
        { kind: 'work_item', id: 'local/AQ-01', state: 'accepted' },
        { kind: 'slice', id: 'local/AQ-02/a', state: 'verified' },
      ],
    },
  ],
  slices: [
    ...source.slices,
    {
      ...source.slices[0]!,
      id: 'local/AQ-02/a',
      work_item: 'local/AQ-02',
      title: 'local/AQ-02/a',
      scope: 'Complete local/AQ-02/a',
      start_requires: STATES.map((state) => ({ kind: 'slice' as const, id: SLICE, state })),
    },
  ],
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const f = await slicedFixture(withConsumer);
  const ws = f.state.workspaceId;
  const tx = f.state.context.storage;
  const definitionId = f.parentScope.definitionId;
  const definition = present(tx.imports.definition(ws, definitionId));
  const binding = present(tx.imports.bindings(ws, definitionId).find((b) => b.revision === 1));
  const consumerItem = present(
    binding.bindings.flatMap((b) => b.workItems).find((w) => w.sourceId === 'local/AQ-02'),
  ).workItemId;
  return { ...f, ws, tx, definition, consumerItem };
}

const sliceScope = (f: Fixture, revision = 1): ExecutionScope => ({
  ...f.scopes[0]!,
  bindingRevision: revision,
});
const consumerScope = (f: Fixture, revision = 1): ExecutionScope => ({
  ...f.parentScope,
  kind: 'slice',
  bindingRevision: revision,
  sourceId: 'local/AQ-02/a',
});

/** A worktree of slice a, as a development attempt records it; of `scope` when given. */
function sliceTree(f: Fixture, scope: ExecutionScope = sliceScope(f)): Worktree {
  const id = asWorktreeId(randomUUID());
  return f.tx.execution.worktrees.insert({
    id,
    workspaceId: f.ws,
    repositoryId: f.repository.id,
    projectId: asProjectId('project-1'),
    workItemId: f.state.workItemId,
    branchName: `ct/slice-a-${id.slice(0, 8)}`,
    baseSha: '0'.repeat(40),
    baseBranch: 'main',
    integrationBranch: 'main',
    path: `/nonexistent/slice-a-${id}`,
    createdAt: new Date().toISOString(),
    createdByUserId: f.state.userId,
    executionScope: scope,
  });
}

/** A run in the tree that started. */
function startedRun(f: Fixture, tree: Worktree): AgentRun {
  const id = asAgentRunId(randomUUID());
  f.tx.execution.runs.insert({
    id,
    workspaceId: f.ws,
    worktreeId: tree.id,
    repositoryId: f.repository.id,
    projectId: asProjectId('project-1'),
    workItemId: f.state.workItemId,
    backend: 'claude-code',
    role: 'implement',
    permissionMode: 'auto',
    brief: 'Implement slice a.',
    createdAt: new Date().toISOString(),
    createdByUserId: f.state.userId,
  });
  return present(
    f.tx.execution.runs.transition({
      workspaceId: f.ws,
      runId: id,
      expectedStatuses: ['starting'],
      toStatus: 'running',
      occurredAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    }),
  );
}

const MERGE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

/** The tree's merge into the integration branch at `MERGE_SHA`. */
function integrate(f: Fixture, tree: Worktree): void {
  f.tx.execution.worktrees.markMerged({
    workspaceId: f.ws,
    worktreeId: tree.id,
    occurredAt: new Date().toISOString(),
    mergeSha: MERGE_SHA,
  });
}

/** A scope receipt for the tree's run, at `integrationSha`; slice a's own unless `scope` says. */
function receipt(
  f: Fixture,
  tree: Worktree,
  run: AgentRun,
  integrationSha: string,
  scope: ExecutionScope = sliceScope(f),
): void {
  f.tx.scopeReceipts.add({
    id: randomUUID(),
    workspaceId: f.ws,
    workItemId: f.state.workItemId,
    scope,
    worktreeId: tree.id,
    reviewRunId: run.id,
    headSha: 'c'.repeat(40),
    integrationSha,
    evidence: {
      scope,
      requirements: [{ requirement: 'Tests passed', evidence: 'Recorded.' }],
      caseIds: [],
    },
    recordedAt: new Date().toISOString(),
    recordedByUserId: f.state.userId,
  });
}

/** What each copy answers for slice a in each state. */
function answers(f: Fixture, revision = 1) {
  const blockers = scopePhaseBlockers(
    f.tx,
    f.ws,
    f.consumerItem,
    consumerScope(f, revision),
    'start',
    { resources: false },
  ).filter((b) => b.code === 'slice-requirement');
  const requirement = (state: State): ConcurrencyRequirement => ({
    kind: 'slice',
    id: SLICE,
    state,
  });
  return {
    milestoneMet: Object.fromEntries(
      STATES.map((state) => [
        state,
        milestoneMet(f.tx, f.ws, f.definition, revision, requirement(state)),
      ]),
    ),
    scopePhaseBlockers: Object.fromEntries(
      STATES.map((state) => [
        state,
        !blockers.some(
          (b) => b.message === `Slice ${SLICE} must be ${state}.` && b.refs?.sliceId === SLICE,
        ),
      ]),
    ),
  };
}

/** The parent's required-slices answer for slice a. */
function parentCheck(f: Fixture) {
  return scopePhaseBlockers(f.tx, f.ws, f.state.workItemId, f.parentScope, 'accept', {
    resources: false,
  })
    .filter(
      (b) =>
        ['required-slice-unmerged', 'required-slice-unverified'].includes(b.code) &&
        b.refs?.sliceId === SLICE,
    )
    .map((b) => b.code);
}

/** Slice a's facts, written in order: a tree with a started run, then its merge. */
function developed(f: Fixture, options: { merged?: boolean } = {}) {
  const tree = sliceTree(f);
  const run = startedRun(f, tree);
  if (options.merged) integrate(f, tree);
  return { tree, run };
}

const met = (started: boolean, merged: boolean, verified: boolean) => ({
  started,
  merged,
  verified,
});

describe('the slice requirement, both copies', () => {
  const rows: readonly {
    readonly name: string;
    readonly facts: (f: Fixture) => void;
    readonly expected: ReturnType<typeof met>;
    readonly parent: readonly string[];
  }[] = [
    {
      name: 'no worktree and no run',
      facts: () => {},
      expected: met(false, false, false),
      parent: ['required-slice-unmerged'],
    },
    {
      name: 'a worktree with only a created run',
      facts: (f) => {
        const tree = sliceTree(f);
        f.tx.execution.runs.insert({
          id: asAgentRunId(randomUUID()),
          workspaceId: f.ws,
          worktreeId: tree.id,
          repositoryId: f.repository.id,
          projectId: asProjectId('project-1'),
          workItemId: f.state.workItemId,
          backend: 'claude-code',
          role: 'implement',
          permissionMode: 'auto',
          brief: 'Implement slice a.',
          createdAt: new Date().toISOString(),
          createdByUserId: f.state.userId,
        });
      },
      expected: met(false, false, false),
      parent: ['required-slice-unmerged'],
    },
    {
      name: 'a run started',
      facts: (f) => void developed(f),
      expected: met(true, false, false),
      parent: ['required-slice-unmerged'],
    },
    {
      name: 'an integrated merge',
      facts: (f) => void developed(f, { merged: true }),
      expected: met(true, true, false),
      parent: ['required-slice-unverified'],
    },
    {
      // A merge counts as started without a started run (an operator merged the tree by hand):
      // the R-B7 scheduler half's mutation round found no row that held it.
      name: 'an integrated merge with no started run',
      facts: (f) => integrate(f, sliceTree(f)),
      expected: met(true, true, false),
      parent: ['required-slice-unverified'],
    },
    {
      // R-B7 scheduler half, review LOW-4: only slice a's own trees count. A started run in the
      // parent's acceptance tree (same work item, another scope) does not start the slice.
      name: 'a started run in a tree of another scope of the same work item',
      facts: (f) => void startedRun(f, sliceTree(f, f.parentScope)),
      expected: met(false, false, false),
      parent: ['required-slice-unmerged'],
    },
    {
      name: 'accepted slice evidence, and nothing else',
      facts: () => {
        evidence.accepted = true;
      },
      expected: met(false, false, true),
      parent: ['required-slice-unmerged'],
    },
    {
      name: 'an integrated merge with accepted slice evidence',
      facts: (f) => {
        developed(f, { merged: true });
        evidence.accepted = true;
      },
      expected: met(true, true, true),
      parent: [],
    },
    {
      name: 'a current scope receipt at the integrated merge',
      facts: (f) => {
        const { tree, run } = developed(f, { merged: true });
        receipt(f, tree, run, MERGE_SHA);
        evidence.receiptCurrent = true;
      },
      expected: met(true, true, true),
      parent: [],
    },
    {
      name: 'a current scope receipt at another integration sha',
      facts: (f) => {
        const { tree, run } = developed(f, { merged: true });
        receipt(f, tree, run, OTHER_SHA);
        evidence.receiptCurrent = true;
      },
      expected: met(true, true, false),
      parent: ['required-slice-unverified'],
    },
    {
      // R-B7 scheduler half, review LOW-4: only receipts of slice a's own scope count. A current
      // receipt of the same slice under binding revision 2 (same work item, another scope) at
      // the merge does not verify it.
      name: 'a current receipt of another binding revision at the integrated merge',
      facts: (f) => {
        const { tree, run } = developed(f, { merged: true });
        receipt(f, tree, run, MERGE_SHA, sliceScope(f, 2));
        evidence.receiptCurrent = true;
      },
      expected: met(true, true, false),
      parent: ['required-slice-unverified'],
    },
    {
      name: 'a stale scope receipt at the integrated merge',
      facts: (f) => {
        const { tree, run } = developed(f, { merged: true });
        receipt(f, tree, run, MERGE_SHA);
        evidence.receiptCurrent = false;
      },
      expected: met(true, true, false),
      parent: ['required-slice-unverified'],
    },
    {
      name: 'a current scope receipt with no merge',
      facts: (f) => {
        const { tree, run } = developed(f);
        receipt(f, tree, run, MERGE_SHA);
        evidence.receiptCurrent = true;
      },
      expected: met(true, false, false),
      parent: ['required-slice-unmerged'],
    },
  ];

  it.each(rows)('$name: both copies agree', async ({ facts, expected, parent }) => {
    const f = await fixture();
    facts(f);
    expect(answers(f)).toEqual({ milestoneMet: expected, scopePhaseBlockers: expected });
    expect(parentCheck(f)).toEqual(parent);
  });
});

describe('the slice requirement on a binding that does not bind the slice’s work item', () => {
  /**
   * A binding revision missing `local/AQ-01` (the slice's work item) and keeping `local/AQ-02`.
   * The API cannot write it: `saveBindings` binds every work item of a bound alias, and
   * revisions are immutable; it is written here by hand.
   */
  function unbound(f: Fixture): number {
    const binding = present(
      f.tx.imports.bindings(f.ws, f.definition.id).find((b) => b.revision === 1),
    );
    f.tx.imports.addBindings({
      ...binding,
      revision: 2,
      createdAt: new Date().toISOString(),
      bindings: binding.bindings.map((b) => ({
        ...b,
        workItems: b.workItems.filter((w) => w.sourceId !== 'local/AQ-01'),
      })),
    });
    return 2;
  }

  it('answers not met in both copies without accepted slice evidence', async () => {
    const f = await fixture();
    const revision = unbound(f);
    expect(answers(f, revision)).toEqual({
      milestoneMet: met(false, false, false),
      scopePhaseBlockers: met(false, false, false),
    });
  });

  it('answers not met in both copies with accepted slice evidence too (flipped by R-B7 decision 3 A)', async () => {
    const f = await fixture();
    const revision = unbound(f);
    evidence.accepted = true;
    // R-B7 decision 3 A: one slice-requirement rule with the milestone's answer for a slice whose
    // work item is not in the binding; before, the phase gate counted accepted slice evidence as
    // verified there.
    expect(answers(f, revision)).toEqual({
      milestoneMet: met(false, false, false),
      scopePhaseBlockers: met(false, false, false),
    });
  });
});
