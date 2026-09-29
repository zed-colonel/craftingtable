import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerSourceRepositoryResponseSchema,
  runtimeEvidenceViewSchema,
} from '@craftingtable/contracts';
import type { PinnedCargoManifest } from '@craftingtable/agents';
import type { ExecutionScope } from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, expect } from 'vitest';
import {
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  fixtureRepository,
  git,
  HOST_CARGO,
  itNeedsCargo,
  mutationHeaders,
  runLauncher,
  runToFinish,
  scopeReport,
  scopeTree,
  slicedFixture,
  startCycle,
  waitFor,
} from './execution-test-support.js';
import { UpstreamPinMovedError, UpstreamTransitionUndeclaredError } from './services/errors.js';

afterEach(cleanupExecutionFixtures);

const A = 'local/AQ-01/a';
const B = 'local/AQ-01/b';

/**
 * ADR-069 on a real Cargo build. Slice a (integration) moves `local` onto the provider's current
 * pin; slice b is domain work. The consumer already depends on the provider, as WI does on AQ.
 */
async function transitionFixture() {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s) => ({ ...s, mode: s.id === A ? 'integration' : 'domain' })),
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
  execFileSync(
    HOST_CARGO as string,
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
  await svc.configure(f.auth, ws, definitionId, {
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
  });
  const scope = (kind: ExecutionScope['kind'], sourceId: string): ExecutionScope => ({
    kind,
    sourceId,
    definitionId,
    bindingRevision: 2,
  });
  const base = `/api/workspaces/${ws}/concurrency-definitions/${definitionId}/runtime`;
  const declare = (payload: Record<string, unknown>) =>
    f.state.context.app.inject({
      method: 'POST',
      url: `${base}/declare-transitions`,
      headers: mutationHeaders(f.state),
      payload,
    });
  const prepared = async (tree: { id: string }) => {
    const found = storage.execution.worktrees.find(ws, tree.id as never)!;
    const launch = await svc.prepare(
      found,
      randomUUID(),
      join(f.state.context.directory, `prepare-${randomUUID()}`),
    );
    return {
      launch: launch!,
      manifest: JSON.parse(readFileSync(launch!.manifestPath, 'utf8')) as PinnedCargoManifest,
    };
  };
  return { f, ws, storage, scope, declare, prepared, repository, providerSha: observed.commitSha };
}

itNeedsCargo(
  'stops current-pin work on an undeclared link, then moves domain work at the declared transition',
  async () => {
    const { f, ws, storage, scope, declare, prepared, repository, providerSha } =
      await transitionFixture();
    const treeA = await scopeTree(f, scope('slice', A));
    // Only a link of the map can be declared, so configuration accepts only the map's upstreams.
    const generation = storage.runtimeEvidence.generations(
      ws,
      scope('slice', A).definitionId,
      2,
    )[0]!;
    await expect(
      f.state.context.services.runtimeEvidenceService.configure(
        f.auth,
        ws,
        scope('slice', A).definitionId,
        {
          bindingRevision: 2,
          expectedGeneration: generation.generation,
          pins: generation.pins.map((p) => ({
            alias: p.alias,
            ref: p.ref,
            expectedCommitSha: p.commitSha,
            conformanceRevision: p.conformanceRevision,
            packages: [...p.packages],
          })),
          consumers: [{ alias: 'local', upstreams: ['provider', 'unmapped'] }],
          environments: [...generation.environments],
        },
      ),
    ).rejects.toThrow('local does not build against unmapped in this map');

    // Undeclared: integration work stops with its own code instead of building on a guess.
    await expect(prepared(treeA)).rejects.toThrow(UpstreamTransitionUndeclaredError);
    const cycle = await startCycle(f.state, treeA.id);
    await waitFor(
      () => currentCycle(f.state, cycle).status === 'needs-attention',
      'undeclared transition',
    );
    expect(currentCycle(f.state, cycle).attention?.code).toBe('upstream-transition-undeclared');
    expect(f.backend.launches).toHaveLength(0);
    await controlCycle(f.state, currentCycle(f.state, cycle), 'stop');

    // The view offers only the slice every current-pin scope already waits for.
    const offered = await f.state.context.services.runtimeEvidenceService.view(
      f.auth,
      ws,
      scope('slice', A).definitionId,
    );
    expect(offered.upstreamTransitions?.links).toEqual([
      { consumer: 'local', upstream: 'provider', candidates: [A] },
    ]);

    // The operator record goes through the same checks as a map declaration.
    const transition = { consumer: 'local', upstream: 'provider', slice: A };
    const rationale = 'Slice a migrates local to the provider pin.';
    const scoped = await declare({
      expectedRecordIds: [],
      transitions: [{ ...transition, slice: B }],
      rationale,
    });
    expect(scoped.statusCode).toBe(409);
    expect(scoped.body).toContain('builds against the current pins');
    const approved = await declare({ expectedRecordIds: [], transitions: [transition], rationale });
    expect(approved.statusCode, approved.body).toBe(200);
    const view = runtimeEvidenceViewSchema.parse(approved.json()).upstreamTransitions!;
    const recordId = view.records[0]!.id;
    expect(view.links).toEqual([
      {
        consumer: 'local',
        upstream: 'provider',
        slice: A,
        declaredBy: 'record',
        recordId,
        candidates: [],
      },
    ]);
    expect(
      (await declare({ expectedRecordIds: [], transitions: [transition], rationale })).statusCode,
    ).toBe(409);
    const twice = await declare({
      expectedRecordIds: [recordId],
      transitions: [transition],
      rationale,
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.body).toContain('declared more than once');
    // Approved records are immutable in storage, not only through the API.
    const db = openDatabase(storage.databasePath);
    try {
      for (const sql of [
        "UPDATE upstream_transition_records SET record_json='{}' WHERE id=?",
        'DELETE FROM upstream_transition_records WHERE id=?',
      ])
        expect(() => db.prepare(sql).run(recordId)).toThrow('immutable');
    } finally {
      db.close();
    }
    expect((await prepared(treeA)).launch.dependencies).toEqual([
      expect.objectContaining({
        alias: 'provider',
        purpose: 'current-upstream',
        transition: { slice: A, recordId },
      }),
    ]);

    // Domain work based before the transition merged keeps the historical source; none is
    // prepared yet, so the provider stays forbidden rather than resolved from a registry.
    const early = await scopeTree(f, scope('slice', B));
    const forbidden = async () => {
      const before = await prepared(early);
      expect(before.launch.dependencies).toEqual([]);
      expect(before.manifest.forbiddenPackages).toEqual(['ct_runtime_provider']);
    };
    await forbidden();

    const merged = (tree: { id: string }, mergeSha: string) => {
      const integration = storage.execution.worktrees.find(ws, tree.id as never)!.baseBranch;
      git(['update-ref', `refs/heads/${integration}`, mergeSha], f.root);
      storage.execution.worktrees.markMerged({
        workspaceId: ws,
        worktreeId: tree.id as never,
        occurredAt: new Date().toISOString(),
        mergeSha,
      });
    };
    // Slice a merges. The early tree's history lacks that merge, so its link has not moved.
    const migrationSha = commitFile(treeA.path, 'migration.txt', 'moved to the provider pin');
    merged(treeA, migrationSha);
    await forbidden();

    // With the consumer's historical preparation, the early tree builds the historical provider.
    const stopped = currentCycle(f.state, cycle);
    const preparationId = randomUUID();
    storage.execution.cycles.replace(
      {
        ...stopped,
        version: stopped.version + 1,
        baselinePreparation: {
          id: preparationId,
          contextDigest: 'a'.repeat(64),
          createdAt: new Date().toISOString(),
          createdByUserId: f.state.userId,
          status: 'prepared',
          directory: join(f.state.context.directory, 'baseline'),
          consumerAlias: 'local',
          sources: [
            {
              alias: 'provider',
              repositoryId: repository.id,
              directoryName: 'provider',
              commitSha: providerSha,
            },
          ],
          message: 'Historical provider prepared.',
        },
      },
      stopped.version,
    );
    const historical = await prepared(early);
    expect(historical.launch.dependencies).toEqual([
      expect.objectContaining({
        alias: 'provider',
        commitSha: providerSha,
        purpose: 'historical-development',
        transition: { slice: A, recordId },
      }),
    ]);
    expect(historical.manifest.historicalPreparationId).toBe(preparationId);
    expect(historical.manifest.verification?.mode).toBe('scoped-checks');
    expect(historical.manifest.forbiddenPackages).toBeUndefined();

    // The domain slice merges on top, and a fresh verification of it is based on the migrated
    // head: the same shape as WI-02/domain after WI-02/integration.
    commitFile(early.path, 'domain.txt', 'domain work');
    git(['merge', '--no-edit', '--no-gpg-sign', migrationSha], early.path);
    merged(early, git(['rev-parse', 'HEAD'], early.path).trim());
    const verification = await scopeTree(f, scope('slice-verification', B));
    const after = await prepared(verification);
    expect(after.launch.dependencies).toEqual([
      expect.objectContaining({
        alias: 'provider',
        purpose: 'current-upstream',
        transition: { slice: A, recordId },
      }),
    ]);
    // Every link moved, so the domain verification is a current-upstream build: CI sees that
    // mode, and acceptance needs a pinned Cargo build/test, not only scoped checks.
    expect(after.manifest.verification?.mode).toBe('current-upstream-build');
    expect(after.launch.movedToCurrentPins).toBe(true);
    expect(after.manifest.forbiddenPackages).toBeUndefined();
    expect(after.manifest.packages.map((p) => p.name)).toEqual(['ct_runtime_provider']);

    // The fresh verification builds against the current pin and is told why.
    f.backend.replyForRequest = async (request) => {
      expect(request.prompt).toContain(
        `moves to the current pin at ${A}, declared by operator record ${recordId}`,
      );
      await runLauncher(request, 'cargo', ['test', '--offline'], {
        ...process.env,
        CARGO_NET_OFFLINE: 'true',
      });
      return { resultText: scopeReport(f.state, verification.executionScope!) };
    };
    const svc = f.state.context.services.runtimeEvidenceService;
    const tree = () => storage.execution.worktrees.find(ws, verification.id)!;
    const run = await runToFinish(f.state, verification.id, { role: 'review' });
    const build = storage.runtimeEvidence.build(ws, run)!;
    expect(build.error).toBeUndefined();
    expect(build.receipts).toContain('"verificationMode":"current-upstream-build"');
    expect(storage.runtimeEvidence.run(ws, run)?.verificationMode).toBe('current-upstream-build');
    expect(() => svc.assertRun(tree(), run)).not.toThrow();

    // A scoped check alone no longer satisfies it.
    f.backend.replyForRequest = async (request) => {
      await runLauncher(request, 'ct-check', [
        '--',
        process.execPath,
        '-e',
        'console.log("domain checked")',
      ]);
      return { resultText: scopeReport(f.state, verification.executionScope!) };
    };
    const scopedOnly = await runToFinish(f.state, verification.id, { role: 'review' });
    expect(() => svc.assertRun(tree(), scopedOnly)).toThrow('successful pinned Cargo build/test');
  },
);

itNeedsCargo(
  'stops as upstream-pin-moved when a pinned upstream advanced, and resumes only after the refresh (LIVE-15)',
  async () => {
    const { f, ws, storage, scope, declare, prepared, providerSha } = await transitionFixture();
    const treeA = await scopeTree(f, scope('slice', A));
    const declared = await declare({
      expectedRecordIds: [],
      transitions: [{ consumer: 'local', upstream: 'provider', slice: A }],
      rationale: 'Slice a migrates local to the provider pin.',
    });
    expect(declared.statusCode, declared.body).toBe(200);
    // The provider's integration advances after its pin was saved, as wi's did live.
    const provider = storage.execution.sourceRepositories
      .list(ws)
      .find((r) => r.displayName === 'Pinned provider')!.rootPath;
    git(['commit', '--allow-empty', '-m', 'provider advanced'], provider);
    const advancedSha = git(['rev-parse', 'HEAD'], provider).trim();
    const moved = [
      { alias: 'provider', pinnedCommitSha: providerSha, currentCommitSha: advancedSha },
    ];

    // A typed error carrying what moved, not a generic conflict.
    await expect(prepared(treeA)).rejects.toThrow(UpstreamPinMovedError);
    await expect(prepared(treeA)).rejects.toMatchObject({
      definitionId: scope('slice', A).definitionId,
      pins: moved,
    });

    // The cycle stops with its own code and the pins as structured refs, not controller-error.
    const cycle = await startCycle(f.state, treeA.id);
    await waitFor(() => currentCycle(f.state, cycle).status === 'needs-attention', 'pin stop');
    expect(currentCycle(f.state, cycle).attention).toMatchObject({
      code: 'upstream-pin-moved',
      owner: 'operator',
      refs: { definitionId: scope('slice', A).definitionId, pins: moved },
    });
    expect(currentCycle(f.state, cycle).reason).toContain('Preview dependency refresh');
    expect(f.backend.launches).toHaveLength(0);

    // Its inbox item opens the dependency environment where the refresh is previewed.
    const item = storage.attention.open(ws).find((i) => i.subjectKey === `cycle:${cycle.id}`);
    expect(item).toMatchObject({
      code: 'upstream-pin-moved',
      path: `/workspaces/${ws}/roadmaps#runtime-evidence-${scope('slice', A).definitionId}`,
    });

    // A plain Resume would meet the same pin, so it is refused while the pin is stale.
    const resume = () =>
      f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(f.state),
        payload: { action: 'resume', expectedVersion: currentCycle(f.state, cycle).version },
      });
    const refused = await resume();
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('dependency refresh');
    expect(currentCycle(f.state, cycle).status).toBe('needs-attention');

    // Once the refresh saves a generation pinning the advanced commit, Resume goes ahead.
    const generation = storage.runtimeEvidence.generations(
      ws,
      scope('slice', A).definitionId,
      2,
    )[0]!;
    await f.state.context.services.runtimeEvidenceService.configure(
      f.auth,
      ws,
      scope('slice', A).definitionId,
      {
        bindingRevision: 2,
        expectedGeneration: generation.generation,
        pins: generation.pins.map((p) => ({
          alias: p.alias,
          ref: p.ref,
          expectedCommitSha: advancedSha,
          conformanceRevision: p.conformanceRevision,
          packages: [...p.packages],
        })),
        consumers: generation.consumers.map((c) => ({
          alias: c.alias,
          upstreams: [...c.upstreams],
        })),
        environments: [...generation.environments],
      },
    );
    const resumed = await resume();
    expect(resumed.statusCode, resumed.body).toBe(200);
    await controlCycle(f.state, currentCycle(f.state, cycle), 'stop');
  },
);
