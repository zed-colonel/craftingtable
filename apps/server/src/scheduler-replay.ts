import { createHash } from 'node:crypto';
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
  type CycleOwner,
  effectiveCycleAttention,
  effectiveHoldAttention,
  effectiveRoadmapAttention,
  phaseBlockerCode,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapStatusList,
} from '@craftingtable/domain';
import type { AgentBackend } from '@craftingtable/agents';
import type { AgentBackendKind } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import { type ServiceSet, createServices } from './composition.js';
import { configFromEnv } from './config.js';
import { openDaemonStorage } from './persisted-records.js';
import {
  canonicalJson,
  compareRecords,
  type ReplayCheck,
  type ReplayRecord,
} from './replay-check.js';
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
 *
 * The pass takes the snapshot as the live daemon's next pass would find it: live runs stay
 * live and no restart recovery runs. It runs on this host, so decisions that read the host
 * (native toolchain identity, `CRAFTINGTABLE_KATA_READINESS` in the environment) follow the
 * replaying shell, not the daemon's unit; replay on the workstation that took the snapshot.
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
    | 'running'
    | 'none'
    | 'not-scheduled';
  /** The command the pass issued, or the roadmap write it made. */
  readonly action?: string;
  /** The issued command's arguments (`commandArguments`). Absent in older goldens. */
  readonly args?: CommandArguments;
  /** The typed code of a wait or hold, where one exists. */
  readonly code?: string;
  readonly reason?: string;
}
/**
 * What an intercepted command was asked to do, as a golden can pin it (GR F-3): ids, branch
 * names, kinds, numbers and digests of free text. It leaves out what is the same on every call
 * (the caller, the workspace), what the pass mints afresh (a reserved attempt's worktree, cycle
 * and attempt ids), callbacks, and free text itself.
 */
export type CommandArguments = Readonly<Record<string, unknown>>;
export interface SchedulerRoadmapPass {
  readonly roadmapId: string;
  readonly before: string;
  readonly after: string;
  readonly code?: string;
  readonly reason?: string;
  /** A command the pass issued outside any entry, e.g. the completion check. */
  readonly action?: string;
  readonly args?: CommandArguments;
  /** Open repairs the pass adopted as operator-requested rounds. */
  readonly adopted?: number;
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
  /**
   * The golden's shape: 2 since R-I10's review pass, whose entries and roadmaps carry command
   * arguments. Absent (1) in older goldens, whose check then leaves arguments out.
   */
  readonly format?: number;
  readonly roadmaps: readonly SchedulerRoadmapPass[];
  readonly entries: readonly SchedulerEntryDecision[];
  readonly cycles: readonly CheckpointReadiness[];
  /** Each roadmap's status list (R-E3a) as the pass leaves it. Absent in older goldens. */
  readonly status?: readonly RoadmapStatusList[];
  /**
   * The inbox after the pass: the items each roadmap's pass projects, as if it were running
   * (LIVE-10, LIVE-11), and every other open item (LIVE-09). Absent in older goldens.
   */
  readonly attention?: readonly {
    readonly subjectKey: string;
    readonly code: string;
    readonly blocks?: number;
  }[];
}

/**
 * Keys each scheduler decision by its roadmap entry or cycle, for `--check`. A status list is
 * its header (`statuslist:`) and one record per entry (`status:`). Attention is a multiset
 * (GR F-8): the n-th item with one subject and code is keyed `#n`, so a duplicated or dropped
 * item is a new or missing record, not a collapsed one.
 */
export function schedulerRecords(replay: SchedulerReplay): ReplayRecord[] {
  const attention = new Map<string, unknown[]>();
  for (const item of replay.attention ?? []) {
    const key = `attention:${item.subjectKey}/${item.code}`;
    attention.set(key, [...(attention.get(key) ?? []), item]);
  }
  return [
    ...replay.roadmaps.map((r) => ({ key: `roadmap:${r.roadmapId}`, value: r })),
    ...replay.entries.map((e) => ({ key: `entry:${e.roadmapId}/${e.entryId}`, value: e })),
    ...replay.cycles.map((c) => ({ key: `cycle:${c.cycleId}`, value: c })),
    ...[...attention].flatMap(([key, items]) =>
      // Items under one key differ at most in `blocks`; order them so the pairing is stable.
      items
        .map((item) => ({ item, canonical: canonicalJson(item) }))
        .sort((a, b) => a.canonical.localeCompare(b.canonical))
        .map(({ item }, index) => ({ key: index ? `${key}#${index + 1}` : key, value: item })),
    ),
    ...(replay.status ?? []).flatMap(({ entries, ...header }) => [
      { key: `statuslist:${header.roadmapId}`, value: header },
      ...entries.map((e) => ({ key: `status:${header.roadmapId}/${e.entryId}`, value: e })),
    ]),
  ];
}

/**
 * Compares a scheduler replay with its golden (`controller:replay --scheduler --check`). What a
 * golden predates is left out of both sides, and the check says so. A format-2 golden is
 * compared in full: one that lacks status lists or attention has none, and differs if the
 * replay has some.
 */
export function checkSchedulerReplay(
  golden: SchedulerReplay,
  replay: SchedulerReplay,
): ReplayCheck {
  const withArguments = (golden.format ?? 1) >= 2;
  const withStatus = withArguments || !!golden.status;
  const withAttention = withArguments || !!golden.attention;
  const comparable = ({ status, attention, ...records }: SchedulerReplay): SchedulerReplay => ({
    ...records,
    ...(withStatus ? { status } : {}),
    ...(withAttention ? { attention } : {}),
    ...(withArguments
      ? {}
      : {
          roadmaps: records.roadmaps.map(({ args: _args, ...roadmap }) => roadmap),
          entries: records.entries.map(({ args: _args, ...entry }) => entry),
        }),
  });
  return compareRecords(
    schedulerRecords(comparable(golden)),
    schedulerRecords(comparable(replay)),
    [
      ...(withArguments ? [] : ['command arguments (the golden predates them)']),
      ...(withStatus ? [] : ['status lists (the golden predates them)']),
      ...(withAttention ? [] : ['attention (the golden predates it)']),
    ],
  );
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

/** Free text pinned without being recorded. */
const digest = (text: string | undefined) =>
  text ? `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}` : undefined;
/** A cycle owner without its attempt id, which a reservation in this pass mints afresh. */
const ownerArguments = (owner: CycleOwner | null | undefined) =>
  owner && {
    roadmapId: owner.roadmapId,
    entryId: owner.entryId,
    definitionRevision: owner.definitionRevision,
  };
/** Drops the fields a command was not given, so absent and undefined compare alike. */
const given = (fields: Record<string, unknown>): CommandArguments =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

/** One intercepted command: the decision it stands for, and its recorded arguments. */
type Command<F> = F extends (...args: infer A) => unknown
  ? {
      readonly decision: SchedulerEntryDecision['decision'];
      readonly args: (args: A) => CommandArguments;
    }
  : never;
type Commands<S> = { readonly [M in keyof S]?: Command<S[M]> };

const INTERCEPTED = {
  workCycleService: {
    start: {
      decision: 'start',
      args: ([, , workItemId, input, , allowScopeReview, owner]) =>
        given({
          workItemId,
          profiles: input.profiles,
          policy: input.policy,
          instructions: digest(input.instructions),
          allowScopeReview,
          owner: ownerArguments(owner),
        }),
    },
    delegateScopeRepair: {
      decision: 'recover',
      args: ([, , cycleId, input, delegation]) =>
        given({
          cycleId,
          expectedVersion: input.expectedVersion,
          snapshotDigest: input.snapshotDigest,
          sourceId: input.sourceId,
          maxRemediationRounds: input.maxRemediationRounds,
          instructions: digest(input.instructions),
          owner: ownerArguments(delegation?.owner),
          profiles: delegation?.profiles,
          policy: delegation?.policy,
        }),
    },
    repeatScopeReview: {
      decision: 'advance',
      args: ([, , cycleId, expectedVersion, guidance]) =>
        given({ cycleId, expectedVersion, guidance: digest(guidance) }),
    },
    control: {
      decision: 'advance',
      args: ([, , cycleId, action, expectedVersion, guidance]) =>
        given({ cycleId, action, expectedVersion, guidance: digest(guidance) }),
    },
    resolveIntegration: {
      decision: 'advance',
      args: ([, , cycleId, input]) =>
        given({
          cycleId,
          action: input.action,
          expectedVersion: input.expectedVersion,
          profile: input.profile,
          instructions: digest(input.instructions),
        }),
    },
    refreshIntegration: {
      decision: 'advance',
      args: ([cycle, parent, launching]) =>
        given({ cycleId: cycle.id, cycleVersion: cycle.version, runId: parent?.id, launching }),
    },
  } satisfies Commands<ServiceSet['workCycleService']>,
  executionService: {
    createWorktree: {
      decision: 'start',
      args: ([, , workItemId, input]) =>
        given({
          workItemId,
          repositoryId: input.repositoryId,
          branchName: input.branchName,
          executionScope: input.executionScope,
        }),
    },
    mergeWorktree: {
      decision: 'advance',
      args: ([, , worktreeId, input, , delegation, finalApproval]) =>
        given({
          worktreeId,
          targetBranch: input?.targetBranch,
          adoptChecks: input?.adoptChecks && {
            proposalDigest: input.adoptChecks.proposalDigest,
            declarationId: input.adoptChecks.declarationId,
            rationale: digest(input.adoptChecks.rationale),
          },
          roadmapId: delegation?.roadmapId,
          definitionRevision: delegation?.definitionRevision,
          finalApproval,
        }),
    },
    recordScopeReceipt: {
      decision: 'advance',
      args: ([, , worktreeId, expectedWorktreeVersion]) =>
        given({ worktreeId, expectedWorktreeVersion }),
    },
  } satisfies Commands<ServiceSet['executionService']>,
  runtimeEvidenceService: {
    assertSubjectsCurrent: {
      decision: 'complete',
      args: ([, definitionId, bindingRevision, subjects]) =>
        given({ definitionId, bindingRevision, subjects }),
    },
  } satisfies Commands<ServiceSet['runtimeEvidenceService']>,
} as const;

/** The arguments the replay records for an intercepted call. Exported for its test. */
export function commandArguments(
  service: keyof typeof INTERCEPTED,
  method: string,
  args: readonly unknown[],
): CommandArguments {
  const command = (
    INTERCEPTED[service] as Record<string, { args: (a: never) => CommandArguments }>
  )[method];
  if (!command) throw new Error(`${service}.${method} is not intercepted`);
  return command.args(args as never);
}

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

/**
 * Runs one pass over `database`, which it modifies: pass a copy. Opening an older schema
 * migrates it and first writes a pre-migration copy beside it, so allow twice its size.
 */
export async function replaySchedulerDecisions(
  database: string,
  dataDir: string,
  now: Date,
): Promise<SchedulerReplay> {
  const storage = openDaemonStorage(database);
  try {
    // The stored capacities, so the daemon's configured defaults do not replace them: plan
    // evidence is bound to them.
    const capacity = (key: string) => String(storage.phaseScheduling.capacity(key));
    const before = storage.roadmaps.list().filter((r) => r.status !== 'draft');
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: dataDir,
      CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
      CRAFTINGTABLE_WEB_DIST: '',
      CRAFTINGTABLE_DEVELOPMENT_CAPACITY: capacity('local-development'),
      CRAFTINGTABLE_VERIFICATION_CAPACITY: capacity('local-verification'),
    });
    let issued: Issued | undefined;
    const record = (
      command: string,
      decision: SchedulerEntryDecision['decision'],
      args?: CommandArguments,
    ) => {
      issued ??= { command, decision, ...(args ? { args } : {}) };
    };
    // Backends with the default models, so settings validate as on the host; none can launch,
    // because every start is intercepted and no controller worker runs. Git is present for
    // the same checks, but any call is recorded and stops the entry: the snapshot's worktrees
    // are real repositories.
    const missing = join(dataDir, 'no-agent-executable');
    const git = new Proxy({} as GitOperations, {
      // The replay cannot follow a pass past Git, read or write: it records where it stopped.
      get: (_target, method) => () => {
        record(`git:${String(method)}`, 'not-scheduled');
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
      // The snapshot as the live daemon's next pass finds it, live runs included: no restart.
      restartRecovery: false,
    });
    const cycles = checkpointReadiness(storage);
    intercept(services, record);
    const observed = new Map<string, SchedulerEntryDecision>();
    const passActions = new Map<string, Issued>();
    services.roadmapService.observeScheduling({
      entry: (roadmap, entry, outcome) => {
        const key = `${roadmap.id}/${entry.id}`;
        if (!observed.has(key))
          observed.set(
            key,
            decide(roadmap, entry, outcome, issued, () =>
              storage.roadmaps.find(roadmap.workspaceId, roadmap.id),
            ),
          );
        issued = undefined;
      },
      passEnded: (roadmapId) => {
        if (issued) passActions.set(roadmapId, issued);
        issued = undefined;
      },
    });
    await services.roadmapService.tick();
    const entries: SchedulerEntryDecision[] = [];
    const roadmaps: SchedulerRoadmapPass[] = [];
    for (const prior of before) {
      const after = storage.roadmaps.find(prior.workspaceId, prior.id) ?? prior;
      const attention = effectiveRoadmapAttention(after);
      const issuedByPass = passActions.get(prior.id);
      const adopted = after.attempts.filter(
        (a) =>
          a.recovery?.requestedByUserId &&
          a.status === 'active' &&
          !prior.attempts.some((p) => p.id === a.id),
      ).length;
      roadmaps.push({
        roadmapId: prior.id,
        before: prior.status,
        after: after.status,
        ...(attention ? { code: attention.code } : {}),
        ...(after.status !== prior.status ? { reason: after.reason } : {}),
        ...(issuedByPass ? { action: issuedByPass.command } : {}),
        ...(issuedByPass?.args ? { args: issuedByPass.args } : {}),
        ...(adopted ? { adopted } : {}),
      });
      for (const entry of prior.definition.entries) {
        const found = observed.get(`${prior.id}/${entry.id}`);
        entries.push(
          found?.action === 'roadmap-stopped' && attention
            ? { ...found, code: attention.code }
            : (found ??
                describe(prior, entry, {
                  decision: 'not-scheduled',
                  code: after.status === 'running' ? 'not-reached' : `roadmap-${after.status}`,
                })),
        );
      }
    }
    // Attention items are rebuilt on every copy with fresh ids; name each by its subject.
    const status = before.map((prior) => {
      const list = services.roadmapService.statusOf(
        storage.roadmaps.find(prior.workspaceId, prior.id) ?? prior,
      );
      return {
        ...list,
        entries: list.entries.map((entry) =>
          entry.waitsOn?.attentionItemId
            ? {
                ...entry,
                waitsOn: {
                  ...entry.waitsOn,
                  attentionItemId: `subject:${
                    storage.attention.find(prior.workspaceId, entry.waitsOn.attentionItemId)
                      ?.subjectKey
                  }`,
                },
              }
            : entry,
        ),
      };
    });
    const attention = [
      ...before.flatMap((prior) =>
        services.roadmapService
          .passAttention(storage.roadmaps.find(prior.workspaceId, prior.id) ?? prior)
          .map((item) => ({
            subjectKey: item.subjectKey,
            code: item.code,
            ...(item.blocks === undefined ? {} : { blocks: item.blocks }),
          })),
      ),
      ...storage.attention
        .open()
        .filter((item) => !item.scopeKey.startsWith('roadmap-pass:'))
        .map((item) => ({ subjectKey: item.subjectKey, code: item.code })),
    ].sort((a, b) => `${a.subjectKey}/${a.code}`.localeCompare(`${b.subjectKey}/${b.code}`));
    return { format: 2, roadmaps, entries, cycles, status, attention };
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

interface Issued {
  readonly command: string;
  readonly decision: SchedulerEntryDecision['decision'];
  readonly args?: CommandArguments;
}

function decide(
  roadmap: Roadmap,
  entry: RoadmapEntry,
  outcome: EntryPassOutcome,
  issued: Issued | undefined,
  latest: () => Roadmap | undefined,
): SchedulerEntryDecision {
  if (issued)
    return describe(roadmap, entry, {
      decision: issued.decision,
      action: issued.command,
      ...(issued.args ? { args: issued.args } : {}),
      ...(issued.command.startsWith('git:') ? { code: 'replay-stopped-at-git' } : {}),
    });
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
    case 'failed':
      // The pass stops the roadmap after this report; its code is read once the pass ends.
      return describe(roadmap, entry, {
        decision: 'hold',
        action: 'roadmap-stopped',
        reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
    case 'evaluated': {
      const changed = changedAttempts(roadmap, latest(), entry);
      if (changed)
        return describe(roadmap, entry, { decision: changed.decision, action: changed.action });
      // Every evaluation returns a typed step (R-C12): a wait, or an entry at work on its own.
      return 'wait' in outcome.step
        ? describe(roadmap, entry, {
            decision: 'wait',
            code: outcome.step.wait.code,
            reason: outcome.step.wait.reason,
          })
        : describe(roadmap, entry, { decision: 'running' });
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
  record: (
    command: string,
    decision: SchedulerEntryDecision['decision'],
    args: CommandArguments,
  ) => void,
): void {
  for (const [service, methods] of Object.entries(INTERCEPTED))
    for (const [method, { decision }] of Object.entries(methods)) {
      const name = service as keyof typeof INTERCEPTED;
      const target = services[name] as unknown as Record<string, unknown>;
      target[method] = (...args: unknown[]) => {
        const command =
          method === 'control' && typeof args[3] === 'string' ? `control:${args[3]}` : method;
        record(command, decision, commandArguments(name, method, args));
        throw new ReplayIntercept(command);
      };
    }
  // Removing a settled decision preparation's worktree (LIVE-16) is housekeeping before the
  // pass evaluates any entry: it decides nothing the replay compares, and its Git call would be
  // charged to whichever entry came first. The replay leaves those worktrees as they are.
  services.executionService.releaseDecisionWorktree = async () => false;
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
        // Observed on the packet itself: a slice prerequisite needs a current receipt or
        // accepted evidence somewhere in it, and each case a coverage binding.
        const section = ledger.checkpoints.find((c) => c.id === checkpoint.id);
        const missing = attested
          ? [
              ...(source?.requires ?? [])
                .filter((r) => r.kind === 'slice')
                .filter(
                  (r) =>
                    !ledger.receipts.some((p) => p.current && p.scope.sourceId === r.id) &&
                    !section?.prerequisites.some(
                      (p) => p.kind === 'scope-receipt' && p.receipt.scope.sourceId === r.id,
                    ) &&
                    !ledger.acceptedExternalEvidence.some(
                      (s) => s.subject.kind === 'slice' && s.subject.sourceId === r.id,
                    ),
                )
                .map((r) => `receipt:${r.id}`),
              // A prerequisite accepted as an architecture decision needs its decision text.
              ...(section?.prerequisites ?? []).flatMap((p) => {
                if (p.kind !== 'accepted-evidence') return [];
                const decided = storage.runtimeEvidence
                  .submissions(cycle.workspaceId, scope.definition.id)
                  .find((s) => s.id === p.submissionId);
                const decisions = (
                  section as { decisions?: readonly { submissionId: string }[] } | undefined
                )?.decisions;
                const carried =
                  ledger.architectureDecisions.some((d) => d.submissionId === p.submissionId) ||
                  !!decisions?.some((d) => d.submissionId === p.submissionId);
                return decided?.architectureDecision && !carried
                  ? [`decision:${p.requirement.id}`]
                  : [];
              }),
              ...checkpoint.caseIds
                .filter(
                  (id) =>
                    !ledger.cases.includes(id) &&
                    !section?.coverage.some((c) => c.id === id) &&
                    !section?.baselineCoverage.some((c) => c.id === id),
                )
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
