import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerSourceRepositoryResponseSchema } from '@craftingtable/contracts';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveScope, scopeCases, scopeRequirements } from './services/execution-scope.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  cleanupExecutionFixtures,
  commitFile,
  currentCycle,
  declareFixtureChecks,
  expectedScopeEvidence,
  expectScopeCases,
  fixtureRepository,
  git,
  HOST_CARGO,
  HOST_GIT,
  itNeedsCargo,
  merge,
  mutationHeaders,
  runLauncher,
  runToFinish,
  scopeKey,
  scopeReport,
  scopeTree,
  slicedFixture,
  startCycle,
  waitFor,
  withoutDaemonChecks,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

async function checkpointCandidateFixture(
  // A current-upstream scope: a pinned Cargo build establishes it (ADR-053), with every adopted
  // check the daemon runs (R-G13 increment 2).
  check: (request: import('@craftingtable/agents').AgentLaunchRequest) => unknown = async (
    request,
  ) => {
    await runLauncher(request, 'cargo', ['check', '--offline', '--locked']);
    await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
  },
  declare = true,
  review = true,
  /** Whether the daemon runs the adopted checks before the review (R-G13 increment 3). */
  daemonChecks = true,
) {
  const f = await slicedFixture((source) => ({
    ...source,
    work_items: source.work_items.map((w) => ({
      ...w,
      repository: 'local',
      aq_baseline_case_ids: ['BASE-A', 'BASE-B'],
    })),
    checkpoints: [
      ...source.checkpoints,
      {
        ...source.checkpoints[0]!,
        id: 'CORE-G1',
        kind: 'contract',
        owner: 'local',
        requires: [],
        decision_refs: [],
        evidence_profile: 'contract-checkpoint',
        pass_criteria: ['Core replay passes'],
      },
    ],
    evidence_profiles: [
      ...source.evidence_profiles,
      {
        id: 'contract-checkpoint',
        required_evidence: ['Exact core tests'],
        reviewer_roles: ['provider-maintainer', 'consumer-maintainer'],
        independence_required: true,
      },
    ],
    baseline_acceptance_coverage: source.slices.map((slice, index) => ({
      id: index === 0 ? 'BASE-A' : 'BASE-B',
      // Provenance: sealLocalMap binds the case to its source document.
      source_id: '',
      source_record_sha256: '',
      owner_work_item: 'local/AQ-01',
      producing_slice: slice.id,
      capability_gate: 'CORE-G1',
      status_on_import: 'unresolved',
    })),
    slices: source.slices.map((slice, index) => ({
      ...slice,
      mode: 'implementation',
      aq_baseline_case_ids: [index === 0 ? 'BASE-A' : 'BASE-B'],
      merge_requires: [{ kind: 'checkpoint', id: 'CORE-G1', state: 'passed' }],
    })),
  }));
  // Each slice's map entry names its baseline case.
  // Slice a also produces the base map's CASE-PARENT.
  expectScopeCases(f.state, {
    'slice local/AQ-01/a': ['BASE-A', 'CASE-PARENT'],
    'slice local/AQ-01/b': ['BASE-B'],
  });
  const svc = f.state.context.services.runtimeEvidenceService;
  const config = {
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
  };
  if (declare) declareFixtureChecks(f.state);
  await svc.configure(f.auth, f.state.workspaceId, f.parentScope.definitionId, config);
  writeFileSync(
    join(f.root, 'Cargo.toml'),
    '[package]\nname="ct_candidate"\nversion="0.1.0"\nedition="2021"\n[lib]\npath="lib.rs"\n',
  );
  writeFileSync(join(f.root, 'lib.rs'), 'pub fn core() -> u32 { 1 }\n');
  execFileSync(HOST_CARGO as string, ['generate-lockfile', '--offline'], { cwd: f.root });
  git(['add', '.'], f.root);
  git(['commit', '-m', 'candidate crate'], f.root);
  const tree = await scopeTree(f, f.scopes[0]!);
  commitFile(tree.path, 'candidate.txt', 'reviewed core');
  const base = `/api/workspaces/${f.state.workspaceId}/concurrency-definitions/${f.parentScope.definitionId}/runtime`;
  if (!daemonChecks) withoutDaemonChecks(f.state);
  if (!review) return { ...f, svc, tree, run: undefined, base, config };
  f.backend.replyForRequest = async (request) => {
    await check(request);
    return {
      resultText:
        '## Open questions\nnone\n\n## Review report\n' +
        scopeReport(f.state, tree.executionScope!),
    };
  };
  const run = await runToFinish(f.state, tree.id, { role: 'review' });
  expect(
    f.state.context.storage.runtimeEvidence.build(f.state.workspaceId, run)?.error,
  ).toBeUndefined();
  return { ...f, svc, tree, run, base, config };
}
itNeedsCargo(
  'prepares candidate checkpoint evidence, retains later slice cases and permits only its reviewed merge',
  async () => {
    const f = await checkpointCandidateFixture(),
      ws = f.state.workspaceId,
      id = f.parentScope.definitionId;
    const { acceptedEvidence } = await import('./services/runtime-evidence-policy.js');
    const { checkpointRecoverySchema } = await import('@craftingtable/contracts');
    const tx = f.state.context.storage;
    expect((await merge(f.state, f.tree.id)).statusCode).toBe(409);
    const previewResponse = await f.state.context.app.inject({
      method: 'GET',
      url: `${f.base}/checkpoint-recovery/${f.tree.id}`,
      headers: { cookie: f.state.cookie },
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = checkpointRecoverySchema.parse(previewResponse.json()).candidates[0]!;
    expect(preview.issues).toEqual([]);
    expect(preview.cases.map((c) => c.id)).toEqual(['BASE-A']);
    expect(preview.laterCases).toEqual([{ id: 'BASE-B', sliceId: 'local/AQ-01/b' }]);
    const input = {
      worktreeId: f.tree.id,
      checkpointId: 'CORE-G1',
      snapshotDigest: preview.snapshotDigest,
    };
    expect(
      (
        await f.state.context.app.inject({
          method: 'POST',
          url: `${f.base}/prepare-checkpoint`,
          headers: { cookie: f.state.cookie },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    const prepared = await f.svc.prepareCheckpoint(f.auth, ws, id, input);
    const submission = prepared.candidates[0]!.submission!;
    expect(submission.candidateCheckpoint?.headSha).toBe(
      git(['rev-parse', 'HEAD'], f.tree.path).trim(),
    );
    expect(submission.reviewers).toEqual([]);
    expect(tx.runtimeEvidence.decisions(ws)).toHaveLength(0);
    const acceptance = {
      submissionId: submission.id,
      outcome: 'accepted' as const,
      rationale: 'Reviewed the saved tests and core obligations.',
    };
    await expect(f.svc.decide(f.auth, ws, id, acceptance)).rejects.toThrow(
      'every required reviewer responsibility',
    );
    await f.svc.decide(f.auth, ws, id, {
      ...acceptance,
      checkpointReviewRoles: preview.reviewerRoles,
    });
    const subject = { kind: 'checkpoint' as const, sourceId: 'CORE-G1' };
    expect(acceptedEvidence(tx, ws, id, 1, subject)).toBeUndefined();
    expect(acceptedEvidence(tx, ws, id, 1, subject, new Set(), f.scopes[0])).toBeDefined();
    expect(acceptedEvidence(tx, ws, id, 1, subject, new Set(), f.scopes[1])).toBeUndefined();
    const landed = await merge(f.state, f.tree.id);
    expect(landed.statusCode, landed.body).toBe(200);
    expect(acceptedEvidence(tx, ws, id, 1, subject)).toBeDefined();
    await expect(f.svc.assertSubjectsCurrent(ws, id, 1, [subject])).resolves.toBeUndefined();
    expect(tx.scopeReceipts.list(ws, f.state.workItemId)).toHaveLength(0);
    expect(tx.planning.workItems.find(ws, f.state.workItemId)?.status).toBe('admitted');
    const resolvedB = resolveScope(tx, ws, f.state.workItemId, f.scopes[1]!);
    expect(scopeCases(resolvedB)).toContain('BASE-B');
    commitFile(f.root, 'later-integration.txt', 'a changed integration candidate');
    await expect(f.svc.assertSubjectsCurrent(ws, id, 1, [subject])).rejects.toThrow(
      'Integration changed',
    );
  },
);
itNeedsCargo(
  'a checkpoint candidate needs the receipt kind its verification mode requires (R-G4)',
  async () => {
    // A current-upstream review whose only receipt is local CI: CI is supplemental (ADR-053).
    const f = await checkpointCandidateFixture((request) => {
      const raw = readFileSync(
        join(request.buildEnvironment!.binDirectory, '../manifest.json'),
        'utf8',
      );
      const m = JSON.parse(raw) as import('@craftingtable/agents').PinnedCargoManifest;
      expect(m.verification?.mode).toBe('current-upstream-build');
      appendFileSync(
        m.receiptPath,
        `${JSON.stringify({
          kind: 'local-ci',
          runtimeId: m.runtimeId,
          runId: m.runId,
          manifestDigest: createHash('sha256').update(raw).digest('hex'),
          verificationMode: m.verification?.mode,
          headSha: git(['rev-parse', 'HEAD'], request.cwd).trim(),
          clean: true,
          success: true,
        })}\n`,
      );
    });
    const { checkpointRecoverySchema } = await import('@craftingtable/contracts');
    const preview = await f.state.context.app.inject({
      method: 'GET',
      url: `${f.base}/checkpoint-recovery/${f.tree.id}`,
      headers: { cookie: f.state.cookie },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(checkpointRecoverySchema.parse(preview.json()).candidates[0]!.issues).toContain(
      'The checkpoint needs a successful controller receipt on the exact clean candidate.',
    );
  },
);
itNeedsCargo.each([
  ['a pinned build alone', 'cargo', 'The checkpoint needs a successful run of each declared check'],
  [
    'the adopted checks alone',
    'declared',
    'The checkpoint needs a successful controller receipt on the exact clean candidate.',
  ],
] as const)(
  'a current-upstream candidate needs every adopted check and a pinned build: %s does not do (R-G13 increment 2)',
  async (_label, only, issue) => {
    // What the agent ran alone: the daemon's runs before a review are tested on their own.
    const f = await checkpointCandidateFixture(
      (request) =>
        only === 'cargo'
          ? runLauncher(request, 'cargo', ['check', '--offline', '--locked'])
          : runLauncher(request, 'ct-check', ['--declared', 'fixture']),
      true,
      true,
      false,
    );
    const { checkpointRecoverySchema } = await import('@craftingtable/contracts');
    const preview = await f.state.context.app.inject({
      method: 'GET',
      url: `${f.base}/checkpoint-recovery/${f.tree.id}`,
      headers: { cookie: f.state.cookie },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const issues = checkpointRecoverySchema.parse(preview.json()).candidates[0]!.issues;
    expect(issues.some((i) => i.startsWith(issue))).toBe(true);
    // The review gate holds a run to its adopted checks even with no pinned upstream to build.
    if (only === 'cargo')
      expect(() => f.svc.assertRun(f.tree, f.run!)).toThrow('ct-check --declared fixture');
  },
);
itNeedsCargo(
  'a current-upstream slice in a repository with no adopted checks does not run (R-G13 increment 2, fail closed)',
  async () => {
    const f = await checkpointCandidateFixture(undefined, false, false);
    const cycle = await startCycle(f.state, f.tree.id);
    await waitFor(() => currentCycle(f.state, cycle).status === 'needs-attention', 'check stop');
    expect(currentCycle(f.state, cycle).attention).toMatchObject({
      code: 'repository-checks-undeclared',
      refs: { repositoryId: f.tree.repositoryId },
    });
    expect(f.backend.launches).toHaveLength(0);
  },
);
itNeedsCargo.each(['candidate', 'integration', 'dirty', 'run', 'runtime'] as const)(
  'rejects checkpoint acceptance after %s drift',
  async (change) => {
    const f = await checkpointCandidateFixture(),
      ws = f.state.workspaceId,
      id = f.parentScope.definitionId;
    const p = (await f.svc.checkpointRecovery(f.auth, ws, id, f.tree.id)).candidates[0]!;
    const prepared = await f.svc.prepareCheckpoint(f.auth, ws, id, {
      worktreeId: f.tree.id,
      checkpointId: p.checkpointId,
      snapshotDigest: p.snapshotDigest,
    });
    if (change === 'candidate') commitFile(f.tree.path, 'changed.txt', 'after review');
    if (change === 'integration') commitFile(f.root, 'changed.txt', 'after review');
    if (change === 'dirty') writeFileSync(join(f.tree.path, 'untracked.txt'), 'after review');
    if (change === 'run') await runToFinish(f.state, f.tree.id, { role: 'review' });
    if (change === 'runtime')
      await f.svc.configure(f.auth, ws, id, {
        ...f.config,
        expectedGeneration: 1,
        environments: f.config.environments.map((e) => ({ ...e, fixtureDigest: 'f'.repeat(64) })),
      });
    await expect(
      f.svc.decide(f.auth, ws, id, {
        submissionId: prepared.candidates[0]!.submission!.id,
        outcome: 'accepted',
        rationale: 'Reviewed',
        checkpointReviewRoles: p.reviewerRoles,
      }),
    ).rejects.toThrow();
    expect(f.state.context.storage.runtimeEvidence.decisions(ws)).toHaveLength(0);
  },
);

async function evidenceFixture(checkpointOwner = 'local') {
  const f = await slicedFixture((source) => ({
    ...source,
    work_items: source.work_items.map((w) => ({
      ...w,
      source_profile_case_ids: [...w.source_profile_case_ids, 'CASE-LOCAL'],
    })),
    checkpoints: [
      ...source.checkpoints,
      {
        ...source.checkpoints[0]!,
        id: 'LOCAL-QUALIFIED',
        kind: 'contract',
        owner: checkpointOwner,
        requires: [],
        decision_refs: [],
        evidence_profile: 'scope-review',
        pass_criteria: ['Exact source tested'],
      },
      {
        ...source.checkpoints[0]!,
        id: 'LOCAL-PUBLISHED',
        kind: 'release',
        owner: checkpointOwner,
        requires: [{ kind: 'checkpoint', id: 'LOCAL-QUALIFIED', state: 'passed' }],
        decision_refs: [],
        evidence_profile: 'scope-review',
        pass_criteria: ['Publication retrieved'],
      },
    ],
    acceptance_coverage: [
      ...source.acceptance_coverage,
      {
        id: 'CASE-LOCAL',
        source_id: '',
        source_record_sha256: '',
        owner_work_item: 'local/AQ-01',
        producing_slices: ['local/AQ-01/a'],
        checkpoint: 'LOCAL-QUALIFIED',
        requires_kata_host: true,
        evidence_status_on_import: 'unresolved',
      },
    ],
  }));
  const svc = f.state.context.services.runtimeEvidenceService,
    definitionId = f.parentScope.definitionId;
  const input = {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [],
    consumers: [{ alias: 'local', upstreams: [] }],
    environments: [
      {
        id: 'native',
        kind: 'external-native' as const,
        identityDigest: '1'.repeat(64),
        fixtureDigest: '2'.repeat(64),
        toolchainDigest: '3'.repeat(64),
        authorization: 'Local fixture operator authorizes isolated test fixtures.',
      },
      {
        id: 'kata',
        kind: 'external-kata' as const,
        identityDigest: '4'.repeat(64),
        fixtureDigest: '2'.repeat(64),
        toolchainDigest: '3'.repeat(64),
        authorization: 'Operator authorizes this actual Kata host and VM.',
      },
    ],
  };
  declareFixtureChecks(f.state);
  const view = await svc.configure(f.auth, f.state.workspaceId, definitionId, input);
  const spec = view.subjects.find((s) => s.subject.sourceId === 'LOCAL-QUALIFIED')!;
  const head = execFileSync(HOST_GIT, ['rev-parse', 'HEAD'], {
    cwd: f.root,
    encoding: 'utf8',
  }).trim();
  const submission: import('@craftingtable/contracts').EvidenceSubmissionRequest = {
    runtimeId: view.current!.id,
    subject: spec.subject,
    subjectCommit: head,
    environmentId: 'kata',
    executedBy: 'implementation-author',
    executedAt: new Date().toISOString(),
    reviewers: [
      { identity: 'independent-reviewer', roles: spec.reviewerRoles, artifact: 'review' },
    ],
    requirements: spec.requirements.map((requirement) => ({ requirement, artifact: 'log' })),
    cases: spec.cases.map((c) => ({
      id: c.id,
      sourceRecordDigest: c.sourceRecordDigest,
      result: 'passed',
      artifact: 'log',
    })),
    artifacts: [
      { name: 'log', content: 'actual host/VM observations and passing case output' },
      {
        name: 'review',
        content: 'Independent reviewer examined source and reproduced the required case.',
      },
    ],
    kata: {
      runtime: 'kata',
      hostIdentity: 'test-host',
      vmIdentity: 'test-vm',
      imageDigest: '5'.repeat(64),
      configurationDigest: '6'.repeat(64),
      observationArtifact: 'log',
      noNativeFallback: true,
    },
  };
  return { ...f, svc, definitionId, input, view, submission };
}
it('requires independently reviewed exact case coverage and distinguishes native from actual Kata', async () => {
  const f = await evidenceFixture(),
    ws = f.state.workspaceId;
  const submit = (input: import('@craftingtable/contracts').EvidenceSubmissionRequest) =>
    f.svc.submit(f.auth, ws, f.definitionId, input);
  await expect(submit({ ...f.submission, cases: [] })).rejects.toThrow('CASE-LOCAL');
  await expect(
    submit({ ...f.submission, cases: [...f.submission.cases, ...f.submission.cases] }),
  ).rejects.toThrow('Duplicate case');
  await expect(
    submit({
      ...f.submission,
      cases: f.submission.cases.map((c) => ({ ...c, sourceRecordDigest: 'a'.repeat(64) })),
    }),
  ).rejects.toThrow('exact source record');
  await expect(submit({ ...f.submission, executedBy: 'independent-reviewer' })).rejects.toThrow(
    'independent review',
  );
  const { kata: _kata, ...native } = f.submission;
  await expect(submit({ ...native, environmentId: 'native' })).rejects.toThrow('Actual Kata');
  const submitted = await submit(f.submission);
  const s = submitted.submissions[0]!;
  expect(s.decision).toBeUndefined();
  const accepted = await f.svc.decide(f.auth, ws, f.definitionId, {
    submissionId: s.submission.id,
    outcome: 'accepted',
    rationale: 'Examined attached verification and independent review.',
  });
  expect(accepted.submissions[0]?.decision?.outcome).toBe('accepted');
  expect(accepted.subjects.find((s) => s.subject.sourceId === 'LOCAL-PUBLISHED')?.issues).toEqual(
    [],
  );
  // Eligibility is not a publication pass. An identical generation retains exact qualification inputs.
  expect(
    accepted.submissions.some((s) => s.submission.subject.sourceId === 'LOCAL-PUBLISHED'),
  ).toBe(false);
  const revised = await f.svc.configure(f.auth, ws, f.definitionId, {
    ...f.input,
    expectedGeneration: 1,
  });
  expect(revised.submissions[0]?.decision?.outcome).toBe('accepted');
  expect(revised.submissions[0]?.issues).toEqual([]);
  const changed = await f.svc.configure(f.auth, ws, f.definitionId, {
    ...f.input,
    expectedGeneration: 2,
    environments: f.input.environments.map((e) =>
      e.id === 'kata' ? { ...e, fixtureDigest: 'f'.repeat(64) } : e,
    ),
  });
  expect(changed.submissions[0]?.issues.join(' ')).toContain('Environment, fixture');
  expect(
    changed.subjects.find((s) => s.subject.sourceId === 'LOCAL-PUBLISHED')?.issues.join(' '),
  ).toContain('LOCAL-QUALIFIED');
  await expect(
    f.svc.decide(f.auth, ws, f.definitionId, {
      submissionId: s.submission.id,
      outcome: 'accepted',
      rationale: 'Retry stale record.',
    }),
  ).rejects.toThrow('Environment, fixture');
});
it('lists submissions without their bodies and reads a full record on demand (R-H4, LIVE-29)', async () => {
  const f = await evidenceFixture(),
    ws = f.state.workspaceId;
  await f.svc.submit(f.auth, ws, f.definitionId, f.submission);
  const [stored] = f.state.context.storage.runtimeEvidence.submissions(ws, f.definitionId);
  const base = `/api/workspaces/${ws}/concurrency-definitions/${f.definitionId}/runtime`;
  const get = (url: string) =>
    f.state.context.app.inject({ method: 'GET', url, headers: { cookie: f.state.cookie } });
  const view = await get(base);
  expect(view.statusCode, view.body).toBe(200);
  const listed = view.json().submissions[0].submission;
  expect(listed.artifacts).toEqual(
    stored!.artifacts.map((a) => ({
      name: a.name,
      digest: a.digest,
      bytes: Buffer.byteLength(a.content),
    })),
  );
  expect(view.body).not.toContain('actual host/VM observations');
  const full = await get(`${base}/submissions/${stored!.id}`);
  expect(full.statusCode, full.body).toBe(200);
  expect(full.json()).toEqual(JSON.parse(JSON.stringify(stored)));
  expect((await get(`${base}/submissions/${randomUUID()}`)).statusCode).toBe(404);
  const elsewhere = `/api/workspaces/${ws}/concurrency-definitions/${randomUUID()}/runtime`;
  expect((await get(`${elsewhere}/submissions/${stored!.id}`)).statusCode).toBe(404);
  expect(
    (
      await f.state.context.app.inject({
        method: 'GET',
        url: `${base}/submissions/${stored!.id}`,
      })
    ).statusCode,
  ).toBe(401);
});
it('reads storage once per evidence view, however many submissions it lists (R-H4, LIVE-29)', async () => {
  const f = await evidenceFixture(),
    ws = f.state.workspaceId,
    storage = f.state.context.storage;
  const reads = () => {
    const spies = [
      vi.spyOn(storage.imports, 'bindings'),
      vi.spyOn(storage.imports, 'definition'),
      vi.spyOn(storage.runtimeEvidence, 'submissions'),
      vi.spyOn(storage.runtimeEvidence, 'generations'),
      vi.spyOn(storage.execution.runs, 'listRecentHeaders'),
    ];
    return async () => {
      await f.svc.view(f.auth, ws, f.definitionId);
      const counts = spies.map((spy) => spy.mock.calls.length);
      for (const spy of spies) spy.mockRestore();
      return counts;
    };
  };
  await f.svc.submit(f.auth, ws, f.definitionId, f.submission);
  const one = await reads()();
  for (const executedAt of ['2026-09-30T00:00:01.000Z', '2026-09-30T00:00:02.000Z'])
    await f.svc.submit(f.auth, ws, f.definitionId, { ...f.submission, executedAt });
  expect(storage.runtimeEvidence.submissions(ws, f.definitionId)).toHaveLength(3);
  expect(await reads()()).toEqual(one);
});
it('checks actual Git freshness at evidence review and keeps decisions immutable', async () => {
  const f = await evidenceFixture(),
    ws = f.state.workspaceId;
  const submitted = await f.svc.submit(f.auth, ws, f.definitionId, f.submission);
  const s = submitted.submissions[0]!.submission;
  execFileSync(
    HOST_GIT,
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'integration advanced',
    ],
    { cwd: f.root },
  );
  await expect(
    f.svc.decide(f.auth, ws, f.definitionId, {
      submissionId: s.id,
      outcome: 'accepted',
      rationale: 'Old evidence.',
    }),
  ).rejects.toThrow('current integration commit');
  await f.svc.decide(f.auth, ws, f.definitionId, {
    submissionId: s.id,
    outcome: 'rejected',
    rationale: 'Integration advanced; collect fresh results.',
  });
  await expect(
    f.svc.decide(f.auth, ws, f.definitionId, {
      submissionId: s.id,
      outcome: 'rejected',
      rationale: 'Duplicate.',
    }),
  ).rejects.toThrow('immutable decision');
});
it('previews exact dependency refreshes, rejects stale approval and retains unchanged native authority', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    repositories: [
      { ...source.repositories[0]!, id: 'local' },
      {
        ...source.repositories[0]!,
        id: 'provider',
        role: 'implemented_upstream',
        target_branch: null,
        merge_lock: null,
      },
    ],
    work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
  }));
  const ws = f.state.workspaceId,
    tx = f.state.context.storage,
    svc = f.state.context.services.runtimeEvidenceService;
  const id = f.parentScope.definitionId,
    provider = fixtureRepository();
  commitFile(
    provider,
    'Cargo.toml',
    '[package]\nname="refresh_provider"\nversion="0.2.0"\nedition="2021"\n',
  );
  const registered = await f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/repositories`,
    headers: mutationHeaders(f.state),
    payload: { rootPath: provider, displayName: 'Refresh provider' },
  });
  const repository = registerSourceRepositoryResponseSchema.parse(registered.json()).repository;
  const binding = tx.imports.bindings(ws, id)[0]!;
  tx.imports.addBindings({
    ...binding,
    revision: 2,
    bindings: [
      ...binding.bindings,
      {
        alias: 'provider',
        repositoryId: repository.id,
        integrationBranch: 'main',
        sourceArtifacts: [],
        workItems: [],
      },
    ],
  });
  const pin = await svc.inspect(f.auth, ws, id, {
    bindingRevision: 2,
    alias: 'provider',
    ref: 'main',
  });
  declareFixtureChecks(f.state);
  const configured = await svc.configure(f.auth, ws, id, {
    bindingRevision: 2,
    expectedGeneration: 0,
    pins: [
      {
        alias: 'provider',
        ref: 'main',
        expectedCommitSha: pin.commitSha,
        conformanceRevision: 'fixture',
        packages: pin.packages,
      },
    ],
    consumers: [{ alias: 'local', upstreams: ['provider'] }],
    environments: [
      {
        id: 'local',
        kind: 'local-development',
        identityDigest: 'a'.repeat(64),
        fixtureDigest: 'b'.repeat(64),
        toolchainDigest: 'c'.repeat(64),
        authorization: 'Non-sensitive fixtures',
      },
    ],
  });
  const old = configured.current!;
  const { nativeHostDigest } = await import('@craftingtable/agents');
  const native = {
    id: randomUUID(),
    workspaceId: ws,
    definitionId: id,
    bindingRevision: 2,
    runtimeId: old.id,
    approved: true,
    hostDigest: nativeHostDigest(),
    auditDigest: 'a'.repeat(64),
    audit: 'Approved host',
    rationale: 'Non-sensitive fixtures',
    createdAt: new Date().toISOString(),
    createdByUserId: f.state.userId,
  };
  tx.runtimeEvidence.addNativeApproval(native);
  commitFile(provider, 'POLICY.md', 'A source policy update is still an exact pin change.');
  const base = `/api/workspaces/${ws}/concurrency-definitions/${id}/runtime`;
  const input = { bindingRevision: 2, expectedGeneration: 1 };
  expect(
    (
      await f.state.context.app.inject({
        method: 'POST',
        url: `${base}/preview-refresh`,
        headers: { cookie: f.state.cookie },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  const response = await f.state.context.app.inject({
    method: 'POST',
    url: `${base}/preview-refresh`,
    headers: mutationHeaders(f.state),
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  const { runtimeRefreshPreviewSchema } = await import('@craftingtable/contracts');
  const preview = runtimeRefreshPreviewSchema.parse(response.json());
  expect(preview).toMatchObject({
    nativeApproval: 'retained',
    blockers: [],
    pins: [{ alias: 'provider', before: pin.commitSha, changed: true }],
  });
  expect(tx.runtimeEvidence.generations(ws, id, 2)).toHaveLength(1);
  expect(f.backend.launches).toHaveLength(0);
  commitFile(provider, 'later.md', 'Provider advanced during review');
  const stale = await f.state.context.app.inject({
    method: 'POST',
    url: `${base}/refresh`,
    headers: mutationHeaders(f.state),
    payload: { ...input, snapshotDigest: preview.snapshotDigest, rationale: 'Reviewed pins' },
  });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(tx.runtimeEvidence.generations(ws, id, 2)).toHaveLength(1);
  const fresh = await svc.previewRefresh(f.auth, ws, id, input);
  const applied = await f.state.context.app.inject({
    method: 'POST',
    url: `${base}/refresh`,
    headers: mutationHeaders(f.state),
    payload: {
      ...input,
      snapshotDigest: fresh.snapshotDigest,
      rationale: 'Reviewed the changed provider and unchanged host scope',
    },
  });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json()).toMatchObject({
    current: {
      generation: 2,
      environments: old.environments,
      pins: [{ packages: pin.packages }],
    },
    nativeVerification: { current: true, approval: { id: native.id, runtimeId: old.id } },
    issues: [],
  });
  expect(tx.runtimeEvidence.generations(ws, id, 2)[1]).toEqual(old);
  expect(f.backend.launches).toHaveLength(0);
  expect(
    (await svc.previewRefresh(f.auth, ws, id, { ...input, expectedGeneration: 2 })).blockers.join(
      ' ',
    ),
  ).toContain('already current');
  tx.runtimeEvidence.addNativeApproval({ ...native, id: randomUUID(), approved: false });
  expect((await svc.view(f.auth, ws, id)).nativeVerification.current).toBe(false);
  mkdirSync(join(provider, 'examples/extra'), { recursive: true });
  commitFile(
    provider,
    'examples/extra/Cargo.toml',
    '[package]\nname="unselected_example"\nversion="0.1.0"\nedition="2021"\n',
  );
  await expect(
    svc.previewRefresh(f.auth, ws, id, { ...input, expectedGeneration: 2 }),
  ).rejects.toThrow('Cargo package set changed');
  expect(tx.runtimeEvidence.generations(ws, id, 2)).toHaveLength(2);
});
it('protects runtime routes with workspace authorization and mutation CSRF', async () => {
  const f = await evidenceFixture(),
    base = `/api/workspaces/${f.state.workspaceId}/concurrency-definitions/${f.definitionId}/runtime`;
  const anonymous = await f.state.context.app.inject({ method: 'GET', url: base });
  expect(anonymous.statusCode).toBe(401);
  const noCsrf = await f.state.context.app.inject({
    method: 'POST',
    url: `${base}/configure`,
    headers: { cookie: f.state.cookie },
    payload: f.input,
  });
  expect(noCsrf.statusCode).toBe(403);
  const view = await f.state.context.app.inject({
    method: 'GET',
    url: base,
    headers: { cookie: f.state.cookie },
  });
  expect(view.statusCode, view.body).toBe(200);
  const bad = await f.state.context.app.inject({
    method: 'POST',
    url: `${base}/submit`,
    headers: {
      cookie: f.state.cookie,
      origin: f.state.context.config.publicOrigin,
      'x-craftingtable-csrf': f.state.csrfToken,
    },
    payload: {},
  });
  expect(bad.statusCode, bad.body).toBe(400);
});

// Builds a real crate: a host without Cargo skips it (R-I5, QA-08).
it.skipIf(HOST_CARGO === undefined).each(['integration', 'implementation'] as const)(
  'supplies isolated %s verification and freezes generation-bound review provenance',
  async (mode) => {
    const f = await slicedFixture((source) => ({
      ...source,
      // Integration work builds against the current pin, so the map declares when local
      // moves to it (ADR-069): at slice a, which slice b now waits for.
      ...(mode === 'integration'
        ? {
            upstream_transitions: [
              { consumer: 'local', upstream: 'provider', slice: 'local/AQ-01/a' },
            ],
          }
        : {}),
      slices: source.slices.map((s) => ({
        ...s,
        mode,
        ...(mode === 'integration' && s.id === 'local/AQ-01/b'
          ? {
              start_requires: [
                ...s.start_requires,
                { kind: 'slice' as const, id: 'local/AQ-01/a', state: 'merged' as const },
              ],
            }
          : {}),
      })),
      repositories: [
        { ...source.repositories[0]!, id: 'local' },
        {
          ...source.repositories[0]!,
          id: 'provider',
          role: 'implemented_upstream',
          target_branch: null,
          merge_lock: null,
        },
      ],
      work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
    }));
    const provider = fixtureRepository();
    writeFileSync(
      join(provider, 'Cargo.toml'),
      '[package]\nname="ct_runtime_provider"\nversion="0.2.0"\nedition="2021"\n[lib]\npath="lib.rs"\n',
    );
    writeFileSync(join(provider, 'lib.rs'), 'pub fn value()->u32{42}\n');
    git(['add', '.'], provider);
    git(['commit', '-m', 'provider'], provider);
    writeFileSync(
      join(f.root, 'Cargo.toml'),
      '[package]\nname="ct_runtime_consumer"\nversion="0.1.0"\nedition="2021"\n[lib]\npath="lib.rs"\n[dependencies]\nct_runtime_provider="0.2"\n',
    );
    writeFileSync(
      join(f.root, 'lib.rs'),
      '#[test] fn pin(){assert_eq!(ct_runtime_provider::value(),42);}\n',
    );
    const cargo = HOST_CARGO as string;
    execFileSync(
      cargo,
      [
        'generate-lockfile',
        '--offline',
        '--config',
        `patch.crates-io.ct_runtime_provider.path=${JSON.stringify(provider)}`,
      ],
      { cwd: f.root },
    );
    git(['add', '.'], f.root);
    git(['commit', '-m', 'consumer'], f.root);
    mkdirSync(join(f.root, 'contract'));
    writeFileSync(
      join(f.root, 'contract/Cargo.toml'),
      '[package]\nname="ct_supplementary"\nversion="0.1.0"\nedition="2021"\n[workspace]\n[lib]\npath="lib.rs"\n',
    );
    writeFileSync(join(f.root, 'contract/lib.rs'), '#[test] fn contract(){assert_eq!(2+2,4); }');
    execFileSync(
      cargo,
      [
        'generate-lockfile',
        '--offline',
        '--manifest-path',
        'contract/Cargo.toml',
        '--config',
        `patch.crates-io.ct_runtime_provider.path=${JSON.stringify(provider)}`,
      ],
      { cwd: f.root },
    );
    git(['add', '.'], f.root);
    git(['commit', '-m', 'supplementary contract fixture'], f.root);
    const registered = await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/repositories`,
      headers: mutationHeaders(f.state),
      payload: { rootPath: provider, displayName: 'Pinned provider' },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const repository = registerSourceRepositoryResponseSchema.parse(registered.json()).repository;
    const ws = f.state.workspaceId,
      definitionId = f.parentScope.definitionId,
      svc = f.state.context.services.runtimeEvidenceService,
      storage = f.state.context.storage;
    const old = storage.imports.bindings(ws, definitionId)[0]!;
    storage.imports.addBindings({
      ...old,
      revision: 2,
      bindings: [
        ...old.bindings,
        {
          alias: 'provider',
          repositoryId: repository.id,
          integrationBranch: 'main',
          sourceArtifacts: [],
          workItems: [],
        },
      ],
    });
    const observed = await svc.inspect(f.auth, ws, definitionId, {
      bindingRevision: 2,
      alias: 'provider',
      ref: 'main',
    });
    expect(observed.packages).toEqual([
      { name: 'ct_runtime_provider', path: '', version: '0.2.0' },
    ]);
    const config = {
      bindingRevision: 2,
      expectedGeneration: 0,
      pins: [
        {
          alias: 'provider',
          ref: 'main',
          conformanceRevision: 'local-fixture',
          packages: observed.packages,
        },
      ],
      consumers: [{ alias: 'local', upstreams: ['provider'] }],
      environments: [
        {
          id: 'local',
          kind: 'local-development' as const,
          identityDigest: '1'.repeat(64),
          fixtureDigest: '2'.repeat(64),
          toolchainDigest: '3'.repeat(64),
          authorization: 'Isolated fixture builds only.',
        },
      ],
    };
    // The builds and checks the agent supplies: the daemon's runs before a review are tested on
    // their own.
    withoutDaemonChecks(f.state);
    declareFixtureChecks(f.state, [
      {
        id: 'fixture',
        argv: [
          'node',
          '-e',
          'if(!require("node:fs").readFileSync("lib.rs","utf8").includes("pin()"))process.exit(1)',
        ],
        definitionPaths: [],
      },
    ]);
    await svc.configure(f.auth, ws, definitionId, config);
    const scope = { ...f.scopes[0]!, bindingRevision: 2 },
      tree = await scopeTree(f, scope);
    f.backend.replyForRequest = () => ({ resultText: scopeReport(f.state, scope) });
    const withoutBuild = await runToFinish(f.state, tree.id, { role: 'review' });
    // The daemon recorded no check, so the frozen record is empty and the gate refuses it (R-G4).
    expect(storage.runtimeEvidence.build(ws, withoutBuild)).toMatchObject({ receipts: '' });
    expect(() => svc.assertRun(tree, withoutBuild)).toThrow('The review needs a successful');
    f.backend.replyForRequest = async (request) => {
      expect(request.buildEnvironment?.namespace).toBeTruthy();
      expect(request.prompt).toContain('Pinned dependency environment:');
      if (mode === 'integration')
        await runLauncher(request, 'cargo', ['test', '--offline'], {
          ...process.env,
          CARGO_NET_OFFLINE: 'true',
        });
      // Every adopted check, in either mode (R-G13 increment 2).
      await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
      return { resultText: scopeReport(f.state, scope) };
    };
    if (mode === 'integration') {
      const original = f.backend.replyForRequest;
      // The adopted checks alone do not meet a current-upstream gate: it needs a pinned build.
      f.backend.replyForRequest = async (request) => {
        await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
        await runLauncher(request, 'ct-check', [
          '--',
          process.execPath,
          '-e',
          'console.log("contract checked")',
        ]);
        return { resultText: scopeReport(f.state, scope) };
      };
      const scopedOnly = await runToFinish(f.state, tree.id, { role: 'review' });
      expect(() => svc.assertRun(tree, scopedOnly)).toThrow('successful pinned Cargo');
      f.backend.replyForRequest = async (request) => {
        await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
        await runLauncher(request, 'cargo', [
          'test',
          '--offline',
          '--locked',
          '--manifest-path',
          'contract/Cargo.toml',
        ]);
        return { resultText: scopeReport(f.state, scope) };
      };
      const supplementaryOnly = await runToFinish(f.state, tree.id, { role: 'review' });
      expect(storage.runtimeEvidence.build(ws, supplementaryOnly)?.receipts).toContain(
        'supplementary-check',
      );
      expect(() => svc.assertRun(tree, supplementaryOnly)).toThrow('successful pinned Cargo');
      // Nor does a pinned build alone: every adopted check is needed too.
      f.backend.replyForRequest = async (request) => {
        await runLauncher(request, 'cargo', ['test', '--offline'], {
          ...process.env,
          CARGO_NET_OFFLINE: 'true',
        });
        return { resultText: scopeReport(f.state, scope) };
      };
      const pinnedOnly = await runToFinish(f.state, tree.id, { role: 'review' });
      expect(() => svc.assertRun(tree, pinnedOnly)).toThrow('ct-check --declared fixture');
      f.backend.replyForRequest = original;
    }
    const run = await runToFinish(f.state, tree.id, { role: 'review' });
    expect(() => svc.assertRun(tree, run)).not.toThrow();
    const environment = storage.runtimeEvidence.run(ws, run)!;
    const manifest = JSON.parse(
      readFileSync(environment.manifestPath, 'utf8'),
    ) as import('@craftingtable/agents').PinnedCargoManifest;
    if (mode === 'integration') {
      expect(manifest.packages[0]!.path).not.toBe(provider);
      expect(manifest.packages[0]!.path).toContain('/scratch/dependencies/');
    } else {
      expect(manifest.packages).toHaveLength(0);
      expect(manifest.verification?.mode).toBe('scoped-checks');
    }
    const frozen = storage.runtimeEvidence.build(ws, run)!;
    expect(frozen.error).toBeUndefined();
    expect(frozen.receipts).toContain('"success":true');
    // The build or check was run and recorded by the daemon (R-G4).
    expect(frozen.receipts).toContain('"recordedBy":"daemon"');
    rmSync(manifest.receiptPath, { force: true });
    expect(() => svc.assertRun(tree, run)).not.toThrow();
    const db = openDatabase(storage.databasePath);
    try {
      expect(() =>
        db.prepare('UPDATE run_build_records SET record_json=? WHERE run_id=?').run('{}', run),
      ).toThrow('immutable');
    } finally {
      db.close();
    }
    await svc.configure(f.auth, ws, definitionId, { ...config, expectedGeneration: 1 });
    expect(() => svc.assertRun(tree, run)).not.toThrow();
    expect(storage.runtimeEvidence.build(ws, run)?.runtimeId).toBe(environment.runtimeId);
    await svc.configure(f.auth, ws, definitionId, {
      ...config,
      expectedGeneration: 2,
      environments: config.environments.map((e) => ({ ...e, toolchainDigest: 'f'.repeat(64) })),
    });
    expect(() => svc.assertRun(tree, run)).toThrow('obsolete dependency environment');
    git(['commit', '--allow-empty', '-m', 'provider advanced'], provider);
    await expect(
      svc.configure(f.auth, ws, definitionId, {
        ...config,
        expectedGeneration: 3,
        pins: config.pins.map((p) => ({ ...p, expectedCommitSha: observed.commitSha })),
      }),
    ).rejects.toThrow('ref advanced before saving');
    const prepared = svc.prepare(tree, randomUUID(), join(f.state.context.directory, 'new-run'));
    if (mode === 'integration') await expect(prepared).rejects.toThrow('integration changed');
    else await expect(prepared).resolves.toMatchObject({ verification: { mode: 'scoped-checks' } });
  },
);

it('binds consumer evidence independently of checkpoint ownership and derives cross-project build providers', async () => {
  // The checkpoints belong to the map's implemented upstream, not to the tested consumer.
  const f = await evidenceFixture('base');
  const { testedRepositories, requiredUpstreams } = await import(
    './services/runtime-evidence-policy.js'
  );
  // Cross-project providers are derived from the real v0.3 map.
  const real = f.state.context.services.packageImportService.importConcurrency(
    f.auth,
    f.state.workspaceId,
    'map.zip',
    readFileSync(
      new URL(
        '../../../fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip',
        import.meta.url,
      ),
    ),
  );
  const imported = f.state.context.storage.imports.definition(
    f.state.workspaceId,
    real.attempt.definitionId!,
  )!;
  expect(testedRepositories(imported, { kind: 'checkpoint', sourceId: 'WI-AQ-G1' })).toEqual([
    'wi',
  ]);
  expect(testedRepositories(imported, { kind: 'checkpoint', sourceId: 'EXO-AQ-G1' })).toEqual([
    'exo',
  ]);
  expect(requiredUpstreams(imported, 'wi')).toEqual(['aq']);
  expect(requiredUpstreams(imported, 'exo')).toEqual(['aq', 'wi']);
  await expect(
    f.svc.submit(f.auth, f.state.workspaceId, f.definitionId, {
      ...f.submission,
      subjectCommit: 'f'.repeat(40),
    }),
  ).rejects.toThrow('current integration commit');
  const { subjectCommit: _commit, ...noCode } = f.submission;
  await expect(f.svc.submit(f.auth, f.state.workspaceId, f.definitionId, noCode)).rejects.toThrow(
    'exact tested local consumer commit',
  );
  const submitted = await f.svc.submit(f.auth, f.state.workspaceId, f.definitionId, {
    ...noCode,
    testedCode: [{ alias: 'local', commitSha: f.submission.subjectCommit! }],
  });
  expect(submitted.submissions[0]?.submission.testedCode).toEqual([
    { alias: 'local', commitSha: f.submission.subjectCommit },
  ]);
});

// The checkpoint fixture's baseline cases, as the resolver derives them from its map (QA-06).
itNeedsCargo(
  'derives the checkpoint fixture’s slice cases exactly as the scenario tests report them',
  async () => {
    const f = await checkpointCandidateFixture();
    const { state } = f;
    for (const scope of f.scopes) {
      const resolved = resolveScope(
        state.context.storage,
        state.workspaceId,
        state.workItemId,
        scope,
      );
      expect(
        { requirements: scopeRequirements(resolved), caseIds: scopeCases(resolved) },
        scopeKey(scope),
      ).toEqual(expectedScopeEvidence(state, scope));
    }
  },
);
