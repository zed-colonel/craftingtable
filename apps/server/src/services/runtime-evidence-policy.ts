import {
  architectureDecisionIssues,
  architectureDecisionDigest,
  stagedDecision,
} from './architecture-decision-policy.js';
import { nativeApproval, needsNativeEvidence } from './native-verification-policy.js';
import { generatedPlanIssues } from './plan-acceptance-policy.js';
import { integratedSlice } from './scope-lineage.js';
import { runtimeInputChanges } from './runtime-input-policy.js';
import { snapshotCalculation } from './map-read-snapshot.js';
import { adoptedDecisions, mapAdopted } from './map-adoption-policy.js';
import type {
  ConcurrencyDefinition,
  RuntimeGeneration,
  EvidenceSubject,
  EvidenceSubmission,
  ExecutionScope,
  WorkspaceId,
  PhaseBlocker,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
export function activeRuntime(
  tx: StorageRepositories,
  ws: string,
  definitionId: string,
  bindingRevision: number,
) {
  return tx.imports.bindings(ws as WorkspaceId, definitionId)[0]?.revision === bindingRevision
    ? tx.runtimeEvidence.generations(ws, definitionId, bindingRevision)[0]
    : undefined;
}
export function subjectRequirements(d: ConcurrencyDefinition, subject: EvidenceSubject) {
  const slice =
    subject.kind === 'slice' ? d.source.slices.find((s) => s.id === subject.sourceId) : undefined;
  const parent =
    subject.kind === 'parent'
      ? d.source.work_items.find((s) => s.id === subject.sourceId)
      : undefined;
  const checkpoint =
    subject.kind === 'checkpoint'
      ? d.source.checkpoints.find((s) => s.id === subject.sourceId)
      : undefined;
  const node = slice ?? parent ?? checkpoint;
  if (!node) throw new Error('Unknown evidence subject.');
  const profile = d.source.evidence_profiles.find(
    (p) =>
      p.id ===
      (slice?.evidence_profile ??
        checkpoint?.evidence_profile ??
        parent?.acceptance_evidence_profile),
  );
  if (!profile) throw new Error('Unknown evidence profile.');
  const cases = [
    ...d.source.acceptance_coverage
      .filter((c) =>
        subject.kind === 'checkpoint'
          ? c.checkpoint === subject.sourceId
          : subject.kind === 'slice'
            ? c.producing_slices.includes(subject.sourceId)
            : c.owner_work_item === subject.sourceId,
      )
      .map((c) => ({
        id: c.id,
        sourceRecordDigest: c.source_record_sha256,
        requiresKata: c.requires_kata_host,
      })),
    ...d.source.baseline_acceptance_coverage
      .filter((c) =>
        subject.kind === 'checkpoint'
          ? c.capability_gate === subject.sourceId
          : subject.kind === 'slice'
            ? c.producing_slice === subject.sourceId
            : c.owner_work_item === subject.sourceId,
      )
      .map((c) => ({ id: c.id, sourceRecordDigest: c.source_record_sha256, requiresKata: false })),
  ];
  return {
    subject,
    title: node.title,
    profile: profile.id,
    requirements: [
      ...new Set([
        ...profile.required_evidence,
        ...(slice
          ? [slice.scope]
          : parent
            ? [parent.source_exit_gate]
            : (checkpoint?.pass_criteria ?? [])),
      ]),
    ],
    reviewerRoles: [...profile.reviewer_roles],
    cases,
    decisionRefs: slice?.decision_refs ?? checkpoint?.decision_refs ?? [],
    checkpoint,
    slice,
    parent,
  };
}
export function testedRepositories(d: ConcurrencyDefinition, subject: EvidenceSubject): string[] {
  const spec = subjectRequirements(d, subject);
  const repositories = new Set<string>();
  const add = (alias: string | undefined) => {
    if (
      alias &&
      d.source.repositories.some((r) => r.id === alias && r.role === 'planned_application')
    )
      repositories.add(alias);
  };
  add(spec.parent?.repository);
  add(spec.slice && d.source.work_items.find((w) => w.id === spec.slice?.work_item)?.repository);
  add(spec.checkpoint?.owner);
  for (const id of spec.cases.map((c) => c.id)) {
    const c =
      d.source.acceptance_coverage.find((c) => c.id === id) ??
      d.source.baseline_acceptance_coverage.find((c) => c.id === id);
    add(d.source.work_items.find((w) => w.id === c?.owner_work_item)?.repository);
  }
  return [...repositories];
}
/** Qualification uses its tested consumers; an unclassified/stack subject freezes all pins. */
export function evidenceInputs(d: ConcurrencyDefinition, subject: EvidenceSubject) {
  const consumers = testedRepositories(d, subject);
  const owner = subjectRequirements(d, subject).checkpoint?.owner;
  return consumers.length
    ? {
        consumers,
        pins:
          owner &&
          d.source.repositories.some((r) => r.id === owner && r.role === 'implemented_upstream')
            ? [owner]
            : [],
      }
    : {};
}

export function scopeRuntimeChanges(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
  recordedRuntimeId: string | undefined,
  current = activeRuntime(tx, ws, scope.definitionId, scope.bindingRevision),
): string[] {
  if (recordedRuntimeId && recordedRuntimeId === current?.id) return [];
  const binding = tx.imports
    .bindings(ws, scope.definitionId)
    .find((b) => b.revision === scope.bindingRevision);
  const d = tx.imports.definition(ws, scope.definitionId);
  const parent =
    scope.kind === 'parent-acceptance'
      ? scope.sourceId
      : d?.source.slices.find((s) => s.id === scope.sourceId)?.work_item;
  const alias = binding?.bindings.find((b) =>
    b.workItems.some((w) => w.sourceId === parent),
  )?.alias;
  if (!alias) return ['The review consumer binding is unavailable.'];
  const recorded = tx.runtimeEvidence
    .generations(ws, scope.definitionId, scope.bindingRevision)
    .find((r) => r.id === recordedRuntimeId);
  return snapshotCalculation(
    tx,
    `runtime-inputs:${recordedRuntimeId}:${current?.id}:${alias}`,
    () => runtimeInputChanges(recorded, current, { consumers: [alias] }),
  );
}
/** Explicit start/merge providers inform the minimum supplied build environment. */
export function requiredUpstreams(d: ConcurrencyDefinition, consumerAlias: string): string[] {
  const required = new Set(
    d.source.repositories
      .filter((r) => r.role === 'implemented_upstream' && r.id !== consumerAlias)
      .map((r) => r.id),
  );
  const parents = d.source.work_items.filter((w) => w.repository === consumerAlias);
  for (const slice of d.source.slices.filter((s) => parents.some((w) => w.id === s.work_item)))
    for (const req of [...slice.start_requires, ...slice.merge_requires]) {
      const owner =
        req.kind === 'checkpoint'
          ? d.source.checkpoints.find((c) => c.id === req.id)?.owner
          : req.kind === 'work_item'
            ? d.source.work_items.find((w) => w.id === req.id)?.repository
            : d.source.work_items.find(
                (w) => w.id === d.source.slices.find((s) => s.id === req.id)?.work_item,
              )?.repository;
      if (owner && owner !== consumerAlias && d.source.repositories.some((r) => r.id === owner))
        required.add(owner);
    }
  return [...required];
}
export function expectedSubjectCommit(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  bindingRevision: number,
  subject: EvidenceSubject,
): string | undefined {
  const b = tx.imports.bindings(ws, d.id).find((b) => b.revision === bindingRevision);
  const info = subjectRequirements(d, subject);
  if (info.slice) {
    const id = b?.bindings
      .flatMap((b) => b.workItems)
      .find((w) => w.sourceId === info.slice?.work_item)?.workItemId;
    return id
      ? integratedSlice(tx, ws, id, {
          kind: 'slice',
          definitionId: d.id,
          bindingRevision,
          sourceId: subject.sourceId,
        })?.mergeSha
      : undefined;
  }
  return undefined;
}
export function submissionIssues(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  runtime: RuntimeGeneration | undefined,
  s: EvidenceSubmission,
): string[] {
  if (s.architectureDecision) return architectureDecisionIssues(tx, d, s);
  const issues: string[] = [];
  if (
    !runtime ||
    runtime.bindingRevision !== s.bindingRevision ||
    tx.imports.bindings(d.workspaceId, d.id)[0]?.revision !== s.bindingRevision
  )
    issues.push('Evidence belongs to an inactive runtime generation or binding.');
  const recorded = tx.runtimeEvidence
    .generations(d.workspaceId, d.id, s.bindingRevision)
    .find((r) => r.id === s.runtimeId);
  issues.push(
    ...runtimeInputChanges(recorded, runtime, {
      ...evidenceInputs(d, s.subject),
      environmentId: s.environmentId,
    }),
  );
  const spec = subjectRequirements(d, s.subject);
  const b = tx.imports.bindings(d.workspaceId, d.id).find((b) => b.revision === s.bindingRevision);
  const requiredCode = testedRepositories(d, s.subject),
    code = s.testedCode ?? [];
  if (new Set(code.map((c) => c.alias)).size !== code.length)
    issues.push('Duplicate tested repository commits.');
  for (const alias of requiredCode)
    if (!code.some((c) => c.alias === alias))
      issues.push(`Identify the exact tested ${alias} consumer commit.`);
  if (code.some((c) => !requiredCode.includes(c.alias)))
    issues.push('Tested repository does not belong to this evidence subject.');
  for (const tested of code) {
    const binding = b?.bindings.find((b) => b.alias === tested.alias);
    const newest = binding?.workItems
      .flatMap((w) => tx.execution.worktrees.listForWorkItem(d.workspaceId, w.workItemId))
      .filter((t) => t.mergeSha && t.integrationBranch === binding.integrationBranch)
      .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0];
    if (
      newest?.mergeSha &&
      (newest.mergedAt ?? '') > s.createdAt &&
      tested.commitSha !== newest.mergeSha
    )
      issues.push(
        `The tested ${tested.alias} integration changed after this evidence was collected.`,
      );
  }
  const env = runtime?.environments.find((e) => e.id === s.environmentId);
  if (!env) issues.push('The recorded environment is not in the active generation.');
  if (new Set(s.artifacts.map((a) => a.name)).size !== s.artifacts.length)
    issues.push('Artifact names must be unique.');
  const artifact = (name: string) => s.artifacts.some((a) => a.name === name && a.content.trim());
  const required = new Set(spec.requirements);
  if (new Set(s.requirements.map((e) => e.requirement)).size !== s.requirements.length)
    issues.push('Duplicate requirement evidence.');
  for (const requirement of required)
    if (!s.requirements.some((e) => e.requirement === requirement && artifact(e.artifact)))
      issues.push(`Missing artifact for requirement: ${requirement}`);
  if (s.requirements.some((e) => !required.has(e.requirement)))
    issues.push('Evidence contains a requirement outside this subject.');
  if (new Set(s.cases.map((e) => e.id)).size !== s.cases.length)
    issues.push('Duplicate case evidence.');
  for (const expected of spec.cases) {
    const c = s.cases.find((c) => c.id === expected.id);
    if (
      !c ||
      c.sourceRecordDigest !== expected.sourceRecordDigest ||
      c.result !== 'passed' ||
      !artifact(c.artifact)
    )
      issues.push(`Case ${expected.id} needs a passing artifact for its exact source record.`);
  }
  if (s.cases.some((c) => !spec.cases.some((e) => e.id === c.id)))
    issues.push('Case evidence is assigned to another subject.');
  if (s.generatedPlan) issues.push(...generatedPlanIssues(tx, d, runtime, s));
  for (const role of s.generatedPlan ? [] : spec.reviewerRoles)
    if (
      !s.reviewers.some(
        (r) =>
          r.roles.includes(role) &&
          r.identity.toLowerCase() !== s.executedBy.toLowerCase() &&
          artifact(r.artifact),
      )
    )
      issues.push(`Independent review evidence is missing role ${role}.`);
  if (
    !s.generatedPlan &&
    !s.reviewers.some(
      (r) => r.identity.toLowerCase() !== s.executedBy.toLowerCase() && artifact(r.artifact),
    )
  )
    issues.push('An implementer/executor assertion cannot supply independent review.');
  if (new Set(s.reviewers.map((r) => r.identity.toLowerCase())).size !== s.reviewers.length)
    issues.push('Reviewer identities must be unique.');
  const resourceKinds =
    spec.slice?.resources_by_phase.verify.map((id) =>
      d.source.resource_profiles.find((p) => p.id === id),
    ) ?? [];
  const needsKata =
    spec.cases.some((c) => c.requiresKata) ||
    resourceKinds.some((r) => r?.requires_hardware_virtualization);
  const needsNative = resourceKinds.some((r) => r?.fixture_authorization_required);
  if (
    needsKata &&
    (env?.kind !== 'external-kata' || !s.kata || !artifact(s.kata.observationArtifact))
  )
    issues.push(
      'Actual Kata host/VM/image/configuration observations and no-fallback evidence are required; native evidence cannot substitute.',
    );
  if (needsNative && env?.kind === 'local-development')
    issues.push(
      'This subject requires an explicitly authorized external qualification environment.',
    );
  if (s.kata && env?.kind !== 'external-kata')
    issues.push('Kata observations require a Kata environment binding.');
  const expected = expectedSubjectCommit(tx, d.workspaceId, d, s.bindingRevision, s.subject);
  if (s.subject.kind === 'slice' && (!expected || s.sliceMergeSha !== expected))
    issues.push('Slice evidence must match its latest integration merge.');
  if (
    s.subject.kind === 'parent' &&
    (!s.subjectCommit || (expected && s.subjectCommit !== expected))
  )
    issues.push('Parent evidence must match the current integration candidate.');
  return issues;
}
export function acceptedEvidence(
  tx: StorageRepositories,
  ws: WorkspaceId,
  definitionId: string,
  bindingRevision: number,
  subject: EvidenceSubject,
  visiting = new Set<string>(),
): EvidenceSubmission | undefined {
  const d = tx.imports.definition(ws, definitionId),
    runtime = activeRuntime(tx, ws, definitionId, bindingRevision);
  if (!d || !runtime) return;
  const decisions = tx.runtimeEvidence.decisions(ws);
  return tx.runtimeEvidence
    .submissions(ws, definitionId)
    .find(
      (s) =>
        s.subject.kind === subject.kind &&
        s.subject.sourceId === subject.sourceId &&
        s.architectureDecision?.coverage !== 'clauses' &&
        decisions.some((a) => a.submissionId === s.id && a.outcome === 'accepted') &&
        !submissionIssues(tx, d, runtime, s).length &&
        !prerequisiteIssues(tx, d, bindingRevision, subject, visiting).length,
    );
}
export function runtimeScopeBlockers(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
  consumerAlias: string,
): PhaseBlocker[] {
  const d = tx.imports.definition(ws, scope.definitionId),
    runtime = activeRuntime(tx, ws, scope.definitionId, scope.bindingRevision);
  if (!d) return [{ kind: 'authorization', message: 'Runtime definition is unavailable.' }];
  if (tx.imports.bindings(ws, scope.definitionId)[0]?.revision !== scope.bindingRevision)
    return [
      {
        kind: 'authorization',
        message: 'The map binding was superseded. Reconcile the execution scope before continuing.',
      },
    ];
  if (!runtime)
    return d.source.repositories.some((r) => r.role === 'implemented_upstream')
      ? [
          {
            kind: 'evidence',
            message:
              'Configure exact upstream pins and a dependency environment for this map binding.',
          },
        ]
      : [];
  const consumer = runtime.consumers.find((c) => c.alias === consumerAlias);
  if (!consumer)
    return [{ kind: 'evidence', message: `Configure supplied dependencies for ${consumerAlias}.` }];
  return requiredUpstreams(d, consumerAlias)
    .filter(
      (alias) =>
        !consumer.upstreams.includes(alias) || !runtime.pins.some((p) => p.alias === alias),
    )
    .map((alias) => ({
      kind: 'evidence' as const,
      message: `${consumerAlias} must use an exact ${alias} upstream pin.`,
    }));
}
/** Requirements stay closed until independently accepted evidence exists for every predecessor. */
export function prerequisiteIssues(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  bindingRevision: number,
  subject: EvidenceSubject,
  visiting = new Set<string>(),
): string[] {
  const key = `${subject.kind}:${subject.sourceId}`;
  if (visiting.has(key)) return ['Circular evidence prerequisite.'];
  const next = new Set(visiting).add(key),
    spec = subjectRequirements(d, subject),
    issues: string[] = [];
  const adopted = adoptedDecisions(tx, d.workspaceId, d.id, bindingRevision);
  const missing = spec.decisionRefs.filter((id) => !adopted.has(id));
  if (missing.length) issues.push(`Decision adoption is required: ${missing.join(', ')}.`);
  if (
    spec.checkpoint &&
    ['plan_approval', 'architecture_decision'].includes(spec.checkpoint.kind) &&
    !mapAdopted(tx, d.workspaceId, d.id, bindingRevision)
  )
    issues.push('Adopt the exact bound map before accepting decision checkpoint evidence.');
  const requirements =
    spec.checkpoint?.requires ??
    (spec.slice
      ? [...spec.slice.start_requires, ...spec.slice.merge_requires, ...spec.slice.verify_requires]
      : (spec.parent?.acceptance_requires ?? []));
  const bindings = tx.imports
    .bindings(d.workspaceId, d.id)
    .find((b) => b.revision === bindingRevision);
  for (const r of requirements) {
    if (r.kind === 'checkpoint') {
      if (
        spec.slice &&
        stagedDecision(
          tx,
          d.workspaceId,
          { kind: 'slice', definitionId: d.id, bindingRevision, sourceId: spec.slice.id },
          r.id,
        )
      )
        continue;
      if (
        !acceptedEvidence(
          tx,
          d.workspaceId,
          d.id,
          bindingRevision,
          { kind: 'checkpoint', sourceId: r.id },
          next,
        )
      )
        issues.push(`Checkpoint ${r.id} must pass with current accepted evidence.`);
    } else {
      const parent =
        r.kind === 'work_item' ? r.id : d.source.slices.find((s) => s.id === r.id)?.work_item;
      const id = bindings?.bindings
        .flatMap((b) => b.workItems)
        .find((w) => w.sourceId === parent)?.workItemId;
      if (r.kind === 'work_item') {
        if (!parentAccepted(tx, d.workspaceId, d.id, bindingRevision, r.id))
          issues.push(`Parent ${r.id} must be accepted.`);
      } else {
        const trees = id
          ? tx.execution.worktrees
              .listForWorkItem(d.workspaceId, id)
              .filter(
                (t) =>
                  t.executionScope?.definitionId === d.id &&
                  t.executionScope.bindingRevision === bindingRevision &&
                  t.executionScope.sourceId === r.id &&
                  t.executionScope.kind === 'slice',
              )
          : [];
        const integrated =
          id &&
          integratedSlice(tx, d.workspaceId, id, {
            kind: 'slice',
            definitionId: d.id,
            bindingRevision,
            sourceId: r.id,
          });
        const satisfied =
          r.state === 'started'
            ? !!integrated ||
              trees.some((t) =>
                tx.execution.runs.listForWorktree(d.workspaceId, t.id).some((r) => r.startedAt),
              )
            : r.state === 'merged'
              ? !!integrated?.mergeSha
              : !!acceptedEvidence(
                  tx,
                  d.workspaceId,
                  d.id,
                  bindingRevision,
                  { kind: 'slice', sourceId: r.id },
                  next,
                ) ||
                (!!id &&
                  tx.scopeReceipts
                    .list(d.workspaceId, id)
                    .some(
                      (p) =>
                        currentScopeReceipt(tx, d.workspaceId, p) &&
                        p.scope.definitionId === d.id &&
                        p.scope.bindingRevision === bindingRevision &&
                        p.scope.sourceId === r.id &&
                        integrated?.mergeSha === p.integrationSha,
                    ));
        if (!satisfied) issues.push(`Slice ${r.id} must be ${r.state}.`);
      }
    }
  }
  return issues;
}

export function currentScopeReceipt(
  tx: StorageRepositories,
  ws: WorkspaceId,
  p: import('@craftingtable/domain').ScopeReceipt,
): boolean {
  if (
    tx.amendments.superseded(ws, p.scope.definitionId, p.scope.bindingRevision) ||
    tx.imports.bindings(ws, p.scope.definitionId)[0]?.revision !== p.scope.bindingRevision
  )
    return false;
  const item = tx.planning.workItems.find(ws, p.workItemId);
  const policy = item && tx.execution.branchSettings.policy(ws, item.planVersionId);
  if (
    policy &&
    tx.execution.runs.find(ws, p.reviewRunId)?.reviewBranchContext?.repositoryPolicyVersion !==
      policy.version
  )
    return false;
  const run = tx.runtimeEvidence.run(ws, p.reviewRunId);
  if (run?.architectureDecisionDigest !== architectureDecisionDigest(tx, ws, p.scope)) return false;
  const runtime = activeRuntime(tx, ws, p.scope.definitionId, p.scope.bindingRevision);
  if (!runtime) return true;
  const d = tx.imports.definition(ws, p.scope.definitionId);
  if (d && needsNativeEvidence(d, p.scope)) {
    const approval = nativeApproval(tx, ws, p.scope);
    if (!approval || run?.nativeApprovalId !== approval.id) return false;
  }
  return scopeRuntimeChanges(tx, ws, p.scope, run?.runtimeId, runtime).length === 0;
}

/** Completion in another adopted scope is history, not acceptance of these requirements. */
export function parentAccepted(
  tx: StorageRepositories,
  ws: WorkspaceId,
  definitionId: string,
  bindingRevision: number,
  sourceId: string,
): boolean {
  const id = tx.imports
    .bindings(ws, definitionId)
    .find((b) => b.revision === bindingRevision)
    ?.bindings.flatMap((b) => b.workItems)
    .find((w) => w.sourceId === sourceId)?.workItemId;
  return (
    !!id &&
    tx.planning.workItems.find(ws, id)?.status === 'completed' &&
    tx.scopeReceipts
      .list(ws, id)
      .some(
        (p) =>
          p.scope.kind === 'parent-acceptance' &&
          p.scope.definitionId === definitionId &&
          p.scope.bindingRevision === bindingRevision &&
          p.scope.sourceId === sourceId &&
          currentScopeReceipt(tx, ws, p),
      )
  );
}
