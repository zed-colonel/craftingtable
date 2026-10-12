import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import type { StartFinalizationRequest } from '@craftingtable/contracts';
import {
  type AgentRunId,
  asFinalizationStageId,
  asReviewFindingId,
  asWorkItemSourceId,
  type CycleAttentionCode,
  type Finalization,
  type FindingSeverity,
  optionalFinding,
  type ReviewFinding,
} from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import {
  beginFinalization,
  cleanupExecutionFixtures,
  commitFile,
  finalizationCommand,
  finalizationCycle,
  finalizationFixture,
  implementsFinalization,
  present,
  type ScriptedReply,
  stagedInput,
  stagedLedger,
  stagedText,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * The AQ finalization's ten operator stops (2026-09-13, legacy improvement rounds), replayed
 * against the staged controller (R-C7, HIST-16). The fixture holds what each stop was: its
 * kind, and the severities and categories of the findings open at it. This test puts each
 * stop's situation in front of a staged finalization in the same order, answers the operator
 * stops the way the AQ operator did (in staged commands), and records what the controller did
 * at each: an operator stop, or the mechanism that handled it without one.
 *
 * `EXPECTED` is the table to change when the controller changes: one row per recorded stop
 * (`S1` to `S10`), plus the stops only a staged finalization has (`simplification`, `polish`)
 * and the promotion. A row names either the operator stops and how they were answered, or the
 * mechanism that removes the stop, and why.
 */
interface RecordedFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly category: 'correctness';
  /** Deferred by the operator before the stop (retired with R-B10). */
  readonly deferred?: true;
}
interface RecordedStop {
  readonly stop: number;
  readonly step: 'review' | 'remediate';
  readonly kind:
    | 'report-invalid'
    | 'remediation-limit'
    | 'question'
    | 'open-questions-section-missing'
    | 'worktree-dirty'
    | 'step-incomplete';
  readonly issue?: 'finding-id-pattern' | 'exit-gate-evidence-too-long';
  readonly question?: 'genuine' | 'nit-policy';
  readonly exitGateMet?: boolean;
  readonly findings: readonly RecordedFinding[];
}
const record = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/records/aq-finalization-stops-2026-09-13.json', import.meta.url),
    'utf8',
  ),
) as { readonly stops: readonly RecordedStop[] };

/**
 * The staged finalization the scenario runs. AQ's two improvement rounds each had their own
 * pass; staged, every recorded finding is correctness work (no record has a category), so
 * round 1 is a correctness stage over the plan's work items and round 2 the whole-plan
 * correctness stage after it. Each has the remediation allowance the record's stops imply:
 * round 1 reached its limit (S3) after two remediations, round 2 (S8) after three.
 */
const STAGE_OF_STOP: Readonly<Record<number, string>> = {
  1: 'correctness-items',
  2: 'correctness-items',
  3: 'correctness-items',
  4: 'correctness',
  5: 'correctness',
  6: 'correctness',
  7: 'correctness',
  8: 'correctness',
  9: 'final-review',
  10: 'final-review',
};

/** What handles a recorded stop without the operator. */
type Mechanism =
  /** R-C2: a format fault in the final report is repaired in the same session. */
  | 'output-repair'
  /**
   * R-G11 (AGT-62): a result given while background work runs is a progress notice, and the
   * turn ends with the result that collects it.
   */
  | 'background-result-held'
  /** A stage review that changed the worktree becomes housekeeping remediation. */
  | 'housekeeping'
  /** R-C8 (ADR-062): a session limit with a known reset is retried after it. */
  | 'service-retry'
  /** R-C7 D5: nits alone at a stage's spent allowance become follow-ups; the stage goes on. */
  | 'nits-parked'
  /** R-C7 D6: started with "optional findings: follow-up", discovery parks its ideas. */
  | 'optional-follow-up';
/** How the scenario's operator answers a stop, as the AQ operator did. */
type Answer = 'resume' | 'authorize-remediation' | 'remediate-findings' | 'select-none' | 'promote';
interface Expectation {
  /** The operator stops, in order, with the command that answered each. */
  readonly stops?: readonly { readonly code: CycleAttentionCode; readonly answer: Answer }[];
  /** The mechanisms that handled the stop instead. */
  readonly mechanisms?: readonly Mechanism[];
  readonly why: string;
}
const EXPECTED: Readonly<Record<string, Expectation>> = {
  S1: { mechanisms: ['output-repair'], why: 'R-C2 repairs the invalid finding IDs.' },
  S2: { mechanisms: ['output-repair'], why: 'R-C2 repairs the oversized exit-gate evidence.' },
  S3: {
    mechanisms: ['nits-parked'],
    why: 'D5: the lone nit at the spent allowance becomes a follow-up and the stage goes on.',
  },
  S4: {
    stops: [{ code: 'finalization-needs-input', answer: 'resume' }],
    why: 'A genuine question is the operator’s.',
  },
  // R-G11 (AGT-62) changed S5 and S6 from R-C2's output repair: their reports lacked the Open
  // questions section because they were a background task's progress, not the turn's outcome.
  S5: {
    mechanisms: ['background-result-held'],
    why: 'R-G11: the result given while the check matrix ran is a progress notice; the turn ends at the collected report.',
  },
  S6: {
    mechanisms: ['background-result-held'],
    why: 'R-G11: the result given while the check matrix ran is a progress notice; the turn ends at the collected report.',
  },
  S7: {
    mechanisms: ['housekeeping'],
    why: 'Stage completion turns the changed worktree into housekeeping remediation.',
  },
  S8: {
    mechanisms: ['nits-parked'],
    why: 'D5: the brief states the nit policy, so there is no question, and the nits are parked.',
  },
  S9: { mechanisms: ['service-retry'], why: 'R-C8 waits for the session limit’s reset.' },
  S10: {
    stops: [{ code: 'remediation-exhausted', answer: 'remediate-findings' }],
    why: 'Kept by D5: the final review’s minor (and new nits) reopen correctness at its spent allowance (ADR-042); the parked nits stay follow-ups.',
  },
  simplification: {
    mechanisms: ['optional-follow-up'],
    why: 'D6: started with optional findings as follow-ups, discovery does not stop to select.',
  },
  polish: {
    mechanisms: ['optional-follow-up'],
    why: 'D6: started with optional findings as follow-ups, discovery does not stop to select.',
  },
  promotion: {
    stops: [{ code: 'final-promotion', answer: 'promote' }],
    why: 'Promotion is always the operator’s (ADR-033).',
  },
};
/** The order the rows happen in. */
const ORDER = [...record.stops.map((s) => `S${s.stop}`), 'promotion'].flatMap((label) =>
  label === 'S9' ? ['simplification', 'polish', label] : [label],
);

/** A remediation's report, collected. */
const COLLECTED = 'Committed and checked.\n\n## Open questions\nnone';
/** What a remediation said while its check matrix still ran (S5, S6). */
const BACKGROUND_PROGRESS = 'The check matrix is still running in the background.';

/** The reviewer asks about the nit policy unless its brief states what happens to nits. */
const NIT_POLICY = /nit-severity findings[^.]*follow-up/i;

it('replays the AQ finalization stop sequence against the staged controller (R-C7)', async () => {
  let offset = 0;
  const fixture = await finalizationFixture({ now: () => new Date(Date.now() + offset) });
  const { state, backend } = fixture;
  let value: Finalization | undefined;
  const cycle = () => finalizationCycle(state, present(value));
  const followUps = () => new Set(cycle().finalizationProgress?.followUps.map((f) => f.id));

  /** The candidate's open findings: situations add them, implementation fixes required ones. */
  const open = new Map<string, ReviewFinding>();
  // The recorded findings name their ids as the golden holds them.
  const finding = (
    f: Pick<ReviewFinding, 'severity' | 'category'> & { readonly id: string },
  ): ReviewFinding => ({
    ...structuredFinding,
    status: 'open',
    title: `${f.severity} ${f.category} finding`,
    id: asReviewFindingId(f.id),
    severity: f.severity,
    ...(f.category ? { category: f.category } : {}),
  });
  /** Fixed findings stay in every later report, resolved, as a reviewer must keep them. */
  const resolved = new Map<string, ReviewFinding>();
  const fix = (f: ReviewFinding) => {
    open.delete(f.id);
    resolved.set(f.id, { ...f, status: 'resolved', disposition: 'Fixed and verified.' });
  };
  const required = (f: ReviewFinding) => !optionalFinding(f) && !followUps().has(f.id);
  let served = 0;
  let current = 'start';
  const observed: { label: string; code: CycleAttentionCode }[] = [];
  /** How many of each row's operator stops have been answered. */
  const answered: Record<string, number> = {};
  const mechanisms: Record<string, Mechanism[]> = {};
  const note = (mechanism: Mechanism, label = current) => {
    mechanisms[label] = [...(mechanisms[label] ?? []), mechanism];
  };
  /** The next recorded stop, when this launch is where it happened. */
  const situation = (step: RecordedStop['step'], stage: string | undefined) => {
    const stop = record.stops[served];
    if (!stop || stop.step !== step || STAGE_OF_STOP[stop.stop] !== stage) return;
    served += 1;
    current = `S${stop.stop}`;
    return stop;
  };
  const stageOf = () => {
    const progress = cycle().finalizationProgress;
    return progress && present(value).stages?.[progress.stageIndex]?.id;
  };
  /** Each worktree's latest review request, or none after an implementation: what a repair redoes. */
  const lastReview = new Map<string, AgentLaunchRequest | undefined>();
  const report = (
    request: AgentLaunchRequest,
    overrides: Parameters<typeof stagedText>[2] = {},
  ) => {
    return stagedText(request, [...resolved.values(), ...open.values()], {
      met: ![...open.values()].some(required),
      ...overrides,
    });
  };

  /** Follow-ups already seen: a new required-category one was parked by D5. */
  const seen = new Set<string>();
  backend.onLaunch = (request) => {
    for (const f of value ? (cycle().finalizationProgress?.followUps ?? []) : []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      if (!optionalFinding(f) && !mechanisms[current]?.includes('nits-parked')) note('nits-parked');
      // An optional idea parked without the operator selecting its stage's batch.
      if (optionalFinding(f) && f.category && !answered[f.category])
        note('optional-follow-up', f.category);
    }
    if (implementsFinalization(request)) {
      if (request.prompt.includes('Review changed the worktree')) note('housekeeping');
      // Every implementation commits its work, the housekeeping one the files left behind.
      commitFile(request.cwd, `work-${backend.launches.length}.txt`, 'work\n');
    }
  };
  backend.repairForRequest = (request) => {
    note('output-repair');
    const review = lastReview.get(request.cwd);
    return review ? { resultText: report(review) } : { resultText: COLLECTED };
  };
  /** The remediation runs whose turns ended on a background task (S5, S6), by row. */
  const backgroundRuns = new Map<string, AgentRunId>();
  backend.replyForRequest = (request): ScriptedReply => {
    if (implementsFinalization(request)) {
      lastReview.set(request.cwd, undefined);
      const stop = situation('remediate', stageOf());
      // S5's turn ended on a background task with its work unfinished; S6's finished it.
      if (stop?.stop !== 5) for (const f of [...open.values()]) if (required(f)) fix(f);
      if (!stop) return { resultText: COLLECTED };
      // As Claude Code reports it: a result while the check matrix runs, then, once its task
      // notification arrives, the report that collects it.
      backgroundRuns.set(current, cycle().currentRunId);
      return {
        resultText: COLLECTED,
        claudeStream: [
          { type: 'system', subtype: 'task_started', task_id: 'matrix' },
          { type: 'result', subtype: 'success', result: BACKGROUND_PROGRESS },
          { type: 'system', subtype: 'task_notification', task_id: 'matrix', status: 'completed' },
          { type: 'result', subtype: 'success', result: COLLECTED },
        ],
      };
    }
    lastReview.set(request.cwd, request);
    const ledger = stagedLedger(request);
    const stage = present(ledger.stages[ledger.progress.stageIndex]);
    const state = ledger.progress.stages[ledger.progress.stageIndex];
    const stop = situation('review', stage.id);
    for (const f of stop?.findings ?? [])
      if (!f.deferred || open.has(f.id)) open.set(f.id, finding(f));
    // Staged only: each discovery reports one optional idea in its own category.
    if (
      (stage.kind === 'simplification' || stage.kind === 'polish') &&
      state?.status !== 'verifying'
    ) {
      const idea = asReviewFindingId(stage.kind === 'simplification' ? 'S-1' : 'P-1');
      open.set(idea, finding({ id: idea, severity: 'minor', category: stage.kind }));
    }
    switch (stop?.kind) {
      case 'report-invalid':
        return {
          resultText:
            stop.issue === 'finding-id-pattern'
              ? report(request).replace('"id":"F-017"', '"id":"AQ-01/F-017"')
              : report(request).replace(
                  'Fixture checks and obligations assessed.',
                  'x'.repeat(20_001),
                ),
        };
      case 'question':
        return {
          resultText: report(request, {
            met: stop.exitGateMet,
            ...(stop.question === 'genuine' || !NIT_POLICY.test(request.prompt)
              ? { questions: 'Which behaviour does the plan intend here?' }
              : {}),
          }),
        };
      case 'worktree-dirty':
        writeFileSync(join(request.cwd, 'review-artifact.txt'), 'left behind\n');
        return { resultText: report(request) };
      case 'step-incomplete':
        return {
          resultText: 'API Error',
          providerFailure: {
            kind: 'quota',
            message: 'You’ve hit your session limit.',
            safeToRetry: true,
            resetsAt: new Date(Date.now() + offset + 30 * 60_000).toISOString(),
          },
        };
      case 'remediation-limit':
        return { resultText: report(request, { met: stop.exitGateMet }) };
      default:
        return { resultText: report(request) };
    }
  };

  const base = stagedInput(fixture.legacyInput);
  const [correctness, ...rest] = base.stages;
  const input: StartFinalizationRequest = {
    ...base,
    stages: [
      {
        ...present(correctness),
        id: asFinalizationStageId('correctness-items'),
        name: 'correctness by work item',
        workItemSourceIds: [asWorkItemSourceId('AQ-01'), asWorkItemSourceId('AQ-02')],
        policy: { ...present(correctness).policy, maxRemediationRounds: 2 },
      },
      {
        ...present(correctness),
        policy: { ...present(correctness).policy, maxRemediationRounds: 3 },
      },
      // D6: the operator chose at the start to keep optional findings as follow-up work.
      ...rest.map((s) =>
        s.kind === 'simplification' || s.kind === 'polish'
          ? { ...s, optionalFindings: 'follow-up' as const }
          : s,
      ),
    ],
  };
  value = await beginFinalization(fixture, input);

  const answer = async (answer: Answer) => {
    const run = present(
      state.context.storage.execution.runs.find(state.workspaceId, cycle().currentRunId),
    );
    const response = await finalizationCommand(
      state,
      present(value),
      answer === 'select-none' ? 'select-stage-findings' : answer === 'promote' ? 'merge' : answer,
      answer === 'resume'
        ? { instructions: 'Operator guidance for the question.' }
        : answer === 'authorize-remediation'
          ? { additionalRounds: 1 }
          : answer === 'remediate-findings'
            ? {
                findingIds: [...open.values()].filter(required).map((f) => f.id),
                rationale: 'Fix these findings.',
                additionalRounds: 1,
              }
            : answer === 'select-none'
              ? { selectedFindingIds: [], rationale: 'Keep them as follow-up work.' }
              : {
                  expectedHeadSha: run.reviewBranchContext?.headSha,
                  expectedTargetSha: run.reviewBranchContext?.targetSha,
                },
    );
    expect(response.statusCode, `${answer}: ${response.body}`).toBe(200);
  };
  for (;;) {
    await waitFor(
      () =>
        ['needs-attention', 'awaiting-merge'].includes(cycle().status) ||
        !!cycle().providerRecovery?.nextRetryAt,
      `the stop after ${current}`,
    );
    const retry = cycle().providerRecovery?.nextRetryAt;
    if (retry && cycle().status === 'running') {
      note('service-retry');
      offset = Date.parse(retry) + 1000 - Date.now();
      await waitFor(() => !cycle().providerRecovery?.nextRetryAt, 'the scheduled retry');
      continue;
    }
    const code = present(cycle().attention).code;
    const stage = stageOf();
    const label =
      code === 'final-promotion'
        ? 'promotion'
        : code === 'stage-batch-selection' && stage
          ? stage
          : current;
    observed.push({ label, code });
    const expected = EXPECTED[label]?.stops?.[answered[label] ?? 0];
    // An unexpected stop fails here, with the sequence so far, rather than hanging.
    expect({ label, code, observed }).toEqual({
      label,
      code: expected?.code,
      observed,
    });
    answered[label] = (answered[label] ?? 0) + 1;
    await answer(present(expected).answer);
    if (code === 'final-promotion') break;
  }

  // What R-G11 left in each journal: the progress as a notice, one turn with the collected report.
  for (const [label, runId] of backgroundRuns) {
    const events = state.context.storage.execution.runEvents.listAfter({
      workspaceId: state.workspaceId,
      runId,
      after: 0,
      limit: 500,
    });
    const turns = events.flatMap((e) => (e.kind === 'turn-completed' ? [e.payload] : []));
    if (
      turns.length === 1 &&
      turns[0]?.resultText === COLLECTED &&
      events.some((e) => e.kind === 'notice' && e.payload.message.endsWith(BACKGROUND_PROGRESS))
    )
      note('background-result-held', label);
  }
  expect(observed).toEqual(
    ORDER.flatMap((label) =>
      (EXPECTED[label]?.stops ?? []).map((stop) => ({ label, code: stop.code })),
    ),
  );
  expect(mechanisms).toEqual(
    Object.fromEntries(
      ORDER.flatMap((label) =>
        EXPECTED[label]?.mechanisms ? [[label, EXPECTED[label].mechanisms]] : [],
      ),
    ),
  );
  // R-C7's done-when: besides the promotion, the operator answers only the genuine question
  // (S4) and the stop D5 keeps (S10: a minor reopening correctness at its spent allowance).
  expect(observed.map((o) => o.label)).toEqual(['S4', 'S10', 'promotion']);
  expect(served).toBe(record.stops.length);
  expect(
    present(
      state.context.storage.execution.finalizations.find(state.workspaceId, present(value).id),
    ).status,
  ).toBe('completed');
});
