import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import {
  cargoManifestDigest as hash,
  prepareCargoLauncher,
  type PinnedCargoManifest,
} from '@craftingtable/agents';
import {
  configureRuntimeSchema,
  evidenceSubmissionRequestSchema,
  type ConfigureRuntime,
  type EvidenceSubmissionRequest,
} from '@craftingtable/contracts';
import {
  asAgentRunId,
  asAuditEventId,
  asEventId,
  type ConcurrencyDefinition,
  type EvidenceSubmission,
  type EvidenceSubject,
  type RuntimeGeneration,
  type WorkspaceId,
  type Worktree,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { resolveExecutable } from './executables.js';
import {
  activeRuntime,
  subjectRequirements,
  submissionIssues,
  prerequisiteIssues,
  expectedSubjectCommit,
  acceptedEvidence,
  testedRepositories,
} from './runtime-evidence-policy.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}
function packages(files: readonly { path: string; content: Uint8Array }[]) {
  const root = Buffer.from(files.find((f) => f.path === 'Cargo.toml')?.content ?? []).toString(
    'utf8',
  );
  const workspace = root.match(
    /^\[workspace\.package\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m,
  )?.[1];
  const versionOf = (body: string | undefined) =>
    body?.match(/^version\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
  return files
    .filter((f) => f.path === 'Cargo.toml' || f.path.endsWith('/Cargo.toml'))
    .flatMap((f) => {
      const body = Buffer.from(f.content).toString('utf8');
      const section = body.match(/^\[package\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
      const name = section?.match(/^name\s*=\s*["']([A-Za-z0-9_-]+)["']\s*(?:#.*)?$/m)?.[1];
      if (section && /^publish\s*=\s*false\s*(?:#.*)?$/m.test(section)) return [];
      const version =
        versionOf(section) ??
        (section && /^version\.workspace\s*=\s*true\s*(?:#.*)?$/m.test(section)
          ? versionOf(workspace)
          : undefined);
      return name
        ? [
            {
              name,
              path: f.path === 'Cargo.toml' ? '' : dirname(f.path),
              ...(version ? { version } : {}),
            },
          ]
        : [];
    });
}
export class RuntimeEvidenceService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly git: GitOperations | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private definition(ws: WorkspaceId, id: string) {
    const d = this.storage.imports.definition(ws, id);
    if (!d) throw new NotFoundError();
    return d;
  }
  private binding(ws: WorkspaceId, id: string, revision: number) {
    const b = this.storage.imports.bindings(ws, id).find((b) => b.revision === revision);
    if (!b) conflict('Bind the exact plans and repositories first.');
    return b;
  }
  private requireGit() {
    if (!this.git) throw new ExecutionRequestError('unavailable', 'Git is unavailable.');
    return this.git;
  }
  private current(ws: WorkspaceId, id: string) {
    const b = this.storage.imports.bindings(ws, id)[0];
    return b && activeRuntime(this.storage, ws, id, b.revision);
  }
  async inspect(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    input: { bindingRevision: number; alias: string; ref: string },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const b = this.binding(ws, id, input.bindingRevision).bindings.find(
      (b) => b.alias === input.alias,
    );
    const repo =
      b?.repositoryId && this.storage.execution.sourceRepositories.find(ws, b.repositoryId);
    if (!repo || repo.status !== 'active') conflict('Choose an active repository binding first.');
    const commit = await this.requireGit().resolveCommit(repo.rootPath, input.ref);
    if (!commit.ok) conflict(commit.failure.message);
    const exported = await this.requireGit().exportCommit(repo.rootPath, commit.value.commitSha);
    if (!exported.ok) conflict(exported.failure.message);
    return { ...commit.value, packages: packages(exported.value) };
  }
  async configure(context: AuthContext, ws: WorkspaceId, id: string, raw: ConfigureRuntime) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const input = configureRuntimeSchema.parse(raw),
      d = this.definition(ws, id),
      binding = this.binding(ws, id, input.bindingRevision);
    const unique = (values: readonly string[], label: string) => {
      if (new Set(values).size !== values.length) conflict(`Duplicate ${label}.`);
    };
    unique(
      input.pins.map((p) => p.alias),
      'upstream pins',
    );
    unique(
      input.consumers.map((p) => p.alias),
      'consumers',
    );
    unique(
      input.environments.map((p) => p.id),
      'environments',
    );
    for (const consumer of input.consumers) {
      if (
        !d.source.repositories.some(
          (r) => r.id === consumer.alias && r.role === 'planned_application',
        )
      )
        conflict('Unknown planned consumer.');
      unique(consumer.upstreams, 'consumer dependencies');
      if (
        consumer.upstreams.some(
          (u) => u === consumer.alias || !input.pins.some((p) => p.alias === u),
        )
      )
        conflict('Every upstream must have a distinct exact pin.');
      unique(
        consumer.upstreams.flatMap((u) =>
          input.pins.find((p) => p.alias === u)!.packages.map((p) => p.name),
        ),
        'supplied crate names',
      );
    }
    const pins: RuntimeGeneration['pins'][number][] = [];
    for (const pin of input.pins) {
      if (!d.source.repositories.some((r) => r.id === pin.alias))
        conflict('Unknown repository alias.');
      const observed = await this.inspect(context, ws, id, {
        bindingRevision: input.bindingRevision,
        alias: pin.alias,
        ref: pin.ref,
      });
      if (pin.expectedCommitSha && pin.expectedCommitSha !== observed.commitSha)
        conflict(
          'The inspected ref advanced before saving. Inspect it again and review the new commit.',
        );
      unique(
        pin.packages.map((p) => p.name),
        'crate names',
      );
      if (
        !pin.packages.length ||
        pin.packages.some(
          (p) => !observed.packages.some((o) => o.name === p.name && o.path === p.path),
        )
      )
        conflict('Select Cargo packages present at the exact pinned commit.');
      if (
        observed.packages.some(
          (o) => !pin.packages.some((p) => p.name === o.name && p.path === o.path),
        )
      )
        conflict(
          'Include every publishable Cargo package discovered in the pinned repository to prevent partial upstream fallback.',
        );
      const bound = binding.bindings.find((b) => b.alias === pin.alias)!;
      const baseline = d.source.aq_baseline_binding;
      if (
        baseline &&
        pin.alias === baseline.repository &&
        pin.conformanceRevision !== String(baseline.conformance_package_revision)
      )
        conflict(
          `This source baseline requires conformance revision ${baseline.conformance_package_revision}.`,
        );
      if (pin.alias === baseline?.repository) {
        if (observed.commitSha === baseline.historical_pre_contract_commit)
          conflict(
            'The historical pre-contract commit cannot be used as the current implementation pin.',
          );
        if (
          pin.packages.some(
            (p) =>
              observed.packages.find((o) => o.name === p.name && o.path === p.path)?.version !==
              baseline.crate_version,
          )
        )
          conflict(
            `The baseline requires actual Cargo crate version ${baseline.crate_version}. Exclude unpublished test/example packages.`,
          );
      }
      pins.push({
        alias: pin.alias,
        ref: pin.ref,
        repositoryId: bound.repositoryId!,
        ...observed,
        packages: pin.packages.map(
          (p) => observed.packages.find((o) => o.name === p.name && o.path === p.path)!,
        ),
        conformanceRevision: pin.conformanceRevision,
      });
    }
    const at = this.now().toISOString();
    this.storage.transaction((tx) => {
      this.workspaces.requireRole(context, ws, ['owner', 'editor']);
      if (
        tx.imports.bindings(ws, id)[0]?.revision !== input.bindingRevision ||
        (activeRuntime(tx, ws, id, input.bindingRevision)?.generation ?? 0) !==
          input.expectedGeneration
      )
        conflict('Runtime or plan binding changed. Refresh before saving.');
      const data = { pins, consumers: input.consumers, environments: input.environments };
      tx.runtimeEvidence.addGeneration({
        id: randomUUID(),
        workspaceId: ws,
        definitionId: id,
        bindingRevision: input.bindingRevision,
        generation: input.expectedGeneration + 1,
        digest: hash(JSON.stringify(data)),
        ...data,
        createdAt: at,
        createdByUserId: context.user.id,
      });
      this.changed(
        tx,
        context,
        ws,
        id,
        'runtime.configured',
        'Pinned dependency environment configured.',
        at,
      );
    });
    this.notifier.notify();
    return this.view(context, ws, id);
  }
  async freshness(
    ws: WorkspaceId,
    runtime: RuntimeGeneration,
    consumerAlias?: string,
  ): Promise<string[]> {
    const issues: string[] = [];
    const binding = this.binding(ws, runtime.definitionId, runtime.bindingRevision);
    if (this.current(ws, runtime.definitionId)?.id !== runtime.id)
      issues.push('The runtime generation or plan binding has changed.');
    const required = consumerAlias
      ? runtime.consumers.find((c) => c.alias === consumerAlias)?.upstreams
      : undefined;
    for (const pin of runtime.pins.filter((p) => !required || required.includes(p.alias))) {
      const b = binding.bindings.find((b) => b.alias === pin.alias),
        repo = this.storage.execution.sourceRepositories.find(ws, pin.repositoryId);
      if (!repo || repo.status !== 'active' || b?.repositoryId !== repo.id) {
        issues.push(`Pinned repository ${pin.alias} is unavailable.`);
        continue;
      }
      if (b.integrationBranch || pin.ref) {
        const head = await this.requireGit().resolveCommit(
          repo.rootPath,
          b.integrationBranch ?? pin.ref,
        );
        if (!head.ok || head.value.commitSha !== pin.commitSha)
          issues.push(
            `${pin.alias} integration changed. Configure and review a new pin generation before reusing evidence.`,
          );
      }
    }
    return issues;
  }
  private async evidenceFreshness(
    d: ConcurrencyDefinition,
    runtime: RuntimeGeneration,
    s: EvidenceSubmission,
  ) {
    const issues = await this.freshness(d.workspaceId, runtime);
    const binding = this.binding(d.workspaceId, d.id, s.bindingRevision);
    for (const code of s.testedCode ?? []) {
      const b = binding.bindings.find((b) => b.alias === code.alias);
      const repo =
        b?.repositoryId &&
        this.storage.execution.sourceRepositories.find(d.workspaceId, b.repositoryId);
      const head =
        repo && repo.status === 'active' && b?.integrationBranch
          ? await this.requireGit().resolveBranch(repo.rootPath, b.integrationBranch)
          : undefined;
      if (!head?.ok || head.value !== code.commitSha)
        issues.push(
          `Evidence must identify the current integration commit for its subject (${code.alias}).`,
        );
    }
    if (!s.testedCode?.length && !runtime.pins.length)
      issues.push('Identify the tested code with consumer commits or upstream pins.');
    return issues;
  }
  async submit(context: AuthContext, ws: WorkspaceId, id: string, raw: EvidenceSubmissionRequest) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const input = evidenceSubmissionRequestSchema.parse(raw),
      d = this.definition(ws, id),
      runtime = this.current(ws, id);
    if (!runtime || runtime.id !== input.runtimeId)
      conflict('Choose the current runtime generation.');
    try {
      subjectRequirements(d, input.subject);
    } catch {
      throw new ExecutionRequestError('invalid-request', 'Unknown evidence subject.');
    }
    const requiredCode = testedRepositories(d, input.subject);
    const testedCode =
      input.testedCode ??
      (input.subjectCommit && requiredCode.length === 1
        ? [{ alias: requiredCode[0]!, commitSha: input.subjectCommit }]
        : []);
    let source: {} | { sourceRunDigest: string; sourceRunCommit: string } = {};
    if (input.sourceRunId) {
      const run = this.storage.execution.runs.find(ws, asAgentRunId(input.sourceRunId));
      const turn =
        run && this.storage.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
      if (
        !run ||
        run.status !== 'finished' ||
        run.role !== 'review' ||
        !run.reviewBranchContext ||
        turn?.kind !== 'turn-completed' ||
        turn.payload.outcome !== 'success' ||
        turn.payload.truncated
      )
        conflict('Historical reuse requires a completed successful review with exact Git context.');
      const pin = runtime.pins.find((p) => p.repositoryId === run.repositoryId);
      const repository = this.storage.execution.sourceRepositories.find(ws, run.repositoryId);
      if (!repository) conflict('Historical repository unavailable.');
      const reviewed = await this.requireGit().resolveCommit(
        repository.rootPath,
        run.reviewBranchContext.headSha,
      );
      const alias = this.binding(ws, id, runtime.bindingRevision).bindings.find(
        (b) => b.repositoryId === run.repositoryId,
      )?.alias;
      const testedCommit =
        testedCode.find((c) => c.alias === alias)?.commitSha ?? input.subjectCommit;
      const expected =
        pin?.treeSha ??
        (testedCommit
          ? await this.requireGit().resolveCommit(repository.rootPath, testedCommit)
          : undefined);
      const expectedTree =
        typeof expected === 'string' ? expected : expected?.ok ? expected.value.treeSha : undefined;
      if (!reviewed.ok || reviewed.value.treeSha !== expectedTree)
        conflict('Historical review does not cover the exact current source tree.');
      source = {
        sourceRunDigest: hash(JSON.stringify({ run, turn })),
        sourceRunCommit: run.reviewBranchContext.headSha,
      };
    }
    const sliceMergeSha = expectedSubjectCommit(
      this.storage,
      ws,
      d,
      runtime.bindingRevision,
      input.subject,
    );
    const s: EvidenceSubmission = {
      ...input,
      testedCode,
      ...(testedCode.length === 1 ? { subjectCommit: testedCode[0]!.commitSha } : {}),
      ...source,
      ...(sliceMergeSha ? { sliceMergeSha } : {}),
      id: randomUUID(),
      workspaceId: ws,
      definitionId: id,
      bindingRevision: runtime.bindingRevision,
      artifacts: input.artifacts.map((a) => ({ ...a, digest: hash(a.content) })),
      createdAt: this.now().toISOString(),
      createdByUserId: context.user.id,
    };
    const issues = [
      ...submissionIssues(this.storage, d, runtime, s),
      ...(await this.evidenceFreshness(d, runtime, s)),
    ];
    if (issues.length) conflict(issues.join('\n'));
    this.storage.transaction((tx) => {
      this.workspaces.requireRole(context, ws, ['owner', 'editor']);
      if (this.current(ws, id)?.id !== runtime.id) conflict('Runtime changed while submitting.');
      tx.runtimeEvidence.addSubmission(s);
      this.changed(
        tx,
        context,
        ws,
        id,
        'evidence.submitted',
        `Evidence submitted for ${s.subject.sourceId}.`,
        s.createdAt,
      );
    });
    this.notifier.notify();
    return this.view(context, ws, id);
  }
  async decide(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    input: { submissionId: string; outcome: 'accepted' | 'rejected'; rationale: string },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const d = this.definition(ws, id),
      s = this.storage.runtimeEvidence.submissions(ws, id).find((s) => s.id === input.submissionId),
      runtime = this.current(ws, id);
    if (!s) throw new NotFoundError();
    if (input.outcome === 'accepted') {
      if (!runtime) conflict('Configure a runtime first.');
      const issues = [
        ...submissionIssues(this.storage, d, runtime, s),
        ...prerequisiteIssues(this.storage, d, s.bindingRevision, s.subject),
        ...(await this.evidenceFreshness(d, runtime, s)),
      ];
      if (issues.length) conflict(issues.join('\n'));
    }
    const at = this.now().toISOString();
    this.storage.transaction((tx) => {
      this.workspaces.requireRole(context, ws, ['owner', 'editor']);
      if (tx.runtimeEvidence.decisions(ws).some((v) => v.submissionId === s.id))
        conflict(
          'This submission already has an immutable decision. Submit new evidence to reassess.',
        );
      if (input.outcome === 'accepted' && this.current(ws, id)?.id !== runtime?.id)
        conflict('Runtime changed during review.');
      tx.runtimeEvidence.addDecision({
        ...input,
        id: randomUUID(),
        workspaceId: ws,
        decidedAt: at,
        decidedByUserId: context.user.id,
      });
      this.changed(
        tx,
        context,
        ws,
        id,
        'evidence.decided',
        `${s.subject.sourceId} evidence ${input.outcome}.`,
        at,
      );
    });
    this.notifier.notify();
    return this.view(context, ws, id);
  }
  async view(context: AuthContext, ws: WorkspaceId, id: string) {
    this.workspaces.requireAuthorized(context, ws);
    const d = this.definition(ws, id),
      binding = this.storage.imports.bindings(ws, id)[0],
      runtime = this.current(ws, id),
      decisions = this.storage.runtimeEvidence.decisions(ws);
    const subjects = [
      ...d.source.checkpoints.map((s) => ({ kind: 'checkpoint' as const, sourceId: s.id })),
      ...d.source.slices.map((s) => ({ kind: 'slice' as const, sourceId: s.id })),
      ...d.source.work_items.map((s) => ({ kind: 'parent' as const, sourceId: s.id })),
    ];
    const history = binding
      ? this.storage.runtimeEvidence.generations(ws, id, binding.revision)
      : [];
    const upstreamHistory = runtime
      ? this.storage.execution.runs.listRecent(ws, 5000).flatMap((run) => {
          const pin = runtime.pins.find((p) => p.repositoryId === run.repositoryId);
          return pin &&
            run.status === 'finished' &&
            run.role === 'review' &&
            run.reviewBranchContext
            ? [
                {
                  alias: pin.alias,
                  runId: run.id,
                  headSha: run.reviewBranchContext.headSha,
                  label: `${run.role} · ${run.finishedAt ?? run.createdAt}`,
                },
              ]
            : [];
        })
      : [];
    const builds = this.storage.execution.runs
      .listRecent(ws, 500)
      .flatMap((run) => {
        const env = this.storage.runtimeEvidence.run(ws, run.id);
        if (!env || !history.some((g) => g.id === env.runtimeId)) return [];
        const record = this.storage.runtimeEvidence.build(ws, run.id);
        if (!record) return [];
        let successfulBuilds = 0,
          error = record.error;
        try {
          successfulBuilds = record.receipts
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { success?: boolean; clean?: boolean })
            .filter((r) => r.success && r.clean).length;
        } catch {
          error = 'Malformed build record.';
        }
        return [
          {
            runId: run.id,
            runtimeId: env.runtimeId,
            digest: record.digest,
            successfulBuilds,
            ...(error ? { error } : {}),
          },
        ];
      })
      .slice(0, 30);
    return {
      issues: runtime ? await this.freshness(ws, runtime) : [],
      builds,
      bindingRevision: binding?.revision ?? 0,
      ...(runtime ? { current: runtime } : {}),
      history,
      repositories: d.source.repositories.map((r) => ({
        alias: r.id,
        role: r.role,
        configured: !!binding?.bindings.find((b) => b.alias === r.id)?.repositoryId,
        ...(binding?.bindings.find((b) => b.alias === r.id)?.integrationBranch
          ? { integrationBranch: binding.bindings.find((b) => b.alias === r.id)!.integrationBranch }
          : {}),
      })),
      subjects: subjects.map((subject) => {
        const spec = subjectRequirements(d, subject);
        return {
          subject,
          title: spec.title,
          profile: spec.profile,
          requirements: spec.requirements,
          reviewerRoles: spec.reviewerRoles,
          testedRepositories: testedRepositories(d, subject),
          cases: spec.cases,
          issues: binding
            ? prerequisiteIssues(this.storage, d, binding.revision, subject)
            : ['Bind plans first.'],
        };
      }),
      submissions: await Promise.all(
        this.storage.runtimeEvidence.submissions(ws, id).map(async (s) => ({
          submission: s,
          ...(decisions.find((v) => v.submissionId === s.id)
            ? { decision: decisions.find((v) => v.submissionId === s.id) }
            : {}),
          issues: [
            ...submissionIssues(this.storage, d, runtime, s),
            ...prerequisiteIssues(this.storage, d, s.bindingRevision, s.subject),
            ...(runtime ? await this.evidenceFreshness(d, runtime, s) : []),
          ],
        })),
      ),
      upstreamHistory,
    };
  }
  buildRecord(context: AuthContext, ws: WorkspaceId, id: string, runId: string) {
    this.workspaces.requireAuthorized(context, ws);
    this.definition(ws, id);
    const record = this.storage.runtimeEvidence.build(ws, runId);
    const generations = this.storage.imports
      .bindings(ws, id)
      .flatMap((b) => this.storage.runtimeEvidence.generations(ws, id, b.revision));
    if (!record || !generations.some((g) => g.id === record.runtimeId)) throw new NotFoundError();
    return record;
  }
  async prepare(tree: Worktree, runId: string, runDirectory: string) {
    const scope = tree.executionScope;
    if (!scope) return;
    const runtime = activeRuntime(
      this.storage,
      tree.workspaceId,
      scope.definitionId,
      scope.bindingRevision,
    );
    if (!runtime) return;
    const b = this.binding(
      tree.workspaceId,
      scope.definitionId,
      scope.bindingRevision,
    ).bindings.find((b) => b.repositoryId === tree.repositoryId);
    if (!b) conflict('Pinned consumer binding unavailable.');
    await this.assertFreshTree(tree);
    const consumer = runtime.consumers.find((c) => c.alias === b.alias);
    if (!consumer) conflict('Configure the consumer dependency environment.');

    const cargoExecutable = resolveExecutable('cargo', undefined, process.env, [
      join(homedir(), '.cargo', 'bin'),
    ]);
    if (!cargoExecutable)
      throw new ExecutionRequestError('unavailable', 'The pinned build adapter requires Cargo.');
    const directory = join(runDirectory, 'dependencies'),
      files: { path: string; digest: string }[] = [],
      supplied: { name: string; path: string }[] = [];
    for (const alias of consumer.upstreams) {
      const pin = runtime.pins.find((p) => p.alias === alias);
      if (!pin) conflict('A required pin is unavailable.');
      const repo = this.storage.execution.sourceRepositories.find(
        tree.workspaceId,
        pin.repositoryId,
      );
      if (!repo) conflict('Pinned repository unavailable.');
      const exported = await this.requireGit().exportCommit(repo.rootPath, pin.commitSha);
      if (!exported.ok) conflict(exported.failure.message);
      const root = join(
        runDirectory,
        'scratch',
        'dependencies',
        `source-${runtime.pins.indexOf(pin)}`,
      );
      for (const file of exported.value) {
        const path = join(root, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.content, { mode: file.executable ? 0o500 : 0o400 });
        files.push({ path, digest: hash(file.content) });
      }
      supplied.push(...pin.packages.map((p) => ({ name: p.name, path: join(root, p.path) })));
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const configPath = join(directory, 'pins.toml');
    const config =
      '[patch.crates-io]\n' +
      supplied
        .map((p) => `${JSON.stringify(p.name)} = { path = ${JSON.stringify(p.path)} }`)
        .join('\n') +
      '\n';
    writeFileSync(configPath, config, { mode: 0o400 });
    const gitExecutable = resolveExecutable('git', undefined);
    if (!gitExecutable)
      throw new ExecutionRequestError(
        'unavailable',
        'Git is required for pinned build provenance.',
      );
    const manifest: PinnedCargoManifest = {
      gitExecutable,
      runtimeId: runtime.id,
      runId,
      cargoExecutable,
      workspacePath: tree.path,
      targetDirectory: join(runDirectory, 'scratch', 'target'),
      packages: supplied,
      files,
      configPath,
      configDigest: hash(config),
      receiptPath: join(directory, 'build-receipts.jsonl'),
    };
    const launch = prepareCargoLauncher(directory, manifest);
    return { ...launch, runtimeId: runtime.id };
  }
  assertRun(tree: Worktree, runId: string) {
    const scope = tree.executionScope;
    if (!scope) return;
    const runtime = activeRuntime(
      this.storage,
      tree.workspaceId,
      scope.definitionId,
      scope.bindingRevision,
    );
    if (!runtime) return;
    const env = this.storage.runtimeEvidence.run(tree.workspaceId, runId);
    const alias = this.binding(
      tree.workspaceId,
      scope.definitionId,
      scope.bindingRevision,
    ).bindings.find((b) => b.repositoryId === tree.repositoryId)?.alias;
    if (!runtime.consumers.find((c) => c.alias === alias)?.upstreams.length) return;
    if (!env || env.runtimeId !== runtime.id)
      conflict('Review uses an obsolete dependency environment. Run a fresh review.');
    try {
      const record = this.storage.runtimeEvidence.build(tree.workspaceId, runId);
      if (!record || record.error || record.manifestDigest !== env.manifestDigest)
        conflict('The review has no valid frozen pinned build record.');
      const run = this.storage.execution.runs.find(tree.workspaceId, asAgentRunId(runId));
      const receipts = record.receipts
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              success: boolean;
              clean: boolean;
              headSha: string;
              manifestDigest: string;
              runId: string;
              runtimeId: string;
            },
        );
      if (
        !receipts.some(
          (r) =>
            r.success &&
            r.clean &&
            r.headSha === run?.reviewBranchContext?.headSha &&
            r.manifestDigest === env.manifestDigest &&
            r.runId === runId &&
            r.runtimeId === runtime.id,
        )
      )
        conflict(
          'The review needs a successful pinned Cargo build/test on its exact clean reviewed commit.',
        );
    } catch (error) {
      if (error instanceof ExecutionRequestError) throw error;
      conflict(
        'A successful pinned Cargo build/test receipt is required before accepting this review.',
      );
    }
  }
  freezeRun(tx: StorageRepositories, ws: WorkspaceId, runId: string) {
    const env = tx.runtimeEvidence.run(ws, runId);
    if (!env || tx.runtimeEvidence.build(ws, runId)) return;
    let receipts = '',
      error: string | undefined;
    try {
      const raw = readFileSync(env.manifestPath, 'utf8');
      if (hash(raw) !== env.manifestDigest) throw new Error('Pinned manifest changed.');
      const m = JSON.parse(raw) as PinnedCargoManifest;
      if (statSync(m.receiptPath).size > 4 * 1024 * 1024)
        throw new Error('Build receipts exceed 4 MiB.');
      receipts = readFileSync(m.receiptPath, 'utf8');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Build record unavailable.';
    }
    tx.runtimeEvidence.addBuild({
      runId,
      workspaceId: ws,
      runtimeId: env.runtimeId,
      manifestDigest: env.manifestDigest,
      receipts,
      digest: hash(receipts),
      ...(error ? { error } : {}),
    });
  }
  async assertSubjectsCurrent(
    ws: WorkspaceId,
    definitionId: string,
    bindingRevision: number,
    subjects: readonly EvidenceSubject[],
  ) {
    const d = this.definition(ws, definitionId),
      runtime = this.current(ws, definitionId);
    if (!runtime || runtime.bindingRevision !== bindingRevision)
      conflict('The selected scope needs a current pinned environment and checkpoint evidence.');
    for (const subject of subjects) {
      const evidence = acceptedEvidence(this.storage, ws, definitionId, bindingRevision, subject);
      if (!evidence)
        conflict(`Current independently accepted evidence is required for ${subject.sourceId}.`);
      const issues = await this.evidenceFreshness(d, runtime, evidence);
      if (issues.length) conflict(issues.join(' '));
    }
  }
  async assertFreshTree(tree: Worktree, transition?: 'start' | 'merge' | 'verify' | 'accept') {
    const scope = tree.executionScope;
    if (!scope) return;
    const runtime = activeRuntime(
      this.storage,
      tree.workspaceId,
      scope.definitionId,
      scope.bindingRevision,
    );
    if (!runtime) return;
    const d = this.definition(tree.workspaceId, scope.definitionId),
      binding = this.binding(tree.workspaceId, d.id, scope.bindingRevision);
    const alias = binding.bindings.find((b) => b.repositoryId === tree.repositoryId)?.alias;
    const issues = await this.freshness(tree.workspaceId, runtime, alias);
    const phase =
      transition ??
      (scope.kind === 'slice-verification'
        ? 'verify'
        : scope.kind === 'parent-acceptance'
          ? 'accept'
          : 'start');
    const seen = new Set<string>();
    const check = async (subject: EvidenceSubject, root = false) => {
      const key = `${subject.kind}:${subject.sourceId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const spec = subjectRequirements(d, subject);
      const evidence = acceptedEvidence(
        this.storage,
        tree.workspaceId,
        d.id,
        scope.bindingRevision,
        subject,
      );
      if (evidence && (!root || phase === 'verify' || phase === 'accept'))
        issues.push(...(await this.evidenceFreshness(d, runtime, evidence)));
      const reqs =
        spec.checkpoint?.requires ??
        (spec.slice
          ? [
              ...spec.slice.start_requires,
              ...(!root || phase !== 'start' ? spec.slice.merge_requires : []),
              ...(!root || phase === 'verify' ? spec.slice.verify_requires : []),
            ]
          : (spec.parent?.acceptance_requires ?? []));
      for (const req of reqs)
        if (req.kind === 'checkpoint' || (req.kind === 'slice' && req.state === 'verified'))
          await check({ kind: req.kind, sourceId: req.id });
      if (spec.parent)
        for (const slice of [
          ...spec.parent.required_slices,
          ...spec.parent.profile_evidence_slices,
        ])
          await check({ kind: 'slice', sourceId: slice });
    };
    await check(
      {
        kind: scope.kind === 'parent-acceptance' ? 'parent' : 'slice',
        sourceId: scope.sourceId,
      },
      true,
    );
    if (issues.length) conflict([...new Set(issues)].join('\n'));
  }
  private changed(
    tx: StorageRepositories,
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    action: 'runtime.configured' | 'evidence.submitted' | 'evidence.decided',
    message: string,
    at: string,
  ) {
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: at,
      actorKind: 'user',
      actorUserId: context.user.id,
      workspaceId: ws,
      action,
      targetType: 'concurrency-definition',
      targetId: id,
      outcome: 'succeeded',
      metadata: {},
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt: at,
      workspaceId: ws,
      actorUserId: context.user.id,
      kind: 'runtime-evidence-changed',
      payload: { definitionId: id, message },
    });
  }
}
