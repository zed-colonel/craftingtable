import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDeclarationPreviewSchema,
  checkDefinitionDiagnosisSchema,
  repositoryCheckReceiptsSchema,
} from '@craftingtable/contracts';
import { CHECK_DECLARATION_PATH } from '@craftingtable/domain';
import { afterEach, expect, vi } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  currentCycle,
  designDone,
  git,
  implementationDone,
  itNeedsCargo,
  mutationHeaders,
  roadmapControl,
  runLauncher,
  scopeReport,
  scopeTree,
  slicedFixture,
  startCycle,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';
import { CheckAdoptionRequiredError } from './services/errors.js';

/**
 * R-G13 increment 5 (operator decision 2026-09-30): a slice that changes a declared check's
 * definition, or the checks file, is merged only by a person who approves the definitions
 * shown with the merge, and that approval adopts them at the merge commit. LIVE-30: a stop
 * says whether the slice or its integration branch changed the definition.
 */

afterEach(cleanupExecutionFixtures);

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ADOPTED = '#!/bin/sh\necho adopted check\n';
const IMPROVED = '#!/bin/sh\necho improved check\n';
const checksFile = (ids: readonly string[]) =>
  `${JSON.stringify({ version: 1, checks: ids.map((id) => ({ id, argv: ['scripts/check.sh'] })) })}\n`;

/** Commits files onto a branch through a scratch worktree, as the operator would. */
function commitOnBranch(root: string, branch: string, files: Record<string, string>) {
  if (git(['branch', '--show-current'], root).trim() === branch) {
    writeFiles(root, files);
    git(['add', '--all'], root);
    git(['commit', '--no-gpg-sign', '-m', 'checks'], root);
    return git(['rev-parse', 'HEAD'], root).trim();
  }
  const scratch = mkdtempSync(join(tmpdir(), 'ct-adoption-branch-'));
  rmSync(scratch, { recursive: true });
  git(['worktree', 'add', scratch, branch], root);
  try {
    writeFiles(scratch, files);
    git(['add', '--all'], scratch);
    git(['commit', '--no-gpg-sign', '-m', 'checks'], scratch);
    return git(['rev-parse', 'HEAD'], scratch).trim();
  } finally {
    git(['worktree', 'remove', '--force', scratch], root);
  }
}

function writeFiles(cwd: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
    if (path.endsWith('.sh')) chmodSync(join(cwd, path), 0o755);
  }
}

/**
 * A scoped implementation slice whose integration branch carries a checks file and its script,
 * adopted from `adoptFrom` (default: the integration branch's head). `slice` is what the
 * implementing agent commits.
 */
async function adoptionFixture(
  slice: Record<string, string>,
  options: { adoptFrom?: (root: string, integration: string) => string } = {},
) {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s) => ({ ...s, mode: 'implementation' })),
    work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
  }));
  const ws = f.state.workspaceId;
  const storage = f.state.context.storage;
  const root = f.repository.rootPath;
  const integration = storage.execution.branchSettings
    .list()
    .find((s) => s.repositoryId === f.repository.id)!.integrationBranch;
  const head = commitOnBranch(root, integration, {
    [CHECK_DECLARATION_PATH]: checksFile(['script']),
    'scripts/check.sh': ADOPTED,
  });
  const ref = options.adoptFrom?.(root, integration) ?? integration;
  const checks = f.state.context.services.repositoryChecksService;
  const preview = await checks.preview(f.auth, ws, f.repository.id, ref);
  await checks.adopt(f.auth, ws, f.repository.id, {
    ref,
    expectedCommit: preview.commitSha,
    rationale: 'The integration branch proposes these checks.',
  });
  const svc = f.state.context.services.runtimeEvidenceService;
  await svc.configure(f.auth, ws, f.parentScope.definitionId, {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [],
    consumers: [{ alias: 'local', upstreams: [] }],
    environments: [
      {
        id: 'local',
        kind: 'local-development' as const,
        identityDigest: '1'.repeat(64),
        fixtureDigest: '2'.repeat(64),
        toolchainDigest: '3'.repeat(64),
        authorization: 'Local development checks',
      },
    ],
  });
  const tree = await scopeTree(f, f.scopes[0]!);
  f.backend.replyForRequest = async (request) => {
    if (request.model === 'design-model') return designDone;
    if (request.model !== 'review-model') {
      writeFiles(request.cwd, { 'slice.txt': 'slice implementation\n', ...slice });
      git(['add', '--all'], request.cwd);
      git(['commit', '--no-gpg-sign', '-m', 'slice'], request.cwd);
      return implementationDone;
    }
    // The daemon has already run the adopted checks before the reviewer (increment 3).
    return {
      resultText: `## Open questions\nnone\n\n## Review report\n${scopeReport(f.state, tree.executionScope!)}`,
    };
  };
  const merge = (payload: object = {}) =>
    f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/worktrees/${tree.id}/merge`,
      headers: mutationHeaders(f.state),
      payload,
    });
  const definitions = async () => {
    const response = await f.state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}/worktrees/${tree.id}/check-definitions`,
      headers: { cookie: f.state.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return checkDefinitionDiagnosisSchema.parse(response.json());
  };
  const declarations = () => storage.runtimeEvidence.checkDeclarations(ws, f.repository.id);
  return { f, ws, storage, root, integration, head, tree, merge, definitions, declarations };
}

async function runToMergeApproval(x: Awaited<ReturnType<typeof adoptionFixture>>) {
  const cycle = await startCycle(x.f.state, x.tree.id);
  await waitFor(
    () => {
      const current = currentCycle(x.f.state, cycle);
      if (current.status === 'needs-attention') throw new Error(current.reason);
      return current.status === 'awaiting-merge';
    },
    'merge approval',
    25000,
  );
  return currentCycle(x.f.state, cycle);
}

itNeedsCargo(
  "a slice that changes its check's script is merged only with the operator's approval of the definitions, which adopts them at the merge commit",
  { timeout: 40000 },
  async () => {
    const x = await adoptionFixture({ 'scripts/check.sh': IMPROVED });
    const cycle = await runToMergeApproval(x);
    // Not a stop: a merge for a person, who sees the definitions with it.
    expect(cycle.attention).toMatchObject({
      code: 'merge-approval',
      owner: 'operator',
      refs: { repositoryId: x.tree.repositoryId },
    });
    expect(cycle.reason).toContain('approving its merge adopts them');
    const gates = await x.f.state.context.services.executionService.workItemExecution(
      x.f.auth,
      x.ws,
      x.f.state.workItemId,
    );
    expect(gates.mergeGates[x.tree.id]).toMatchObject({
      mergeable: true,
      reason: 'check-adoption',
    });

    const diagnosis = await x.definitions();
    expect(diagnosis).toMatchObject({
      sliceChanged: ['scripts/check.sh'],
      targetDiffers: [],
      declaration: { version: 1, sourceCommit: x.head },
    });
    expect(diagnosis.merge).toMatchObject({
      unchanged: false,
      issues: [],
      checks: [],
      definitions: [
        {
          path: 'scripts/check.sh',
          adopted: { digest: sha(ADOPTED), text: ADOPTED },
          proposed: { digest: sha(IMPROVED), text: IMPROVED },
        },
      ],
    });
    const digest = diagnosis.merge!.proposalDigest!;

    // Without the approval, or with another proposal's, the merge is refused.
    const bare = await x.merge();
    expect(bare.statusCode, bare.body).toBe(409);
    expect(bare.body).toContain('Review them and approve adopting them with the merge');
    const stale = await x.merge({
      adoptChecks: { proposalDigest: '0'.repeat(64), rationale: 'x' },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.body).toContain('changed since they were shown');
    expect(x.declarations()).toHaveLength(1);

    const merged = await x.merge({
      adoptChecks: { proposalDigest: digest, rationale: 'The slice improves the check.' },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    const mergeSha = (merged.json() as { mergeSha: string }).mergeSha;
    const [latest] = x.declarations();
    const operation = x.storage.execution.merges.latest(x.ws, x.tree.id)!;
    expect(latest).toMatchObject({
      version: 2,
      sourceCommit: mergeSha,
      definitionDigests: { 'scripts/check.sh': sha(IMPROVED) },
      rationale: 'The slice improves the check.',
      adoptedByUserId: x.f.state.userId,
      adoptedAtMerge: {
        operationId: operation.id,
        worktreeId: x.tree.id,
        reviewRunId: cycle.currentRunId,
      },
    });
    expect(operation.checkAdoption).toEqual({
      proposalDigest: digest,
      rationale: 'The slice improves the check.',
    });
    expect(git(['show', `${mergeSha}:scripts/check.sh`], x.root)).toBe(IMPROVED);
    const audit = x.storage.audit
      .listWorkspace({ workspaceId: x.ws, limit: 500 })
      .find((e) => e.action === 'repository-checks.adopted');
    expect(audit).toMatchObject({
      outcome: 'succeeded',
      actorUserId: x.f.state.userId,
      metadata: { via: 'merge', operationId: operation.id, version: 2, sourceCommit: mergeSha },
    });
  },
);

itNeedsCargo(
  'a slice that changes only the checks file is adopted at its merge too',
  { timeout: 40000 },
  async () => {
    const x = await adoptionFixture({ [CHECK_DECLARATION_PATH]: checksFile(['script', 'again']) });
    const cycle = await runToMergeApproval(x);
    expect(cycle.attention?.refs).toEqual({ repositoryId: x.tree.repositoryId });
    const diagnosis = await x.definitions();
    expect(diagnosis.sliceChanged).toEqual([CHECK_DECLARATION_PATH]);
    expect(diagnosis.merge).toMatchObject({
      checks: [{ id: 'again', change: 'added' }],
      definitions: [],
    });
    const merged = await x.merge({
      adoptChecks: { proposalDigest: diagnosis.merge!.proposalDigest!, rationale: 'One more.' },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(x.declarations()[0]!.checks.map((c) => c.id)).toEqual(['script', 'again']);
  },
);

itNeedsCargo(
  'a slice whose merge cannot adopt its checks file stops at approval, saying so',
  { timeout: 40000 },
  async () => {
    const x = await adoptionFixture({ [CHECK_DECLARATION_PATH]: '{"version": 1, "checks": []}\n' });
    const cycle = await startCycle(x.f.state, x.tree.id);
    await waitFor(
      () => currentCycle(x.f.state, cycle).status === 'needs-attention',
      'definition stop',
      25000,
    );
    const stopped = currentCycle(x.f.state, cycle);
    expect(stopped.attention).toMatchObject({ code: 'check-definition-changed' });
    expect(stopped.reason).toContain(
      `This slice changes ${CHECK_DECLARATION_PATH}, and its merge cannot adopt the change:`,
    );
    expect(x.declarations()).toHaveLength(1);
  },
);

itNeedsCargo(
  'LIVE-30: checks adopted from a branch behind the integration branch stop the slice, and the stop says the slice did not change them',
  { timeout: 40000 },
  async () => {
    let stale = '';
    const x = await adoptionFixture(
      {},
      {
        adoptFrom: (root, integration) => {
          // The checks are adopted from a side branch; the integration branch then changes the
          // script, as WI-05 did.
          git(['branch', 'craftingtable/checks', integration], root);
          stale = git(['rev-parse', 'craftingtable/checks'], root).trim();
          commitOnBranch(root, integration, { 'scripts/check.sh': IMPROVED });
          return 'craftingtable/checks';
        },
      },
    );
    // The preview warns about both.
    const preview = checkDeclarationPreviewSchema.parse(
      await x.f.state.context.services.repositoryChecksService.preview(
        x.f.auth,
        x.ws,
        x.tree.repositoryId,
        'craftingtable/checks',
      ),
    );
    expect(preview.branches).toEqual([
      expect.objectContaining({
        branch: x.integration,
        contains: true,
        differing: ['scripts/check.sh'],
      }),
    ]);
    expect(preview.warnings.join(' ')).toContain(
      `scripts/check.sh differs at the head of ${x.integration}`,
    );

    const cycle = await startCycle(x.f.state, x.tree.id);
    await waitFor(
      () => currentCycle(x.f.state, cycle).status === 'needs-attention',
      'definition stop',
      25000,
    );
    const stopped = currentCycle(x.f.state, cycle);
    expect(stopped.attention).toMatchObject({ code: 'check-definition-changed' });
    expect(stopped.reason).toContain(
      `This slice did not change scripts/check.sh: adoption version 1 (from ${stale.slice(0, 12)}) differs from what it carries from ${x.integration}`,
    );
    expect(stopped.reason).not.toContain('revert');
    const diagnosis = await x.definitions();
    expect(diagnosis).toMatchObject({ sliceChanged: [], targetDiffers: ['scripts/check.sh'] });
    expect(diagnosis.merge).toBeUndefined();
  },
);

itNeedsCargo(
  'a commit on a side branch is not on the integration branch, and adoption warns',
  { timeout: 20000 },
  async () => {
    const x = await adoptionFixture({});
    git(['branch', 'side', x.integration], x.root);
    commitOnBranch(x.root, 'side', { 'other.txt': 'other\n' });
    const preview = await x.f.state.context.services.repositoryChecksService.preview(
      x.f.auth,
      x.ws,
      x.tree.repositoryId,
      'side',
    );
    expect(preview.branches).toEqual([
      expect.objectContaining({ branch: x.integration, contains: false, differing: [] }),
    ]);
    expect(preview.warnings.join(' ')).toContain(`side is not on ${x.integration}`);
  },
);

itNeedsCargo(
  'a roadmap never merges a slice that adopts definitions, and an adoption the merge commit does not propose is not recorded',
  { timeout: 40000 },
  async () => {
    const x = await adoptionFixture({ 'scripts/check.sh': IMPROVED });
    await runToMergeApproval(x);
    const digest = (await x.definitions()).merge!.proposalDigest!;
    // A delegated (roadmap) merge is refused, whatever it carries.
    await expect(
      x.f.state.context.services.executionService.mergeWorktree(
        x.f.auth,
        x.ws,
        x.tree.id,
        { adoptChecks: { proposalDigest: digest, rationale: 'x' } },
        undefined,
        {
          roadmapId: '00000000-0000-4000-8000-000000000001',
          definitionRevision: 1,
          check: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(CheckAdoptionRequiredError);
    expect(x.storage.execution.merges.latest(x.ws, x.tree.id)).toBeUndefined();

    // The merge commit is read again; one that proposes something else adopts nothing.
    const checks = x.f.state.context.services.repositoryChecksService;
    const real = checks.proposalAt.bind(checks);
    vi.spyOn(checks, 'proposalAt').mockImplementation(async (repository, at, ref) => {
      const proposal = await real(repository, at, ref);
      return ref.startsWith('merge ')
        ? { ...proposal, checks: [...proposal.checks, { ...proposal.checks[0]!, id: 'planted' }] }
        : proposal;
    });
    const merged = await x.merge({ adoptChecks: { proposalDigest: digest, rationale: 'x' } });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(x.declarations()).toHaveLength(1);
    expect(
      x.storage.audit
        .listWorkspace({ workspaceId: x.ws, limit: 500 })
        .find((e) => e.action === 'repository-checks.adopted'),
    ).toMatchObject({
      outcome: 'failed',
      metadata: {
        via: 'merge',
        reason: 'The merge commit proposes other checks than the operator approved.',
      },
    });
  },
);

itNeedsCargo(
  'an approval that names an adoption is refused when the merge adopts nothing',
  { timeout: 40000 },
  async () => {
    const x = await adoptionFixture({});
    const cycle = await runToMergeApproval(x);
    expect(cycle.attention?.refs).toBeUndefined();
    const refused = await x.merge({
      adoptChecks: { proposalDigest: '0'.repeat(64), rationale: 'Nothing to adopt.' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain('has nothing to adopt');
    expect((await x.merge()).statusCode).toBe(200);
    expect(x.declarations()).toHaveLength(1);
  },
);

itNeedsCargo(
  "a roadmap that merges automatically leaves a slice that changes a check's definition to a person, whose approval adopts it",
  { timeout: 60000 },
  async () => {
    const f = await supervisedMapFixture();
    const { state } = f;
    const ws = state.workspaceId;
    const storage = state.context.storage;
    const root = f.repository.rootPath;
    const integration = storage.execution.branchSettings
      .list()
      .find((s) => s.repositoryId === f.repository.id)!.integrationBranch;
    commitOnBranch(root, integration, {
      [CHECK_DECLARATION_PATH]: checksFile(['script']),
      'scripts/check.sh': ADOPTED,
    });
    const checks = state.context.services.repositoryChecksService;
    const preview = await checks.preview(f.auth, ws, f.repository.id, integration);
    await checks.adopt(f.auth, ws, f.repository.id, {
      ref: integration,
      expectedCommit: preview.commitSha,
      rationale: 'The integration branch proposes these checks.',
    });
    f.backend.replyForRequest = async (request) => {
      if (request.model === 'design-model') return designDone;
      const tree = storage.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      if (request.model === 'review-model')
        return {
          resultText:
            '## Open questions\nnone\n## Review report\n' +
            scopeReport({ ...state, workItemId: tree.workItemId! }, tree.executionScope!),
        };
      writeFiles(request.cwd, { 'scripts/check.sh': IMPROVED });
      git(['add', '--all'], request.cwd);
      git(['commit', '--no-gpg-sign', '-m', 'slice'], request.cwd);
      return implementationDone;
    };
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    expect((await roadmapControl(state, 'start')).statusCode).toBe(200);
    const sliceTree = () =>
      storage.execution.worktrees
        .listForWorkItem(ws, state.workItemId)
        .find((t) => t.executionScope?.kind === 'slice')!;
    await waitFor(
      () => {
        const tree = sliceTree();
        const cycle = tree && storage.execution.cycles.activeForWorktree(ws, tree.id);
        if (cycle?.status === 'needs-attention') throw new Error(cycle.reason);
        return cycle?.status === 'awaiting-merge';
      },
      'merge approval',
      40000,
    );
    const tree = sliceTree();
    // Several controller passes later the roadmap has not merged it, and the stop is the
    // operator's, not claimed by the roadmap.
    for (let i = 0; i < 3; i += 1) await state.context.services.workCycleService.tick();
    await state.context.services.roadmapService.tick();
    expect(storage.execution.worktrees.find(ws, tree.id)?.mergedAt).toBeUndefined();
    expect(storage.execution.cycles.activeForWorktree(ws, tree.id)?.attention).toEqual({
      code: 'merge-approval',
      owner: 'operator',
      refs: { repositoryId: f.repository.id },
    });
    // A slice approved before this rule carries no such attention: the roadmap's merge is
    // refused, and the merge becomes the operator's instead of a hold.
    const approved = storage.execution.cycles.activeForWorktree(ws, tree.id)!;
    expect(
      storage.execution.cycles.replace(
        { ...approved, attention: { code: 'merge-approval', owner: 'operator' } },
        approved.version,
      ),
    ).toBeDefined();
    await state.context.services.roadmapService.tick();
    expect(storage.execution.worktrees.find(ws, tree.id)?.mergedAt).toBeUndefined();
    expect(storage.execution.merges.latest(ws, tree.id)).toBeUndefined();
    expect(storage.execution.cycles.activeForWorktree(ws, tree.id)?.attention?.refs).toEqual({
      repositoryId: f.repository.id,
    });
    expect(
      Object.values(storedRoadmap(state).entryHolds ?? {}).filter(
        (h) => h.status === 'needs-attention',
      ),
    ).toEqual([]);
    const response = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}/worktrees/${tree.id}/check-definitions`,
      headers: { cookie: state.cookie },
    });
    const diagnosis = checkDefinitionDiagnosisSchema.parse(response.json());
    const merged = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/worktrees/${tree.id}/merge`,
      headers: mutationHeaders(state),
      payload: {
        adoptChecks: { proposalDigest: diagnosis.merge!.proposalDigest!, rationale: 'Better.' },
      },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(
      storage.runtimeEvidence.checkDeclarations(ws, f.repository.id)[0]!.definitionDigests,
    ).toEqual({ 'scripts/check.sh': sha(IMPROVED) });
  },
);

itNeedsCargo(
  "the Checks panel's receipts say which ran an adopted check and who asked, and trust a requester only where the daemon recorded the receipt",
  { timeout: 40000 },
  async () => {
    const x = await adoptionFixture({});
    const review = x.f.backend.replyForRequest!;
    x.f.backend.replyForRequest = async (request) => {
      // The reviewer runs a check of its own choosing as well.
      if (request.model === 'review-model') await runLauncher(request, 'ct-check', ['--', 'true']);
      return review(request);
    };
    const cycle = await runToMergeApproval(x);
    const read = async () => {
      const response = await x.f.state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${x.ws}/repositories/${x.tree.repositoryId}/checks/receipts`,
        headers: { cookie: x.f.state.cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      return repositoryCheckReceiptsSchema.parse(response.json());
    };
    const reviewRun = (await read()).runs.find((r) => r.runId === cycle.currentRunId)!;
    expect(reviewRun).toMatchObject({
      role: 'review',
      recordedBy: 'daemon',
      declarationVersion: 1,
    });
    expect(reviewRun.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'declared',
          checkId: 'script',
          declarationVersion: 1,
          command: 'ct-check --declared script',
          requestedBy: 'daemon',
          success: true,
          definitions: 'adopted',
        }),
        expect.objectContaining({
          kind: 'supplemental',
          requestedBy: 'agent',
          command: expect.stringContaining('true'),
        }),
      ]),
    );

    // A run that wrote its own receipt file could claim any requester: it is unknown.
    const storage = x.storage.runtimeEvidence;
    const env = storage.run(x.ws, cycle.currentRunId!)!;
    const build = storage.build(x.ws, cycle.currentRunId!)!;
    vi.spyOn(storage, 'run').mockImplementation((_ws, id) => {
      const { receiptAuthority: _, ...legacy } = env;
      return id === cycle.currentRunId ? legacy : undefined;
    });
    vi.spyOn(storage, 'build').mockImplementation((_ws, id) =>
      id === cycle.currentRunId
        ? {
            ...build,
            receipts: `${JSON.stringify({ kind: 'scoped-check', origin: 'daemon', command: 'true', args: [], success: true, clean: true, headSha: 'a'.repeat(40) })}\n`,
          }
        : undefined,
    );
    expect((await read()).runs).toEqual([
      expect.objectContaining({
        runId: cycle.currentRunId,
        recordedBy: 'run',
        receipts: [expect.objectContaining({ kind: 'supplemental', requestedBy: 'unknown' })],
      }),
    ]);
  },
);
