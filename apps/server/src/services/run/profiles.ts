/** The workspace's run profiles, the agent backends and their model checks (R-B7). */
import { randomUUID } from 'node:crypto';
import type { AgentBackend } from '@craftingtable/agents';
import {
  AGENT_BACKENDS,
  AGENT_PROFILE_PURPOSES,
  type AgentBackendKind,
  asAuditEventId,
  DEFAULT_COMPLETION_POLICY,
  type WorkspaceAgentProfile,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { workspaceLayer } from '../agent-profile-policy.js';
import { launchProfile, resolveAgents, selectionSet } from '../agent-resolution.js';
import type { AuthContext } from '../auth-service.js';
import { ExecutionRequestError } from '../errors.js';
import type { WorkspaceService } from '../workspace-service.js';
import { misnamedModel } from './shared.js';

/** The part of an agent selection the model checks read (R-G15). */
export type ModelSelection = { readonly backend: AgentBackendKind; readonly model?: string };

/** The workspace defaults `run-profiles` and the page reads report (R-E5a). */
export type RunProfiles = {
  readonly profiles: readonly (WorkspaceAgentProfile & { readonly stored: boolean })[];
  readonly agents: Readonly<
    Record<
      import('@craftingtable/domain').AgentProfilePurpose,
      import('@craftingtable/domain').EffectiveAgent
    >
  >;
};

/** `run-profiles`' answer: the defaults, and the same as the selection set setup starts from. */
function withSelections(profiles: RunProfiles) {
  return { ...profiles, selections: selectionSet(profiles.agents) };
}

export class RunProfileCatalog {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly backends: ReadonlyMap<AgentBackendKind, AgentBackend>,
    private readonly now: () => Date,
  ) {}

  hasBackend(kind: AgentBackendKind): boolean {
    return this.backends.has(kind);
  }

  /**
   * Refuses agent selections an operator submits whose model is a display name, or another
   * spelling of a catalog id (R-G15, LIVE-34): caught when it is chosen, not at a later launch.
   * Each selection is named by its slot (a role, an entry's step, a purpose). Only what a command
   * submits is checked, and a slot that keeps the model the record already saved there (`saved`)
   * is let through, so a saved selection is a warning and never blocks another change; the
   * launch check still stops it.
   */
  requireModelIds(
    selections: Iterable<readonly [slot: string, selection: ModelSelection | undefined]>,
    saved: Iterable<readonly [slot: string, selection: ModelSelection | undefined]> = [],
  ): void {
    const key = (slot: string, selection: ModelSelection) =>
      `${slot}\0${selection.backend}\0${selection.model}`;
    const kept = new Set(
      [...saved].flatMap(([slot, selection]) => (selection ? [key(slot, selection)] : [])),
    );
    for (const [slot, selection] of selections) {
      if (selection === undefined || kept.has(key(slot, selection))) continue;
      const backend = this.backends.get(selection.backend);
      const misnamed = backend && misnamedModel(backend, selection.model);
      if (misnamed !== undefined) throw new ExecutionRequestError('invalid-request', misnamed);
    }
  }

  backendAvailable(): boolean {
    return this.backends.size > 0;
  }

  defaultBackend(): AgentBackendKind | undefined {
    return AGENT_BACKENDS.find((kind) => this.backends.has(kind));
  }

  /**
   * Every role, in role order; unsaved roles carry the daemon's default. Beside them, each
   * purpose's default with its source (R-E5a), read in the same read.
   */
  listRunProfiles(context: AuthContext, workspaceId: WorkspaceId, requestId?: string) {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return withSelections(
      this.storage.readTransaction((tx) => this.runProfilesIn(tx, workspaceId)),
    );
  }

  /**
   * The workspace's default step time limit for new cycles and roadmap entries (R-C17 part 4,
   * decisions 8 and 9): the saved one, or the completion policy's own while none is saved.
   */
  cycleDefaults(
    context: AuthContext,
    workspaceId: WorkspaceId,
    requestId?: string,
  ): { readonly maxRunMinutes: number; readonly stored: boolean } {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const saved = this.storage.execution.cycleDefaults.find(workspaceId);
    return {
      maxRunMinutes: saved?.maxRunMinutes ?? DEFAULT_COMPLETION_POLICY.maxRunMinutes,
      stored: saved !== undefined,
    };
  }

  /** Saves the workspace's default step time limit, audited with what it was. */
  saveCycleDefaults(
    context: AuthContext,
    workspaceId: WorkspaceId,
    maxRunMinutes: number,
    requestId?: string,
  ): { readonly maxRunMinutes: number; readonly stored: boolean } {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      const saved = tx.execution.cycleDefaults.find(workspaceId)?.maxRunMinutes;
      // The same value saved again changes nothing and is not audited (increment 5 review N-5).
      if (saved === maxRunMinutes) return;
      const before = saved ?? DEFAULT_COMPLETION_POLICY.maxRunMinutes;
      tx.execution.cycleDefaults.save(workspaceId, {
        maxRunMinutes,
        updatedAt: occurredAt,
        updatedByUserId: context.user.id,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'cycle-defaults.updated',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'succeeded',
        metadata: { maxRunMinutes: { from: before, to: maxRunMinutes } },
      });
    });
    return { maxRunMinutes, stored: true };
  }

  saveRunProfiles(
    context: AuthContext,
    workspaceId: WorkspaceId,
    profiles: readonly WorkspaceAgentProfile[],
    requestId?: string,
  ): RunProfiles {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    this.requireModelIds(
      profiles.map((profile) => [profile.role, profile] as const),
      this.storage.execution.runProfiles
        .list(workspaceId)
        .map((profile) => [profile.role, profile] as const),
    );
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.execution.runProfiles.replace({
        workspaceId,
        profiles,
        occurredAt,
        updatedByUserId: context.user.id,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'run-profiles.updated',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'succeeded',
        metadata: {
          profiles: profiles.map((profile) => ({
            role: profile.role,
            backend: profile.backend,
            model: profile.model ?? null,
            permissionMode: profile.permissionMode,
            reasoningEffort: profile.reasoningEffort ?? null,
          })),
        },
      });
    });
    return withSelections(
      this.storage.readTransaction((tx) => this.runProfilesIn(tx, workspaceId)),
    );
  }

  /** The workspace's defaults as a resolution layer (R-E5a). */
  workspaceLayerIn(tx: StorageRepositories, workspaceId: WorkspaceId) {
    return workspaceLayer(
      tx.execution.runProfiles.list(workspaceId),
      this.defaultBackend() ?? AGENT_BACKENDS[0],
    );
  }

  /**
   * The workspace's profiles as `listRunProfiles` returns them, read in the caller's read (R-D5):
   * each role's effective default, whether it is saved, and its source (R-E5a).
   */
  runProfilesIn(tx: StorageRepositories, workspaceId: WorkspaceId): RunProfiles {
    const layer = this.workspaceLayerIn(tx, workspaceId);
    const agents = resolveAgents({ workspace: layer });
    return {
      profiles: AGENT_PROFILE_PURPOSES.map((role) => ({
        ...launchProfile(agents[role]),
        role,
        stored: layer.profiles.some((profile) => profile.role === role),
      })),
      agents,
    };
  }
}
