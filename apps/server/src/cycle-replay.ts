import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuditEvent,
  effectiveCycleAttention,
  phaseBlockerCode,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import { openDaemonStorage } from './persisted-records.js';
import {
  canonicalJson,
  compareRecords,
  type ReplayCheck,
  type ReplayRecord,
} from './replay-check.js';
import { replayServices } from './replay-services.js';
import { ConcurrentModificationError } from './services/errors.js';

/**
 * Replays the cycle controller's pass over a database snapshot (R-B4).
 *
 * The golden and every-run replays classify a cycle's current run (`decideStepOutcome`), and the
 * scheduler replay runs the roadmap pass; neither runs the cycle pass itself, whose ordered checks
 * come before any run is classified. This runs one real `WorkCycleService.tick()` on a private
 * copy of the snapshot and records, for every cycle that had not ended, what the pass did to it:
 * the commands it reached that the replay intercepts (Git, an agent launch, ending a turn, a
 * checkpoint's recovery preview), the transitions it wrote (their audit actions, in order), and
 * the cycle as the pass left it: its stop and waits, and a digest of the whole stored record. Every Git call is recorded and stops that cycle's reconciliation as
 * a contention the pass retries later, so nothing runs and the snapshot is never modified.
 *
 * Most cycles of a snapshot wait for the operator, and the pass leaves them alone. So a second
 * pass runs on another copy with every stopped or paused cycle lifted to `running` as a resume
 * leaves it (its stop cleared, its investigation and output repair ended, a new step window), as
 * if each were resumed at once (`resumed`): what the controller's checks would decide for that
 * cycle now, as the every-run replay asks of a run that is no longer current. Its records
 * characterize the checks, not anything the daemon would do.
 *
 * Both passes take the snapshot as the live daemon's next pass would find it, at the time of its
 * last controller write: live runs stay live and no restart recovery runs. A path that catches
 * every error (the implementation checkpoint, the design continuation) meets the intercepted Git
 * call as a failure and records its own stop; such a record is the replay's, not the daemon's,
 * and it is the same on every replay.
 */

/** A cycle as a record shows it: its stop, its waits and a digest of its reason. */
export interface CycleReplayState {
  readonly status: WorkCycle['status'];
  readonly step: WorkCycle['step'];
  readonly code?: string;
  readonly owner?: string;
  readonly claim?: string;
  /** The stored phase wait's blocker codes. */
  readonly phaseWait?: readonly string[];
  readonly designWait?: true;
  /** The pass reserved a new run for the step. */
  readonly reserved?: true;
  readonly reason: string;
  /**
   * A digest of the whole stored cycle as the pass left it, with every id the pass minted (a
   * reserved run, a detected conflict) read as `(minted)`: any field the pass wrote changes it.
   */
  readonly cycle?: string;
}

/** What one pass did to one cycle. */
export interface CyclePassRecord {
  /** The commands the pass reached that the replay intercepted, in order. */
  readonly calls?: readonly string[];
  /** The audit actions of the transitions the pass wrote, in order. */
  readonly actions?: readonly string[];
  /** The cycle as the pass left it, when the pass changed its stored record. */
  readonly after?: CycleReplayState;
}

export interface CycleReplayRecord {
  readonly cycleId: string;
  readonly before: CycleReplayState;
  /** The pass over the snapshot as it is. */
  readonly pass: CyclePassRecord;
  /** The pass with this cycle lifted to `running`: only for a stopped or paused cycle. */
  readonly resumed?: CyclePassRecord;
}

export interface CycleReplay {
  readonly cycles: readonly CycleReplayRecord[];
}

/** The statuses the second pass lifts to `running`: a cycle waiting for the operator. */
const LIFTED: ReadonlySet<WorkCycle['status']> = new Set(['needs-attention', 'paused']);

/** Recorded instead of running: the pass retries a contention later, so it moves on. */
class ReplayIntercept extends ConcurrentModificationError {
  constructor(readonly command: string) {
    super(`Replay stopped at ${command}.`);
  }
}

/** Free text pinned without being recorded. */
const digest = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The stored cycle's digest, each UUID it did not hold before the pass read as `(minted)`. */
function cycleDigest(after: WorkCycle, before: WorkCycle): string {
  const known = new Set(JSON.stringify(before).match(UUID) ?? []);
  return digest(canonicalJson(after).replace(UUID, (id) => (known.has(id) ? id : '(minted)')));
}

function replayState(cycle: WorkCycle, reserved = false, before?: WorkCycle): CycleReplayState {
  const attention = effectiveCycleAttention(cycle);
  return {
    status: cycle.status,
    step: cycle.step,
    ...(attention
      ? {
          code: attention.code,
          owner: attention.owner,
          ...(attention.claim ? { claim: attention.claim } : {}),
        }
      : {}),
    ...(cycle.phaseWait ? { phaseWait: cycle.phaseWait.blockers.map(phaseBlockerCode) } : {}),
    ...(cycle.designWait ? { designWait: true as const } : {}),
    ...(reserved ? { reserved: true as const } : {}),
    reason: digest(cycle.reason),
    ...(before ? { cycle: cycleDigest(cycle, before) } : {}),
  };
}

/** Both passes over a copy of `snapshot`; the snapshot itself is only read. */
export async function replayCycleSnapshot(snapshot: string, now: Date): Promise<CycleReplay> {
  const run = async (lift: boolean) => {
    const directory = mkdtempSync(join(tmpdir(), 'craftingtable-cycle-replay-'));
    try {
      const copy = join(directory, 'snapshot.sqlite');
      copyFileSync(snapshot, copy);
      // The pass writes to its copy; a corpus snapshot is kept read-only.
      chmodSync(copy, 0o600);
      return await replayCyclePass(copy, directory, now, lift);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const [stored, resumed] = [await run(false), await run(true)];
  return {
    cycles: stored.map(({ cycleId, before, record }) => {
      const lifted = resumed.find((r) => r.cycleId === cycleId);
      return {
        cycleId,
        before,
        pass: record,
        ...(LIFTED.has(before.status) && lifted ? { resumed: lifted.record } : {}),
      };
    }),
  };
}

/**
 * Runs one cycle pass over `database`, which it modifies: pass a copy. With `lift`, every stopped
 * or paused cycle is first stored as `running`, its stop cleared and its step window renewed. Opening an older schema migrates
 * it and first writes a pre-migration copy beside it, so allow twice its size.
 */
export async function replayCyclePass(
  database: string,
  dataDir: string,
  now: Date,
  lift: boolean,
): Promise<{ cycleId: string; before: CycleReplayState; record: CyclePassRecord }[]> {
  const storage = openDaemonStorage(database);
  try {
    const stored = storage.execution.cycles.listActive();
    if (lift)
      for (const cycle of stored)
        if (LIFTED.has(cycle.status)) {
          // As every resume leaves a cycle (`change()`'s rules for an operator command): its stop
          // cleared, its investigation and output repair ended, and a new window for the step.
          // Waits stay: only one resume path clears a phase wait.
          const { attention: _stop, investigation: _ended, ...rest } = cycle;
          storage.execution.cycles.replace(
            {
              ...rest,
              ...(cycle.outputRepair ? { outputRepair: null } : {}),
              status: 'running',
              runDeadlineAt: new Date(
                now.getTime() + cycle.policy.maxRunMinutes * 60_000,
              ).toISOString(),
            },
            cycle.version,
          );
        }
    const before = storage.execution.cycles.listActive();
    const workspaces = [...new Set(before.map((cycle) => cycle.workspaceId))];
    const lastAudit = new Map(
      workspaces.map((id) => [
        id,
        storage.audit.listWorkspace({ workspaceId: id, limit: 1 })[0]?.sequence ?? 0,
      ]),
    );
    let pending: string[] = [];
    const calls = new Map<string, readonly string[]>();
    const intercepted = (command: string): never => {
      pending.push(command);
      throw new ReplayIntercept(command);
    };
    const services = await replayServices(storage, dataDir, now, (method) =>
      intercepted(`git:${method}`),
    );
    const runs = services.agentRunService;
    // A launch is recorded and taken as started; a turn ends with no process to end.
    runs.startForCycle = async () => {
      pending.push('start-run');
      return undefined as never;
    };
    runs.finishCycleTurn = (_cycle, cancel = false) => {
      pending.push(cancel ? 'cancel-turn' : 'end-turn');
      return false;
    };
    runs.cancelInvestigation = () => {
      pending.push('cancel-investigation');
    };
    // A checkpoint's attestation is checked as the daemon checks it; its recovery preview, which
    // captures the candidate and may audit the host, is where the replay stops.
    (
      services.runtimeEvidenceService as unknown as { checkpointRecovery: () => Promise<never> }
    ).checkpointRecovery = async () => intercepted('checkpoint-recovery');
    services.workCycleService.observePass({
      cycle: (cycle) => {
        if (pending.length) calls.set(cycle.id, pending);
        pending = [];
      },
    });
    await services.workCycleService.tick();
    const actions = new Map<string, string[]>();
    for (const workspaceId of workspaces)
      for (const event of auditSince(storage, workspaceId, lastAudit.get(workspaceId) ?? 0))
        if (event.action === 'work-cycle.updated' && event.targetId)
          actions.set(event.targetId, [
            ...(actions.get(event.targetId) ?? []),
            String(event.metadata.action),
          ]);
    return stored
      .map((original) => {
        const cycle = before.find((c) => c.id === original.id) ?? original;
        const after = storage.execution.cycles.find(cycle.workspaceId, cycle.id);
        const changed = !!after && JSON.stringify(after) !== JSON.stringify(cycle);
        return {
          cycleId: cycle.id,
          before: replayState(original),
          record: {
            ...(calls.has(cycle.id) ? { calls: calls.get(cycle.id) } : {}),
            ...(actions.has(cycle.id) ? { actions: actions.get(cycle.id) } : {}),
            ...(changed
              ? { after: replayState(after, after.currentRunId !== cycle.currentRunId, cycle) }
              : {}),
          },
        };
      })
      .sort((a, b) => a.cycleId.localeCompare(b.cycleId));
  } finally {
    storage.close();
  }
}

/** The audit events a workspace gained after `sequence`, oldest first. */
function auditSince(
  storage: ReturnType<typeof openDaemonStorage>,
  workspaceId: WorkspaceId,
  sequence: number,
): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (let before: number | undefined; ; ) {
    const page = storage.audit.listWorkspace({
      workspaceId,
      limit: 500,
      ...(before === undefined ? {} : { before }),
    });
    const newer = page.filter((event) => (event.sequence ?? 0) > sequence);
    events.push(...newer);
    if (newer.length < page.length || page.length < 500) break;
    before = page.at(-1)?.sequence;
  }
  return events.reverse();
}

/** Keys each cycle's record by its id, for `--check`. */
export function cycleRecords(replay: CycleReplay): ReplayRecord[] {
  return replay.cycles.map((record) => ({ key: `cycle:${record.cycleId}`, value: record }));
}

/** Compares a cycles replay with its golden (`controller:replay --cycles --check`). */
export function checkCycleReplay(golden: CycleReplay, replay: CycleReplay): ReplayCheck {
  return compareRecords(cycleRecords(golden), cycleRecords(replay));
}
