import { randomUUID } from 'node:crypto';
import type { ConcurrencyDetail, SaveConcurrencyBindings } from '@craftingtable/contracts';
import {
  type ArchiveImportAttempt,
  asAuditEventId,
  asEventId,
  type ConcurrencyDefinition,
  type ConcurrencyPlanBinding,
  type ImportIssue,
  type PlanVersion,
  type PlanVersionId,
  type ProjectId,
  type WorkspaceId,
} from '@craftingtable/domain';
import {
  ArchiveError,
  analyzeConcurrencyArchive,
  type ConcurrencyAnalysis,
  inspectPlanArchive,
  type PlanArchiveSelection,
  preparePlanArchive,
  previewSelectedPlanArchive,
  sha256Hex,
  sourceRecordDigest,
} from '@craftingtable/planning';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import type { PlanImportService } from './plan-import-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

const issue = (
  code: string,
  message: string,
  severity: ImportIssue['severity'] = 'error',
): ImportIssue => ({ code, message, severity });
const failure = (error: unknown) => [
  issue(
    error instanceof ArchiveError ? error.code : 'invalid-archive',
    error instanceof Error ? error.message : 'Invalid archive.',
  ),
];
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new NotFoundError();
  return value;
}
function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}

/** Import/preview only. This service has no execution, Git or agent adapter. */
export class PackageImportService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly plans: PlanImportService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
  ) {}
  previewPlan(
    context: AuthContext,
    workspaceId: WorkspaceId,
    bytes: Uint8Array,
    selection?: PlanArchiveSelection,
  ) {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    try {
      if (!selection) return { ...inspectPlanArchive(bytes), diagnostics: [] };
      const result = previewSelectedPlanArchive(bytes, selection);
      return {
        ...result,
        diagnostics: result.diagnostics.map((d) => ({
          severity: d.severity,
          code: d.code,
          message: d.message,
          ...(d.path ? { path: d.path } : {}),
        })),
      };
    } catch (error) {
      return {
        archiveDigest: sha256Hex(bytes),
        entries: [],
        implementationPlans: [],
        workBreakdowns: [],
        diagnostics: failure(error),
        valid: false,
      };
    }
  }
  importPlan(
    context: AuthContext,
    workspaceId: WorkspaceId,
    filename: string,
    bytes: Uint8Array,
    input: PlanArchiveSelection & {
      archiveDigest: string;
      projectId?: ProjectId;
      projectName?: string;
      activate: boolean;
      expectedActivePlanVersionId?: PlanVersionId;
    },
  ) {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (input.projectId && !this.storage.planning.projects.find(workspaceId, input.projectId))
      throw new NotFoundError();
    if (sha256Hex(bytes) !== input.archiveDigest)
      conflict('The ZIP changed after preview. Preview it again.');
    let prepared: ReturnType<typeof preparePlanArchive>;
    try {
      prepared = preparePlanArchive(bytes, input);
    } catch (error) {
      return {
        attempt: this.recordFailed(context, workspaceId, filename, bytes, 'plan', failure(error)),
      };
    }
    const at = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const oldProject = input.projectId && tx.planning.projects.find(workspaceId, input.projectId);
      if (
        oldProject &&
        input.activate &&
        oldProject.activePlanVersionId !== input.expectedActivePlanVersionId
      )
        conflict('The active plan changed since this form loaded. Refresh before importing.');
      const plan = this.plans.import(context, {
        workspaceId,
        bundle: prepared.bundle,
        projectId: input.projectId,
        projectName: input.projectName,
        deferNotification: true,
      });
      if (
        plan.outcome !== 'failed-validation' &&
        input.projectId &&
        plan.project.id !== input.projectId
      )
        conflict(
          'These exact plan files already belong to a different project. Open that project instead.',
        );
      // No-op reimports remain idempotent; changing the active version needs an idle project.
      if (
        oldProject &&
        input.activate &&
        plan.outcome !== 'failed-validation' &&
        !plan.isActiveVersion
      )
        this.requireIdleProject(tx, workspaceId, oldProject.id);
      const archive = this.archive(tx, workspaceId, filename, bytes, at);
      const attempt: ArchiveImportAttempt = {
        id: randomUUID(),
        workspaceId,
        archiveId: archive.id,
        kind: 'plan',
        outcome: plan.outcome,
        createdAt: at,
        createdByUserId: context.user.id,
        diagnostics:
          plan.outcome === 'duplicate'
            ? []
            : plan.diagnostics.map((d) => ({
                severity: d.severity,
                code: d.code,
                message: d.message,
              })),
        ...(plan.outcome === 'failed-validation' ? {} : { planVersionId: plan.version.id }),
      };
      if (plan.outcome !== 'failed-validation') {
        tx.imports.linkPlan({
          workspaceId,
          planVersionId: plan.version.id,
          archiveId: archive.id,
          implementationPlan: input.implementationPlan,
          workBreakdown: input.workBreakdown,
          selectedPaths: prepared.selectedPaths,
        });
        if (oldProject && input.activate && !plan.isActiveVersion) {
          const project = tx.planning.projects.find(workspaceId, plan.project.id);
          if (
            !project ||
            !tx.imports.activatePlan(workspaceId, project.id, plan.version.id, project.version)
          )
            conflict('Project changed during import.');
          tx.audit.append({
            id: asAuditEventId(randomUUID()),
            occurredAt: at,
            actorKind: 'user',
            actorUserId: context.user.id,
            workspaceId,
            action: 'plan.version-activated',
            targetType: 'plan-version',
            targetId: plan.version.id,
            outcome: 'succeeded',
            metadata: {
              projectId: plan.project.id,
              previousPlanVersionId: project.activePlanVersionId ?? null,
            },
          });
        }
      }
      this.recordAttempt(tx, attempt, context);
      return {
        attempt: this.attemptView(tx, attempt),
        plan:
          plan.outcome !== 'failed-validation' && oldProject && input.activate
            ? { ...plan, isActiveVersion: true }
            : plan,
      };
    });
    this.notifier.notify();
    return result;
  }
  private requireIdleProject(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ) {
    const versions = tx.planning.versions.listForProject(workspaceId, projectId);
    const versionIds = new Set(versions.map((v) => v.id));
    const items = versions.flatMap((v) => tx.planning.workItems.listForVersion(workspaceId, v.id));
    const itemIds = new Set(items.map((i) => i.id));
    if (
      items.some((i) => i.status === 'admitted') ||
      tx.execution.worktrees
        .listActive(workspaceId)
        .some(
          (w) =>
            !w.mergedAt &&
            ((w.workItemId && itemIds.has(w.workItemId)) ||
              (w.planVersionId && versionIds.has(w.planVersionId))),
        ) ||
      tx.roadmaps
        .list(workspaceId)
        .some(
          (r) =>
            !['draft', 'completed', 'stopped'].includes(r.status) &&
            r.definition.entries.some((e) => e.projectId === projectId),
        ) ||
      tx.execution.finalizations
        .list(workspaceId)
        .some(
          (f) => versionIds.has(f.planVersionId) && !['completed', 'stopped'].includes(f.status),
        )
    )
      conflict(
        'This project has admitted work or delegated execution. Import with “Make active” unchecked, then remove unstarted items from the agenda or finish/stop existing work before changing its active plan.',
      );
  }
  importConcurrency(
    context: AuthContext,
    workspaceId: WorkspaceId,
    filename: string,
    bytes: Uint8Array,
  ) {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    let analysis: ConcurrencyAnalysis;
    try {
      analysis = analyzeConcurrencyArchive(bytes);
    } catch (error) {
      return {
        attempt: this.recordFailed(
          context,
          workspaceId,
          filename,
          bytes,
          'concurrency',
          failure(error),
        ),
      };
    }
    const at = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const archive = this.archive(tx, workspaceId, filename, bytes, at);
      const source = analysis.source;
      const existing =
        source &&
        tx.imports
          .definitions(workspaceId)
          .find((d) => d.mapId === source.map_id && d.revision === source.revision);
      const outcome = !source
        ? 'failed-validation'
        : existing
          ? existing.digest === analysis.digest
            ? 'duplicate'
            : 'conflict'
          : 'succeeded';
      const definitionId = existing?.id ?? (source ? randomUUID() : undefined);
      if (source && analysis.digest && outcome === 'succeeded')
        tx.imports.addDefinition({
          id: definitionId as string,
          workspaceId,
          archiveId: archive.id,
          mapId: source.map_id,
          revision: source.revision,
          digest: analysis.digest,
          source,
          graphNodeCount: analysis.graphNodeCount,
          graphEdgeCount: analysis.graphEdgeCount,
          createdAt: at,
          createdByUserId: context.user.id,
        });
      const attempt: ArchiveImportAttempt = {
        id: randomUUID(),
        workspaceId,
        archiveId: archive.id,
        kind: 'concurrency',
        outcome,
        createdAt: at,
        createdByUserId: context.user.id,
        diagnostics:
          outcome === 'conflict'
            ? [
                issue(
                  'definition-revision-conflict',
                  'This map ID and revision already exist with different content. Supply a new map revision; existing history is immutable.',
                ),
              ]
            : analysis.diagnostics,
        ...(definitionId ? { definitionId } : {}),
      };
      this.recordAttempt(tx, attempt, context);
      if (outcome === 'succeeded' && definitionId)
        this.changed(
          tx,
          context,
          workspaceId,
          definitionId,
          'Concurrency definition imported as an inactive draft.',
          at,
        );
      return { attempt: this.attemptView(tx, attempt) };
    });
    this.notifier.notify();
    return result;
  }
  list(context: AuthContext, workspaceId: WorkspaceId) {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.readTransaction((tx) => ({
      definitions: tx.imports.definitions(workspaceId).map((d) => this.summary(tx, d)),
      attempts: tx.imports.attempts(workspaceId, 'concurrency').map((a) => this.attemptView(tx, a)),
    }));
  }
  detail(context: AuthContext, workspaceId: WorkspaceId, id: string): ConcurrencyDetail {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.readTransaction((tx) => this.projectDetail(tx, workspaceId, id));
  }
  saveBindings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    input: SaveConcurrencyBindings,
  ): ConcurrencyDetail {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    this.storage.transaction((tx) => {
      const d = tx.imports.definition(workspaceId, id);
      if (!d) throw new NotFoundError();
      const current = tx.imports.bindings(workspaceId, id)[0];
      if ((current?.revision ?? 0) !== input.expectedRevision)
        conflict('Bindings changed. Refresh before saving.');
      const bindings: ConcurrencyPlanBinding[] = [];
      for (const requested of input.bindings) {
        const repo = d.source.repositories.find((r) => r.id === requested.alias);
        if (!repo) conflict('Unknown repository alias.');
        if (repo.role === 'implemented_upstream') {
          if (requested.planVersionId || !requested.repositoryId)
            conflict('Implemented upstream binds a registered repository, not a runnable plan.');
          const registered = tx.execution.sourceRepositories.find(
            workspaceId,
            requested.repositoryId,
          );
          if (registered?.status !== 'active') throw new NotFoundError();
          bindings.push({
            alias: repo.id,
            repositoryId: registered.id,
            sourceArtifacts: [],
            workItems: [],
          });
          continue;
        }
        if (!requested.planVersionId || requested.repositoryId)
          conflict('Choose an exact plan version; its branch settings supply the repository.');
        const version = tx.planning.versions.find(workspaceId, requested.planVersionId);
        if (!version) throw new NotFoundError();
        const option = this.planOption(tx, d, repo.id, version);
        if (!option.exactSources)
          conflict(
            `${repo.id}: selected plan does not match the complete source binding. ${option.issues
              .map((i) => i.message)
              .join(' ')
              .slice(0, 1200)}`,
          );
        const artifacts = tx.planning.artifacts.listForVersion(workspaceId, version.id);
        const branch = tx.execution.branchSettings.find(workspaceId, version.id);
        const workItems = tx.planning.workItems.listForVersion(workspaceId, version.id);
        bindings.push({
          alias: repo.id,
          projectId: version.projectId,
          planVersionId: version.id,
          ...(branch
            ? {
                repositoryId: branch.repositoryId,
                integrationBranch: branch.integrationBranch,
                branchSettingsVersion: branch.version,
              }
            : {}),
          sourceArtifacts: d.source.source_files
            .filter((f) => f.repository === repo.id)
            .map((f) => ({
              sourceId: f.id,
              artifactId: present(
                artifacts.find(
                  (a) =>
                    a.sha256 === f.sha256 &&
                    a.logicalFilename === f.original_path.split('/').at(-1),
                ),
              ).id,
              sha256: f.sha256,
            })),
          workItems: d.source.work_items
            .filter((p) => p.repository === repo.id)
            .map((p) => ({
              sourceId: p.id,
              workItemId: present(workItems.find((w) => w.sourceId === p.source_item_id)).id,
              sourceRecordDigest: p.source_record_sha256,
            })),
        });
      }
      const planIds = bindings.flatMap((b) => (b.planVersionId ? [b.planVersionId] : []));
      if (new Set(planIds).size !== planIds.length)
        conflict('Different repository aliases must bind different plan versions.');
      const at = this.now().toISOString();
      tx.imports.addBindings({
        workspaceId,
        definitionId: id,
        revision: input.expectedRevision + 1,
        bindings,
        createdAt: at,
        createdByUserId: context.user.id,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: at,
        actorKind: 'user',
        actorUserId: context.user.id,
        workspaceId,
        action: 'concurrency.bindings',
        targetType: 'concurrency-definition',
        targetId: id,
        outcome: 'succeeded',
        metadata: { revision: input.expectedRevision + 1, bindingCount: bindings.length },
      });
      this.changed(
        tx,
        context,
        workspaceId,
        id,
        'Exact concurrency bindings recorded. Execution remains unavailable.',
        at,
      );
    });
    this.notifier.notify();
    return this.detail(context, workspaceId, id);
  }
  archiveContent(context: AuthContext, workspaceId: WorkspaceId, id: string) {
    this.workspaces.requireAuthorized(context, workspaceId);
    const archive = this.storage.imports.archive(workspaceId, id);
    if (!archive) throw new NotFoundError();
    return archive;
  }
  private planOption(
    tx: StorageRepositories,
    d: ConcurrencyDefinition,
    alias: string,
    v: PlanVersion,
  ) {
    const artifacts = tx.planning.artifacts.listForVersion(d.workspaceId, v.id);
    const issues: ImportIssue[] = [];
    const repo = present(d.source.repositories.find((r) => r.id === alias));
    for (const source of d.source.source_files.filter((f) => f.repository === alias)) {
      const name = source.original_path.split('/').at(-1);
      const artifact = artifacts.find((a) => a.logicalFilename === name);
      if (!artifact || artifact.sha256 !== source.sha256)
        issues.push(
          issue(
            'plan-source-mismatch',
            `${name}: ${artifact ? 'content differs' : 'missing from this plan version'}.`,
          ),
        );
      else if (
        (source.id === repo.source_plan && artifact.role !== 'implementation-plan') ||
        (source.id === repo.source_work_breakdown && artifact.role !== 'work-breakdown')
      )
        issues.push(issue('plan-role-mismatch', `${name}: imported with the wrong primary role.`));
    }
    const items = tx.planning.workItems.listForVersion(d.workspaceId, v.id);
    const expected = d.source.work_items.filter((p) => p.repository === alias);
    if (
      items.length !== expected.length ||
      expected.some((p) => {
        const w = items.find((w) => w.sourceId === p.source_item_id);
        return !w || sourceRecordDigest(w.sourceFields) !== p.source_record_sha256;
      })
    )
      issues.push(
        issue('plan-work-item-mismatch', 'The complete original work-item records do not match.'),
      );
    const archiveDigest = d.source.source_archives.find((a) => a.repository === alias)?.sha256;
    const archiveMatched = tx.imports
      .planLinks(d.workspaceId, v.id)
      .some(
        (link) => tx.imports.archiveInfo(d.workspaceId, link.archiveId)?.digest === archiveDigest,
      );
    const exactSources = issues.length === 0;
    if (!archiveMatched)
      issues.push(
        issue(
          'archive-provenance-missing',
          'The declared source ZIP has not been imported for this exact plan version.',
          'warning',
        ),
      );
    const branch = tx.execution.branchSettings.find(d.workspaceId, v.id);
    return {
      projectId: v.projectId,
      projectName:
        tx.planning.projects.find(d.workspaceId, v.projectId)?.name ?? 'Unavailable project',
      planVersionId: v.id,
      versionNumber: v.versionNumber,
      document: v.document,
      exactSources,
      archiveMatched,
      issues,
      ...(branch
        ? { repositoryId: branch.repositoryId, integrationBranch: branch.integrationBranch }
        : {}),
    };
  }
  private projectDetail(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    id: string,
  ): ConcurrencyDetail {
    const d = tx.imports.definition(workspaceId, id);
    if (!d) throw new NotFoundError();
    const archive = present(tx.imports.archiveInfo(workspaceId, d.archiveId));
    const history = tx.imports.bindings(workspaceId, id);
    const binding = history[0];
    const versions = tx.planning.projects
      .list(workspaceId)
      .flatMap((p) => tx.planning.versions.listForProject(workspaceId, p.id));
    const repositories = d.source.repositories.map((repo) => {
      const selected = binding?.bindings.find((b) => b.alias === repo.id);
      const options =
        repo.role === 'implemented_upstream'
          ? []
          : versions.map((v) => this.planOption(tx, d, repo.id, v));
      const selectedOption = options.find((o) => o.planVersionId === selected?.planVersionId);
      const issues: ImportIssue[] = [];
      if (!selected)
        issues.push(issue('binding-missing', `Choose and save the exact ${repo.id} binding.`));
      if (
        repo.role === 'implemented_upstream' &&
        selected?.repositoryId &&
        tx.execution.sourceRepositories.find(workspaceId, selected.repositoryId)?.status !==
          'active'
      )
        issues.push(
          issue(
            'repository-unavailable',
            'The bound upstream repository is unavailable. Choose an active repository and save a new binding revision.',
          ),
        );
      if (repo.role === 'implemented_upstream')
        issues.push(
          issue(
            'baseline-unbound',
            'Repository selection preserves AQ history; the current implementation commit, build evidence, acceptance and publication remain unbound.',
          ),
        );
      else if (selected) {
        if (!selectedOption?.exactSources)
          issues.push(issue('binding-invalid', 'Bound plan source is unavailable or mismatched.'));
        if (selectedOption && !selectedOption.archiveMatched)
          issues.push(
            issue(
              'archive-provenance-missing',
              'Source files match, but the declared ZIP provenance is not recorded.',
            ),
          );
        const branch =
          selected.planVersionId &&
          tx.execution.branchSettings.find(workspaceId, selected.planVersionId);
        if (!branch)
          issues.push(
            issue(
              'branch-unconfigured',
              'Configure Repository & branches on this plan version, then save bindings again.',
            ),
          );
        else {
          if (
            branch.repositoryId !== selected.repositoryId ||
            branch.integrationBranch !== selected.integrationBranch ||
            branch.version !== selected.branchSettingsVersion
          )
            issues.push(
              issue(
                'branch-binding-stale',
                'Repository/branch settings changed or were configured after binding. Review and save a new binding revision.',
              ),
            );
          if (
            tx.execution.sourceRepositories.find(workspaceId, branch.repositoryId)?.status !==
            'active'
          )
            issues.push(
              issue('repository-unavailable', 'The registered repository is unavailable.'),
            );
          if (repo.target_branch !== branch.integrationBranch)
            issues.push(
              issue(
                'branch-name-differs',
                `The map suggests ${repo.target_branch}; the plan uses ${branch.integrationBranch}. This difference requires reconciliation before adoption.`,
                'warning',
              ),
            );
        }
      }
      const sourceArchive = present(d.source.source_archives.find((a) => a.repository === repo.id));
      return {
        alias: repo.id,
        name: repo.repository,
        role: repo.role,
        suggestedBranch: repo.target_branch,
        archiveFilename: sourceArchive.filename,
        archiveDigest: sourceArchive.sha256,
        sources: d.source.source_files
          .filter((f) => f.repository === repo.id)
          .map((f) => ({ id: f.id, path: f.original_path, sha256: f.sha256 })),
        options,
        ...(selected?.planVersionId ? { selectedPlanVersionId: selected.planVersionId } : {}),
        ...(selected?.repositoryId ? { selectedRepositoryId: selected.repositoryId } : {}),
        boundWorkItems: (selected?.workItems ?? []).map((w) => ({
          sourceId: w.sourceId,
          workItemId: w.workItemId,
        })),
        issues,
      };
    });
    const nodes: ConcurrencyDetail['nodes'] = [];
    for (const p of d.source.work_items)
      nodes.push({
        id: p.id,
        kind: 'work-item',
        title: p.title,
        description: p.source_exit_gate,
        evidenceProfile: p.acceptance_evidence_profile,
        requirements: p.acceptance_requires.map((r) => ({ ...r, phase: 'accept' })),
        resources: [],
        sourceIds: [p.source_test_reference.source_id],
        decisionIds: [],
        caseIds: [...p.source_profile_case_ids, ...p.aq_baseline_case_ids],
        criteria: p.required_slices.map((id) => `Verify ${id}`),
      });
    for (const s of d.source.slices)
      nodes.push({
        id: s.id,
        kind: 'slice',
        title: s.title,
        description: s.scope,
        parentId: s.work_item,
        evidenceProfile: s.evidence_profile,
        requirements: [
          ...s.start_requires.map((r) => ({ ...r, phase: 'start' as const })),
          ...s.merge_requires.map((r) => ({ ...r, phase: 'merge' as const })),
          ...s.verify_requires.map((r) => ({ ...r, phase: 'verify' as const })),
        ],
        resources: (['start', 'merge', 'verify'] as const).flatMap((phase) =>
          s.resources_by_phase[phase].map((id) => ({ phase, id })),
        ),
        sourceIds: s.source_refs.map((r) => r.source_id),
        decisionIds: [...s.decision_refs],
        caseIds: [...s.aq_baseline_case_ids],
        criteria: s.excludes.map((e) => `Excluded: ${e}`),
      });
    for (const c of d.source.checkpoints)
      nodes.push({
        id: c.id,
        kind: 'checkpoint',
        title: c.title,
        description: `${c.kind}; unresolved. Eligibility does not constitute a pass.`,
        evidenceProfile: c.evidence_profile,
        requirements: c.requires.map((r) => ({ ...r, phase: 'evaluate' })),
        resources: [],
        sourceIds: c.source_refs.map((r) => r.source_id),
        decisionIds: [...c.decision_refs],
        caseIds: [],
        criteria: [...c.pass_criteria],
      });
    return {
      summary: this.summary(tx, d),
      archiveId: archive.id,
      archiveDigest: archive.digest,
      repositories,
      sourceRepositories: tx.execution.sourceRepositories
        .list(workspaceId)
        .filter((r) => r.status === 'active')
        .map((r) => ({ id: r.id, name: r.displayName })),
      blockers: [
        issue(
          'execution-not-implemented',
          'This release imports and binds definitions only. Slice execution, phase scheduling and evidence-backed gates are not available.',
        ),
        issue(
          'adoption-required',
          'Map decisions remain proposals. Adoption and Start will be separate commands once required execution capabilities exist.',
        ),
        issue(
          'environment-configuration-required',
          'Independent reviewers, pinned upstream builds, resource allocations and execution authorizations remain unconfigured.',
        ),
      ],
      nodes,
      decisions: d.source.decisions.map((x) => ({
        id: x.id,
        title: x.title,
        proposal: x.proposed_resolution,
      })),
      evidenceProfiles: d.source.evidence_profiles.map((e) => ({
        id: e.id,
        requiredEvidence: [...e.required_evidence],
        reviewerRoles: [...e.reviewer_roles],
      })),
      resources: d.source.resource_profiles.map((r) => ({
        id: r.id,
        description: r.description,
        requiresHardware: r.requires_hardware_virtualization,
        requiresAuthorization: r.fixture_authorization_required,
      })),
      targets: d.source.planning_targets.map((t) => ({
        id: t.id,
        checkpoint: t.checkpoint,
        scope: t.scope,
        isRelease: t.is_release,
      })),
      suggestedTarget: d.source.scheduling_policy.suggested_focus_target,
      limitations: [...d.source.limitations],
      history: history.map((h) => ({
        revision: h.revision,
        createdAt: h.createdAt,
        aliases: h.bindings.map((b) => b.alias),
      })),
    };
  }
  private summary(tx: StorageRepositories, d: ConcurrencyDefinition) {
    return {
      id: d.id,
      mapId: d.mapId,
      revision: d.revision,
      digest: d.digest,
      document: d.source.document,
      createdAt: d.createdAt,
      parentCount: d.source.work_items.length,
      sliceCount: d.source.slices.length,
      checkpointCount: d.source.checkpoints.length,
      graphNodeCount: d.graphNodeCount,
      graphEdgeCount: d.graphEdgeCount,
      bindingRevision: tx.imports.bindings(d.workspaceId, d.id)[0]?.revision ?? 0,
      status: 'imported-draft' as const,
      executable: false as const,
    };
  }
  private archive(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    filename: string,
    bytes: Uint8Array,
    at: string,
  ) {
    return tx.imports.addArchive(
      {
        id: randomUUID(),
        workspaceId,
        filename: filename.replace(/[^A-Za-z0-9._()-]/g, '_').slice(0, 200) || 'package.zip',
        digest: sha256Hex(bytes),
        byteLength: bytes.length,
        createdAt: at,
      },
      bytes,
    );
  }
  private recordFailed(
    context: AuthContext,
    workspaceId: WorkspaceId,
    filename: string,
    bytes: Uint8Array,
    kind: ArchiveImportAttempt['kind'],
    diagnostics: readonly ImportIssue[],
  ) {
    return this.storage.transaction((tx) => {
      const at = this.now().toISOString();
      const archive = this.archive(tx, workspaceId, filename, bytes, at);
      const attempt: ArchiveImportAttempt = {
        id: randomUUID(),
        workspaceId,
        archiveId: archive.id,
        kind,
        outcome: 'failed-validation',
        createdAt: at,
        createdByUserId: context.user.id,
        diagnostics,
      };
      this.recordAttempt(tx, attempt, context);
      return this.attemptView(tx, attempt);
    });
  }
  private recordAttempt(
    tx: StorageRepositories,
    attempt: ArchiveImportAttempt,
    context: AuthContext,
  ) {
    tx.imports.addAttempt(attempt);
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: attempt.createdAt,
      actorKind: 'user',
      actorUserId: context.user.id,
      workspaceId: attempt.workspaceId,
      action: 'package.import',
      targetType: 'archive-import-attempt',
      targetId: attempt.id,
      outcome: ['succeeded', 'duplicate'].includes(attempt.outcome) ? 'succeeded' : 'failed',
      metadata: {
        kind: attempt.kind,
        outcome: attempt.outcome,
        diagnosticCount: attempt.diagnostics.length,
      },
    });
  }
  private attemptView(tx: StorageRepositories, a: ArchiveImportAttempt) {
    return {
      id: a.id,
      archiveId: a.archiveId,
      filename: tx.imports.archiveInfo(a.workspaceId, a.archiveId)?.filename ?? 'package.zip',
      kind: a.kind,
      outcome: a.outcome,
      createdAt: a.createdAt,
      diagnostics: [...a.diagnostics],
      ...(a.definitionId ? { definitionId: a.definitionId } : {}),
      ...(a.planVersionId ? { planVersionId: a.planVersionId } : {}),
    };
  }
  private changed(
    tx: StorageRepositories,
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    reason: string,
    at: string,
  ) {
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt: at,
      workspaceId,
      actorUserId: context.user.id,
      kind: 'roadmap-changed',
      payload: { roadmapId: id, status: 'draft', reason },
    });
  }
}
