import {
  currentDecisionPreparation,
  decisionPreparationForRun,
} from './decision-preparation-policy.js';
import { workflowContext, workflowDelegation } from './workflow-policy.js';
import { parseWorkflowReport } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { worktreePlan, repositoryPolicyEvidence } from './repository-policy.js';
import { checkpointDigest, candidateCheckpointIssues } from './checkpoint-candidate-policy.js';
import { resolveScope, scopeEvidenceIssues } from './execution-scope.js';
import { finalizationHasNoQuestions } from './finalization-policy.js';
import { architectureDecisionInbox } from './architecture-decision-inbox.js';
import {
  architectureDecisionIssues,
  architectureDecisionDigest,
  decisionBindingDigest,
  supportsArchitectureDecision,
} from './architecture-decision-policy.js';
import {
  nativeApproval,
  needsNativeVerification,
  needsNativeEvidence,
} from './native-verification-policy.js';
import { buildVerificationPolicy } from './build-verification-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { relevantPinAliases } from './runtime-input-policy.js';
import { runtimeRefreshImpact, queueRuntimeReviews } from './runtime-refresh.js';
import {
  PLAN_CHECKPOINT,
  savedPlanSnapshot,
  generatedPlanIssues,
} from './plan-acceptance-policy.js';
import { assertFinalizationMap, providerBranch } from './map-finalization-policy.js';
import { randomUUID } from 'node:crypto';
import { homedir, hostname, platform, release, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import {
  auditNativeEnvironment,
  cargoManifestDigest as hash,
  prepareCargoLauncher,
  loadLocalCiConfig,
  cleanupLocalCiManifest,
  prepareLocalCheckLaunchers,
  observeRustToolchain,
  type PinnedCargoManifest,
} from '@craftingtable/agents';
import {
  proposeArchitectureDecisionSchema,
  checkpointRecoverySchema,
  type ProposeArchitectureDecision,
  configureRuntimeSchema,
  evidenceSubmissionRequestSchema,
  type ConfigureRuntime,
  type EvidenceSubmissionRequest,
  type RuntimePinStatus,
  type RuntimeRefreshPreview,
  type ApplyRuntimeRefresh,
  type CheckpointRecovery,
} from '@craftingtable/contracts';
import {
  asAgentRunId,
  asWorktreeId,
  asAuditEventId,
  asEventId,
  canonicalDefinition,
  type ConcurrencyDefinition,
  type EvidenceSubmission,
  type EvidenceSubject,
  type RuntimeGeneration,
  type WorkspaceId,
  type Worktree,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext, CommandContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { resolveExecutable } from './executables.js';
import {
  activeRuntime,
  subjectRequirements,
  submissionIssues,
  prerequisiteGaps,
  prerequisiteIssues,
  expectedSubjectCommit,
  acceptedEvidence,
  testedRepositories,
  requiredUpstreams,
  evidenceInputs,
  scopeRuntimeChanges,
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
  async auditNative(context: AuthContext, ws: WorkspaceId, id: string) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    this.definition(ws, id);
    return auditNativeEnvironment();
  }
  async approveNative(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    input: import('@craftingtable/contracts').NativeApprovalRequest,
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    this.definition(ws, id);
    const audit = input.approved ? await auditNativeEnvironment() : undefined;
    if (audit && (!audit.ready || audit.auditDigest !== input.auditDigest))
      conflict('Workstation audit changed or is incomplete. Audit again before approving.');
    this.storage.transaction((tx) => {
      this.workspaces.requireRole(context, ws, ['owner', 'editor']);
      const runtime = activeRuntime(tx, ws, id, input.bindingRevision);
      const prior = tx.runtimeEvidence.nativeApprovals(ws, id, input.bindingRevision)[0];
      if (
        !runtime ||
        runtime.id !== input.runtimeId ||
        (prior?.id ?? null) !== input.expectedApprovalId
      )
        conflict('Environment or approval changed. Refresh before saving.');
      if (!audit && !prior) conflict('No native approval to revoke.');
      const at = this.now().toISOString();
      tx.runtimeEvidence.addNativeApproval({
        id: randomUUID(),
        workspaceId: ws,
        definitionId: id,
        bindingRevision: input.bindingRevision,
        runtimeId: runtime.id,
        approved: input.approved,
        hostDigest: audit?.hostDigest ?? prior!.hostDigest,
        auditDigest: audit?.auditDigest ?? prior!.auditDigest,
        audit: audit?.facts ?? prior!.audit,
        rationale: input.rationale,
        createdAt: at,
        createdByUserId: context.user.id,
      });
      this.changed(
        tx,
        context,
        ws,
        id,
        'runtime.configured',
        input.approved
          ? 'Managed native verification approved. No test results or Kata authority granted.'
          : 'Managed native verification revoked.',
        at,
      );
    });
    this.notifier.notify();
    return this.view(context, ws, id);
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
    if (repo?.status !== 'active') conflict('Choose an active repository binding first.');
    const commit = await this.requireGit().resolveCommit(repo.rootPath, input.ref);
    if (!commit.ok) conflict(commit.failure.message);
    const exported = await this.requireGit().exportCommit(repo.rootPath, commit.value.commitSha);
    if (!exported.ok) conflict(exported.failure.message);
    return { ...commit.value, packages: packages(exported.value) };
  }
  async discover(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    input: { bindingRevision: number; refs: { alias: string; ref: string }[] },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const d = this.definition(ws, id),
      binding = this.binding(ws, id, input.bindingRevision);
    if (this.storage.imports.bindings(ws, id)[0]?.revision !== binding.revision)
      conflict('The map binding changed. Refresh before discovering setup.');
    if (
      new Set(input.refs.map((r) => r.alias)).size !== input.refs.length ||
      input.refs.some((r) => !binding.bindings.some((b) => b.alias === r.alias))
    )
      conflict('Choose each bound repository ref at most once.');
    const current = this.current(ws, id);
    const consumers = d.source.repositories
      .filter((r) => r.role === 'planned_application')
      .map((r) => ({ alias: r.id, upstreams: requiredUpstreams(d, r.id) }));
    const aliases = new Set(consumers.flatMap((c) => c.upstreams));
    const pins: ConfigureRuntime['pins'] = [];
    for (const alias of aliases) {
      const b = binding.bindings.find((b) => b.alias === alias);
      const repo =
        b?.repositoryId && this.storage.execution.sourceRepositories.find(ws, b.repositoryId);
      if (!b || !repo || repo.status !== 'active')
        conflict(`Bind an active repository for ${alias} before discovery.`);
      const ref =
        input.refs.find((r) => r.alias === alias)?.ref ??
        providerBranch(this.storage, ws, b) ??
        repo.defaultBranch;
      if (!ref) conflict(`Choose the branch or commit for ${alias}.`);
      const observed = await this.inspect(context, ws, id, {
        bindingRevision: binding.revision,
        alias,
        ref,
      });
      if (!observed.packages.length)
        conflict(`No publishable Cargo packages were found for ${alias} at ${ref}.`);
      const baseline = d.source.aq_baseline_binding;
      if (
        baseline?.repository === alias &&
        (observed.commitSha === baseline.historical_pre_contract_commit ||
          observed.packages.some((p) => p.version !== baseline.crate_version))
      )
        conflict(
          `${alias} must point to the implemented baseline with Cargo version ${baseline.crate_version}.`,
        );
      pins.push({
        alias,
        ref,
        expectedCommitSha: observed.commitSha,
        packages: observed.packages,
        conformanceRevision:
          baseline?.repository === alias
            ? String(baseline.conformance_package_revision)
            : (current?.pins.find((p) => p.alias === alias)?.conformanceRevision ??
              (b.planVersionId ? `plan-version:${b.planVersionId}` : `map:${d.revision}`)),
      });
    }
    const cargo = resolveExecutable('cargo', undefined, process.env, [
      join(homedir(), '.cargo', 'bin'),
    ]);
    const rustc = resolveExecutable('rustc', undefined, process.env, [
      join(homedir(), '.cargo', 'bin'),
    ]);
    if (!cargo || !rustc)
      conflict('Local discovery requires installed Cargo and rustc executables.');
    const observations = [];
    for (const consumer of consumers) {
      const b = binding.bindings.find((b) => b.alias === consumer.alias);
      const repo =
        b?.repositoryId && this.storage.execution.sourceRepositories.find(ws, b.repositoryId);
      if (repo?.status !== 'active')
        conflict(
          `Configure the ${consumer.alias} plan repository and integration branch before discovery.`,
        );
      const toolchain = await observeRustToolchain({ cargo, rustc }, repo.rootPath).catch(() =>
        conflict(
          `Could not observe the installed Rust toolchain for ${consumer.alias}. Check that Cargo and rustc work in its registered checkout; discovery does not install toolchains.`,
        ),
      );
      observations.push({ repository: consumer.alias, ...toolchain });
    }
    const discovery = {
      kind: 'local-discovery-v1' as const,
      environment: JSON.stringify(
        {
          host: hostname(),
          platform: platform(),
          release: release(),
          architecture: arch(),
          scope:
            'Local development on the CraftingTable daemon host; no native or Kata qualification.',
        },
        null,
        2,
      ),
      fixtures: JSON.stringify(
        {
          description:
            'Imported source and case manifests for local development; no executed fixture or test result is asserted.',
          definitionDigest: d.digest,
          bindingRevision: binding.revision,
          sources: binding.bindings
            .flatMap((b) =>
              b.sourceArtifacts.map((a) => ({
                alias: b.alias,
                source: a.sourceId,
                digest: a.sha256,
              })),
            )
            .sort((a, b) => `${a.alias}:${a.source}`.localeCompare(`${b.alias}:${b.source}`)),
        },
        null,
        2,
      ),
      toolchains: JSON.stringify(
        {
          description:
            'Installed toolchains observed in the registered consumer checkouts. Actual run builds retain separate provenance.',
          observations,
        },
        null,
        2,
      ),
    };
    if (
      this.storage.imports.bindings(ws, id)[0]?.revision !== binding.revision ||
      this.current(ws, id)?.id !== current?.id
    )
      conflict('The binding or runtime changed during discovery. Refresh and try again.');
    return {
      configuration: configureRuntimeSchema.parse({
        bindingRevision: binding.revision,
        expectedGeneration: current?.generation ?? 0,
        pins,
        consumers,
        environments: [
          ...(current?.environments.filter((e) => e.id !== 'craftingtable-local-development') ??
            []),
          {
            id: 'craftingtable-local-development',
            kind: 'local-development',
            discovery,
            identityDigest: hash(discovery.environment),
            fixtureDigest: hash(discovery.fixtures),
            toolchainDigest: hash(discovery.toolchains),
            authorization:
              'Local development on this daemon host using the selected dependency pins. External native/Kata qualification is not authorized.',
          },
        ],
      }),
      notes: [
        'Discovery is a draft. Review the commits and captured inputs, then explicitly save the dependency environment.',
        'For planned upstreams, the suggested conformance identity names the exact imported plan version; it does not claim that conformance has passed.',
        'The fixture fingerprint identifies imported planning/case sources. Native/Kata execution and qualification fixtures require separate reviewed evidence.',
      ],
    };
  }
  private refreshBlockers(ws: WorkspaceId, id: string): string[] {
    const tx = this.storage,
      issues: string[] = [];
    const roadmaps = tx.roadmaps
      .list(ws)
      .filter((r) => r.definition.crossProject?.definitionId === id);
    if (roadmaps.some((r) => r.status === 'running'))
      issues.push('Pause roadmap scheduling before refreshing dependencies.');
    const trees = tx.execution.worktrees
      .listActive(ws)
      .filter((t) => t.executionScope?.definitionId === id);
    for (const tree of trees) {
      if (
        tx.execution.runs
          .listForWorktree(ws, tree.id)
          .some((r) => !['finished', 'failed', 'cancelled', 'interrupted'].includes(r.status))
      )
        issues.push(`Wait for or end the live session in ${tree.branchName}.`);
      const cycle = tx.execution.cycles.activeForWorktree(ws, tree.id);
      if (cycle && ['running', 'queued'].includes(cycle.status))
        issues.push(`Pause the cycle in ${tree.branchName}.`);
      if (tx.execution.merges.latest(ws, tree.id)?.status === 'reserved')
        issues.push(`Finish the pending merge in ${tree.branchName}.`);
      if (
        cycle?.integrationResolution &&
        !['completed', 'abandoned'].includes(cycle.integrationResolution.status)
      )
        issues.push(`Finish or abandon conflict resolution in ${tree.branchName}.`);
    }
    if (tx.phaseScheduling.active().some((p) => trees.some((t) => t.id === p.worktreeId)))
      issues.push('Wait for the current phase reservations to be released.');
    if (
      tx.execution.finalizations
        .list(ws)
        .some(
          (f) => f.mapContext?.definitionId === id && !['stopped', 'completed'].includes(f.status),
        )
    )
      issues.push('Finish or stop the active finalization before changing its pinned environment.');
    if (roadmaps.some((r) => tx.amendments.pending(ws, r.id)))
      issues.push('Resolve the pending roadmap amendment first.');
    return [...new Set(issues)];
  }
  private refreshProjection(
    ws: WorkspaceId,
    id: string,
    current: RuntimeGeneration,
    pins: RuntimeGeneration['pins'],
  ): RuntimeRefreshPreview {
    const data = { pins, consumers: current.consumers, environments: current.environments };
    const candidate: RuntimeGeneration = {
      ...current,
      ...data,
      id: '00000000-0000-4000-8000-000000000000',
      generation: current.generation + 1,
      digest: hash(canonicalDefinition(data)),
    };
    const impact = runtimeRefreshImpact(this.storage, this.definition(ws, id), candidate);
    const blockers = this.refreshBlockers(ws, id);
    if (
      pins.every((p) =>
        current.pins.some((old) => canonicalDefinition(old) === canonicalDefinition(p)),
      )
    )
      blockers.push(
        'Dependency pins are already current. No new generation is needed; review plan acceptance instead.',
      );
    const facts = {
      runtime: current,
      data,
      impact,
      blockers,
      roadmaps: this.storage.roadmaps
        .list(ws)
        .filter((r) => r.definition.crossProject?.definitionId === id)
        .map((r) => ({ id: r.id, version: r.version })),
      cycles: this.storage.execution.cycles
        .listForWorkspace(ws)
        .filter((c) => c.executionScope?.definitionId === id)
        .map((c) => ({ id: c.id, version: c.version, runId: c.currentRunId })),
      approval: this.storage.runtimeEvidence.nativeApprovals(ws, id, current.bindingRevision)[0],
    };
    return {
      bindingRevision: current.bindingRevision,
      expectedGeneration: current.generation,
      snapshotDigest: hash(canonicalDefinition(facts)),
      ...impact,
      blockers,
      pins: pins.map((p) => ({
        alias: p.alias,
        ref: p.ref,
        before: current.pins.find((old) => old.alias === p.alias)!.commitSha,
        after: p.commitSha,
        changed:
          canonicalDefinition(p) !==
          canonicalDefinition(current.pins.find((old) => old.alias === p.alias)),
      })),
    };
  }
  private async refreshedPins(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    input: { bindingRevision: number; expectedGeneration: number },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const current = this.current(ws, id);
    if (
      !current ||
      current.generation !== input.expectedGeneration ||
      current.bindingRevision !== input.bindingRevision
    )
      conflict('The saved dependency generation changed. Refresh the preview.');
    const binding = this.binding(ws, id, input.bindingRevision);
    const pins: RuntimeGeneration['pins'][number][] = [];
    for (const pin of current.pins) {
      const b = binding.bindings.find((b) => b.alias === pin.alias);
      const ref = (b && providerBranch(this.storage, ws, b)) ?? pin.ref;
      const observed = await this.inspect(context, ws, id, {
        bindingRevision: input.bindingRevision,
        alias: pin.alias,
        ref,
      });
      const packages = pin.packages.map((saved) => {
        const pkg = observed.packages.find((p) => p.name === saved.name && p.path === saved.path);
        if (!pkg)
          conflict(
            `The ${pin.alias} package mapping for ${saved.name} is no longer available. Review the advanced dependency setup before refreshing.`,
          );
        return pkg;
      });
      if (packages.length !== observed.packages.length)
        conflict(
          `The ${pin.alias} Cargo package set changed. Inspect and review its crate mappings in the advanced dependency setup.`,
        );
      pins.push({ ...pin, ref, ...observed, packages });
    }
    if (this.current(ws, id)?.id !== current.id)
      conflict('The dependency generation changed during inspection. Preview again.');
    return { current, pins };
  }
  async previewRefresh(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    input: { bindingRevision: number; expectedGeneration: number },
  ) {
    const { current, pins } = await this.refreshedPins(context, ws, id, input);
    return this.refreshProjection(ws, id, current, pins);
  }
  async refresh(context: AuthContext, ws: WorkspaceId, id: string, input: ApplyRuntimeRefresh) {
    const { current, pins } = await this.refreshedPins(context, ws, id, input);
    const preview = this.refreshProjection(ws, id, current, pins);
    if (preview.snapshotDigest !== input.snapshotDigest)
      conflict('The dependency refresh impact changed. Preview and review it again.');
    if (preview.blockers.length) conflict(preview.blockers.join(' '));
    return this.configure(
      context,
      ws,
      id,
      {
        bindingRevision: current.bindingRevision,
        expectedGeneration: current.generation,
        pins: pins.map((p) => ({
          alias: p.alias,
          ref: p.ref,
          expectedCommitSha: p.commitSha,
          conformanceRevision: p.conformanceRevision,
          packages: [...p.packages],
        })),
        consumers: current.consumers.map((c) => ({ alias: c.alias, upstreams: [...c.upstreams] })),
        environments: [...current.environments],
      },
      input,
    );
  }
  async configure(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    raw: ConfigureRuntime,
    refresh?: ApplyRuntimeRefresh,
  ) {
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
    for (const env of input.environments) {
      if (
        env.discovery &&
        (env.kind !== 'local-development' ||
          hash(env.discovery.environment) !== env.identityDigest ||
          hash(env.discovery.fixtures) !== env.fixtureDigest ||
          hash(env.discovery.toolchains) !== env.toolchainDigest)
      )
        conflict(
          'Discovered local fingerprints must match their captured inputs and cannot qualify external environments.',
        );
    }
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
      const current = activeRuntime(tx, ws, id, input.bindingRevision);
      const blockers = current ? this.refreshBlockers(ws, id) : [];
      if (blockers.length) conflict(blockers.join(' '));
      if (
        refresh &&
        (!current ||
          this.refreshProjection(ws, id, current, pins).snapshotDigest !== refresh.snapshotDigest)
      )
        conflict('The dependency refresh impact changed during save. Preview and review it again.');
      const generation: RuntimeGeneration = {
        id: randomUUID(),
        workspaceId: ws,
        definitionId: id,
        bindingRevision: input.bindingRevision,
        generation: input.expectedGeneration + 1,
        digest: hash(JSON.stringify(data)),
        ...data,
        createdAt: at,
        createdByUserId: context.user.id,
      };
      const impact = runtimeRefreshImpact(tx, d, generation);
      tx.runtimeEvidence.addGeneration(generation);
      queueRuntimeReviews(tx, context, generation, impact.reviews, at);
      this.changed(
        tx,
        context,
        ws,
        id,
        'runtime.configured',
        'Pinned dependency environment configured.',
        at,
        {
          generation: generation.generation,
          previousRuntimeId: current?.id ?? null,
          ...(refresh
            ? { refreshDigest: refresh.snapshotDigest, rationale: refresh.rationale }
            : {}),
          retainedEvidenceIds: impact.evidence
            .filter((e) => e.disposition === 'retained')
            .map((e) => e.id),
          reviews: impact.reviews.map((r) => ({ sourceId: r.sourceId, action: r.action })),
        },
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
    const required = consumerAlias
      ? runtime.consumers.find((c) => c.alias === consumerAlias)?.upstreams
      : undefined;
    return [
      ...(this.current(ws, runtime.definitionId)?.id !== runtime.id
        ? ['The runtime generation or plan binding has changed.']
        : []),
      ...(await this.pinStatus(ws, runtime, required)).flatMap((p) => (p.issue ? [p.issue] : [])),
    ];
  }
  private async pinStatus(
    ws: WorkspaceId,
    runtime: RuntimeGeneration,
    aliases?: readonly string[],
  ): Promise<RuntimePinStatus[]> {
    const result: RuntimePinStatus[] = [];
    const binding = this.binding(ws, runtime.definitionId, runtime.bindingRevision);
    for (const pin of runtime.pins.filter((p) => !aliases || aliases.includes(p.alias))) {
      const b = binding.bindings.find((b) => b.alias === pin.alias),
        repo = this.storage.execution.sourceRepositories.find(ws, pin.repositoryId);
      const ref = (b && providerBranch(this.storage, ws, b)) ?? pin.ref;
      const status = { alias: pin.alias, ref, savedCommitSha: pin.commitSha };
      if (repo?.status !== 'active' || b?.repositoryId !== repo.id) {
        result.push({ ...status, issue: `Pinned repository ${pin.alias} is unavailable.` });
        continue;
      }
      const head = await this.requireGit().resolveCommit(repo.rootPath, ref);
      result.push({
        ...status,
        ...(head.ok ? { currentCommitSha: head.value.commitSha } : {}),
        ...(!head.ok
          ? { issue: `${pin.alias} provider ref is unavailable. Check its repository binding.` }
          : head.value.commitSha !== pin.commitSha
            ? {
                issue: `${pin.alias} integration changed. Preview dependency refresh to review the new pin and affected evidence.`,
              }
            : {}),
      });
    }
    return result;
  }
  private async evidenceFreshness(
    d: ConcurrencyDefinition,
    runtime: RuntimeGeneration,
    s: EvidenceSubmission,
    knownFreshness?: readonly RuntimePinStatus[],
  ) {
    if (s.architectureDecision) return architectureDecisionIssues(this.storage, d, s);
    const aliases = relevantPinAliases(runtime, evidenceInputs(d, s.subject));
    const issues = (knownFreshness ?? (await this.pinStatus(d.workspaceId, runtime, aliases)))
      .filter((p) => aliases.includes(p.alias))
      .flatMap((p) => (p.issue ? [p.issue] : []));
    const binding = this.binding(d.workspaceId, d.id, s.bindingRevision);
    if (s.candidateCheckpoint) issues.push(...(await this.candidateFreshness(s)));
    for (const code of s.testedCode ?? []) {
      if (s.candidateCheckpoint) continue;
      const b = binding.bindings.find((b) => b.alias === code.alias);
      const repo =
        b?.repositoryId &&
        this.storage.execution.sourceRepositories.find(d.workspaceId, b.repositoryId);
      const head =
        repo && repo.status === 'active' && b && providerBranch(this.storage, d.workspaceId, b)
          ? await this.requireGit().resolveBranch(
              repo.rootPath,
              providerBranch(this.storage, d.workspaceId, b)!,
            )
          : undefined;
      if (!head?.ok || head.value !== code.commitSha)
        issues.push(
          `Evidence must identify the current integration commit for its subject (${code.alias}).`,
        );
    }
    if (!s.generatedPlan && !s.candidateCheckpoint && !s.testedCode?.length && !runtime.pins.length)
      issues.push('Identify the tested code with consumer commits or upstream pins.');
    return issues;
  }
  private async candidateFreshness(s: EvidenceSubmission): Promise<string[]> {
    const c = s.candidateCheckpoint;
    if (!c) return [];
    const issues = candidateCheckpointIssues(this.storage, s);
    const tree = this.storage.execution.worktrees.find(s.workspaceId, asWorktreeId(c.worktreeId));
    const repo =
      tree && this.storage.execution.sourceRepositories.find(s.workspaceId, tree.repositoryId);
    if (!tree || !repo || repo.status !== 'active' || !tree.integrationBranch)
      return [...issues, 'The candidate repository or integration branch is unavailable.'];
    const git = this.requireGit();
    const target = await git.resolveCommit(repo.rootPath, tree.integrationBranch);
    if (tree.mergeSha) {
      if (
        !target.ok ||
        target.value.commitSha !== tree.mergeSha ||
        target.value.treeSha !== c.treeSha
      )
        issues.push(
          'Integration changed after this candidate was merged. Prepare fresh checkpoint evidence.',
        );
    } else {
      const source = await git.inspectRepository(tree.path);
      if (
        !source.ok ||
        source.value.headSha !== c.headSha ||
        !source.value.clean ||
        source.value.branch !== tree.branchName
      )
        issues.push('The candidate must remain clean at its exact reviewed commit.');
      if (!target.ok || target.value.commitSha !== c.integrationSha)
        issues.push(
          'Integration advanced after this review. Update the slice and obtain a fresh review.',
        );
      const ancestor = await git.isAncestor(repo.rootPath, c.integrationSha, c.headSha);
      if (!ancestor.ok || !ancestor.value)
        issues.push('The candidate must include its reviewed integration baseline.');
    }
    const plan = worktreePlan(this.storage, tree);
    if (plan && this.storage.execution.branchSettings.find(s.workspaceId, plan))
      issues.push(
        ...(
          await repositoryPolicyEvidence(
            this.storage,
            git,
            s.workspaceId,
            plan,
            this.now().toISOString(),
          )
        ).issues,
      );
    try {
      this.assertRun(tree, c.runId);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Candidate build evidence is stale.');
    }
    // A launch/retarget during asynchronous inspection cannot retain the older approval.
    issues.push(...candidateCheckpointIssues(this.storage, s));
    return [...new Set(issues)];
  }

  async checkpointRecovery(
    context: CommandContext,
    ws: WorkspaceId,
    id: string,
    worktreeId: string,
    delegated = false,
  ): Promise<CheckpointRecovery> {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const d = this.definition(ws, id),
      runtime = this.current(ws, id);
    const tree = this.storage.execution.worktrees.find(ws, asWorktreeId(worktreeId));
    if (
      !tree ||
      tree.executionScope?.definitionId !== id ||
      tree.executionScope.kind !== 'slice' ||
      !tree.workItemId
    )
      throw new NotFoundError();
    const scope = resolveScope(this.storage, ws, tree.workItemId, tree.executionScope);
    const ids = new Set(
      scope.slice?.merge_requires.filter((r) => r.kind === 'checkpoint').map((r) => r.id),
    );
    const checkpoints = d.source.checkpoints.filter(
      (c) =>
        ids.has(c.id) &&
        (delegated
          ? ['contract', 'profile', 'semantic_review'].includes(c.kind)
          : c.kind === 'contract' && c.evidence_profile === 'contract-checkpoint'),
    );
    const run = this.storage.execution.runs.listForWorktree(ws, tree.id)[0];
    const turn = run && this.storage.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
    const report = turn?.kind === 'turn-completed' ? turn.payload.resultText : '';
    const assessment = turn?.kind === 'turn-completed' ? turn.payload.reviewReport : undefined;
    const build = run && this.storage.runtimeEvidence.build(ws, run.id);
    const binding = this.binding(ws, id, tree.executionScope.bindingRevision);
    const alias = binding.bindings.find((b) => b.repositoryId === tree.repositoryId)?.alias;
    const repo = this.storage.execution.sourceRepositories.find(ws, tree.repositoryId);
    const commit =
      run?.reviewBranchContext && repo
        ? await this.requireGit().resolveCommit(repo.rootPath, run.reviewBranchContext.headSha)
        : undefined;
    const commonIssues: string[] = [];
    if (!runtime || runtime.bindingRevision !== tree.executionScope.bindingRevision)
      commonIssues.push('Configure the current dependency environment first.');
    if (tree.mergeSha)
      commonIssues.push('This candidate has already merged; use its retained checkpoint evidence.');
    if (
      run?.role !== 'review' ||
      run.status !== 'finished' ||
      run.verdict !== 'mergeable' ||
      !run.reviewBranchContext ||
      turn?.kind !== 'turn-completed' ||
      turn.payload.outcome !== 'success' ||
      turn.payload.truncated ||
      assessment?.status !== 'complete' ||
      !assessment.report.exitGate.met ||
      assessment.report.findings.some((f) => f.status === 'open' && f.severity !== 'nit') ||
      !finalizationHasNoQuestions(report)
    )
      commonIssues.push(
        'Finish a successful, question-free review with no unresolved blocking, major or minor findings.',
      );
    if (assessment?.status === 'complete')
      commonIssues.push(...scopeEvidenceIssues(scope, assessment.report.scopeEvidence));
    if (!build || build.error || !commit?.ok || !alias)
      commonIssues.push('The exact reviewed commit and frozen build evidence are required.');
    if ([report, build?.receipts ?? ''].some((text) => Buffer.byteLength(text) > 512 * 1024))
      commonIssues.push(
        'The retained report or receipts exceed the checkpoint packet limit; use a bounded external evidence package.',
      );
    const candidates: unknown[] = [];
    for (const checkpoint of checkpoints) {
      const subject = { kind: 'checkpoint' as const, sourceId: checkpoint.id };
      const spec = subjectRequirements(d, subject, scope.scope.sourceId);
      const gaps = prerequisiteGaps(this.storage, d, scope.scope.bindingRevision, subject);
      const issues = [...commonIssues, ...gaps.map((gap) => gap.message)];
      const prerequisiteCheckpoints = gaps.flatMap((gap) =>
        gap.checkpointId ? [gap.checkpointId] : [],
      );
      if (spec.cases.some((c) => c.requiresKata))
        issues.push('This checkpoint requires separately qualified external evidence.');
      const requiredCode = testedRepositories(d, subject);
      if (
        !(
          (requiredCode.length === 1 && requiredCode[0] === alias) ||
          (delegated && checkpoint.kind === 'semantic_review' && requiredCode.length === 0)
        )
      )
        issues.push(
          'This checkpoint requires evidence from multiple or different consumer repositories.',
        );
      const workflow = parseWorkflowReport(report);
      if (delegated) {
        const attestation = workflow.status === 'complete' ? workflow.report.checkpoint : undefined;
        if (
          !attestation ||
          attestation.id !== checkpoint.id ||
          !attestation.passed ||
          spec.requirements.some(
            (r) => !attestation.requirements.some((a) => a.requirement === r && a.evidence.trim()),
          ) ||
          attestation.requirements.some((a) => !spec.requirements.includes(a.requirement)) ||
          spec.cases.some((c) => !attestation.caseIds.includes(c.id))
        )
          issues.push(
            'A complete, passing independent checkpoint attestation is required for every exact requirement and case.',
          );
      }
      for (const c of spec.cases)
        if (
          assessment?.status !== 'complete' ||
          !(
            delegated && workflow.status === 'complete'
              ? workflow.report.checkpoint?.caseIds
              : assessment.report.scopeEvidence?.caseIds
          )?.includes(c.id)
        )
          issues.push(`The review must explicitly cover case ${c.id}.`);
      const laterCases = d.source.baseline_acceptance_coverage
        .filter(
          (c) => c.capability_gate === checkpoint.id && c.producing_slice !== scope.scope.sourceId,
        )
        .map((c) => ({ id: c.id, sliceId: c.producing_slice }));
      const snapshotDigest = checkpointDigest({
        definition: d.digest,
        binding: binding.revision,
        runtime: runtime?.digest,
        worktree: tree.id,
        version: tree.version,
        checkpoint: checkpoint.id,
        run: run?.id,
        report: turn?.kind === 'turn-completed' ? turn.payload : undefined,
        build: build?.digest,
        head: run?.reviewBranchContext,
        tree: commit?.ok ? commit.value.treeSha : undefined,
      });
      const saved = this.storage.runtimeEvidence
        .submissions(ws, id)
        .find(
          (s) =>
            s.subject.sourceId === checkpoint.id &&
            s.candidateCheckpoint?.snapshotDigest === snapshotDigest,
        );
      const draft =
        runtime &&
        run?.reviewBranchContext &&
        turn?.kind === 'turn-completed' &&
        build &&
        commit?.ok &&
        alias
          ? this.checkpointPacket(
              context,
              d,
              runtime,
              tree,
              checkpoint.id,
              snapshotDigest,
              run.id,
              turn.payload,
              build,
              commit.value.treeSha,
              alias,
            )
          : undefined;
      if (draft)
        issues.push(
          ...submissionIssues(this.storage, d, runtime, draft),
          ...(await this.evidenceFreshness(d, runtime!, draft)),
        );
      candidates.push({
        checkpointId: checkpoint.id,
        title: checkpoint.title,
        requirements: spec.requirements,
        reviewerRoles: spec.reviewerRoles,
        cases: spec.cases.map((c) => ({ id: c.id, sourceRecordDigest: c.sourceRecordDigest })),
        laterCases,
        issues: [...new Set(issues)],
        prerequisiteCheckpoints,
        snapshotDigest,
        ...(run ? { runId: run.id } : {}),
        ...(run?.reviewBranchContext
          ? {
              headSha: run.reviewBranchContext.headSha,
              integrationSha: run.reviewBranchContext.targetSha,
            }
          : {}),
        report,
        buildReceipts: build?.receipts ?? '',
        ...(saved
          ? {
              submission: saved,
              decision: this.storage.runtimeEvidence
                .decisions(ws)
                .find((x) => x.submissionId === saved.id),
            }
          : {}),
      });
    }
    return checkpointRecoverySchema.parse({ worktreeId, candidates });
  }

  private checkpointPacket(
    context: CommandContext,
    d: ConcurrencyDefinition,
    runtime: RuntimeGeneration,
    tree: Worktree,
    checkpointId: string,
    snapshotDigest: string,
    runId: string,
    payload: import('@craftingtable/domain').AgentRunEventPayloads['turn-completed'],
    build: import('@craftingtable/domain').RunBuildRecord,
    treeSha: string,
    alias: string,
  ): EvidenceSubmission {
    const run = this.storage.execution.runs.find(d.workspaceId, asAgentRunId(runId))!;
    const branch = run.reviewBranchContext!;
    const spec = subjectRequirements(
      d,
      { kind: 'checkpoint', sourceId: checkpointId },
      tree.executionScope!.sourceId,
    );
    const artifacts = [
      { name: 'independent-review', content: payload.resultText },
      { name: 'controller-build-receipts', content: build.receipts },
      {
        name: 'checkpoint-requirements',
        content: JSON.stringify(
          {
            requirements: spec.requirements,
            cases: spec.cases,
            explanation:
              'The retained review and build receipts are evidence for operator assessment, not automatic checkpoint approval. Later baseline cases remain required in their assigned slice verification.',
          },
          null,
          2,
        ),
      },
    ].map((a) => ({ ...a, digest: hash(a.content) }));
    return {
      id: randomUUID(),
      workspaceId: d.workspaceId,
      definitionId: d.id,
      bindingRevision: tree.executionScope!.bindingRevision,
      runtimeId: runtime.id,
      subject: { kind: 'checkpoint', sourceId: checkpointId },
      testedCode: testedRepositories(d, { kind: 'checkpoint', sourceId: checkpointId }).includes(
        alias,
      )
        ? [{ alias, commitSha: branch.headSha }]
        : [],
      subjectCommit: branch.headSha,
      environmentId: runtime.environments.find((e) => e.kind === 'local-development')?.id ?? '',
      executedBy: `review-run:${runId}`,
      executedAt: run.finishedAt!,
      reviewers: [],
      requirements: spec.requirements.map((requirement) => ({
        requirement,
        artifact: 'independent-review',
      })),
      cases: spec.cases.map((c) => ({
        id: c.id,
        sourceRecordDigest: c.sourceRecordDigest,
        result: 'passed',
        artifact: 'independent-review',
      })),
      artifacts,
      candidateCheckpoint: {
        kind: 'reviewed-candidate-v1',
        worktreeId: tree.id,
        sliceId: tree.executionScope!.sourceId,
        runId,
        reportDigest: checkpointDigest(payload),
        buildDigest: build.digest,
        headSha: branch.headSha,
        treeSha,
        integrationSha: branch.targetSha,
        snapshotDigest,
      },
      createdAt: this.now().toISOString(),
      createdByUserId: context.user.id,
    };
  }

  async acceptWorkflowCheckpoint(cycle: WorkCycle): Promise<void> {
    const active = cycle.workflow?.activeReview;
    const delegation = workflowDelegation(this.storage, cycle);
    const candidateContext = workflowContext(this.storage, cycle);
    const checkpoint = candidateContext?.checkpoints.find((c) => c.id === active?.checkpointId);
    const user = this.storage.users.findById(cycle.createdByUserId);
    if (
      user?.status !== 'active' ||
      !cycle.executionScope ||
      !delegation ||
      !delegation.runnable ||
      active?.kind !== 'checkpoint' ||
      !checkpoint?.supported ||
      !checkpoint.assigned ||
      checkpoint.pending.length
    )
      conflict(
        'Checkpoint delegation or prerequisites changed. Review the current roadmap obligations.',
      );
    const context: CommandContext = { user };
    const ws = cycle.workspaceId,
      id = cycle.executionScope.definitionId;
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const check = () => {
      this.workspaces.requireRole(context, ws, ['owner', 'editor']);
      const current = this.storage.execution.cycles.find(ws, cycle.id);
      const currentDelegation = workflowDelegation(this.storage, cycle);
      const currentCheckpoint = workflowContext(this.storage, cycle)?.checkpoints.find(
        (c) => c.id === checkpoint.id,
      );
      if (
        current?.version !== cycle.version ||
        current.currentRunId !== cycle.currentRunId ||
        currentDelegation?.runnable !== true ||
        !currentCheckpoint?.assigned ||
        currentCheckpoint.pending.length
      )
        conflict('Checkpoint delegation changed during review.');
    };
    const preview = await this.checkpointRecovery(context, ws, id, cycle.worktreeId, true);
    const candidate = preview.candidates.find((c) => c.checkpointId === checkpoint.id);
    if (!candidate || candidate.issues.length)
      conflict(candidate?.issues.join(' ') || 'Checkpoint candidate is unavailable.');
    const tree = this.storage.execution.worktrees.find(ws, cycle.worktreeId)!;
    const run = this.storage.execution.runs.find(ws, cycle.currentRunId)!;
    if (candidate.runId !== run.id || active.sourceRunId === run.id)
      conflict('A separate exact-candidate checkpoint review is required.');
    const turn = this.storage.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
    const build = this.storage.runtimeEvidence.build(ws, run.id);
    const runtime = this.current(ws, id);
    if (turn?.kind !== 'turn-completed' || !build || !runtime || !run.reviewBranchContext)
      conflict('Checkpoint review evidence is incomplete.');
    const commit = await this.requireGit().resolveCommit(
      tree.path,
      run.reviewBranchContext.headSha,
    );
    if (!commit.ok) conflict('Checkpoint candidate is unavailable.');
    const d = this.definition(ws, id);
    const alias = this.binding(ws, id, cycle.executionScope.bindingRevision).bindings.find(
      (b) => b.repositoryId === tree.repositoryId,
    )!.alias;
    const packet = this.checkpointPacket(
      context,
      d,
      runtime,
      tree,
      checkpoint.id,
      candidate.snapshotDigest,
      run.id,
      turn.payload,
      build,
      commit.value.treeSha,
      alias,
    );
    const submission: EvidenceSubmission = {
      ...packet,
      reviewers: [
        {
          identity: `agent-review:${run.id}`,
          roles: checkpoint.roles,
          artifact: 'independent-review',
        },
      ],
      candidateCheckpoint: {
        ...packet.candidateCheckpoint!,
        delegatedReview: {
          cycleId: cycle.id,
          roadmapId: delegation.roadmap.id,
          definitionRevision: delegation.attempt.definitionRevision,
          roles: checkpoint.roles,
        },
      },
    };
    const issues = [
      ...submissionIssues(this.storage, d, runtime, submission),
      ...(await this.evidenceFreshness(d, runtime, submission)),
    ];
    if (issues.length) conflict(issues.join(' '));
    check();
    this.storage.transaction((tx) => {
      check();
      tx.runtimeEvidence.addSubmission(submission);
      this.changed(
        tx,
        context,
        ws,
        id,
        'evidence.decided',
        `Delegated checkpoint review accepted ${checkpoint.id}.`,
        this.now().toISOString(),
      );
      tx.runtimeEvidence.addDecision({
        id: randomUUID(),
        workspaceId: ws,
        submissionId: submission.id,
        outcome: 'accepted',
        rationale: `Delegated technical checkpoint review ${run.id}, under saved roadmap reviewer responsibilities. No human review or architecture approval is claimed.`,
        checkpointReviewRoles: checkpoint.roles,
        decidedAt: this.now().toISOString(),
        decidedByUserId: cycle.createdByUserId,
      });
    });
    this.notifier.notify();
  }

  async prepareCheckpoint(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    input: { worktreeId: string; checkpointId: string; snapshotDigest: string },
  ) {
    const preview = await this.checkpointRecovery(context, ws, id, input.worktreeId);
    const candidate = preview.candidates.find((c) => c.checkpointId === input.checkpointId);
    if (!candidate || candidate.snapshotDigest !== input.snapshotDigest)
      conflict('Checkpoint evidence changed. Refresh and review the current candidate.');
    if (candidate.issues.length) conflict(candidate.issues.join('\n'));
    if (candidate.submission && candidate.decision?.outcome !== 'rejected') return preview;
    const d = this.definition(ws, id),
      runtime = this.current(ws, id)!;
    const tree = this.storage.execution.worktrees.find(ws, asWorktreeId(input.worktreeId))!;
    const run = this.storage.execution.runs.find(ws, asAgentRunId(candidate.runId!))!;
    const turn = this.storage.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
    if (turn?.kind !== 'turn-completed') conflict('The completed review is unavailable.');
    const build = this.storage.runtimeEvidence.build(ws, run.id)!;
    const commit = await this.requireGit().resolveCommit(
      tree.path,
      run.reviewBranchContext!.headSha,
    );
    if (!commit.ok) conflict('The reviewed candidate is unavailable.');
    const alias = this.binding(ws, id, tree.executionScope!.bindingRevision).bindings.find(
      (b) => b.repositoryId === tree.repositoryId,
    )!.alias;
    const submission = this.checkpointPacket(
      context,
      d,
      runtime,
      tree,
      input.checkpointId,
      input.snapshotDigest,
      run.id,
      turn.payload,
      build,
      commit.value.treeSha,
      alias,
    );
    const issues = await this.evidenceFreshness(d, runtime, submission);
    if (issues.length) conflict(issues.join('\n'));
    this.storage.transaction((tx) => {
      this.workspaces.requireRole(context, ws, ['owner', 'editor']);
      if (this.current(ws, id)?.id !== runtime.id) conflict('Runtime changed during preparation.');
      const issues = submissionIssues(tx, d, runtime, submission);
      if (issues.length) conflict(issues.join('\n'));
      tx.runtimeEvidence.addSubmission(submission);
      this.changed(
        tx,
        context,
        ws,
        id,
        'evidence.submitted',
        `Prepared ${input.checkpointId} from retained candidate review.`,
        submission.createdAt,
      );
    });
    this.notifier.notify();
    return this.checkpointRecovery(context, ws, id, input.worktreeId);
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
    let source: Record<string, never> | { sourceRunDigest: string; sourceRunCommit: string } = {};
    if (input.sourceRunId) {
      const run = this.storage.execution.runs.find(ws, asAgentRunId(input.sourceRunId));
      const turn =
        run && this.storage.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
      if (
        run?.status !== 'finished' ||
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
    input: {
      submissionId: string;
      outcome: 'accepted' | 'rejected';
      rationale: string;
      checkpointReviewRoles?: readonly string[];
    },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const d = this.definition(ws, id),
      s = this.storage.runtimeEvidence.submissions(ws, id).find((s) => s.id === input.submissionId),
      runtime = this.current(ws, id);
    if (!s) throw new NotFoundError();
    if (input.outcome === 'accepted') {
      if (!runtime) conflict('Configure a runtime first.');
      if (s.candidateCheckpoint) {
        const roles = subjectRequirements(d, s.subject).reviewerRoles;
        if (
          !input.checkpointReviewRoles ||
          input.checkpointReviewRoles.length !== roles.length ||
          new Set(input.checkpointReviewRoles).size !== roles.length ||
          roles.some((role) => !input.checkpointReviewRoles!.includes(role))
        )
          conflict(
            'Explicitly confirm checkpoint review for every required reviewer responsibility.',
          );
      }
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
      if (input.outcome === 'accepted' && s.candidateCheckpoint) {
        const issues = submissionIssues(tx, d, runtime, s);
        if (issues.length) conflict(issues.join(' '));
      }
      if (input.outcome === 'accepted' && s.architectureDecision)
        this.assertDecisionCanChange(tx, ws, id, s);
      if (input.outcome === 'accepted' && s.generatedPlan) {
        const issues = generatedPlanIssues(tx, d, this.current(ws, id), s);
        if (issues.length) conflict(issues.join(' '));
      }
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
  async proposeArchitectureDecision(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    raw: ProposeArchitectureDecision,
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const input = proposeArchitectureDecisionSchema.parse(raw);
    this.storage.transaction((tx) => {
      const d = this.definition(ws, id),
        runtime = this.current(ws, id);
      if (!runtime || runtime.bindingRevision !== input.bindingRevision)
        conflict('Refresh the exact plan binding first.');
      if (!supportsArchitectureDecision(d, input.checkpointId))
        conflict(
          'This checkpoint requires independent evidence outside the supported decision-owner workflow.',
        );
      const subject = { kind: 'checkpoint' as const, sourceId: input.checkpointId };
      const spec = subjectRequirements(d, subject);
      const artifacts: EvidenceSubmission['artifacts'][number][] = [];
      let sourceRunDigest: string | undefined;
      if (input.sourceRunId) {
        const run = tx.execution.runs.find(ws, asAgentRunId(input.sourceRunId));
        const tree = run && tx.execution.worktrees.find(ws, run.worktreeId);
        const binding = this.binding(ws, id, input.bindingRevision).bindings.find(
          (b) => b.alias === spec.checkpoint?.owner,
        );
        const preparation = run && decisionPreparationForRun(tx, ws, run.id);
        const preparedHere =
          preparation?.definitionId === id &&
          preparation.worktreeId === run?.worktreeId &&
          preparation.checkpointId === input.checkpointId &&
          currentDecisionPreparation(tx, preparation);
        if (
          run?.status !== 'finished' ||
          !tree ||
          (!preparedHere &&
            (tree.executionScope?.definitionId !== id ||
              tree.executionScope.bindingRevision !== input.bindingRevision)) ||
          worktreePlan(tx, tree) !== binding?.planVersionId ||
          tree.repositoryId !== binding?.repositoryId
        )
          conflict('Choose a finished source run from this exact bound repository plan.');
        const event = tx.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
        if (
          event?.kind !== 'turn-completed' ||
          event.payload.outcome !== 'success' ||
          event.payload.truncated ||
          !event.payload.resultText
        )
          conflict('The selected source run lacks a complete final report.');
        const content = event.payload.resultText;
        if (Buffer.byteLength(content) > 512 * 1024)
          conflict('The source report exceeds the evidence limit.');
        sourceRunDigest = hash(content);
        if (input.sourceReportDigest && input.sourceReportDigest !== sourceRunDigest)
          conflict('The source recommendation changed. Refresh before preparing approval.');
        artifacts.push({
          name:
            run.role === 'design'
              ? 'source-design-proposal-not-approval'
              : 'source-run-proposal-not-approval',
          content,
          digest: sourceRunDigest,
        });
      }
      const {
        checkpointId: _checkpointId,
        bindingRevision: _revision,
        sourceRunId: _sourceRunId,
        sourceReportDigest: _sourceReportDigest,
        ...proposal
      } = input;
      const architectureDecision: NonNullable<EvidenceSubmission['architectureDecision']> = {
        ...proposal,
        kind: 'architecture-decision-v1',
        bindingDigest: decisionBindingDigest(tx, d, input.bindingRevision),
      };
      const content = JSON.stringify(
        {
          checkpoint: spec.checkpoint,
          sourceFiles: d.source.source_files,
          boundDecision: architectureDecision,
          authority:
            'Proposal only. Separate authenticated repository-maintainer approval is required. Clause approval never passes the full checkpoint or supplies test evidence.',
        },
        null,
        2,
      );
      artifacts.unshift({ name: 'decision-review-packet', content, digest: hash(content) });
      const at = this.now().toISOString();
      const submission: EvidenceSubmission = {
        id: randomUUID(),
        workspaceId: ws,
        definitionId: id,
        bindingRevision: input.bindingRevision,
        runtimeId: runtime.id,
        environmentId: runtime.environments[0]!.id,
        subject,
        architectureDecision,
        executedBy: 'CraftingTable decision packet collector',
        executedAt: at,
        requirements: spec.requirements.map((requirement) => ({
          requirement,
          artifact: 'decision-review-packet',
        })),
        reviewers: [],
        cases: [],
        artifacts,
        createdAt: at,
        createdByUserId: context.user.id,
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId, sourceRunDigest } : {}),
      };
      const issues = architectureDecisionIssues(tx, d, submission);
      if (issues.length) conflict(issues.join('\n'));
      tx.runtimeEvidence.addSubmission(submission);
      this.changed(
        tx,
        context,
        ws,
        id,
        'evidence.submitted',
        `${input.checkpointId} ${input.coverage} proposal saved for operator review.`,
        at,
      );
    });
    this.notifier.notify();
    return this.view(context, ws, id);
  }
  private assertDecisionCanChange(
    tx: StorageRepositories,
    ws: WorkspaceId,
    id: string,
    s: EvidenceSubmission,
  ) {
    const issues = architectureDecisionIssues(tx, this.definition(ws, id), s);
    if (issues.length) conflict(issues.join('\n'));
    // Approval changes run inputs and, for staging, scheduling. Require a stable operator checkpoint.
    if (
      tx.roadmaps
        .list(ws)
        .some((r) => r.definition.crossProject?.definitionId === id && r.status === 'running')
    )
      conflict(
        'Pause roadmap scheduling before approving an architecture decision. Existing work and history are retained.',
      );
    if (
      tx.execution.runs
        .listLive()
        .some(
          (r) =>
            r.workspaceId === ws &&
            (tx.execution.worktrees.find(ws, r.worktreeId)?.executionScope?.definitionId === id ||
              decisionPreparationForRun(tx, ws, r.id)?.definitionId === id),
        )
    )
      conflict('Wait for live runs on this map to finish before changing architecture decisions.');
  }
  async generatePlanEvidence(
    context: AuthContext,
    ws: WorkspaceId,
    id: string,
    input: { roadmapId: string; definitionRevision: number; snapshotDigest: string },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const runtime = this.current(ws, id);
    if (!runtime) conflict('Save the pinned dependency environment first.');
    const freshness = await this.freshness(ws, runtime);
    if (freshness.length) conflict(freshness.join(' '));
    this.storage.transaction((tx) => {
      this.workspaces.requireRole(context, ws, ['owner', 'editor']);
      const d = tx.imports.definition(ws, id),
        roadmap = tx.roadmaps.find(ws, input.roadmapId);
      if (!d || !roadmap) throw new NotFoundError();
      if (this.current(ws, id)?.id !== runtime.id)
        conflict('Runtime changed. Refresh before generating evidence.');
      const snapshot = savedPlanSnapshot(tx, d, roadmap, runtime);
      if (snapshot.issues.length) conflict(snapshot.issues.join(' '));
      if (
        roadmap.definition.revision !== input.definitionRevision ||
        snapshot.snapshotDigest !== input.snapshotDigest
      )
        conflict('Saved configuration changed. Refresh before generating evidence.');
      const existing = tx.runtimeEvidence
        .submissions(ws, id)
        .find(
          (s) =>
            s.generatedPlan?.roadmapId === roadmap.id &&
            s.generatedPlan.snapshotDigest === snapshot.snapshotDigest &&
            !tx.runtimeEvidence
              .decisions(ws)
              .some((a) => a.submissionId === s.id && a.outcome === 'rejected'),
        );
      if (existing) return;
      const at = this.now().toISOString();
      const subject = { kind: 'checkpoint' as const, sourceId: PLAN_CHECKPOINT };
      const spec = subjectRequirements(d, subject);
      const artifacts = Object.entries(snapshot.facts).map(([name, facts]) => {
        const content = JSON.stringify(facts, null, 2);
        return { name, content, digest: hash(content) };
      });
      const content = [
        `Saved roadmap: ${roadmap.definition.name} (revision ${roadmap.definition.revision})`,
        `Map: ${d.mapId} ${d.revision}; binding ${runtime.bindingRevision}; environment generation ${runtime.generation}`,
        `Target: ${roadmap.definition.crossProject!.targetId}; selection: ${roadmap.definition.crossProject!.selection}`,
        `Import validation: structure, source snapshots and graph acyclicity checked (${d.graphNodeCount} milestones, ${d.graphEdgeCount} edges).`,
        `Scheduling proposals: ${d.source.decisions.length} adopted for the exact binding.`,
        ...snapshot.facts.binding!.bindings.map(
          (b) =>
            `Binding ${b.alias}: plan ${b.planVersionId ?? 'implemented upstream'}; repository ${b.repositoryId}; integration ${b.integrationBranch ?? 'upstream ref below'}`,
        ),
        ...runtime.pins.map(
          (p) => `Pin ${p.alias}: ${p.ref} at ${p.commitSha}; conformance ${p.conformanceRevision}`,
        ),
        `Saved activities: ${roadmap.definition.entries.length}. Review their model profiles and reviewer responsibilities in the roadmap artifact.`,
        `Local admission capacity: ${snapshot.facts.resources.developmentCapacity} development, ${snapshot.facts.resources.verificationCapacity} verification.`,
        '',
        'The daemon collected these saved setup facts. This package does not claim a human review, test execution, AQ qualification or release approval. Review the artifacts and record your decision as stack-integration-owner. The authenticated acceptance decision and rationale are the independent plan review.',
      ].join('\n');
      artifacts.unshift({ name: 'plan-review-guide', content, digest: hash(content) });
      if (
        artifacts.some((a) => Buffer.byteLength(a.content) > 512 * 1024) ||
        artifacts.reduce((n, a) => n + Buffer.byteLength(a.content), 0) > 4 * 1024 * 1024
      )
        conflict(
          'The saved configuration exceeds the evidence artifact limit. Submit bounded evidence manually.',
        );
      const submission: EvidenceSubmission = {
        id: randomUUID(),
        workspaceId: ws,
        definitionId: id,
        bindingRevision: runtime.bindingRevision,
        runtimeId: runtime.id,
        subject,
        environmentId: runtime.environments[0]!.id,
        executedBy: 'CraftingTable setup collector',
        executedAt: at,
        reviewers: [],
        requirements: spec.requirements.map((requirement) => ({
          requirement,
          artifact: 'plan-review-guide',
        })),
        cases: [],
        artifacts,
        createdAt: at,
        createdByUserId: context.user.id,
        generatedPlan: {
          kind: 'saved-plan-v1',
          roadmapId: roadmap.id,
          definitionRevision: roadmap.definition.revision,
          snapshotDigest: snapshot.snapshotDigest,
        },
      };
      const issues = submissionIssues(tx, d, runtime, submission);
      if (issues.length) conflict(issues.join(' '));
      tx.runtimeEvidence.addSubmission(submission);
      this.changed(
        tx,
        context,
        ws,
        id,
        'evidence.submitted',
        'Saved plan evidence generated; independent operator acceptance is still required.',
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
    const pinStatus = runtime ? await this.pinStatus(ws, runtime) : [];
    const freshness = pinStatus.flatMap((p) => (p.issue ? [p.issue] : []));
    const snapshot = mapReadSnapshot(this.storage);
    const planAcceptance = d.source.checkpoints.some((c) => c.id === PLAN_CHECKPOINT)
      ? {
          checkpoint: PLAN_CHECKPOINT,
          roadmaps: snapshot.roadmaps
            .list(ws)
            .filter((r) => r.definition.crossProject?.definitionId === id && r.status !== 'stopped')
            .map((roadmap) => {
              const saved = savedPlanSnapshot(snapshot, d, roadmap, runtime);
              const issues = [...saved.issues, ...freshness];
              const submission = snapshot.runtimeEvidence
                .submissions(ws, id)
                .find(
                  (s) =>
                    s.generatedPlan?.roadmapId === roadmap.id &&
                    s.generatedPlan.snapshotDigest === saved.snapshotDigest &&
                    !decisions.some((a) => a.submissionId === s.id && a.outcome === 'rejected'),
                );
              const accepted = acceptedEvidence(snapshot, ws, id, binding?.revision ?? 0, {
                kind: 'checkpoint',
                sourceId: PLAN_CHECKPOINT,
              });
              return {
                roadmapId: roadmap.id,
                name: roadmap.definition.name,
                definitionRevision: roadmap.definition.revision,
                snapshotDigest: saved.snapshotDigest,
                issues,
                state: issues.length
                  ? ('not-ready' as const)
                  : accepted &&
                      (!accepted.generatedPlan || accepted.generatedPlan.roadmapId === roadmap.id)
                    ? ('accepted' as const)
                    : submission
                      ? ('awaiting-review' as const)
                      : ('ready-to-generate' as const),
                ...(submission ? { submissionId: submission.id } : {}),
              };
            }),
        }
      : undefined;
    const subjectsView = subjects.map((subject) => {
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
          ? prerequisiteIssues(snapshot, d, binding.revision, subject)
          : ['Bind plans first.'],
      };
    });
    const submissionsView = snapshot.runtimeEvidence.submissions(ws, id).map((s) => ({
      submission: s,
      ...(decisions.find((v) => v.submissionId === s.id)
        ? { decision: decisions.find((v) => v.submissionId === s.id) }
        : {}),
      issues: [
        ...submissionIssues(snapshot, d, runtime, s),
        ...prerequisiteIssues(snapshot, d, s.bindingRevision, s.subject),
      ],
    }));
    const architectureCheckpoints = d.source.checkpoints.filter((c) =>
      supportsArchitectureDecision(d, c.id),
    );
    const designRuns = snapshot.execution.runs
      .listRecent(ws, 200)
      .filter((run) => {
        if (run.status !== 'finished') return false;
        const tree = snapshot.execution.worktrees.find(ws, run.worktreeId);
        return (
          tree?.executionScope?.definitionId === id &&
          tree.executionScope.bindingRevision === binding?.revision
        );
      })
      .slice(0, 20)
      .flatMap((run) => {
        const event = snapshot.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
        const report =
          event?.kind === 'turn-completed' && !event.payload.truncated
            ? event.payload.resultText
            : undefined;
        if (!report || report.length > 65536) return [];
        const tree = snapshot.execution.worktrees.find(ws, run.worktreeId);
        const slice = d.source.slices.find((s) => s.id === tree?.executionScope?.sourceId);
        const required = new Set(
          slice
            ? [...slice.start_requires, ...slice.merge_requires, ...slice.verify_requires]
                .filter((r) => r.kind === 'checkpoint')
                .map((r) => r.id)
            : [],
        );
        const plan = tree && worktreePlan(snapshot, tree);
        const owner = binding?.bindings.find(
          (b) => b.planVersionId === plan && b.repositoryId === tree?.repositoryId,
        )?.alias;
        return [
          {
            id: run.id,
            title: `${tree?.executionScope?.sourceId ?? 'Design'} · ${run.finishedAt ?? run.createdAt}`,
            checkpointIds: architectureCheckpoints
              .filter((c) => c.owner === owner && (report.includes(c.id) || required.has(c.id)))
              .map((c) => c.id),
            report,
          },
        ];
      });
    return {
      decisionInbox: architectureDecisionInbox(snapshot, d),
      architectureDecisions: {
        checkpoints: architectureCheckpoints.map((c) => ({
          id: c.id,
          title: c.title,
          requirements: subjectRequirements(d, { kind: 'checkpoint', sourceId: c.id }).requirements,
          sourceReferences: JSON.stringify(c, null, 2),
        })),
        slices: d.source.slices.map((s) => ({
          id: s.id,
          title: s.title,
          checkpoints: [
            ...new Set(
              [...s.start_requires, ...s.merge_requires, ...s.verify_requires]
                .filter((r) => r.kind === 'checkpoint')
                .map((r) => r.id),
            ),
          ],
        })),
        designRuns,
      },
      nativeVerification: {
        approval: binding
          ? snapshot.runtimeEvidence.nativeApprovals(ws, id, binding.revision)[0]
          : undefined,
        current:
          !!binding &&
          !!nativeApproval(snapshot, ws, {
            kind: 'slice',
            definitionId: id,
            bindingRevision: binding.revision,
            sourceId: '',
          }),
        requirements: d.source.resource_profiles
          .filter((p) => p.fixture_authorization_required || p.requires_hardware_virtualization)
          .map((p) => ({
            resource: p.id,
            supported:
              p.id === 'controlled-native-test-host' && !p.requires_hardware_virtualization,
            slices: d.source.slices
              .filter((s) => s.resources_by_phase.verify.includes(p.id))
              .map((s) => s.id),
          })),
      },
      ...(planAcceptance ? { planAcceptance } : {}),
      pinStatus,
      issues: freshness,
      builds,
      bindingRevision: binding?.revision ?? 0,
      ...(runtime ? { current: runtime } : {}),
      history,
      repositories: d.source.repositories.map((r) => {
        const b = binding?.bindings.find((b) => b.alias === r.id);
        const repo =
          b?.repositoryId && this.storage.execution.sourceRepositories.find(ws, b.repositoryId);
        const integrationBranch = b && (providerBranch(this.storage, ws, b) || repo?.defaultBranch);
        return {
          alias: r.id,
          role: r.role,
          configured: !!repo && repo.status === 'active',
          requiredUpstreams: r.role === 'planned_application' ? requiredUpstreams(d, r.id) : [],
          ...(integrationBranch ? { integrationBranch } : {}),
          ...(d.source.aq_baseline_binding?.repository === r.id
            ? {
                conformanceRevision: String(
                  d.source.aq_baseline_binding.conformance_package_revision,
                ),
              }
            : {}),
        };
      }),
      subjects: subjectsView,
      submissions: await Promise.all(
        submissionsView.map(async (v) => ({
          ...v,
          issues: [
            ...v.issues,
            ...(runtime ? await this.evidenceFreshness(d, runtime, v.submission, pinStatus) : []),
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
  private treeContext(tree: Worktree) {
    const finalization = tree.planVersionId
      ? this.storage.execution.finalizations
          .list(tree.workspaceId)
          .find((f) => f.worktreeId === tree.id)
      : undefined;
    if (finalization?.mapContext) {
      assertFinalizationMap(this.storage, finalization);
      return { ...finalization.mapContext, finalization: true as const };
    }
    return tree.executionScope;
  }
  async prepare(tree: Worktree, runId: string, runDirectory: string) {
    const scope = this.treeContext(tree);
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

    const definition = this.definition(tree.workspaceId, scope.definitionId);
    const verification = buildVerificationPolicy(
      definition,
      'finalization' in scope ? undefined : scope,
    );
    const preparations =
      verification.mode === 'scoped-checks'
        ? this.storage.execution.cycles
            .listForWorkspace(tree.workspaceId)
            .filter(
              (c) =>
                c.baselinePreparation?.status === 'prepared' &&
                c.executionScope?.definitionId === scope.definitionId &&
                c.executionScope.bindingRevision === scope.bindingRevision &&
                c.baselinePreparation.consumerAlias === b.alias,
            )
        : [];
    // Keep an existing cycle on its own operator-approved historical selection.
    // Fresh verification/parent trees may reuse the latest preparation for this exact binding.
    const historical = (preparations.find((c) => c.worktreeId === tree.id) ?? preparations[0])
      ?.baselinePreparation;
    const cargoExecutable = resolveExecutable('cargo', undefined, process.env, [
      join(homedir(), '.cargo', 'bin'),
    ]);
    if (!cargoExecutable)
      throw new ExecutionRequestError('unavailable', 'The pinned build adapter requires Cargo.');
    const directory = join(runDirectory, 'dependencies'),
      files: { path: string; digest: string }[] = [],
      supplied: { name: string; path: string }[] = [];
    const dependencyIdentities: {
      alias: string;
      commitSha: string;
      treeSha?: string;
      purpose: string;
    }[] = [];
    for (const alias of consumer.upstreams) {
      // Scoped development may use the operator-prepared historical dependencies.
      // Without preparation it remains dependency-free; never silently use registry fallback.
      if (verification.mode === 'scoped-checks' && !historical) continue;
      const baseline = historical?.sources.find((s) => s.alias === alias);
      const pin =
        verification.mode === 'scoped-checks'
          ? baseline && { ...baseline, packages: undefined }
          : runtime.pins.find((p) => p.alias === alias);
      if (!pin) conflict('A required pin is unavailable.');
      const repo = this.storage.execution.sourceRepositories.find(
        tree.workspaceId,
        pin.repositoryId,
      );
      if (repo?.status !== 'active') conflict('Pinned repository unavailable.');
      const exported = await this.requireGit().exportCommit(repo.rootPath, pin.commitSha);
      if (!exported.ok) conflict(exported.failure.message);
      const root = join(
        runDirectory,
        'scratch',
        'dependencies',
        `source-${consumer.upstreams.indexOf(alias)}`,
      );
      for (const file of exported.value) {
        const path = join(root, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.content, { mode: file.executable ? 0o500 : 0o400 });
        files.push({ path, digest: hash(file.content) });
      }
      supplied.push(
        ...(pin.packages ?? packages(exported.value)).map((p) => ({
          name: p.name,
          path: join(root, p.path),
        })),
      );
      dependencyIdentities.push({
        alias,
        commitSha: pin.commitSha,
        ...('treeSha' in pin ? { treeSha: pin.treeSha } : {}),
        purpose:
          verification.mode === 'scoped-checks' ? 'historical-development' : 'current-upstream',
      });
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
    let nativeVerification: PinnedCargoManifest['nativeVerification'];
    if (
      !('finalization' in scope) &&
      scope.kind === 'slice-verification' &&
      needsNativeVerification(definition, scope)
    ) {
      const approval = nativeApproval(this.storage, tree.workspaceId, scope);
      if (!approval)
        conflict('Audit and approve the managed native environment before verification.');
      const audit = await auditNativeEnvironment();
      if (!audit.ready || audit.auditDigest !== approval.auditDigest)
        conflict('Native environment changed or failed its smoke test. Re-audit and approve it.');
      const candidate = await this.requireGit().resolveCommit(tree.path, 'HEAD');
      if (!candidate.ok) conflict(candidate.failure.message);
      const rustc = resolveExecutable('rustc', undefined, process.env, [
        join(homedir(), '.cargo', 'bin'),
      ]);
      if (!rustc) conflict('Installed Rust is required for native verification.');
      const toolchain = JSON.stringify(
        await observeRustToolchain({ cargo: cargoExecutable, rustc }, tree.path),
      );
      nativeVerification = {
        approvalId: approval.id,
        hostDigest: approval.hostDigest,
        auditDigest: approval.auditDigest,
        fixtureDigest: hash(
          JSON.stringify({
            candidateTree: candidate.value.treeSha,
            dependencies: dependencyIdentities,
            files,
            configDigest: hash(config),
          }),
        ),
        toolchainDigest: hash(toolchain),
        toolchain,
      };
    }
    const authority =
      !('finalization' in scope) && needsNativeEvidence(definition, scope) && scope.kind !== 'slice'
        ? nativeApproval(this.storage, tree.workspaceId, scope)
        : undefined;
    if (
      !('finalization' in scope) &&
      scope.kind === 'parent-acceptance' &&
      needsNativeEvidence(definition, scope) &&
      !authority
    )
      conflict(
        'Parent acceptance requires current native verification authority for its prerequisite evidence.',
      );
    const manifest: PinnedCargoManifest = {
      ...(nativeVerification ? { nativeVerification } : {}),
      gitExecutable,
      checkTimeoutMs: Math.min(
        30 * 60000,
        (this.storage.execution.cycles.activeForWorktree(tree.workspaceId, tree.id)?.policy
          .maxRunMinutes ?? 30) * 60000,
      ),
      localCi: loadLocalCiConfig(process.env.CRAFTINGTABLE_ACT_CONFIG),
      verification,
      dependencyIdentities,
      ...(verification.mode === 'scoped-checks' && !historical
        ? {
            forbiddenPackages: runtime.pins
              .filter((p) => consumer.upstreams.includes(p.alias))
              .flatMap((p) => p.packages.map((p) => p.name)),
          }
        : {}),
      ...(historical ? { historicalPreparationId: historical.id } : {}),
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
    await this.assertFreshTree(tree);
    const launch = prepareCargoLauncher(directory, manifest);
    prepareLocalCheckLaunchers(launch.binDirectory, launch.manifestPath, launch.manifestDigest);
    return {
      ...launch,
      verification,
      localCi: manifest.localCi,
      nativeVerification,
      nativeApprovalId: authority?.id,
      architectureDecisionDigest:
        'finalization' in scope
          ? undefined
          : architectureDecisionDigest(this.storage, tree.workspaceId, scope),
      runtimeId: runtime.id,
      definitionId: scope.definitionId,
      bindingRevision: scope.bindingRevision,
    };
  }
  assertPrepared(tree: Worktree, runtimeId: string, decisionDigest?: string) {
    const scope = this.treeContext(tree);
    if (
      !scope ||
      activeRuntime(this.storage, tree.workspaceId, scope.definitionId, scope.bindingRevision)
        ?.id !== runtimeId
    )
      conflict('Dependency generation changed during run preparation.');
    if (
      !('finalization' in scope) &&
      decisionDigest !== architectureDecisionDigest(this.storage, tree.workspaceId, scope)
    )
      conflict(
        'Architecture decisions changed during run preparation. Retry with current evidence.',
      );
  }
  assertRun(tree: Worktree, runId: string) {
    const scope = this.treeContext(tree);
    if (!scope) return;
    const runtime = activeRuntime(
      this.storage,
      tree.workspaceId,
      scope.definitionId,
      scope.bindingRevision,
    );
    if (!runtime) return;
    const env = this.storage.runtimeEvidence.run(tree.workspaceId, runId);
    if (
      !('finalization' in scope) &&
      env?.architectureDecisionDigest !==
        architectureDecisionDigest(this.storage, tree.workspaceId, scope)
    )
      conflict(
        'Approved architecture decisions changed. Run a fresh review using the current decision packet.',
      );
    const alias = this.binding(
      tree.workspaceId,
      scope.definitionId,
      scope.bindingRevision,
    ).bindings.find((b) => b.repositoryId === tree.repositoryId)?.alias;
    const verification = buildVerificationPolicy(
      this.definition(tree.workspaceId, scope.definitionId),
      'finalization' in scope ? undefined : scope,
    );
    if (
      !('finalization' in scope) &&
      scope.kind === 'parent-acceptance' &&
      needsNativeEvidence(this.definition(tree.workspaceId, scope.definitionId), scope)
    ) {
      const authority = nativeApproval(this.storage, tree.workspaceId, scope);
      if (!authority || env?.nativeApprovalId !== authority.id)
        conflict(
          'Parent review native verification authority changed. Run a fresh acceptance review.',
        );
    }
    const nativeRequired =
      !('finalization' in scope) &&
      scope.kind === 'slice-verification' &&
      needsNativeVerification(this.definition(tree.workspaceId, scope.definitionId), scope);
    const approval =
      nativeRequired && !('finalization' in scope)
        ? nativeApproval(this.storage, tree.workspaceId, scope)
        : undefined;
    if (nativeRequired && !approval)
      conflict('Native verification approval is missing, revoked or stale.');
    if (
      !nativeRequired &&
      verification.mode !== 'scoped-checks' &&
      !runtime.consumers.find((c) => c.alias === alias)?.upstreams.length
    )
      return;
    if (
      !env ||
      ('finalization' in scope
        ? env.runtimeId !== runtime.id
        : scopeRuntimeChanges(this.storage, tree.workspaceId, scope, env.runtimeId, runtime)
            .length > 0)
    )
      conflict('Review uses an obsolete dependency environment. Run a fresh review.');
    try {
      const record = this.storage.runtimeEvidence.build(tree.workspaceId, runId);
      if (
        !record ||
        record.error ||
        record.manifestDigest !== env.manifestDigest ||
        record.runtimeId !== env.runtimeId
      )
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
              verificationMode?: string;
              policyDigest?: string;
              kind?: string;
              nativeVerification?: { approvalId: string; hostDigest: string; auditDigest: string };
            },
        );
      if (
        nativeRequired &&
        !receipts.some(
          (r) =>
            r.success &&
            r.clean &&
            r.kind === 'native-check' &&
            r.headSha === run?.reviewBranchContext?.headSha &&
            r.manifestDigest === env.manifestDigest &&
            r.runId === runId &&
            r.runtimeId === env.runtimeId &&
            r.nativeVerification?.approvalId === approval?.id &&
            r.nativeVerification?.hostDigest === approval?.hostDigest &&
            r.nativeVerification?.auditDigest === approval?.auditDigest,
        )
      )
        conflict(
          'Independent verification needs a successful ct-native check on the exact clean reviewed commit in the currently approved environment. Development/act receipts cannot substitute.',
        );
      if (
        !receipts.some(
          (r) =>
            r.success &&
            r.clean &&
            r.headSha === run?.reviewBranchContext?.headSha &&
            r.manifestDigest === env.manifestDigest &&
            r.runId === runId &&
            r.runtimeId === env.runtimeId &&
            (verification.mode === 'scoped-checks'
              ? r.verificationMode === 'scoped-checks' &&
                r.policyDigest === hash(JSON.stringify(verification))
              : r.kind !== 'scoped-check' &&
                r.kind !== 'supplementary-check' &&
                r.kind !== 'native-check' &&
                r.kind !== 'local-ci' &&
                r.verificationMode !== 'scoped-checks'),
        )
      )
        conflict(
          verification.mode === 'scoped-checks'
            ? 'The review needs a successful scoped check on its exact clean reviewed commit. Use ct-check for repository checks, ct-act for CI, or the supplied Cargo launcher; report every scope obligation separately.'
            : 'The review needs a successful pinned Cargo build/test on its exact clean reviewed commit.',
        );
    } catch (error) {
      if (error instanceof ExecutionRequestError) throw error;
      conflict(
        'A successful pinned Cargo build/test receipt is required before accepting this review.',
      );
    }
  }
  async cleanupRun(ws: WorkspaceId, runId: string) {
    const env = this.storage.runtimeEvidence.run(ws, runId);
    if (env) await cleanupLocalCiManifest(env.manifestPath, env.manifestDigest);
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
      if (
        ['act-active', 'native-active'].some((name) =>
          existsSync(join(dirname(env.manifestPath), 'checks', name)),
        )
      )
        throw new Error('Local CI did not finish collection; a fresh review is required.');
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
    const scope = this.treeContext(tree);
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
    const verification = buildVerificationPolicy(d, 'finalization' in scope ? undefined : scope);
    const issues =
      verification.mode === 'scoped-checks'
        ? []
        : await this.freshness(tree.workspaceId, runtime, alias);
    if ('finalization' in scope) {
      if (issues.length) conflict(issues.join('\n'));
      this.treeContext(tree);
      return;
    }
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
        new Set(),
        phase === 'merge' ? scope : undefined,
      );
      if (evidence && (!root || phase === 'verify' || phase === 'accept'))
        issues.push(
          ...(await this.evidenceFreshness(
            d,
            runtime,
            evidence,
            spec.checkpoint &&
              ['plan_approval', 'architecture_decision'].includes(spec.checkpoint.kind)
              ? []
              : undefined,
          )),
        );
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
    this.treeContext(tree);
    if (issues.length) conflict([...new Set(issues)].join('\n'));
  }
  private changed(
    tx: StorageRepositories,
    context: CommandContext,
    ws: WorkspaceId,
    id: string,
    action: 'runtime.configured' | 'evidence.submitted' | 'evidence.decided',
    message: string,
    at: string,
    metadata: Record<string, import('@craftingtable/domain').JsonValue> = {},
  ) {
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: at,
      actorKind: context.session ? 'user' : 'system',
      actorUserId: context.user.id,
      workspaceId: ws,
      action,
      targetType: 'concurrency-definition',
      targetId: id,
      outcome: 'succeeded',
      metadata,
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
