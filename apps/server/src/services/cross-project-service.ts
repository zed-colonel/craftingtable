import { randomUUID } from 'node:crypto';
import {
  type CrossProjectSave,
  roadmapEntryFieldsSchema,
  type SaveCrossProjectRequest,
} from '@craftingtable/contracts';
import {
  asAuditEventId,
  asEventId,
  asMapDecisionId,
  asRoadmapEntryId,
  type ConcurrencyDefinitionId,
  type MapActivity,
  type MapActivitySettings,
  sameExecutionScope,
  startedAttempts,
  targetClosure,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { withPermissions } from './agent-profile-policy.js';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { carryPlanAcceptance } from './generated-plan-evidence.js';
import { bindingIssues } from './map-binding-policy.js';
import {
  crossProjectState,
  effectiveMapSettings,
  type MapSelection,
  mapActivity,
} from './map-state.js';
import type { RoadmapService } from './roadmap-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

function conflict(m: string): never {
  throw new ExecutionRequestError('conflict', m);
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
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
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
