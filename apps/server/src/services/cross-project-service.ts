import { PLAN_CHECKPOINT } from './plan-acceptance-policy.js';
import { bindingIssues } from './map-binding-policy.js';
export { bindingIssues } from './map-binding-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { integratedSlice } from './scope-lineage.js';
import { randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  targetClosure,
  milestoneKey,
  sameExecutionScope,
  type CrossProjectConfiguration,
  type ConcurrencyRequirement,
  type WorkspaceId,
  type ConcurrencyDefinition,
  type MapActivity,
  type RoadmapEntry,
} from '@craftingtable/domain';
import {
  roadmapEntryInputSchema,
  type CrossProjectView,
  type SaveCrossProjectRequest,
} from '@craftingtable/contracts';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { RoadmapService } from './roadmap-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { adoptedDecisions, mapAdopted } from './map-adoption-policy.js';
import {
  acceptedEvidence,
  activeRuntime,
  currentScopeReceipt,
  parentAccepted,
} from './runtime-evidence-policy.js';
import { scopePhaseBlockers } from './execution-scope.js';
function conflict(m: string): never {
  throw new ExecutionRequestError('conflict', m);
}
export type MapSelection = Pick<
  CrossProjectConfiguration,
  'definitionId' | 'bindingRevision' | 'targetId' | 'selection'
>;
export function milestoneSatisfied(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  revision: number,
  r: ConcurrencyRequirement,
): boolean {
  if (r.kind === 'checkpoint')
    return !!acceptedEvidence(tx, ws, d.id, revision, { kind: 'checkpoint', sourceId: r.id });
  const b = tx.imports.bindings(ws, d.id).find((b) => b.revision === revision);
  const parent =
    r.kind === 'work_item' ? r.id : d.source.slices.find((s) => s.id === r.id)?.work_item;
  const id = b?.bindings.flatMap((b) => b.workItems).find((w) => w.sourceId === parent)?.workItemId;
  if (!id) return false;
  if (r.kind === 'work_item') return parentAccepted(tx, ws, d.id, revision, r.id);
  const scope = {
    kind: 'slice' as const,
    definitionId: d.id,
    bindingRevision: revision,
    sourceId: r.id,
  };
  const trees = tx.execution.worktrees
    .listForWorkItem(ws, id)
    .filter((t) => sameExecutionScope(t.executionScope, scope));
  const integrated = integratedSlice(tx, ws, id, scope);
  if (r.state === 'started')
    return (
      !!integrated ||
      trees.some((t) => tx.execution.runs.listForWorktree(ws, t.id).some((r) => r.startedAt))
    );
  if (r.state === 'merged') return !!integrated?.mergeSha;
  return (
    !!acceptedEvidence(tx, ws, d.id, revision, { kind: 'slice', sourceId: r.id }) ||
    tx.scopeReceipts
      .list(ws, id)
      .some(
        (p) =>
          sameExecutionScope(p.scope, scope) &&
          currentScopeReceipt(tx, ws, p) &&
          integrated?.mergeSha === p.integrationSha,
      )
  );
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
    let blockers = n.requires.filter((k) => !states.get(k));
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
        .list(ws)
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
                : undefined),
        )?.reviewer_roles ?? []),
      ],
      requirements: [...n.requires],
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
  const planApprovalPending = nodes.some(
    (n) => n.included && n.kind === 'checkpoint' && n.sourceId === PLAN_CHECKPOINT && !n.satisfied,
  );
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
              message:
                'Save the roadmap, generate STACK-PLAN-ACCEPTED evidence, then review and accept it before Start or Resume.',
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
              message: 'Review and adopt the scheduling decisions for these exact plans.',
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
            'Waiting for plan acceptance: review and accept STACK-PLAN-ACCEPTED evidence before Start or Resume.',
          ]
        : []),
      ...bindingIssues(tx, ws, d.id, revision),
      ...(!mapAdopted(tx, ws, d.id, revision)
        ? ['Adopt the exact map and its proposed scheduling decisions before Start.']
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
export function effectiveMapSettings(
  c: CrossProjectConfiguration,
  alias: string,
  activity: MapActivity,
  sourceId: string,
) {
  let settings = c.defaults;
  for (const [level, key] of [
    ['project', alias],
    ['activity', activity],
    ['individual', `${activity}:${sourceId}`],
  ] as const)
    settings = c.overrides.find((o) => o.level === level && o.key === key)?.settings ?? settings;
  return settings;
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
    id: string,
    input: { bindingRevision: number; decisionIds: readonly string[]; rationale: string },
  ) {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const d = this.storage.imports.definition(ws, id);
    if (!d) throw new NotFoundError();
    const issues = bindingIssues(this.storage, ws, id, input.bindingRevision);
    if (issues.length) conflict(issues.join(' '));
    const ids = d.source.decisions.map((d) => d.id);
    if (
      ids.length !== input.decisionIds.length ||
      new Set(input.decisionIds).size !== ids.length ||
      ids.some((id) => !input.decisionIds.includes(id))
    )
      conflict(
        'Review and explicitly approve every proposed scheduling decision; changing a proposal requires a new definition.',
      );
    const at = new Date().toISOString();
    this.storage.transaction((tx) => {
      tx.imports.addAdoption({
        id: randomUUID(),
        workspaceId: ws,
        definitionId: id,
        bindingRevision: input.bindingRevision,
        decisionIds: ids,
        rationale: input.rationale,
        createdAt: at,
        createdByUserId: context.user.id,
      });
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
          definitionId: id,
          message:
            'Map scheduling decisions adopted. Checkpoint evidence and Start remain separate.',
        },
      });
    });
    this.notifier.notify();
    return { adopted: true };
  }
  save(
    context: AuthContext,
    ws: WorkspaceId,
    input: SaveCrossProjectRequest,
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
    const entries: import('@craftingtable/contracts').SaveRoadmapRequest['entries'] = [];
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
        old?.attempts.some(
          (a) =>
            a.entryId === prior.id && (!amendment || amendment.retainAttemptIds.includes(a.id)),
        );
      const settings = started ? prior : effectiveMapSettings(c, n.repository, activity, r.id);
      entries.push({
        ...(settings.reviewerRoles ? { reviewerRoles: [...settings.reviewerRoles] } : {}),
        id: prior?.id ?? randomUUID(),
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
    return this.roadmaps.save(
      context,
      ws,
      input.roadmapId,
      {
        expectedVersion: input.expectedVersion,
        name: input.name,
        entries: entries.map((e) => roadmapEntryInputSchema.parse(e)),
        scheduling: input.scheduling,
        automation: c.defaults.automation,
      },
      c,
      amendment,
    );
  }
}
