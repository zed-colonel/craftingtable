import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_CODE_MODELS,
  ClaudeCodeBackend,
  CODEX_MODELS,
  CodexBackend,
} from '@craftingtable/agents';
import {
  effectiveCycleAttention,
  effectiveHoldAttention,
  effectiveRoadmapAttention,
  phaseBlockerCode,
  type Roadmap,
  type RoadmapEntry,
} from '@craftingtable/domain';
import type { AgentBackend } from '@craftingtable/agents';
import type { AgentBackendKind } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import { type ServiceSet, createServices } from './composition.js';
import { configFromEnv } from './config.js';
import { openDaemonStorage } from './persisted-records.js';
import { ConcurrentModificationError } from './services/errors.js';
import { resolveScope, scopeEvidenceLedger } from './services/execution-scope.js';
import { PhaseGateError } from './services/phase-resources.js';
import type { EntryPassOutcome } from './services/roadmap-service.js';
import { workflowContext } from './services/workflow-policy.js';

/**
 * Replays one roadmap scheduler pass over a database snapshot (R-I10).
 *
 * `controller:replay` classifies step outcomes only. This records, for every entry of every
 * non-draft roadmap, the decision one `RoadmapService.tick()` would take: start, advance,
 * recover, wait (with its reason), hold, or nothing. It runs the real scheduler on a private
 * copy of the snapshot. Every command that would launch an agent or touch Git is replaced by a
 * recorder that stops the entry there, so nothing is launched and the snapshot is never
 * modified. It also records each roadmap-owned slice cycle's checkpoint readiness, and the
 * inputs a ready checkpoint's attestation needs that its evidence packet lacks (LIVE-07).
 */

export interface SchedulerEntryDecision {
  readonly roadmapId: string;
  readonly entryId: string;
  readonly sourceId: string;
  readonly scope: string;
  readonly decision:
    | 'start'
    | 'advance'
    | 'recover'
    | 'wait'
    | 'hold'
    | 'complete'
    | 'none'
    | 'not-scheduled';
  /** The command the pass issued, or the roadmap write it made. */
  readonly action?: string;
  /** The typed code of a wait or hold, where one exists. */
  readonly code?: string;
  readonly reason?: string;
}
export interface SchedulerRoadmapPass {
  readonly roadmapId: string;
  readonly before: string;
  readonly after: string;
  readonly code?: string;
  readonly reason?: string;
}
export interface CheckpointReadiness {
  readonly cycleId: string;
  readonly sourceId: string;
  readonly status: string;
  readonly code?: string;
  readonly activeCheckpoint?: string;
  readonly checkpoints: readonly {
    readonly id: string;
    readonly ready: boolean;
    readonly accepted: boolean;
    readonly pending: readonly string[];
    /** Inputs the attestation needs that the reviewer's evidence packet does not carry. */
    readonly packetMissing: readonly string[];
  }[];
}
export interface SchedulerReplay {
  readonly roadmaps: readonly SchedulerRoadmapPass[];
  readonly entries: readonly SchedulerEntryDecision[];
  readonly cycles: readonly CheckpointReadiness[];
}

/**
 * Recorded instead of running: the command an entry's evaluation would issue. The pass treats
 * it as a retryable conflict, so it moves on to the next entry without holding this one.
 */
class ReplayIntercept extends ConcurrentModificationError {
  constructor(readonly command: string) {
    super(`Replay stopped at ${command}.`);
  }
}

const INTERCEPTED = {
  workCycleService: {
    start: 'start',
    delegateScopeRepair: 'recover',
    repeatScopeReview: 'advance',
    control: 'advance',
    resolveIntegration: 'advance',
    refreshIntegration: 'advance',
  },
  executionService: {
    createWorktree: 'start',
    mergeWorktree: 'advance',
    recordScopeReceipt: 'advance',
  },
  runtimeEvidenceService: { assertSubjectsCurrent: 'complete' },
} as const;

export async function replaySchedulerSnapshot(
  snapshot: string,
  now: Date,
): Promise<SchedulerReplay> {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-scheduler-replay-'));
  try {
    const copy = join(directory, 'snapshot.sqlite');
    copyFileSync(snapshot, copy);
    return await replaySchedulerDecisions(copy, directory, now);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Runs one pass over `database`, which it modifies: pass a copy. */
export async function replaySchedulerDecisions(
  database: string,
  dataDir: string,
  now: Date,
): Promise<SchedulerReplay> {
  const storage = openDaemonStorage(database);
  try {
    // The stored capacities, so the daemon's configured defaults do not replace them: plan
    // evidence is bound to them. A clean-stop record models the drained restart that keeps
    // running roadmaps running (R-B9).
    const capacity = (key: string) => String(storage.phaseScheduling.capacity(key));
    storage.transaction((tx) =>
      tx.maintenance.recordCleanStop({ stoppedAt: now.toISOString(), interruptedRunCount: 0 }),
    );
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: dataDir,
      CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
      CRAFTINGTABLE_WEB_DIST: '',
      CRAFTINGTABLE_DEVELOPMENT_CAPACITY: capacity('local-development'),
      CRAFTINGTABLE_VERIFICATION_CAPACITY: capacity('local-verification'),
    });
    let issued: { command: string; decision: SchedulerEntryDecision['decision'] } | undefined;
    const record = (command: string, decision: SchedulerEntryDecision['decision']) => {
      issued ??= { command, decision };
    };
    // Backends with the default models, so settings validate as on the host; none can launch,
    // because every start is intercepted and no controller worker runs. Git is present for
    // the same checks, but any call is recorded and stops the entry: the snapshot's worktrees
    // are real repositories.
    const missing = join(dataDir, 'no-agent-executable');
    const git = new Proxy({} as GitOperations, {
      get: (_target, method) => () => {
        record(`git:${String(method)}`, 'advance');
        throw new ReplayIntercept(`git:${String(method)}`);
      },
    });
    const services = await createServices(storage, config, {
      gitOperations: git,
      agentBackends: new Map<AgentBackendKind, AgentBackend>([
        ['claude-code', new ClaudeCodeBackend({ executable: missing, models: CLAUDE_CODE_MODELS })],
        ['codex', new CodexBackend({ executable: missing, models: CODEX_MODELS })],
      ]),
      now: () => now,
      notificationTransport: { send: async () => ({ status: 'accepted' }) },
    });
    const cycles = checkpointReadiness(storage);
    const before = storage.roadmaps.list().filter((r) => r.status !== 'draft');
    intercept(services, record);
    const observed = new Map<string, SchedulerEntryDecision>();
    services.roadmapService.observeScheduling((roadmap, entry, outcome) => {
      const key = `${roadmap.id}/${entry.id}`;
      if (!observed.has(key))
        observed.set(
          key,
          decide(roadmap, entry, outcome, issued, () =>
            storage.roadmaps.find(roadmap.workspaceId, roadmap.id),
          ),
        );
      issued = undefined;
    });
    await services.roadmapService.tick();
    const entries: SchedulerEntryDecision[] = [];
    const roadmaps: SchedulerRoadmapPass[] = [];
    for (const prior of before) {
      const after = storage.roadmaps.find(prior.workspaceId, prior.id) ?? prior;
      const attention = effectiveRoadmapAttention(after);
      roadmaps.push({
        roadmapId: prior.id,
        before: prior.status,
        after: after.status,
        ...(attention ? { code: attention.code } : {}),
        ...(after.status !== prior.status ? { reason: after.reason } : {}),
      });
      for (const entry of prior.definition.entries) {
        const found = observed.get(`${prior.id}/${entry.id}`);
        entries.push(
          found ??
            describe(prior, entry, {
              decision: 'not-scheduled',
              code: after.status === 'running' ? 'not-reached' : `roadmap-${after.status}`,
            }),
        );
      }
    }
    return { roadmaps, entries, cycles };
  } finally {
    storage.close();
  }
}

function describe(
  roadmap: Roadmap,
  entry: RoadmapEntry,
  decision: Omit<SchedulerEntryDecision, 'roadmapId' | 'entryId' | 'sourceId' | 'scope'>,
): SchedulerEntryDecision {
  return {
    roadmapId: roadmap.id,
    entryId: entry.id,
    sourceId: entry.executionScope?.sourceId ?? entry.sourceId,
    scope: entry.executionScope?.kind ?? 'item',
    ...decision,
  };
}

function decide(
  roadmap: Roadmap,
  entry: RoadmapEntry,
  outcome: EntryPassOutcome,
  issued: { command: string; decision: SchedulerEntryDecision['decision'] } | undefined,
  latest: () => Roadmap | undefined,
): SchedulerEntryDecision {
  if (issued)
    return describe(roadmap, entry, { decision: issued.decision, action: issued.command });
  switch (outcome.kind) {
    case 'complete':
      return describe(roadmap, entry, { decision: 'complete' });
    case 'deferred':
      return describe(roadmap, entry, {
        decision: 'wait',
        code: outcome.blocker.kind,
        reason: outcome.blocker.reason,
      });
    case 'held': {
      const hold = roadmap.entryHolds?.[entry.id];
      const attention = hold && effectiveHoldAttention(hold);
      return describe(roadmap, entry, {
        decision: 'hold',
        action: 'existing-hold',
        ...(attention ? { code: attention.code } : { code: hold?.status }),
        ...(hold ? { reason: hold.reason } : {}),
      });
    }
    case 'retry':
      return describe(roadmap, entry, {
        decision: 'wait',
        code:
          outcome.error instanceof PhaseGateError
            ? outcome.error.blockers.map((b) => phaseBlockerCode(b)).join(',')
            : outcome.error instanceof Error
              ? outcome.error.name
              : 'unknown',
        reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
    case 'hold-recorded': {
      const hold = latest()?.entryHolds?.[entry.id];
      const attention = hold && effectiveHoldAttention(hold);
      return describe(roadmap, entry, {
        decision: 'hold',
        action: 'new-hold',
        ...(attention ? { code: attention.code } : {}),
        reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
    }
    case 'evaluated': {
      const after = latest();
      const changed = changedAttempts(roadmap, after, entry);
      return changed
        ? describe(roadmap, entry, { decision: changed.decision, action: changed.action })
        : describe(roadmap, entry, { decision: 'none' });
    }
  }
}

/** What an evaluation that issued no command wrote to the roadmap's attempts. */
function changedAttempts(
  before: Roadmap,
  after: Roadmap | undefined,
  entry: RoadmapEntry,
): { decision: SchedulerEntryDecision['decision']; action: string } | undefined {
  if (!after) return;
  for (const attempt of after.attempts) {
    const prior = before.attempts.find((a) => a.id === attempt.id);
    if (!prior)
      return attempt.recovery
        ? { decision: 'recover', action: 'reserve-round' }
        : { decision: 'start', action: 'reserve-attempt' };
    if (JSON.stringify(prior) === JSON.stringify(attempt)) continue;
    if (attempt.recovery && prior.recovery?.phase !== attempt.recovery.phase)
      return { decision: 'recover', action: `round-${attempt.recovery.phase}` };
    if (attempt.entryId === entry.id && attempt.status === 'completed')
      return { decision: 'complete', action: 'attempt-completed' };
    return { decision: 'advance', action: 'attempt-updated' };
  }
  const hold = after.entryHolds?.[entry.id];
  if (hold && JSON.stringify(hold) !== JSON.stringify(before.entryHolds?.[entry.id]))
    return { decision: 'hold', action: 'new-hold' };
}

function intercept(
  services: ServiceSet,
  record: (command: string, decision: SchedulerEntryDecision['decision']) => void,
): void {
  for (const [service, methods] of Object.entries(INTERCEPTED))
    for (const [method, decision] of Object.entries(methods)) {
      const target = services[service as keyof typeof INTERCEPTED] as unknown as Record<
        string,
        unknown
      >;
      target[method] = (...args: unknown[]) => {
        const command =
          method === 'control' && typeof args[3] === 'string' ? `control:${args[3]}` : method;
        record(command, decision);
        throw new ReplayIntercept(command);
      };
    }
}

/** Checkpoint readiness of each roadmap-owned slice cycle, and what its packet lacks. */
function checkpointReadiness(storage: ReturnType<typeof openDaemonStorage>): CheckpointReadiness[] {
  const result: CheckpointReadiness[] = [];
  for (const cycle of storage.execution.cycles.listActive()) {
    if (!cycle.owner || cycle.executionScope?.kind !== 'slice' || !cycle.workItemId) continue;
    const context = workflowContext(storage, cycle);
    if (!context?.checkpoints.length) continue;
    const scope = resolveScope(storage, cycle.workspaceId, cycle.workItemId, cycle.executionScope);
    const ledger = scopeEvidenceLedger(storage, scope);
    const active = cycle.workflow?.activeReview;
    const attention = effectiveCycleAttention(cycle);
    result.push({
      cycleId: cycle.id,
      sourceId: cycle.executionScope.sourceId,
      status: cycle.status,
      ...(attention ? { code: attention.code } : {}),
      ...(active?.kind === 'checkpoint' && active.checkpointId
        ? { activeCheckpoint: active.checkpointId }
        : {}),
      checkpoints: context.checkpoints.map((checkpoint) => {
        const ready = checkpoint.supported && checkpoint.assigned && !checkpoint.pending.length;
        const source = scope.definition.source.checkpoints.find((c) => c.id === checkpoint.id);
        const attested = ready || checkpoint.id === active?.checkpointId;
        const missing = attested
          ? [
              ...(source?.requires ?? [])
                .filter((r) => r.kind === 'slice')
                .filter(
                  (r) =>
                    !ledger.receipts.some((p) => p.current && p.scope.sourceId === r.id) &&
                    !ledger.acceptedExternalEvidence.some(
                      (s) => s.subject.kind === 'slice' && s.subject.sourceId === r.id,
                    ),
                )
                .map((r) => `receipt:${r.id}`),
              ...checkpoint.caseIds
                .filter((id) => !ledger.cases.includes(id))
                .map((id) => `coverage:${id}`),
            ]
          : [];
        return {
          id: checkpoint.id,
          ready,
          accepted: checkpoint.accepted,
          pending: checkpoint.pending,
          packetMissing: missing,
        };
      }),
    });
  }
  return result.sort((a, b) => a.cycleId.localeCompare(b.cycleId));
}
