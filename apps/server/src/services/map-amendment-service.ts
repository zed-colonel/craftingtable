import { mapProjectReadiness } from './map-finalization-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  asAgentRunId,
  compareConcurrencyDefinitions,
  scopeDefinitionFingerprint,
  targetClosure,
  canonicalDefinition,
  type MapAmendment,
  type MapSelection,
  type Roadmap,
  type WorkspaceId,
  type CrossProjectConfiguration,
  type MapActivitySettings,
} from '@craftingtable/domain';
import type {
  AmendmentImpact,
  ProposeMapAmendment,
  DecideMapAmendment,
} from '@craftingtable/contracts';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { GitOperations } from '@craftingtable/git';
import type { AuthContext } from './auth-service.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkCycleService } from './work-cycle-service.js';
import {
  type CrossProjectService,
  bindingIssues,
  milestoneSatisfied,
} from './cross-project-service.js';
import { integratedSlice, amendmentHoldingScope } from './scope-lineage.js';
import { activeRuntime, currentScopeReceipt, acceptedEvidence } from './runtime-evidence-policy.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalDefinition(value)).digest('hex');
const live = (status: string) =>
  !['finished', 'failed', 'cancelled', 'interrupted'].includes(status);
function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}
/** Proposed changes hold execution; applying a reviewed replacement never launches or grants evidence. */
export class MapAmendmentService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly cross: CrossProjectService,
    private readonly cycles: WorkCycleService,
    private readonly git: GitOperations | undefined,
    private readonly notifier: WorkspaceEventNotifier,
  ) {}
  private roadmap(ws: WorkspaceId, id: string) {
    const r = this.storage.roadmaps.find(ws, id);
    if (!r?.definition.crossProject) throw new NotFoundError();
    return r;
  }
  private proposal(ws: WorkspaceId, roadmapId: string, id: string) {
    const a = this.storage.amendments.list(ws, roadmapId).find((a) => a.id === id);
    if (!a) throw new NotFoundError();
    return a;
  }
  view(context: AuthContext, ws: WorkspaceId, id: string) {
    this.workspaces.requireAuthorized(context, ws);
    const r = this.roadmap(ws, id),
      history = this.storage.amendments.list(ws, id),
      pending = history.find((a) => !a.decision);
    return {
      history,
      ...(pending ? { pendingImpact: this.impact(ws, r, pending.candidate) } : {}),
      candidates: this.storage.imports.definitions(ws).flatMap((d) => {
        const b = this.storage.imports.bindings(ws, d.id)[0];
        return !b || this.storage.amendments.superseded(ws, d.id, b.revision)
          ? []
          : [
              {
                definitionId: d.id,
                bindingRevision: b.revision,
                label: `${d.mapId} · ${d.revision} · binding ${b.revision}`,
                targets: d.source.planning_targets.map((t) => ({ id: t.id, scope: t.scope })),
              },
            ];
      }),
    };
  }
  finalization(context: AuthContext, ws: WorkspaceId, id: string) {
    this.workspaces.requireAuthorized(context, ws);
    const c = this.roadmap(ws, id).definition.crossProject!;
    return { projects: mapProjectReadiness(this.storage, ws, c.definitionId, c.bindingRevision) };
  }
  preview(context: AuthContext, ws: WorkspaceId, id: string, candidate: MapSelection) {
    this.workspaces.requireAuthorized(context, ws);
    return this.impact(ws, this.roadmap(ws, id), candidate);
  }
  private configuration(r: Roadmap, c: MapSelection): CrossProjectConfiguration {
    const old = r.definition.crossProject!,
      d = this.storage.imports.definition(r.workspaceId, c.definitionId);
    if (!d) throw new NotFoundError();
    const closure = targetClosure(d.source, c.targetId, c.selection),
      keys = new Set(
        closure.nodes
          .filter((n) => n.requirement.kind !== 'checkpoint' && n.requirement.state !== 'merged')
          .map(
            (n) =>
              `${n.requirement.kind === 'work_item' ? 'acceptance' : n.requirement.state === 'verified' ? 'verification' : 'development'}:${n.requirement.id}`,
          ),
      );
    const roles = new Set(d.source.evidence_profiles.flatMap((p) => p.reviewer_roles));
    const settings = (s: MapActivitySettings): MapActivitySettings => ({
      ...s,
      ...(s.reviewerRoles
        ? { reviewerRoles: s.reviewerRoles.filter((role) => roles.has(role)) }
        : {}),
    });
    return {
      ...old,
      ...c,
      defaults: settings(old.defaults),
      overrides: old.overrides
        .filter((o) =>
          o.level === 'individual'
            ? keys.has(o.key)
            : o.level === 'project'
              ? d.source.repositories.some(
                  (p) => p.id === o.key && p.role === 'planned_application',
                )
              : true,
        )
        .map((o) => ({ ...o, settings: settings(o.settings) })),
    };
  }
  private impact(ws: WorkspaceId, r: Roadmap, c: MapSelection): AmendmentImpact {
    const before = r.definition.crossProject!,
      old = this.storage.imports.definition(ws, before.definitionId),
      next = this.storage.imports.definition(ws, c.definitionId),
      b = this.storage.imports
        .bindings(ws, c.definitionId)
        .find((b) => b.revision === c.bindingRevision),
      prior = this.storage.imports
        .bindings(ws, before.definitionId)
        .find((b) => b.revision === before.bindingRevision);
    if (!old || !next || !b || !prior) throw new NotFoundError();
    if (!next.source.planning_targets.some((t) => t.id === c.targetId))
      conflict('Choose a declared planning target.');
    const same =
      before.definitionId === c.definitionId && before.bindingRevision === c.bindingRevision;
    const closure = targetClosure(next.source, c.targetId, c.selection),
      keys = new Set(closure.nodes.map((n) => n.key));
    // The amendment replaces the binding, so a bound plan that is no longer active is not
    // a blocker here.
    const blockers = bindingIssues(this.storage, ws, c.definitionId, c.bindingRevision, {
      inactivePlans: false,
    });
    if (r.status === 'running')
      blockers.push('Propose this amendment to pause the roadmap before applying it.');
    if (
      this.storage.roadmaps
        .list(ws)
        .some(
          (other) =>
            other.id !== r.id && ['running', 'paused', 'needs-attention'].includes(other.status),
        )
    )
      blockers.push('Another roadmap holds this workspace delegation.');
    const bindings = b.bindings.map((bound) => {
      const was = prior.bindings.find((p) => p.alias === bound.alias);
      return {
        alias: bound.alias,
        before: was
          ? `${was.planVersionId ?? 'upstream'} · ${was.integrationBranch ?? 'pinned source'}`
          : 'not bound',
        after: `${bound.planVersionId ?? 'upstream'} · ${bound.integrationBranch ?? 'pinned source'}`,
        activate:
          !!bound.projectId &&
          !!bound.planVersionId &&
          this.storage.planning.projects.find(ws, bound.projectId)?.activePlanVersionId !==
            bound.planVersionId,
      };
    });
    const planIds = new Set(
      [...prior.bindings, ...b.bindings].flatMap((b) => (b.planVersionId ? [b.planVersionId] : [])),
    );
    for (const f of this.storage.execution.finalizations.list(ws))
      if (planIds.has(f.planVersionId) && !['completed', 'stopped'].includes(f.status))
        blockers.push(`Stop or finish finalization ${f.id} before changing its plan/map context.`);
    const attempts = r.attempts.map((a) => {
      const entry = r.definition.entries.find((e) => e.id === a.entryId)!,
        scope = entry.executionScope!,
        cycle = this.storage.execution.cycles.find(ws, a.cycleId),
        tree = this.storage.execution.worktrees.find(ws, a.worktreeId);
      const requirement: import('@craftingtable/domain').ConcurrencyRequirement =
        scope.kind === 'parent-acceptance'
          ? { kind: 'work_item', id: scope.sourceId, state: 'accepted' }
          : {
              kind: 'slice',
              id: scope.sourceId,
              state: scope.kind === 'slice-verification' ? 'verified' : 'started',
            };
      const { state, kind } = requirement;
      const included = keys.has(`${kind}:${scope.sourceId}:${state}`);
      const done =
        scope.kind === 'slice'
          ? !!tree?.mergeSha
          : milestoneSatisfied(this.storage, ws, next, c.bindingRevision, requirement);
      const retain =
        same &&
        included &&
        (scope.kind === 'slice'
          ? cycle?.status !== 'stopped' || !!tree?.mergedAt
          : done || !['completed', 'stopped', 'needs-attention'].includes(cycle?.status ?? ''));
      return {
        id: a.id,
        sourceId: scope.sourceId,
        workItemId: entry.workItemId,
        worktreeId: a.worktreeId,
        cycleId: a.cycleId,
        ...(cycle ? { runId: cycle.currentRunId } : {}),
        status: cycle?.status ?? a.status,
        disposition: retain ? ('retain' as const) : ('retire' as const),
      };
    });
    const trees = this.affectedTrees(
      ws,
      r,
      c,
      attempts.filter((a) => a.disposition === 'retire').map((a) => a.worktreeId),
    );
    const activeRuns = trees
      .flatMap((t) => this.storage.execution.runs.listForWorktree(ws, t.id))
      .filter((run) => live(run.status));
    if (this.storage.phaseScheduling.active().some((p) => trees.some((t) => t.id === p.worktreeId)))
      blockers.push('Wait for current phase resource reservations to finish.');
    for (const run of activeRuns)
      blockers.push(
        `Wait for or end run ${run.id} before applying; its original worktree is preserved.`,
      );
    for (const t of trees) {
      const merge = this.storage.execution.merges.latest(ws, t.id);
      if (merge?.status === 'reserved')
        blockers.push(`Recover the pending merge for ${t.branchName} first.`);
      const cy = this.storage.execution.cycles.activeForWorktree(ws, t.id);
      if (
        cy?.integrationResolution &&
        !['completed', 'abandoned'].includes(cy.integrationResolution.status)
      )
        blockers.push(`Complete or abandon conflict resolution for ${t.branchName} first.`);
    }
    // Unowned work is never retired as an incidental effect of activating another plan.
    for (const bound of b.bindings.filter((b) => b.projectId && b.planVersionId)) {
      const project = this.storage.planning.projects.find(ws, bound.projectId!);
      if (project?.activePlanVersionId && project.activePlanVersionId !== bound.planVersionId) {
        for (const t of this.storage.execution.worktrees
          .listActive(ws)
          .filter((t) => t.projectId === bound.projectId))
          if (!trees.some((affected) => affected.id === t.id))
            blockers.push(
              `Resolve unrelated active worktree ${t.branchName} before activating the revised plan.`,
            );
      }
    }
    if (!same)
      for (const t of this.storage.execution.worktrees.listActive(ws))
        if (
          !this.storage.amendments.retired(ws, t.id) &&
          t.executionScope?.definitionId === c.definitionId &&
          t.executionScope.bindingRevision === c.bindingRevision
        )
          blockers.push(
            `Finish candidate worktree ${t.branchName} before applying this binding. It is preserved and was not delegated by this roadmap.`,
          );
    const integrations = closure.nodes
      .filter((n) => n.requirement.kind === 'slice' && n.requirement.state === 'merged')
      .flatMap((n) => {
        const id = n.requirement.id,
          source = prior.bindings
            .flatMap((p) => p.workItems)
            .find(
              (w) => w.sourceId === old.source.slices.find((s) => s.id === id)?.work_item,
            )?.workItemId;
        if (!source || same) return [];
        const merged = integratedSlice(this.storage, ws, source, {
          kind: 'slice',
          definitionId: old.id,
          bindingRevision: before.bindingRevision,
          sourceId: id,
        });
        if (!merged?.mergeSha) return [];
        const owner = next.source.slices.find((s) => s.id === id)?.work_item,
          target = b.bindings.find((b) => b.workItems.some((w) => w.sourceId === owner));
        const eligible =
          scopeDefinitionFingerprint(old.source, 'slice', id) ===
            scopeDefinitionFingerprint(next.source, 'slice', id) &&
          target?.repositoryId === merged.repositoryId &&
          target?.integrationBranch === merged.integrationBranch;
        return [
          {
            sourceId: id,
            sourceWorktreeId: merged.id,
            mergeSha: merged.mergeSha,
            eligible,
            reason: eligible
              ? 'Code can be reused after ancestry verification. Verification and parent acceptance must be reviewed again.'
              : 'Requirements, source documents or integration binding changed; this code is not eligible for direct reuse.',
          },
        ];
      });
    const receipts = prior.bindings
      .flatMap((p) => p.workItems)
      .flatMap((w) => this.storage.scopeReceipts.list(ws, w.workItemId));
    const evidence = [
      ...receipts
        .filter(
          (p) =>
            p.scope.definitionId === old.id && p.scope.bindingRevision === before.bindingRevision,
        )
        .map((p) => ({
          id: p.id,
          sourceId: p.scope.sourceId,
          kind: p.scope.kind,
          applicability:
            same && currentScopeReceipt(this.storage, ws, p)
              ? ('current' as const)
              : ('reassess' as const),
        })),
      ...this.storage.runtimeEvidence.submissions(ws, old.id).map((s) => ({
        id: s.id,
        sourceId: s.subject.sourceId,
        kind: s.subject.kind,
        applicability:
          same &&
          acceptedEvidence(this.storage, ws, old.id, c.bindingRevision, s.subject)?.id === s.id
            ? ('current' as const)
            : ('reassess' as const),
      })),
    ];
    const warnings = [
      'Applying does not start agents, transfer checkpoint approvals, approve protected promotion, delete branches or complete retired work.',
      'Every excluded milestone remains an obligation outside the selected scope.',
    ];
    for (const t of trees)
      if (!attempts.some((a) => a.worktreeId === t.id))
        warnings.push(
          `Preserve and retire prior worktree ${t.branchName} (${t.id}); its original runs and edits remain inspectable.`,
        );
    if (!same)
      warnings.push(
        'Configure the new pinned environment and explicitly adopt its scheduling decisions after applying. Previous approvals do not transfer.',
      );
    const conf = this.configuration(r, c);
    if (conf.overrides.length !== before.overrides.length)
      warnings.push(
        'Overrides for scopes absent from the new selection are removed; surviving attempts retain frozen settings.',
      );
    if (
      canonicalDefinition(conf.defaults.reviewerRoles) !==
      canonicalDefinition(before.defaults.reviewerRoles)
    )
      warnings.push(
        'Reviewer roles absent from the new definition are removed. Inspect the queued reviewer assignments.',
      );
    const priorKeys = new Set(
      r.definition.entries
        .filter((e) => !r.attempts.some((a) => a.entryId === e.id))
        .map((e) => `${e.executionScope!.kind}:${e.executionScope!.sourceId}`),
    );
    const queuedKeys = new Set(
      closure.nodes
        .filter((n) => n.requirement.kind !== 'checkpoint' && n.requirement.state !== 'merged')
        .map(
          (n) =>
            `${n.requirement.kind === 'work_item' ? 'parent-acceptance' : n.requirement.state === 'verified' ? 'slice-verification' : 'slice'}:${n.requirement.id}`,
        ),
    );
    const retainedKeys = new Set(
      attempts
        .filter((a) => a.disposition === 'retain')
        .map((a) => {
          const e = r.definition.entries.find(
            (e) => e.id === r.attempts.find((t) => t.id === a.id)?.entryId,
          )!;
          return `${e.executionScope!.kind}:${e.executionScope!.sourceId}`;
        }),
    );
    const queued = [...new Set([...priorKeys, ...queuedKeys])]
      .filter((key) => !retainedKeys.has(key))
      .map((key) => ({
        key,
        disposition: !queuedKeys.has(key)
          ? ('removed' as const)
          : same && priorKeys.has(key)
            ? ('retained' as const)
            : ('added' as const),
      }));
    const result = {
      candidate: c,
      queued,
      blockers: [...new Set(blockers)],
      warnings,
      changes: compareConcurrencyDefinitions(old.source, next.source),
      bindings,
      attempts,
      evidence,
      integrations,
    };
    return {
      ...result,
      digest: hash({
        result,
        version: r.version,
        definitionRevision: r.definition.revision,
        bindings: b,
        prior,
        trees: trees.map((t) => ({
          id: t.id,
          version: t.version,
          status: t.status,
          mergeSha: t.mergeSha,
        })),
        runs: activeRuns.map((r) => ({ id: r.id, status: r.status })),
        runtime: activeRuntime(this.storage, ws, c.definitionId, c.bindingRevision)?.id,
        projects: b.bindings.flatMap((b) =>
          b.projectId ? [this.storage.planning.projects.find(ws, b.projectId)] : [],
        ),
      }),
    };
  }
  private affectedTrees(
    ws: WorkspaceId,
    r: Roadmap,
    c: MapSelection,
    retireIds: readonly string[],
  ) {
    const old = r.definition.crossProject!,
      changed = old.definitionId !== c.definitionId || old.bindingRevision !== c.bindingRevision;
    const items =
      this.storage.imports
        .bindings(ws, old.definitionId)
        .find((b) => b.revision === old.bindingRevision)
        ?.bindings.flatMap((b) => b.workItems) ?? [];
    return items
      .flatMap((w) => this.storage.execution.worktrees.listForWorkItem(ws, w.workItemId))
      .filter(
        (t) =>
          !this.storage.amendments.retired(ws, t.id) &&
          (retireIds.includes(t.id) ||
            (changed &&
              t.executionScope?.definitionId === old.definitionId &&
              t.executionScope.bindingRevision === old.bindingRevision)),
      );
  }
  async propose(context: AuthContext, ws: WorkspaceId, id: string, input: ProposeMapAmendment) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const r = this.roadmap(ws, id);
    if (r.version !== input.expectedVersion) conflict('Roadmap changed; refresh before proposing.');
    if (this.storage.amendments.list(ws).some((a) => !a.decision))
      conflict('Decide the existing workspace proposal first.');
    this.impact(ws, r, input.candidate);
    if (
      this.storage.roadmaps
        .list(ws)
        .some(
          (other) =>
            other.id !== id && ['running', 'paused', 'needs-attention'].includes(other.status),
        )
    )
      conflict('Another roadmap holds workspace delegation.');
    if (input.sourceRunId) {
      const run = this.storage.execution.runs.find(ws, asAgentRunId(input.sourceRunId));
      if (!run || !r.definition.entries.some((e) => e.workItemId === run.workItemId))
        conflict('The source run must belong to this roadmap’s work.');
    }
    const at = new Date().toISOString(),
      a: MapAmendment = {
        id: randomUUID(),
        workspaceId: ws,
        roadmapId: id,
        baseRevision: r.definition.revision,
        candidate: input.candidate,
        summary: input.summary,
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
        createdAt: at,
        createdByUserId: context.user.id,
      };
    this.storage.transaction((tx) => {
      tx.amendments.add(a);
      if (
        !tx.roadmaps.save(
          {
            ...withoutAttention(r),
            status: 'paused',
            version: r.version + 1,
            updatedAt: at,
            reason:
              'Planning amendment awaiting review. Running sessions retain their original context; further execution is held.',
          },
          r.version,
        )
      )
        conflict('Roadmap changed; refresh.');
      this.record(tx, context, ws, id, a.id, 'proposed', at);
    });
    this.notifier.notify();
    for (const cycle of this.storage.execution.cycles.listForWorkspace(ws)) {
      if (
        cycle.status === 'running' &&
        cycle.executionScope &&
        amendmentHoldingScope(this.storage, ws, cycle.executionScope)
      )
        await this.cycles.control(context, ws, cycle.id, 'pause', cycle.version);
    }
    return this.view(context, ws, id);
  }
  async decide(context: AuthContext, ws: WorkspaceId, id: string, input: DecideMapAmendment) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const a = this.proposal(ws, id, input.amendmentId);
    if (a.decision) conflict('This amendment already has a decision.');
    const r = this.roadmap(ws, id),
      impact = this.impact(ws, r, a.candidate);
    if (impact.digest !== input.impactDigest || r.definition.revision !== a.baseRevision)
      conflict('The impact preview changed. Review the current impact before deciding.');
    if (input.outcome === 'apply' && impact.blockers.length) conflict(impact.blockers.join(' '));
    if (input.outcome === 'reject' && input.reuseIntegrationIds.length)
      conflict('Rejected proposals cannot carry integration code.');
    const chosen = impact.integrations.filter((i) =>
      input.reuseIntegrationIds.includes(i.sourceId),
    );
    if (chosen.length !== input.reuseIntegrationIds.length || chosen.some((i) => !i.eligible))
      conflict('Select only eligible integration records from this preview.');
    const candidate = this.storage.imports.definition(ws, a.candidate.definitionId)!,
      binding = this.storage.imports
        .bindings(ws, candidate.id)
        .find((b) => b.revision === a.candidate.bindingRevision)!;
    for (const reuse of chosen) {
      const target = binding.bindings.find((b) =>
          b.workItems.some(
            (w) =>
              w.sourceId ===
              candidate.source.slices.find((s) => s.id === reuse.sourceId)?.work_item,
          ),
        ),
        repo =
          target?.repositoryId &&
          this.storage.execution.sourceRepositories.find(ws, target.repositoryId);
      if (!repo || !target?.integrationBranch || !this.git)
        conflict('Integration repository unavailable.');
      const head = await this.git.resolveBranch(repo.rootPath, target.integrationBranch);
      const ancestor =
        head.ok && (await this.git.isAncestor(repo.rootPath, reuse.mergeSha, head.value));
      if (typeof ancestor !== 'object' || !ancestor.ok || !ancestor.value)
        conflict(
          `Integrated code ${reuse.sourceId} is absent from the candidate integration branch.`,
        );
    }
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    if (this.impact(ws, this.roadmap(ws, id), a.candidate).digest !== impact.digest)
      conflict('Execution changed during review; refresh the impact.');
    const at = new Date().toISOString();
    this.storage.transaction((tx) => {
      if (tx.amendments.list(ws, id).find((p) => p.id === a.id)?.decision)
        conflict('Amendment already decided.');
      if (input.outcome === 'apply') {
        const retired = impact.attempts.filter((a) => a.disposition === 'retire'),
          trees = this.affectedTrees(
            ws,
            r,
            a.candidate,
            retired.map((a) => a.worktreeId),
          );
        for (const t of trees) tx.amendments.retire(ws, t.id, a.id);
        for (const t of trees) {
          const cycle = tx.execution.cycles.activeForWorktree(ws, t.id);
          if (cycle) this.cycles.retireForAmendment(context, cycle, a.id);
        }
        for (const reuse of chosen) {
          const item = binding.bindings
            .flatMap((b) => b.workItems)
            .find(
              (w) =>
                w.sourceId ===
                candidate.source.slices.find((s) => s.id === reuse.sourceId)?.work_item,
            )!;
          tx.amendments.addIntegration({
            id: randomUUID(),
            amendmentId: a.id,
            workspaceId: ws,
            workItemId: item.workItemId,
            scope: {
              kind: 'slice',
              definitionId: candidate.id,
              bindingRevision: a.candidate.bindingRevision,
              sourceId: reuse.sourceId,
            },
            sourceWorktreeId: reuse.sourceWorktreeId,
            mergeSha: reuse.mergeSha,
            recordedAt: at,
          });
        }
        for (const b of binding.bindings)
          if (b.projectId && b.planVersionId) {
            const project = tx.planning.projects.find(ws, b.projectId)!;
            if (project.activePlanVersionId !== b.planVersionId) {
              if (!tx.imports.activatePlan(ws, b.projectId, b.planVersionId, project.version))
                conflict('Plan activation changed; refresh.');
              tx.audit.append({
                id: asAuditEventId(randomUUID()),
                workspaceId: ws,
                occurredAt: at,
                actorKind: 'user',
                actorUserId: context.user.id,
                action: 'plan.version-activated',
                targetType: 'plan-version',
                targetId: b.planVersionId,
                outcome: 'succeeded',
                metadata: {
                  amendmentId: a.id,
                  previousPlanVersionId: project.activePlanVersionId ?? null,
                },
              });
            }
          }
        const old = r.definition.crossProject!;
        if (
          old.definitionId !== candidate.id ||
          old.bindingRevision !== a.candidate.bindingRevision
        )
          tx.amendments.supersede(ws, old.definitionId, old.bindingRevision, a.id);
        this.cross.save(
          context,
          ws,
          {
            roadmapId: id,
            expectedVersion: r.version,
            name: r.definition.name,
            configuration: this.configuration(r, a.candidate),
            scheduling: {
              mode: 'parallel',
              maxInFlight: r.definition.scheduling?.maxInFlight ?? 2,
              maxPerRepository: r.definition.scheduling?.maxPerRepository ?? 2,
              maxIntegrationRefreshes: r.definition.scheduling?.maxIntegrationRefreshes ?? 3,
            },
          },
          {
            retainAttemptIds: impact.attempts
              .filter((a) => a.disposition === 'retain')
              .map((a) => a.id),
          },
        );
      }
      if (
        !tx.amendments.decide(ws, a.id, {
          outcome: input.outcome === 'apply' ? 'applied' : 'rejected',
          rationale: input.rationale,
          impactDigest: impact.digest,
          previous: r,
          ...(input.outcome === 'apply' ? { resultingRevision: r.definition.revision + 1 } : {}),
          reusedIntegrationIds: input.reuseIntegrationIds,
          decidedAt: at,
          decidedByUserId: context.user.id,
        })
      )
        conflict('Amendment already decided.');
      this.record(tx, context, ws, id, a.id, input.outcome, at);
    });
    this.notifier.notify();
    return this.view(context, ws, id);
  }
  private record(
    tx: StorageRepositories,
    context: AuthContext,
    ws: WorkspaceId,
    roadmapId: string,
    id: string,
    operation: string,
    at: string,
  ) {
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      workspaceId: ws,
      occurredAt: at,
      actorKind: 'user',
      actorUserId: context.user.id,
      sessionId: context.session.id,
      action: 'roadmap.amendment',
      targetType: 'map-amendment',
      targetId: id,
      outcome: 'succeeded',
      metadata: { roadmapId, operation },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      workspaceId: ws,
      occurredAt: at,
      actorUserId: context.user.id,
      kind: 'roadmap-changed',
      payload: {
        roadmapId,
        status: 'paused',
        reason: `Planning amendment ${operation}. Explicit resume remains required.`,
      },
    });
  }
}

/** A paused roadmap carries no attention; that belongs to needs-attention only (R-A3). */
function withoutAttention<T extends { readonly attention?: unknown }>(
  value: T,
): Omit<T, 'attention'> {
  const { attention: _cleared, ...rest } = value;
  return rest;
}
