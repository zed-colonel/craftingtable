import {
  sameExecutionScope,
  type ExecutionScope,
  type ScopeReviewEvidence,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { ExecutionRequestError, NotFoundError } from './errors.js';

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
export function scopeBlockers(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
  phase: 'start' | 'merge' | 'verify' | 'accept',
): string[] {
  const r = resolveScope(tx, workspaceId, workItemId, scope);
  const issues: string[] = [];
  const settings = tx.execution.branchSettings.find(workspaceId, r.item.planVersionId);
  if (
    settings?.repositoryId !== r.binding.repositoryId ||
    settings?.integrationBranch !== r.binding.integrationBranch ||
    settings?.version !== r.binding.branchSettingsVersion
  )
    issues.push(
      'The frozen repository/branch binding changed. Reconcile the map binding before continuing.',
    );
  if (
    tx.planning.projects.find(workspaceId, r.item.projectId)?.activePlanVersionId !==
    r.item.planVersionId
  )
    issues.push('The bound plan version is no longer active.');
  if (
    !r.binding.repositoryId ||
    tx.execution.sourceRepositories.find(workspaceId, r.binding.repositoryId)?.status !== 'active'
  )
    issues.push('The bound repository is unavailable.');
  if (r.item.status === 'completed') issues.push('The parent work item is already complete.');
  for (const d of tx.planning.dependencies.listPredecessors(workspaceId, workItemId))
    if (d.kind === 'required' && d.status !== 'completed')
      issues.push(
        `Parent predecessor ${d.sourceId} is not accepted. Early-start exceptions require the later phase scheduler.`,
      );
  if (scope.kind === 'slice-verification' && !latestSliceMerge(tx, workspaceId, workItemId, scope))
    issues.push('Merge this slice before starting fresh verification.');
  // Imported requirements confer no adoption, environment or effect authority.
  if (r.definition.source.repositories.some((repo) => repo.role === 'implemented_upstream'))
    issues.push(
      'Pinned upstream environments and baseline evidence are not available yet; this map cannot execute.',
    );
  for (const decision of r.slice?.decision_refs ?? [])
    issues.push(`Decision ${decision} requires adoption; decision adoption is not available yet.`);
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
  for (const requirement of requirements) {
    if (requirement.kind === 'checkpoint')
      issues.push(
        `Checkpoint ${requirement.id} must pass. Checkpoint evidence is not available yet.`,
      );
    else if (requirement.kind === 'work_item') {
      const bound = tx.imports
        .bindings(workspaceId, scope.definitionId)
        .find((b) => b.revision === scope.bindingRevision)
        ?.bindings.flatMap((b) => b.workItems)
        .find((w) => w.sourceId === requirement.id);
      if (
        !bound ||
        tx.planning.workItems.find(workspaceId, bound.workItemId)?.status !== 'completed'
      )
        issues.push(`Parent ${requirement.id} must be accepted.`);
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
      const satisfied =
        requirement.state === 'started'
          ? trees.some(
              (t) =>
                tx.execution.runs.listForWorktree(workspaceId, t.id).length > 0 ||
                tx.execution.cycles.list(workspaceId).some((c) => c.worktreeId === t.id),
            )
          : requirement.state === 'merged'
            ? trees.some((t) => t.mergedAt)
            : receipts.some(
                (p) =>
                  sameExecutionScope(p.scope, target) &&
                  bound &&
                  latestSliceMerge(tx, workspaceId, bound.workItemId, target)?.mergeSha ===
                    p.integrationSha,
              );
      if (!satisfied) issues.push(`Slice ${requirement.id} must be ${requirement.state}.`);
    }
  }
  if (r.slice) {
    const resources = [
      ...r.slice.resources_by_phase.start,
      ...(phase !== 'start' ? r.slice.resources_by_phase.merge : []),
      ...(phase === 'verify' ? r.slice.resources_by_phase.verify : []),
    ];
    for (const resource of resources)
      issues.push(
        `Resource ${resource} requires a phase reservation; resource scheduling is not available yet.`,
      );
  } else {
    const trees = tx.execution.worktrees.listForWorkItem(workspaceId, workItemId);
    const receipts = tx.scopeReceipts.list(workspaceId, workItemId);
    for (const sliceId of r.parent.required_slices) {
      const target = { ...scope, kind: 'slice' as const, sourceId: sliceId };
      const merged = latestSliceMerge(tx, workspaceId, workItemId, target);
      if (!merged) issues.push(`Required slice ${sliceId} has not merged.`);
      else if (
        !receipts.some(
          (p) => sameExecutionScope(p.scope, target) && p.integrationSha === merged.mergeSha,
        )
      )
        issues.push(`Required slice ${sliceId} has not been verified.`);
    }
    if (trees.some((t) => t.status === 'active' && t.executionScope?.kind === 'slice'))
      issues.push('Finish all active slice attempts before reviewing parent acceptance.');
  }
  if (
    (phase === 'verify' || phase === 'accept') &&
    (r.profile.reviewer_roles.length !== 1 ||
      !['review', 'independent-reviewer'].includes(r.profile.reviewer_roles[0] ?? ''))
  )
    issues.push(
      `Evidence profile ${r.profile.id} requires reviewer qualifications (${r.profile.reviewer_roles.join(', ')}); qualified evidence collection is not available yet.`,
    );
  return [...new Set(issues)];
}
export function requireScope(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
  phase: 'start' | 'merge' | 'verify' | 'accept',
) {
  const issues = scopeBlockers(tx, workspaceId, workItemId, scope, phase);
  if (issues.length) conflict(issues.join('\n'));
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
    if (tree.id === ownWorktreeId) continue;
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
  const result = [];
  const trees = tx.execution.worktrees.listForWorkItem(workspaceId, workItemId);
  const receipts = tx.scopeReceipts.list(workspaceId, workItemId);
  for (const d of tx.imports.definitions(workspaceId)) {
    const revisions = tx.imports.bindings(workspaceId, d.id);
    const ownedRevision = trees.find((t) => t.executionScope?.definitionId === d.id)?.executionScope
      ?.bindingRevision;
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
      const verified = receipts.some(
        (r) =>
          sameExecutionScope(r.scope, scope) &&
          (scope.kind === 'parent-acceptance' || r.integrationSha === merged?.mergeSha),
      );
      result.push({
        scope,
        ...(rBindingRepository(b.bindings, workItemId)
          ? { repositoryId: rBindingRepository(b.bindings, workItemId) }
          : {}),
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
  return tx.execution.worktrees
    .listForWorkItem(workspaceId, workItemId)
    .filter(
      (t) =>
        sameExecutionScope(t.executionScope, { ...scope, kind: 'slice' }) &&
        t.mergedAt &&
        t.mergeSha,
    )
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0];
}
/** Capabilities required anywhere in this scope's lifecycle, independently of dynamic gates. */
export function unsupportedScopeCapabilities(r: ResolvedScope): string[] {
  const issues: string[] = [];
  if (r.definition.source.repositories.some((repo) => repo.role === 'implemented_upstream'))
    issues.push('Pinned upstream environments and baseline evidence are not available yet.');
  if (r.slice?.decision_refs.length) issues.push('Decision adoption is not available yet.');
  const requirements = r.slice
    ? [...r.slice.start_requires, ...r.slice.merge_requires, ...r.slice.verify_requires]
    : r.parent.acceptance_requires;
  if (requirements.some((r) => r.kind === 'checkpoint'))
    issues.push('Checkpoint evidence is not available yet.');
  if (r.slice && Object.values(r.slice.resources_by_phase).some((resources) => resources.length))
    issues.push('Phase resource scheduling is not available yet.');
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
/** Retain evidence in a run artifact instead of repeating full reviews inside every prompt. */
export function scopeEvidenceLedger(tx: StorageRepositories, r: ResolvedScope) {
  const bindings = tx.imports
    .bindings(r.item.workspaceId, r.definition.id)
    .find((b) => b.revision === r.scope.bindingRevision);
  const producers = new Set([...r.parent.required_slices, ...parentEvidenceProducers(r)]);
  const parentIds = new Set([
    r.parent.id,
    ...r.definition.source.slices.filter((s) => producers.has(s.id)).map((s) => s.work_item),
  ]);
  return {
    scope: r.scope,
    originalExitGate: r.parent.source_exit_gate,
    requiredSlices: r.parent.required_slices,
    evidenceProducers: [...producers],
    cases: scopeCases(r),
    receipts:
      bindings?.bindings
        .flatMap((b) => b.workItems)
        .filter((w) => parentIds.has(w.sourceId))
        .flatMap((w) => tx.scopeReceipts.list(r.item.workspaceId, w.workItemId))
        .filter(
          (p) =>
            p.scope.definitionId === r.definition.id &&
            p.scope.bindingRevision === r.scope.bindingRevision,
        ) ?? [],
  };
}
