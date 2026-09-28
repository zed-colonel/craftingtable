import {
  architectureDecisionPacket,
  decisionPacketEntries,
  scopeArchitectureDecisions,
  stagedDecision,
} from './architecture-decision-policy.js';
import { operatorDecisions } from './operator-decisions.js';
import { integratedSlice, amendmentHoldingScope } from './scope-lineage.js';
import { adoptedDecisions, mapAdopted, scopeReviewerRoles } from './map-adoption-policy.js';
import {
  sameExecutionScope,
  executionScopeKey,
  type ExecutionPhase,
  type PhaseBlocker,
  type PhaseBlockerCode,
  type ExecutionScope,
  type ScopeReviewEvidence,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { mapReadSnapshot } from './map-read-snapshot.js';
import {
  prerequisiteEvaluation,
  prerequisiteIssues,
  acceptedEvidence,
  runtimeScopeBlockers,
  activeRuntime,
  currentScopeReceipt,
  parentAccepted,
} from './runtime-evidence-policy.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { PhaseGateError, resourceBlockers, phaseResources } from './phase-resources.js';

function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}
export function resolveScope(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
) {
  const item = tx.planning.workItems.find(workspaceId, workItemId);
  const definition = tx.imports.definition(workspaceId, scope.definitionId);
  const revision = tx.imports
    .bindings(workspaceId, scope.definitionId)
    .find((b) => b.revision === scope.bindingRevision);
  const binding = revision?.bindings.find((b) =>
    b.workItems.some((w) => w.workItemId === workItemId),
  );
  const parent = definition?.source.work_items.find((p) =>
    binding?.workItems.some((w) => w.sourceId === p.id && w.workItemId === workItemId),
  );
  if (!item || !definition || !binding || !parent || binding.planVersionId !== item.planVersionId)
    throw new NotFoundError();
  const slice =
    scope.kind === 'parent-acceptance'
      ? undefined
      : definition.source.slices.find((s) => s.id === scope.sourceId && s.work_item === parent.id);
  if (scope.kind === 'parent-acceptance' ? scope.sourceId !== parent.id : !slice)
    throw new NotFoundError();
  const profile = definition.source.evidence_profiles.find(
    (p) => p.id === (slice?.evidence_profile ?? parent.acceptance_evidence_profile),
  );
  if (!profile) conflict('The scope evidence profile is unavailable.');
  return { item, definition, binding, parent, slice, profile, scope };
}
export type ResolvedScope = ReturnType<typeof resolveScope>;
export function scopeRequirements(r: ResolvedScope) {
  return [
    ...new Set([
      ...r.profile.required_evidence,
      ...(r.slice ? [r.slice.scope] : [r.parent.source_exit_gate]),
    ]),
  ];
}
export function scopeCases(r: ResolvedScope): readonly string[] {
  if (!r.slice)
    return [...new Set([...r.parent.source_profile_case_ids, ...r.parent.aq_baseline_case_ids])];
  return [
    ...new Set([
      ...r.slice.aq_baseline_case_ids,
      ...r.definition.source.acceptance_coverage
        .filter((c) => c.producing_slices.includes(r.slice!.id))
        .map((c) => c.id),
    ]),
  ];
}
export function scopePhaseBlockers(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
  phase: ExecutionPhase,
  options: { resources?: boolean; ownerId?: string } = {},
): PhaseBlocker[] {
  tx = mapReadSnapshot(tx);
  const r = resolveScope(tx, workspaceId, workItemId, scope);
  const issues: PhaseBlocker[] = [];
  const add = (
    code: PhaseBlockerCode,
    kind: PhaseBlocker['kind'],
    message: string,
    refs?: PhaseBlocker['refs'],
  ) => issues.push({ kind, code, message, ...(refs ? { refs } : {}) });
  const settings = tx.execution.branchSettings.find(workspaceId, r.item.planVersionId);
  if (
    settings?.repositoryId !== r.binding.repositoryId ||
    settings?.integrationBranch !== r.binding.integrationBranch ||
    settings?.version !== r.binding.branchSettingsVersion
  )
    add(
      'binding-changed',
      'authorization',
      'The frozen repository/branch binding changed. Reconcile the map binding before continuing.',
    );
  if (
    tx.planning.projects.find(workspaceId, r.item.projectId)?.activePlanVersionId !==
    r.item.planVersionId
  )
    add('plan-inactive', 'authorization', 'The bound plan version is no longer active.');
  if (
    !r.binding.repositoryId ||
    tx.execution.sourceRepositories.find(workspaceId, r.binding.repositoryId)?.status !== 'active'
  )
    add('repository-unavailable', 'authorization', 'The bound repository is unavailable.');
  if (tx.amendments.superseded(workspaceId, scope.definitionId, scope.bindingRevision))
    add(
      'binding-retired',
      'authorization',
      'This map binding was retired by a reviewed amendment. Use its adopted replacement.',
    );
  if (amendmentHoldingScope(tx, workspaceId, scope))
    add(
      'amendment-pending',
      'authorization',
      'A planning amendment is awaiting review. Execution is held until it is applied or rejected.',
    );
  const early = scopeAllowsEarlyDevelopment(tx, workspaceId, workItemId, scope);
  for (const d of tx.planning.dependencies.listPredecessors(workspaceId, workItemId)) {
    const mapped = r.definition.source.work_items.find(
      (p) => p.source_item_id === d.sourceId && p.repository === r.parent.repository,
    );
    if (
      d.kind === 'required' &&
      (d.status !== 'completed' ||
        (mapped &&
          !parentAccepted(
            tx,
            workspaceId,
            scope.definitionId,
            scope.bindingRevision,
            mapped.id,
          ))) &&
      (phase === 'accept' || !early)
    )
      add(
        'predecessor-not-accepted',
        'dependency',
        `Parent predecessor ${d.sourceId} must be accepted.${r.slice?.early_start_exception ? ' An explicitly authorized early-development rule can replace this barrier for this slice only.' : ''}`,
      );
  }
  if (
    phase === 'merge' &&
    !tx.execution.worktrees
      .listForWorkItem(workspaceId, workItemId)
      .some(
        (t) =>
          sameExecutionScope(t.executionScope, { ...scope, kind: 'slice' }) &&
          tx.execution.runs.listForWorktree(workspaceId, t.id).some((run) => !!run.startedAt),
      )
  )
    add('slice-not-started', 'dependency', 'Start this slice before merging it.');
  if (phase === 'verify' && !latestSliceMerge(tx, workspaceId, workItemId, scope))
    add('slice-not-merged', 'dependency', 'Merge this slice before starting fresh verification.');
  if (
    phase === 'verify' &&
    tx.execution.worktrees
      .listForWorkItem(workspaceId, workItemId)
      .some(
        (t) =>
          t.status === 'active' &&
          !t.mergedAt &&
          !tx.amendments.retired(workspaceId, t.id) &&
          sameExecutionScope(t.executionScope, { ...scope, kind: 'slice' }),
      )
  )
    add(
      'slice-attempt-active',
      'dependency',
      'Finish and merge the active owning-slice attempt before verification.',
    );
  // Imported requirements confer no adoption, environment or effect authority.
  issues.push(...runtimeScopeBlockers(tx, workspaceId, scope, r.binding.alias));
  const adopted = adoptedDecisions(tx, workspaceId, scope.definitionId, scope.bindingRevision);
  for (const decision of r.slice?.decision_refs ?? [])
    if (!adopted.has(decision))
      add(
        'decision-adoption-required',
        'authorization',
        `Decision ${decision} requires explicit map adoption.`,
      );
  const requirements = r.slice
    ? [
        ...r.slice.start_requires,
        ...(phase !== 'start' ? r.slice.merge_requires : []),
        ...(phase === 'verify' ? r.slice.verify_requires : []),
      ]
    : [
        ...r.parent.acceptance_requires,
        ...parentEvidenceProducers(r).map((id) => ({
          kind: 'slice' as const,
          id,
          state: 'verified' as const,
        })),
      ];
  for (const decision of scopeArchitectureDecisions(tx, workspaceId, scope)) {
    const consumer = decision.architectureDecision?.consumers.find(
      (c) => c.sliceId === scope.sourceId,
    );
    if (!consumer || (phase === 'start' && consumer.phase !== 'start')) continue;
    for (const message of prerequisiteIssues(
      tx,
      r.definition,
      scope.bindingRevision,
      decision.subject,
    ))
      add(
        'staged-approval-prerequisite',
        'evidence',
        `${decision.subject.sourceId} staged approval: ${message}`,
      );
  }
  for (const requirement of requirements) {
    if (requirement.kind === 'checkpoint') {
      if (stagedDecision(tx, workspaceId, scope, requirement.id)) continue;
      if (
        !acceptedEvidence(
          tx,
          workspaceId,
          scope.definitionId,
          scope.bindingRevision,
          {
            kind: 'checkpoint',
            sourceId: requirement.id,
          },
          new Set(),
          phase === 'merge' ? scope : undefined,
        )
      )
        add(
          ['plan_approval', 'architecture_decision'].includes(
            r.definition.source.checkpoints.find((c) => c.id === requirement.id)?.kind ?? '',
          )
            ? 'decision-checkpoint-evidence'
            : 'checkpoint-evidence',
          'evidence',
          `Checkpoint ${requirement.id} must pass with current independently accepted evidence.`,
          { checkpointId: requirement.id },
        );
    } else if (requirement.kind === 'work_item') {
      const bound = tx.imports
        .bindings(workspaceId, scope.definitionId)
        .find((b) => b.revision === scope.bindingRevision)
        ?.bindings.flatMap((b) => b.workItems)
        .find((w) => w.sourceId === requirement.id);
      if (
        !bound ||
        !parentAccepted(tx, workspaceId, scope.definitionId, scope.bindingRevision, requirement.id)
      )
        add('parent-not-accepted', 'dependency', `Parent ${requirement.id} must be accepted.`);
    } else {
      const sourceSlice = r.definition.source.slices.find((s) => s.id === requirement.id);
      const bound = tx.imports
        .bindings(workspaceId, scope.definitionId)
        .find((b) => b.revision === scope.bindingRevision)
        ?.bindings.flatMap((b) => b.workItems)
        .find((w) => w.sourceId === sourceSlice?.work_item);
      const target: ExecutionScope = { ...scope, kind: 'slice', sourceId: requirement.id };
      const trees = bound
        ? tx.execution.worktrees
            .listForWorkItem(workspaceId, bound.workItemId)
            .filter((t) => sameExecutionScope(t.executionScope, target))
        : [];
      const receipts = bound ? tx.scopeReceipts.list(workspaceId, bound.workItemId) : [];
      const integrated = bound && integratedSlice(tx, workspaceId, bound.workItemId, target);
      const satisfied =
        requirement.state === 'started'
          ? !!integrated ||
            trees.some((t) =>
              tx.execution.runs.listForWorktree(workspaceId, t.id).some((run) => !!run.startedAt),
            )
          : requirement.state === 'merged'
            ? !!integrated?.mergeSha
            : !!acceptedEvidence(tx, workspaceId, scope.definitionId, scope.bindingRevision, {
                kind: 'slice',
                sourceId: requirement.id,
              }) ||
              receipts.some(
                (p) =>
                  currentScopeReceipt(tx, workspaceId, p) &&
                  sameExecutionScope(p.scope, target) &&
                  bound &&
                  latestSliceMerge(tx, workspaceId, bound.workItemId, target)?.mergeSha ===
                    p.integrationSha,
              );
      if (!satisfied)
        add(
          'slice-requirement',
          'dependency',
          `Slice ${requirement.id} must be ${requirement.state}.`,
          { sliceId: requirement.id },
        );
    }
  }
  if (
    phase === 'verify' &&
    r.slice &&
    r.definition.source.acceptance_coverage.some(
      (c) => c.requires_kata_host && c.producing_slices.includes(r.slice!.id),
    ) &&
    !acceptedEvidence(tx, workspaceId, scope.definitionId, scope.bindingRevision, {
      kind: 'slice',
      sourceId: scope.sourceId,
    })
  )
    add(
      'external-qualification-required',
      'evidence',
      'Actual Kata case evidence requires an independently accepted external qualification; an agent reviewer-role assignment does not supply it.',
    );
  if (options.resources !== false) issues.push(...resourceBlockers(tx, r, phase, options.ownerId));
  if (!r.slice) {
    const trees = tx.execution.worktrees.listForWorkItem(workspaceId, workItemId);
    const receipts = tx.scopeReceipts.list(workspaceId, workItemId);
    for (const sliceId of r.parent.required_slices) {
      const target = { ...scope, kind: 'slice' as const, sourceId: sliceId };
      const merged = latestSliceMerge(tx, workspaceId, workItemId, target);
      if (!merged)
        add('required-slice-unmerged', 'evidence', `Required slice ${sliceId} has not merged.`, {
          sliceId,
        });
      else if (
        !acceptedEvidence(tx, workspaceId, scope.definitionId, scope.bindingRevision, {
          kind: 'slice',
          sourceId: sliceId,
        }) &&
        !receipts.some(
          (p) =>
            currentScopeReceipt(tx, workspaceId, p) &&
            sameExecutionScope(p.scope, target) &&
            p.integrationSha === merged.mergeSha,
        )
      )
        add(
          'required-slice-unverified',
          'evidence',
          `Required slice ${sliceId} has not been verified.`,
          { sliceId },
        );
    }
    if (
      trees.some(
        (t) =>
          t.status === 'active' &&
          !tx.amendments.retired(workspaceId, t.id) &&
          t.executionScope?.kind === 'slice',
      )
    )
      add(
        'slice-attempt-active',
        'dependency',
        'Finish all active slice attempts before reviewing parent acceptance.',
      );
  }
  if (
    (phase === 'verify' || phase === 'accept') &&
    !acceptedEvidence(tx, workspaceId, scope.definitionId, scope.bindingRevision, {
      kind: r.slice ? 'slice' : 'parent',
      sourceId: scope.sourceId,
    }) &&
    !r.profile.reviewer_roles.every((role) =>
      scopeReviewerRoles(tx, workspaceId, scope).includes(role),
    ) &&
    (r.profile.reviewer_roles.length !== 1 ||
      !['review', 'independent-reviewer'].includes(r.profile.reviewer_roles[0] ?? ''))
  )
    add(
      'reviewer-assignment',
      'review',
      `Evidence profile ${r.profile.id} needs unassigned reviewer qualifications: ${r.profile.reviewer_roles.filter((role) => !scopeReviewerRoles(tx, workspaceId, scope).includes(role)).join(', ')}. Assign these responsibilities to the roadmap review agent, save the changed settings, then review the updated plan; independently reviewed external evidence is also supported.`,
    );
  return [...new Map(issues.map((i) => [i.message, i])).values()];
}
export function scopeBlockers(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
  phase: ExecutionPhase,
): string[] {
  return scopePhaseBlockers(tx, workspaceId, workItemId, scope, phase).map((b) => b.message);
}
export function scopeAllowsEarlyDevelopment(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope?: ExecutionScope,
): boolean {
  if (!scope || scope.kind === 'parent-acceptance') return false;
  const r = resolveScope(tx, workspaceId, workItemId, scope);
  return (
    !!r.slice?.early_start_exception &&
    (mapAdopted(tx, workspaceId, scope.definitionId, scope.bindingRevision) ||
      (!r.slice.decision_refs.length &&
        tx.phaseScheduling.authorized(
          workspaceId,
          workItemId,
          executionScopeKey({ ...scope, kind: 'slice' }),
        )))
  );
}
export function requireScope(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
  phase: ExecutionPhase,
) {
  const issues = scopePhaseBlockers(tx, workspaceId, workItemId, scope, phase, {
    resources: false,
  });
  if (issues.length) throw new PhaseGateError(issues);
  return resolveScope(tx, workspaceId, workItemId, scope);
}
export function requireScopeOwnership(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope?: ExecutionScope,
  ownWorktreeId?: string,
) {
  const trees = tx.execution.worktrees.listForWorkItem(workspaceId, workItemId);
  for (const tree of trees) {
    if (tree.id === ownWorktreeId || tx.amendments.retired(workspaceId, tree.id)) continue;
    if (tree.executionScope) {
      if (!scope)
        conflict(
          'This parent uses execution slices. Use its slice controls and parent acceptance review.',
        );
      if (
        tree.executionScope.definitionId !== scope.definitionId ||
        tree.executionScope.bindingRevision !== scope.bindingRevision
      )
        conflict(
          'This parent already has attempts bound to another map revision. Reconciliation is required.',
        );
      if (tree.status === 'active' && sameExecutionScope(tree.executionScope, scope))
        conflict('This execution scope already has an active worktree.');
    } else if (
      scope &&
      (tree.status === 'active' || tx.execution.runs.listForWorktree(workspaceId, tree.id).length)
    )
      conflict('Finish or reconcile existing whole-item execution before using slices.');
  }
}
export function requireTreeScope(
  tx: StorageRepositories,
  tree: Worktree,
  phase: 'start' | 'merge',
) {
  if (tx.amendments.retired(tree.workspaceId, tree.id))
    conflict(
      'This worktree was retired by a reviewed amendment; its edits and history are retained. Use the replacement scope.',
    );
  if (!tree.workItemId) return;
  requireScopeOwnership(tx, tree.workspaceId, tree.workItemId, tree.executionScope, tree.id);
  if (!tree.executionScope) return;
  if (phase === 'merge' && tree.executionScope.kind !== 'slice')
    conflict('Parent acceptance reviews do not merge. Use Accept parent after independent review.');
  const resolved = requireScope(
    tx,
    tree.workspaceId,
    tree.workItemId,
    tree.executionScope,
    tree.executionScope.kind === 'slice-verification'
      ? 'verify'
      : tree.executionScope.kind === 'parent-acceptance'
        ? 'accept'
        : phase,
  );
  if (
    tree.repositoryId !== resolved.binding.repositoryId ||
    tree.integrationBranch !== resolved.binding.integrationBranch
  )
    conflict('The worktree no longer matches its frozen scope binding.');
}
export function scopeEvidenceIssues(r: ResolvedScope, evidence?: ScopeReviewEvidence): string[] {
  if (!evidence || !sameExecutionScope(evidence.scope, r.scope))
    return ['The review must report evidence for this exact execution scope.'];
  const issues = scopeRequirements(r)
    .filter(
      (requirement) =>
        !evidence.requirements.some((e) => e.requirement === requirement && e.evidence.trim()),
    )
    .map((requirement) => `Missing review evidence: ${requirement}`);
  for (const id of scopeCases(r))
    if (!evidence.caseIds.includes(id)) issues.push(`Missing case evidence: ${id}`);
  if (new Set(evidence.caseIds).size !== evidence.caseIds.length)
    issues.push('Duplicate case evidence.');
  return issues;
}
export function scopeChoices(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
) {
  // Every slice × phase re-resolves the same definition, bindings and evidence;
  // one read snapshot decodes each of them once per call (PERF-04: ~400 -> ~40 ms).
  tx = mapReadSnapshot(tx);
  const result = [];
  const trees = tx.execution.worktrees.listForWorkItem(workspaceId, workItemId);
  const receipts = tx.scopeReceipts.list(workspaceId, workItemId);
  for (const d of tx.imports.definitions(workspaceId)) {
    const revisions = tx.imports.bindings(workspaceId, d.id);
    const ownedRevision = trees.find(
      (t) => !tx.amendments.retired(workspaceId, t.id) && t.executionScope?.definitionId === d.id,
    )?.executionScope?.bindingRevision;
    const b = revisions.find((b) => b.revision === ownedRevision) ?? revisions[0];
    const source = b?.bindings.flatMap((b) => b.workItems).find((w) => w.workItemId === workItemId);
    if (!source || !b) continue;
    const parent = d.source.work_items.find((w) => w.id === source.sourceId);
    if (!parent) continue;
    for (const node of [
      ...d.source.slices.filter((s) => s.work_item === source.sourceId),
      parent,
    ]) {
      const scope: ExecutionScope = {
        kind: 'work_item' in node ? 'slice' : 'parent-acceptance',
        definitionId: d.id,
        bindingRevision: b.revision,
        sourceId: node.id,
      };
      const owned = trees.filter((t) => sameExecutionScope(t.executionScope, scope));
      const merged = latestSliceMerge(tx, workspaceId, workItemId, scope);
      const verified =
        (scope.kind === 'slice' &&
          !!acceptedEvidence(tx, workspaceId, d.id, b.revision, {
            kind: 'slice',
            sourceId: scope.sourceId,
          })) ||
        receipts.some(
          (r) =>
            currentScopeReceipt(tx, workspaceId, r) &&
            sameExecutionScope(r.scope, scope) &&
            (scope.kind === 'parent-acceptance' || r.integrationSha === merged?.mergeSha),
        );
      result.push({
        scope,
        ...(rBindingRepository(b.bindings, workItemId)
          ? { repositoryId: rBindingRepository(b.bindings, workItemId) }
          : {}),
        earlyDevelopment: 'early_start_exception' in node && node.early_start_exception,
        earlyDevelopmentAuthorized: scopeAllowsEarlyDevelopment(tx, workspaceId, workItemId, scope),
        canAuthorizeEarlyDevelopment:
          'early_start_exception' in node &&
          node.early_start_exception &&
          !node.decision_refs.length,
        phases: (scope.kind === 'slice'
          ? (['start', 'merge', 'verify'] as const)
          : (['accept'] as const)
        ).map((phase) => ({
          phase,
          blockers: scopePhaseBlockers(tx, workspaceId, workItemId, scope, phase),
          resources: phaseResources(tx, resolveScope(tx, workspaceId, workItemId, scope), phase)
            .resources,
          reservations: tx.phaseScheduling
            .active()
            .filter(
              (c) =>
                c.workspaceId === workspaceId &&
                trees.some(
                  (t) => t.id === c.worktreeId && t.executionScope?.sourceId === scope.sourceId,
                ),
            ),
        })),
        title: node.title,
        description: 'scope' in node ? node.scope : parent.source_exit_gate,
        excludes: 'excludes' in node ? [...node.excludes] : [],
        blockers: scopeBlockers(
          tx,
          workspaceId,
          workItemId,
          scope,
          scope.kind === 'slice' ? 'start' : 'accept',
        ),
        status: verified
          ? scope.kind === 'slice'
            ? 'verified'
            : 'accepted'
          : owned.some((t) => t.mergedAt)
            ? 'merged'
            : owned.some((t) => tx.execution.runs.listForWorktree(workspaceId, t.id).length > 0)
              ? 'started'
              : owned.some((t) => t.status === 'active')
                ? 'prepared'
                : 'not-started',
        worktreeIds: owned.map((t) => t.id),
      });
    }
  }
  return result;
}
export function scopedReviewIssue(
  tx: StorageRepositories,
  tree: Worktree,
  report?: import('@craftingtable/domain').ReviewReportAssessment,
): string | undefined {
  if (!tree.executionScope || !tree.workItemId) return;
  if (
    report?.status !== 'complete' ||
    !sameExecutionScope(report.report.scopeEvidence?.scope, tree.executionScope)
  )
    return 'The review must identify this exact slice or parent-acceptance scope in scopeEvidence.';
  const r = resolveScope(tx, tree.workspaceId, tree.workItemId, tree.executionScope);
  const requirement = r.slice?.scope ?? r.parent.source_exit_gate;
  if (
    !report.report.scopeEvidence?.requirements.some(
      (e) => e.requirement === requirement && e.evidence.trim(),
    )
  )
    return 'The review omitted evidence for this execution scope’s exit gate.';
}
export function scopeBrief(r: ResolvedScope) {
  return {
    identity: r.scope,
    title: r.slice?.title ?? `Parent acceptance: ${r.parent.title}`,
    scope: r.slice?.scope ?? r.parent.source_exit_gate,
    excludes: r.slice?.excludes ?? [],
    requirements: scopeRequirements(r),
    cases: scopeCases(r),
    context: JSON.stringify({
      definitionId: r.definition.id,
      digest: r.definition.digest,
      bindingRevision: r.scope.bindingRevision,
      parent: r.parent.id,
      originalPredecessors: r.parent.depends_on,
      requiredSlices: r.parent.required_slices,
      gateInterpretation:
        'These are REQUIRED states, not evidence of success. Consult phaseReadiness and current receipts in craftingtable-scope-evidence.json. Only the controller may approve staging changes.',
      earlyStartProposed: r.slice?.early_start_exception,
      start: r.slice?.start_requires,
      merge: r.slice?.merge_requires,
      verify: r.slice?.verify_requires,
      parentAcceptance: r.parent.acceptance_requires,
      sources: r.slice?.source_refs ?? [r.parent.source_test_reference],
      reviewerRoles: r.profile.reviewer_roles,
      evidenceProfile: r.profile.id,
    }),
  };
}

function rBindingRepository(
  bindings: readonly import('@craftingtable/domain').ConcurrencyPlanBinding[],
  itemId: WorkItemId,
) {
  return bindings.find((b) => b.workItems.some((w) => w.workItemId === itemId))?.repositoryId;
}

export function latestSliceMerge(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
) {
  return integratedSlice(tx, workspaceId, workItemId, scope);
}
/** Capabilities required anywhere in this scope's lifecycle, independently of dynamic gates. */
export function unsupportedScopeCapabilities(r: ResolvedScope, tx?: StorageRepositories): string[] {
  const issues: string[] = [];

  if (
    r.slice?.decision_refs.length &&
    (!tx || !mapAdopted(tx, r.item.workspaceId, r.definition.id, r.scope.bindingRevision))
  )
    issues.push('Adopt this exact map binding before delegating its decision-dependent scopes.');
  // Qualified hosts are checked at their own phase, so unavailable verification
  // cannot prevent otherwise authorized development or hold a merge lock.
  return issues;
}

function parentEvidenceProducers(r: ResolvedScope): readonly string[] {
  return [
    ...new Set([
      ...r.parent.profile_evidence_slices,
      ...r.definition.source.acceptance_coverage
        .filter((c) => c.owner_work_item === r.parent.id)
        .flatMap((c) => c.producing_slices),
      ...r.definition.source.baseline_acceptance_coverage
        .filter((c) => c.owner_work_item === r.parent.id)
        .map((c) => c.producing_slice),
    ]),
  ];
}
/** The checkpoints a scope's own requirements name. */
function scopeCheckpointIds(r: ResolvedScope): readonly string[] {
  return [
    ...new Set(
      (r.slice
        ? [...r.slice.start_requires, ...r.slice.merge_requires, ...r.slice.verify_requires]
        : r.parent.acceptance_requires
      )
        .filter((requirement) => requirement.kind === 'checkpoint')
        .map((requirement) => requirement.id),
    ),
  ];
}
/** Retain evidence in a run artifact instead of repeating full reviews inside every prompt. */
export function scopeEvidenceLedger(tx: StorageRepositories, r: ResolvedScope) {
  const bindings = tx.imports
    .bindings(r.item.workspaceId, r.definition.id)
    .find((b) => b.revision === r.scope.bindingRevision);
  const producers = new Set([...r.parent.required_slices, ...parentEvidenceProducers(r)]);
  const parentIds = new Set([
    r.parent.id,
    ...r.parent.depends_on,
    ...(r.slice
      ? [...r.slice.start_requires, ...r.slice.merge_requires, ...r.slice.verify_requires]
      : r.parent.acceptance_requires
    ).flatMap((requirement) =>
      requirement.kind === 'work_item'
        ? [requirement.id]
        : requirement.kind === 'slice'
          ? r.definition.source.slices
              .filter((s) => s.id === requirement.id)
              .map((s) => s.work_item)
          : [],
    ),
    ...r.definition.source.slices.filter((s) => producers.has(s.id)).map((s) => s.work_item),
  ]);
  return {
    scope: r.scope,
    gateInterpretation:
      'Requirements describe required states, not observed successes. The phase blockers below are controller observations. Future merge/verification obligations do not automatically prevent design.',
    earlyDevelopmentAuthorized: scopeAllowsEarlyDevelopment(
      tx,
      r.item.workspaceId,
      r.item.id,
      r.scope,
    ),
    phaseReadiness: Object.fromEntries(
      (r.slice ? (['start', 'merge', 'verify'] as const) : (['accept'] as const)).map((phase) => [
        phase,
        scopePhaseBlockers(tx, r.item.workspaceId, r.item.id, r.scope, phase, { resources: false }),
      ]),
    ),
    architectureDecisions: architectureDecisionPacket(tx, r.item.workspaceId, r.scope),
    originalExitGate: r.parent.source_exit_gate,
    requiredSlices: r.parent.required_slices,
    evidenceProducers: [...producers],
    cases: scopeCases(r),
    runtime: activeRuntime(tx, r.item.workspaceId, r.definition.id, r.scope.bindingRevision),
    operatorDecisions: operatorDecisions(
      tx,
      r.item.workspaceId,
      bindings?.bindings
        .flatMap((b) => b.workItems)
        .filter((w) => parentIds.has(w.sourceId))
        .map((w) => w.workItemId) ?? [],
      r.scope,
    ),
    acceptedExternalEvidence: tx.runtimeEvidence
      .submissions(r.item.workspaceId, r.definition.id)
      .filter(
        (s) =>
          !s.architectureDecision &&
          acceptedEvidence(
            tx,
            r.item.workspaceId,
            r.definition.id,
            r.scope.bindingRevision,
            s.subject,
          )?.id === s.id,
      ),
    // Each checkpoint this scope requires, with the records that met its prerequisites. It is
    // the evaluation that decides the checkpoint is ready, so a checkpoint reviewer sees
    // every input the controller counted (R-C13, LIVE-07).
    checkpoints: scopeCheckpointIds(r).map((id) => {
      const ownDecisions = new Set(
        architectureDecisionPacket(tx, r.item.workspaceId, r.scope).map((d) => d.submissionId),
      );
      const checkpoint = r.definition.source.checkpoints.find((c) => c.id === id);
      const evaluation = prerequisiteEvaluation(tx, r.definition, r.scope.bindingRevision, {
        kind: 'checkpoint',
        sourceId: id,
      });
      // A prerequisite met by an accepted architecture decision is given as the decision
      // itself, so its clauses can be reviewed (R-C15, LIVE-12).
      const accepted = new Set(
        evaluation.inputs.flatMap((input) =>
          input.kind === 'accepted-evidence' ? [input.submissionId] : [],
        ),
      );
      // Decisions the scope's own `architectureDecisions` already carry are not repeated.
      const decisions = decisionPacketEntries(
        tx,
        r.item.workspaceId,
        tx.runtimeEvidence
          .submissions(r.item.workspaceId, r.definition.id)
          .filter((s) => accepted.has(s.id) && s.architectureDecision && !ownDecisions.has(s.id)),
      );
      return {
        id,
        title: checkpoint?.title,
        requires: checkpoint?.requires ?? [],
        prerequisites: evaluation.inputs,
        decisions,
        pending: evaluation.gaps.map((gap) => gap.message),
        coverage: r.definition.source.acceptance_coverage.filter((c) => c.checkpoint === id),
        baselineCoverage: r.definition.source.baseline_acceptance_coverage.filter(
          (c) => c.capability_gate === id,
        ),
      };
    }),
    receipts:
      bindings?.bindings
        .flatMap((b) => b.workItems)
        .filter((w) => parentIds.has(w.sourceId))
        .flatMap((w) => tx.scopeReceipts.list(r.item.workspaceId, w.workItemId))
        .filter(
          (p) =>
            p.scope.definitionId === r.definition.id &&
            p.scope.bindingRevision === r.scope.bindingRevision,
        )
        .map((receipt) => ({
          ...receipt,
          current: currentScopeReceipt(tx, r.item.workspaceId, receipt),
        })) ?? [],
  };
}
