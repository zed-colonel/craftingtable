import { supportsTechnicalCheckpoint } from './technical-checkpoint-policy.js';
import { scopeArchitectureDecisions } from './architecture-decision-policy.js';
import { bindingIssues } from './map-binding-policy.js';
export { bindingIssues } from './map-binding-policy.js';

import { randomUUID } from 'node:crypto';
import {
  type CrossProjectSave,
  type CrossProjectView,
  roadmapEntryFieldsSchema,
  type SaveCrossProjectRequest,
} from '@craftingtable/contracts';
import {
  asAuditEventId,
  asEventId,
  asMapDecisionId,
  asRoadmapEntryId,
  type ConcurrencyDefinitionId,
  type ConcurrencyRequirement,
  type CrossProjectConfiguration,
  type EvidenceDecision,
  type ExecutionScope,
  type MapActivity,
  type MapActivitySettings,
  mapCapabilities,
  milestoneKey,
  type RoadmapEntry,
  sameExecutionScope,
  startedAttempts,
  targetClosure,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { withPermissions } from './agent-profile-policy.js';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { scopePhaseBlockers } from './execution-scope.js';
import { carryPlanAcceptance } from './generated-plan-evidence.js';
import { adoptedDecisions, mapAdopted } from './map-adoption-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { milestoneMet, milestoneSatisfied } from './milestone-policy.js';
import type { RoadmapService } from './roadmap-service.js';
import {
  acceptedEvidence,
  activeRuntime,
  type ReceiptStaleReason,
  receiptStaleness,
} from './runtime-evidence-policy.js';
import { integratedSlice } from './scope-lineage.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

export { milestoneMemoKey, milestoneSatisfied } from './milestone-policy.js';

function conflict(m: string): never {
  throw new ExecutionRequestError('conflict', m);
}
export type MapSelection = Pick<
  CrossProjectConfiguration,
  'definitionId' | 'bindingRevision' | 'targetId' | 'selection'
>;
/**
 * Why a review entry's evidence is not current, typed (R-C10's follow-up, decision 4), read as
 * `milestoneMet` reads it: the latest receipt's own reasons (`receiptStaleness`), and the
 * milestone's, no receipt at all, the slice merged again since the receipt, or the parent item not
 * completed. Empty when the milestone is met. `receipt` is the receipt the reasons are for.
 */
export function evidenceStaleness(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
  workItemId: WorkItemId,
): {
  readonly reasons: readonly EvidenceStaleReason[];
  readonly receipt?: import('@craftingtable/domain').ScopeReceipt;
} {
  if (scope.kind === 'slice') return { reasons: [] };
  const d = tx.imports.definition(ws, scope.definitionId);
  if (!d) return { reasons: ['binding'] };
  const requirement: ConcurrencyRequirement =
    scope.kind === 'parent-acceptance'
      ? { kind: 'work_item', id: scope.sourceId, state: 'accepted' }
      : { kind: 'slice', id: scope.sourceId, state: 'verified' };
  if (milestoneMet(tx, ws, d, scope.bindingRevision, requirement)) return { reasons: [] };
  // The receipts `milestoneMet` reads: the slice's own, or the parent acceptance's.
  const own: ExecutionScope =
    scope.kind === 'parent-acceptance' ? scope : { ...scope, kind: 'slice' };
  const latest = tx.scopeReceipts
    .list(ws, workItemId)
    .filter((p) => sameExecutionScope(p.scope, own))
    .toSorted((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .at(-1);
  const reasons: EvidenceStaleReason[] = [];
  if (scope.kind === 'parent-acceptance') {
    if (tx.planning.workItems.find(ws, workItemId)?.status !== 'completed')
      reasons.push('parent-incomplete');
  } else if (
    latest &&
    integratedSlice(tx, ws, workItemId, { ...scope, kind: 'slice' })?.mergeSha !==
      latest.integrationSha
  )
    reasons.push('merged-again');
  if (!latest) return { reasons: [...reasons, 'no-receipt'] };
  return { reasons: [...reasons, ...receiptStaleness(tx, ws, latest)], receipt: latest };
}
/** Why a review entry's evidence is not current (`evidenceStaleness`). */
export type EvidenceStaleReason =
  | ReceiptStaleReason
  | 'no-receipt'
  | 'merged-again'
  | 'parent-incomplete';

/**
 * When the evidence of a scope last changed by the operator's hand: the latest acceptance of an
 * approved decision it reads, or the adoption of its plan's repository policy (decision 4's
 * settle window reads it).
 */
export function evidenceChangedAt(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
  workItemId: WorkItemId,
): string | undefined {
  const item = tx.planning.workItems.find(ws, workItemId);
  return lastChange(
    scopeArchitectureDecisions(tx, ws, scope).map((s) => s.id),
    tx.runtimeEvidence.decisions(ws),
    item && tx.execution.branchSettings.policy(ws, item.planVersionId)?.adoptedAt,
  );
}
/** The latest acceptance of one of `submissionIds`, or the policy's adoption, if later. */
export function lastChange(
  submissionIds: readonly string[],
  decisions: readonly Pick<EvidenceDecision, 'submissionId' | 'outcome' | 'decidedAt'>[],
  policyAdoptedAt: string | undefined,
): string | undefined {
  const decided = new Set(submissionIds);
  const times = decisions
    .filter((a) => a.outcome === 'accepted' && decided.has(a.submissionId))
    .map((a) => a.decidedAt);
  if (policyAdoptedAt) times.push(policyAdoptedAt);
  return times.toSorted().at(-1);
}

export function crossProjectState(
  tx: StorageRepositories,
  ws: WorkspaceId,
  config: MapSelection,
): CrossProjectView {
  const d = tx.imports.definition(ws, config.definitionId);
  if (!d) throw new NotFoundError();
  tx = mapReadSnapshot(tx);
  const revision = config.bindingRevision;
  if (!d.source.planning_targets.some((t) => t.id === config.targetId))
    conflict('Select a declared planning target.');
  const closure = targetClosure(d.source, config.targetId, config.selection),
    included = new Set(closure.nodes.map((n) => n.key));
  const binding = tx.imports.bindings(ws, d.id).find((b) => b.revision === revision);
  const all = [...closure.nodes, ...closure.excluded];
  const states = new Map(
    all.map((n) => [n.key, milestoneSatisfied(tx, ws, d, revision, n.requirement)]),
  );
  const adopted = adoptedDecisions(tx, ws, d.id, revision);
  const nodes: CrossProjectView['nodes'] = all.map((n) => {
    const r = n.requirement,
      satisfied = states.get(n.key) === true;
    const id = binding?.bindings
      .flatMap((b) => b.workItems)
      .find((w) => w.sourceId === (n.parentId ?? r.id))?.workItemId;
    const decisionCoverage =
      r.kind === 'slice'
        ? scopeArchitectureDecisions(tx, ws, {
            kind: 'slice',
            definitionId: d.id,
            bindingRevision: revision,
            sourceId: r.id,
          }).flatMap((s) => {
            const consumer =
              s.architectureDecision?.coverage === 'clauses' &&
              s.architectureDecision.consumers.find((c) => c.sliceId === r.id);
            return consumer && (r.state !== 'started' || consumer.phase === 'start')
              ? [{ checkpoint: s.subject.sourceId, submissionId: s.id, phase: consumer.phase }]
              : [];
          })
        : [];
    const requirements = n.requires.filter(
      (key) =>
        !decisionCoverage.some(
          (c) => key === milestoneKey({ kind: 'checkpoint', id: c.checkpoint, state: 'passed' }),
        ),
    );
    let blockers = requirements.filter((k) => !states.get(k));
    if (id && !satisfied) {
      try {
        const phase =
          r.kind === 'work_item'
            ? 'accept'
            : r.state === 'started'
              ? 'start'
              : r.state === 'merged'
                ? 'merge'
                : 'verify';
        blockers = [
          ...new Set([
            ...blockers,
            ...scopePhaseBlockers(
              tx,
              ws,
              id,
              {
                kind: r.kind === 'work_item' ? 'parent-acceptance' : 'slice',
                definitionId: d.id,
                bindingRevision: revision,
                sourceId: r.id,
              },
              phase,
            ).map((b) => b.message),
          ]),
        ];
      } catch {
        blockers.push('Resolve the exact plan binding.');
      }
    }
    const cp =
      r.kind === 'checkpoint' ? d.source.checkpoints.find((c) => c.id === r.id) : undefined;
    if (cp)
      for (const decision of cp.decision_refs)
        if (!adopted.has(decision)) blockers.push(`Adopt decision ${decision}.`);
    const needsAdoption =
      cp &&
      ['plan_approval', 'architecture_decision'].includes(cp.kind) &&
      !mapAdopted(tx, ws, d.id, revision);
    if (needsAdoption) blockers.push('Adopt the exact bound map first.');
    const activityKind =
      r.kind === 'work_item'
        ? 'parent-acceptance'
        : r.state === 'verified'
          ? 'slice-verification'
          : 'slice';
    const cycle =
      id &&
      tx.execution.cycles
        .listForWorkspace(ws)
        .find(
          (c) =>
            c.workItemId === id &&
            c.executionScope?.definitionId === d.id &&
            c.executionScope.bindingRevision === revision &&
            c.executionScope.sourceId === r.id &&
            c.executionScope.kind === activityKind &&
            !['completed', 'stopped'].includes(c.status),
        );
    const progress = cycle
      ? `${cycle.step} · ${cycle.status === 'awaiting-merge' && activityKind !== 'slice' ? 'ready for scope acceptance' : cycle.status}: ${cycle.reason}`
      : undefined;
    return {
      key: n.key,
      kind: r.kind,
      sourceId: r.id,
      state: r.state,
      title: n.title,
      repository: n.repository,
      ...(n.parentId ? { parentId: n.parentId } : {}),
      ...(id ? { workItemId: id } : {}),
      included: included.has(n.key),
      priority: closure.priority.has(n.key),
      satisfied,
      status: satisfied
        ? `${r.state} · evidence recorded`
        : (progress ??
          (blockers.length
            ? 'Waiting for requirements'
            : cp
              ? 'Ready for checkpoint evidence'
              : 'Eligible for scheduling')),
      reviewerRoles: [
        ...(d.source.evidence_profiles.find(
          (p) =>
            p.id ===
            (r.kind === 'work_item'
              ? d.source.work_items.find((w) => w.id === r.id)?.acceptance_evidence_profile
              : r.kind === 'slice' && r.state === 'verified'
                ? d.source.slices.find((s) => s.id === r.id)?.evidence_profile
                : r.kind === 'checkpoint' && supportsTechnicalCheckpoint(d, r.id)
                  ? d.source.checkpoints.find((c) => c.id === r.id)?.evidence_profile
                  : undefined),
        )?.reviewer_roles ?? []),
      ],
      ...(decisionCoverage.length
        ? { decisionCoverage, originalRequirements: [...n.requires] }
        : {}),
      requirements,
      blockers,
      action: satisfied
        ? 'none'
        : needsAdoption
          ? 'adopt'
          : cp
            ? 'evidence'
            : id
              ? 'work-item'
              : 'none',
    };
  });
  // Start and Resume wait for the plan checkpoint, and for every stack-owned plan approval when
  // there are several (decided by the operator 2026-10-07). Any other plan approval stays an
  // in-run gate, raised when an entry waits on it, as before R-F2.
  const capabilities = mapCapabilities(d.source);
  const startPlans = new Set(
    capabilities.planCheckpoint
      ? [capabilities.planCheckpoint]
      : d.source.checkpoints
          .filter((c) => c.kind === 'plan_approval' && c.owner === 'stack')
          .map((c) => c.id),
  );
  const pendingPlans = nodes
    .filter(
      (n) => n.included && n.kind === 'checkpoint' && startPlans.has(n.sourceId) && !n.satisfied,
    )
    .map((n) => n.sourceId);
  const planApprovalPending = pendingPlans.length > 0;
  const plan = pendingPlans.join(', ');
  // Only the checkpoint the generator serves is offered for generation.
  const generated = capabilities.planAcceptance?.checkpointId;
  const planSetup =
    generated && pendingPlans.length === 1 && pendingPlans[0] === generated
      ? `Save the roadmap, generate ${generated} evidence, then review and accept it before Start or Resume.`
      : `Submit and accept independently reviewed evidence for ${plan} before Start or Resume.`;
  const fullPlanAccepted = d.source.work_items.every((w) =>
    milestoneSatisfied(tx, ws, d, revision, { kind: 'work_item', id: w.id, state: 'accepted' }),
  );
  const plans = binding?.bindings.flatMap((b) => (b.planVersionId ? [b.planVersionId] : [])) ?? [];
  return {
    definitionId: d.id,
    bindingRevision: revision,
    reviewerRoles: [...new Set(d.source.evidence_profiles.flatMap((p) => p.reviewer_roles))],
    targets: d.source.planning_targets.map((t) => ({
      id: t.id,
      checkpoint: t.checkpoint,
      scope: t.scope,
      isRelease: t.is_release,
    })),
    suggestedTarget: d.source.scheduling_policy.suggested_focus_target,
    decisions: d.source.decisions.map((x) => ({
      id: x.id,
      title: x.title,
      proposal: x.proposed_resolution,
      adopted: adopted.has(x.id),
    })),
    adoptions: tx.imports.adoptions(ws, d.id).map((a) => ({
      id: a.id,
      rationale: a.rationale,
      createdAt: a.createdAt,
      createdByUserId: a.createdByUserId,
      bindingRevision: a.bindingRevision,
    })),
    setupRequirements: [
      ...(planApprovalPending
        ? [
            {
              kind: 'plan-acceptance' as const,
              message: planSetup,
            },
          ]
        : []),
      ...bindingIssues(tx, ws, d.id, revision).map((message) => ({
        kind: 'binding' as const,
        message,
      })),
      ...(!mapAdopted(tx, ws, d.id, revision)
        ? [
            {
              kind: 'adoption' as const,
              message: 'Review and adopt the scheduling proposals for these exact plans.',
            },
          ]
        : []),
      ...(!activeRuntime(tx, ws, d.id, revision) &&
      d.source.repositories.some((r) => r.role === 'implemented_upstream')
        ? [
            {
              kind: 'runtime' as const,
              message: 'Discover and save the pinned dependency environment.',
            },
          ]
        : []),
    ],
    blockers: [
      ...(planApprovalPending
        ? [
            `Waiting for plan acceptance: review and accept ${plan} evidence before Start or Resume.`,
          ]
        : []),
      ...bindingIssues(tx, ws, d.id, revision),
      ...(!mapAdopted(tx, ws, d.id, revision)
        ? ['Adopt the exact map and its scheduling proposals before Start.']
        : []),
      ...(!activeRuntime(tx, ws, d.id, revision) &&
      d.source.repositories.some((r) => r.role === 'implemented_upstream')
        ? ['Configure the pinned dependency environment before Start.']
        : []),
    ],
    nodes,
    targetReached:
      states.get(
        milestoneKey({ kind: 'checkpoint', id: closure.target.checkpoint, state: 'passed' }),
      ) === true,
    selectedScopeComplete: closure.nodes.every((n) => states.get(n.key)),
    fullPlanAccepted,
    finalized:
      plans.length > 0 &&
      plans.every((id) =>
        tx.execution.finalizations
          .list(ws)
          .some((f) => f.planVersionId === id && f.status === 'completed'),
      ),
    published: !!acceptedEvidence(tx, ws, d.id, revision, {
      kind: 'checkpoint',
      sourceId: d.source.terminal_checkpoint,
    }),
  };
}
export function mapActivity(entry: Pick<RoadmapEntry, 'executionScope'>): MapActivity {
  return entry.executionScope?.kind === 'parent-acceptance'
    ? 'acceptance'
    : entry.executionScope?.kind === 'slice-verification'
      ? 'verification'
      : 'development';
}
/**
 * The settings level a map entry takes its settings from: the most specific override that names
 * it (project, then activity, then the individual scope), else the defaults.
 */
export function effectiveMapLevel(
  c: CrossProjectConfiguration,
  alias: string,
  activity: MapActivity,
  sourceId: string,
): CrossProjectConfiguration['overrides'][number] | undefined {
  let found: CrossProjectConfiguration['overrides'][number] | undefined;
  for (const [level, key] of [
    ['project', alias],
    ['activity', activity],
    ['individual', `${activity}:${sourceId}`],
  ] as const)
    found = c.overrides.find((o) => o.level === level && o.key === key) ?? found;
  return found;
}
export function effectiveMapSettings(
  c: CrossProjectConfiguration,
  alias: string,
  activity: MapActivity,
  sourceId: string,
) {
  return effectiveMapLevel(c, alias, activity, sourceId)?.settings ?? c.defaults;
}
export class CrossProjectService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly roadmaps: RoadmapService,
    private readonly notifier: WorkspaceEventNotifier,
  ) {}
  view(context: AuthContext, ws: WorkspaceId, input: MapSelection) {
    this.workspaces.requireAuthorized(context, ws);
    return crossProjectState(this.storage, ws, input);
  }
  adopt(
    context: AuthContext,
    ws: WorkspaceId,
    id: ConcurrencyDefinitionId,
    input: { bindingRevision: number; decisionIds: readonly string[]; rationale: string },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const d = this.storage.imports.definition(ws, id);
    if (!d) throw new NotFoundError();
    const issues = bindingIssues(this.storage, ws, id, input.bindingRevision);
    if (issues.length) conflict(issues.join(' '));
    const ids = d.source.decisions.map((d) => asMapDecisionId(d.id));
    if (
      ids.length !== input.decisionIds.length ||
      new Set(input.decisionIds).size !== ids.length ||
      ids.some((id) => !input.decisionIds.includes(id))
    )
      conflict(
        'Review and explicitly approve every scheduling proposal; changing a proposal requires a new definition.',
      );
    const at = new Date().toISOString();
    this.storage.transaction((tx) => {
      // An adoption carries a plan acceptance it re-opens (R-C6 D2).
      carryPlanAcceptance(
        tx,
        context,
        { workspaceId: ws, definitionId: id, command: 'adoption', at },
        () =>
          tx.imports.addAdoption({
            id: randomUUID(),
            workspaceId: ws,
            definitionId: d.id,
            bindingRevision: input.bindingRevision,
            decisionIds: ids,
            rationale: input.rationale,
            createdAt: at,
            createdByUserId: context.user.id,
          }),
      );
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        workspaceId: ws,
        occurredAt: at,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        action: 'concurrency.adopted',
        targetType: 'concurrency-definition',
        targetId: id,
        outcome: 'succeeded',
        metadata: { bindingRevision: input.bindingRevision, decisionIds: ids },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        workspaceId: ws,
        occurredAt: at,
        actorUserId: context.user.id,
        kind: 'runtime-evidence-changed',
        payload: {
          definitionId: d.id,
          message: 'Scheduling proposals adopted. Checkpoint evidence and Start remain separate.',
        },
      });
    });
    this.notifier.notify();
    return { adopted: true };
  }
  /**
   * A map roadmap's save as its settings form sends it (R-E5b, E5-1 as amended 2026-10-11): each
   * settings level's step permissions. A saved level keeps its agents (the defaults, or the
   * override at the same level and key); a new map roadmap's defaults store the workspace
   * defaults, and a new override the defaults level's. Agents are changed only by an ADR-064
   * assignment.
   */
  save(context: AuthContext, ws: WorkspaceId, input: SaveCrossProjectRequest) {
    const saved = this.storage.roadmaps.find(ws, input.roadmapId)?.definition.crossProject;
    const level = (
      { permissions, ...settings }: SaveCrossProjectRequest['configuration']['defaults'],
      agents: MapActivitySettings['profiles'],
    ): MapActivitySettings => ({ ...settings, profiles: withPermissions(agents, permissions) });
    const c = input.configuration;
    // The defaults level: its stored agents, or for a new map roadmap the workspace defaults now.
    const defaults = level(
      c.defaults,
      saved?.defaults.profiles ?? this.roadmaps.workspaceProfiles(ws),
    );
    return this.saveStored(context, ws, {
      ...input,
      configuration: {
        ...c,
        defaults,
        // A saved override keeps its agents; a new one covers entries that exist, so it starts
        // from the defaults level's and they keep theirs (operator 2026-10-11, review MEDIUM-1).
        overrides: c.overrides.map((o) => ({
          ...o,
          settings: level(
            o.settings,
            saved?.overrides.find((s) => s.level === o.level && s.key === o.key)?.settings
              .profiles ?? defaults.profiles,
          ),
        })),
      },
    });
  }

  /** Saves a map roadmap whose settings carry their profiles: the form's, or an amendment's. */
  saveStored(
    context: AuthContext,
    ws: WorkspaceId,
    input: CrossProjectSave,
    amendment?: { readonly retainAttemptIds: readonly string[] },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const c = input.configuration,
      d = this.storage.imports.definition(ws, c.definitionId);
    if (!d) throw new NotFoundError();
    const issues = bindingIssues(this.storage, ws, d.id, c.bindingRevision);
    if (issues.length) conflict(issues.join(' '));
    if (!d.source.planning_targets.some((t) => t.id === c.targetId))
      conflict('Select a declared planning target.');
    const supportedRoles = new Set(d.source.evidence_profiles.flatMap((p) => p.reviewer_roles));
    for (const settings of [c.defaults, ...c.overrides.map((o) => o.settings)])
      if (settings.reviewerRoles?.some((role) => !supportedRoles.has(role)))
        conflict('Only reviewer roles declared in this map may be assigned.');
    const closure = targetClosure(d.source, c.targetId, c.selection),
      binding = this.storage.imports
        .bindings(ws, d.id)
        .find((b) => b.revision === c.bindingRevision)!;
    const old = this.storage.roadmaps.find(ws, input.roadmapId);
    if (
      !amendment &&
      old?.definition.crossProject &&
      JSON.stringify({
        ...old.definition.crossProject,
        defaults: undefined,
        overrides: undefined,
        parentAcceptance: undefined,
      }) !==
        JSON.stringify({
          ...c,
          defaults: undefined,
          overrides: undefined,
          parentAcceptance: undefined,
        })
    )
      conflict(
        'Retain the saved target and exact bindings. Use Planning amendments and reconciliation to review a scope change.',
      );
    const entries: import('@craftingtable/contracts').RoadmapEntryFields[] = [];
    for (const n of closure.nodes) {
      const r = n.requirement;
      if (r.kind === 'checkpoint' || (r.kind === 'slice' && r.state === 'merged')) continue;
      const activity: MapActivity =
        r.kind === 'work_item'
          ? 'acceptance'
          : r.state === 'verified'
            ? 'verification'
            : 'development';
      const parent = r.kind === 'work_item' ? r.id : n.parentId;
      const workItemId = binding.bindings
        .flatMap((b) => b.workItems)
        .find((w) => w.sourceId === parent)?.workItemId;
      if (!workItemId) conflict(`Missing item binding for ${parent}.`);
      const scope = {
        kind:
          activity === 'acceptance'
            ? ('parent-acceptance' as const)
            : activity === 'verification'
              ? ('slice-verification' as const)
              : ('slice' as const),
        definitionId: d.id,
        bindingRevision: c.bindingRevision,
        sourceId: r.id,
      };
      const prior = old?.definition.entries.find((e) =>
        sameExecutionScope(e.executionScope, scope),
      );
      const started =
        prior &&
        old &&
        startedAttempts(old).some(
          (a) =>
            a.entryId === prior.id && (!amendment || amendment.retainAttemptIds.includes(a.id)),
        );
      const settings = started ? prior : effectiveMapSettings(c, n.repository, activity, r.id);
      entries.push({
        ...(settings.reviewerRoles ? { reviewerRoles: [...settings.reviewerRoles] } : {}),
        id: prior?.id ?? asRoadmapEntryId(randomUUID()),
        workItemId,
        executionScope: scope,
        profiles: settings.profiles,
        policy: settings.policy,
        instructions: settings.instructions,
        automation: settings.automation ?? c.defaults.automation,
      });
    }
    if (
      closure.nodes.some(
        (n) =>
          n.requirement.kind === 'slice' &&
          n.requirement.state === 'started' &&
          !closure.nodes.some(
            (m) =>
              m.requirement.kind === 'slice' &&
              m.requirement.id === n.requirement.id &&
              m.requirement.state === 'merged',
          ),
      )
    )
      conflict(
        'This selection includes a start-only slice milestone. Choose the full roadmap to explicitly include its integration before delegating an implementation cycle.',
      );
    const possible = new Set(entries.map((e) => `${mapActivity(e)}:${e.executionScope?.sourceId}`));
    for (const o of c.overrides)
      if (
        o.level === 'project'
          ? !d.source.repositories.some((r) => r.id === o.key && r.role === 'planned_application')
          : o.level === 'activity'
            ? !['development', 'verification', 'acceptance'].includes(o.key)
            : !possible.has(o.key)
      )
        conflict(`Unknown settings override ${o.level}: ${o.key}.`);
    return this.roadmaps.saveDefinition(
      context,
      ws,
      input.roadmapId,
      {
        expectedVersion: input.expectedVersion,
        name: input.name,
        entries: entries.map((e) => roadmapEntryFieldsSchema.parse(e)),
        scheduling: input.scheduling,
        automation: c.defaults.automation,
      },
      c,
      amendment,
    );
  }
}
