/**
 * Every cycle record shape stored today (R-B4b increment 1), as synthetic records in the shape
 * every release before R-B4b wrote: one row per combination of status and the ten fields R-B4b
 * reshapes that the replay corpus stores (`rb4b/survey`, 17 snapshots at 59d0c4b), the ones the
 * code writes but the corpus happens not to hold (a scheduled service retry, an output repair, a
 * pause kept at a stop), every record from before codes the decoders recover, and each way a cycle
 * ends with the audit rows that entered its statuses. Increment 2's migration must map each one to
 * one: what today's readers answer for a row (`cycle-shapes.test.ts`) is what they answer after.
 *
 * Plain JSON, not `WorkCycle`: these are stored rows, whatever shape the domain type has since.
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type StoredCycle = { readonly [key: string]: Json };

export interface ShapeRow {
  readonly name: string;
  readonly record: StoredCycle;
  /** The audit rows that entered the record's statuses, oldest first (what a backfill reads). */
  readonly history: readonly {
    readonly action: string;
    readonly status: string;
    readonly at: string;
  }[];
  /** The review's scope receipt is recorded: a completed independent review's end. */
  readonly scopeReceipt?: true;
}

const ID = {
  cycle: '6a1f0c5e-0000-4000-8000-000000000001',
  workspace: '6a1f0c5e-0000-4000-8000-000000000002',
  project: '6a1f0c5e-0000-4000-8000-000000000003',
  item: '6a1f0c5e-0000-4000-8000-000000000004',
  worktree: '6a1f0c5e-0000-4000-8000-000000000005',
  user: '6a1f0c5e-0000-4000-8000-000000000006',
  run: '6a1f0c5e-0000-4000-8000-000000000007',
  parent: '6a1f0c5e-0000-4000-8000-000000000008',
  definition: '6a1f0c5e-0000-4000-8000-000000000009',
  finalization: '6a1f0c5e-0000-4000-8000-00000000000a',
  plan: '6a1f0c5e-0000-4000-8000-00000000000b',
} as const;
export const SHAPE_IDS = ID;

const T = (minute: number) => new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString();
const PROFILE = { backend: 'claude-code', permissionMode: 'auto' } as const;

const base: StoredCycle = {
  id: ID.cycle,
  workspaceId: ID.workspace,
  projectId: ID.project,
  workItemId: ID.item,
  worktreeId: ID.worktree,
  workItemSourceId: 'AQ-05',
  workItemTitle: 'Next queue improvement',
  createdByUserId: ID.user,
  createdAt: T(0),
  updatedAt: T(30),
  version: 7,
  status: 'running',
  step: 'review',
  policy: { maxNits: 3, maxRemediationRounds: 3, maxRunMinutes: 60 },
  profiles: { design: PROFILE, implement: PROFILE, review: PROFILE, remediate: PROFILE },
  instructions: '',
  currentRunId: ID.run,
  parentRunId: ID.parent,
  runDeadlineAt: T(90),
  remediationRounds: 1,
  stalledReviews: 0,
  reason: 'Starting review.',
};

/** A value of each form the survey found, for each field. */
const FORMS: Record<string, Record<string, Json | undefined>> = {
  attention: { '-': undefined },
  phaseWait: {
    '-': undefined,
    null: null,
    obj: {
      startedAt: T(20),
      blockers: [
        {
          kind: 'dependency',
          message: 'Slice wi/WI-02/domain must be verified.',
          code: 'slice-requirement',
          refs: { sliceId: 'wi/WI-02/domain' },
        },
      ],
    },
  },
  designWait: {
    '-': undefined,
    null: null,
    obj: {
      startedAt: T(21),
      requirements: [{ kind: 'slice', id: 'wi/WI-01/domain', state: 'merged' }],
    },
  },
  stepGuidance: { '-': undefined, 'empty-str': '', str: 'Keep the existing queue format.' },
  housekeepingInstructions: {
    '-': undefined,
    'empty-str': '',
    str: 'Remove the stray notes file.',
  },
  resultContinuations: { '-': undefined, zero: 0, num: 1 },
  outputRepair: {
    '-': undefined,
    null: null,
    obj: {
      attempts: 1,
      sourceRunId: ID.parent,
      code: 'step-incomplete',
      issues: ['No final report.'],
    },
  },
  providerRecovery: {
    '-': undefined,
    null: null,
    obj: {
      attempts: 1,
      sourceRunId: ID.parent,
      failure: { kind: 'capacity', message: 'Provider overloaded.', safeToRetry: true },
      profile: { ...PROFILE, model: 'claude-opus' },
      nextRetryAt: T(40),
    },
  },
  polishRound: { '-': undefined, num: 1 },
  deferredNits: {
    '-': undefined,
    obj: [
      {
        finding: {
          id: 'F-1',
          severity: 'nit',
          status: 'open',
          title: 'Name the constant',
          explanation: 'A bare number.',
          recommendation: 'Name it.',
        },
        sourceRunId: ID.parent,
        headSha: 'a'.repeat(40),
        targetSha: 'b'.repeat(40),
        reason: 'Deferred to the next round.',
        createdAt: T(10),
        createdByUserId: ID.user,
      },
    ],
  },
};
const FIELDS = [
  'attention',
  'phaseWait',
  'designWait',
  'stepGuidance',
  'housekeepingInstructions',
  'resultContinuations',
  'outputRepair',
  'providerRecovery',
  'polishRound',
  'deferredNits',
] as const;

/** A stop each status's records carry when the survey found one. */
const STOPS: Record<string, Json> = {
  'needs-attention': { code: 'step-incomplete', owner: 'operator' },
  'awaiting-merge': { code: 'merge-approval', owner: 'operator' },
};
const REASONS: Record<string, string> = {
  running: 'Starting review.',
  'awaiting-merge': 'Review meets the completion policy. Operator merge approval required.',
  'needs-attention': 'The step did not finish with a complete successful result.',
  paused: 'Automation paused by operator.',
  completed: 'Worktree integrated; cycle complete.',
  stopped: 'Automation stopped by operator. Manual flow is available.',
};
const ENTERED: Record<string, readonly [string, string][]> = {
  running: [['start', 'running']],
  'awaiting-merge': [
    ['start', 'running'],
    ['advance', 'awaiting-merge'],
  ],
  'needs-attention': [
    ['start', 'running'],
    ['advance', 'needs-attention'],
  ],
  paused: [
    ['start', 'running'],
    ['pause', 'paused'],
  ],
  completed: [
    ['start', 'running'],
    ['advance', 'completed'],
  ],
  stopped: [
    ['start', 'running'],
    ['stop', 'stopped'],
  ],
};
const history = (entered: readonly (readonly [string, string])[]) =>
  entered.map(([action, status], index) => ({ action, status, at: T(index * 5) }));

function record(
  status: string,
  forms: Record<string, string>,
  extra: StoredCycle = {},
): StoredCycle {
  const fields: Record<string, Json> = {};
  for (const field of FIELDS) {
    const form = forms[field] ?? '-';
    const value = field === 'attention' && form === 'obj' ? STOPS[status] : FORMS[field]![form];
    if (value !== undefined) fields[field] = value;
  }
  return { ...base, status, reason: REASONS[status]!, ...fields, ...extra };
}

/** The 41 stored combinations: status, then each field's form in `FIELDS` order. */
const SURVEYED: readonly (readonly string[])[] = [
  ['awaiting-merge', '-', 'obj', 'null', '-', 'empty-str', 'zero', '-', 'null', '-', '-'],
  ['awaiting-merge', 'obj', '-', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  [
    'awaiting-merge',
    'obj',
    '-',
    'null',
    'empty-str',
    'empty-str',
    'zero',
    'null',
    'null',
    '-',
    '-',
  ],
  ['awaiting-merge', 'obj', 'null', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  [
    'awaiting-merge',
    'obj',
    'null',
    'null',
    'empty-str',
    'empty-str',
    'zero',
    'null',
    'null',
    '-',
    '-',
  ],
  ['awaiting-merge', 'obj', 'obj', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['completed', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-'],
  ['completed', '-', '-', '-', '-', 'empty-str', '-', '-', '-', '-', '-'],
  ['completed', '-', '-', '-', '-', 'empty-str', 'zero', '-', '-', '-', '-'],
  ['completed', '-', '-', '-', '-', 'empty-str', 'zero', '-', '-', 'num', 'obj'],
  ['completed', '-', '-', 'null', '-', 'empty-str', 'zero', '-', '-', '-', '-'],
  ['completed', '-', '-', 'null', '-', 'empty-str', 'zero', '-', 'null', '-', '-'],
  ['completed', '-', '-', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['completed', '-', '-', 'null', 'empty-str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['completed', '-', '-', 'null', 'str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['completed', '-', 'null', '-', '-', '-', '-', '-', '-', '-', '-'],
  ['completed', '-', 'null', '-', '-', 'empty-str', 'zero', '-', '-', '-', '-'],
  ['completed', '-', 'null', 'null', '-', 'empty-str', 'zero', '-', '-', '-', '-'],
  ['completed', '-', 'null', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['completed', '-', 'null', 'null', 'empty-str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['needs-attention', '-', 'null', 'null', '-', '-', 'zero', '-', '-', '-', '-'],
  ['needs-attention', 'obj', '-', '-', '-', '-', '-', '-', '-', '-', '-'],
  [
    'needs-attention',
    'obj',
    '-',
    'null',
    'empty-str',
    'empty-str',
    'zero',
    'null',
    'null',
    '-',
    '-',
  ],
  ['needs-attention', 'obj', 'null', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['needs-attention', 'obj', 'null', 'null', '-', 'str', 'zero', 'null', 'null', '-', '-'],
  [
    'needs-attention',
    'obj',
    'null',
    'null',
    'empty-str',
    'empty-str',
    'zero',
    'null',
    'null',
    '-',
    '-',
  ],
  ['needs-attention', 'obj', 'null', 'null', 'str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['paused', '-', '-', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['paused', '-', '-', 'null', 'str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['paused', '-', 'null', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['paused', '-', 'null', 'null', '-', 'str', 'zero', 'null', 'null', '-', '-'],
  ['paused', '-', 'null', 'null', 'str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['running', '-', '-', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['running', '-', '-', 'null', '-', 'str', 'zero', 'null', 'null', '-', '-'],
  ['running', '-', '-', 'null', 'empty-str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['running', '-', '-', 'null', 'str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['running', '-', 'null', 'null', '-', 'empty-str', 'zero', '-', 'null', '-', '-'],
  ['running', '-', 'null', 'null', '-', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['running', '-', 'null', 'null', '-', 'str', 'zero', 'null', 'null', '-', '-'],
  ['running', '-', 'null', 'null', 'str', 'empty-str', 'zero', 'null', 'null', '-', '-'],
  ['stopped', '-', '-', 'null', '-', 'empty-str', 'zero', '-', '-', '-', '-'],
];

/** The finalization record of 2026-09-13, the one that holds the retired fields. */
const FINALIZATION: StoredCycle = {
  finalizationId: ID.finalization,
  planVersionId: ID.plan,
  workItemSourceId: 'Finalization',
  workItemTitle: 'Plan finalization',
  polishPhase: 'final-review',
};
const withoutItem = (cycle: StoredCycle): StoredCycle => {
  const { workItemId: _item, ...rest } = cycle;
  return rest;
};

function surveyed(): ShapeRow[] {
  return SURVEYED.map((combination) => {
    const [status, ...forms] = combination as [string, ...string[]];
    const named = Object.fromEntries(FIELDS.map((field, index) => [field, forms[index]!]));
    const finalization = named.polishRound !== '-';
    const stored = record(status, named);
    return {
      name: `stored: ${status} ${forms.join(' ')}`,
      record: finalization ? withoutItem({ ...stored, ...FINALIZATION }) : stored,
      history: history(ENTERED[status]!),
    };
  });
}

/** Records from before codes: every rule the decoders recover a code by (R-A3). */
const LEGACY_REASONS = [
  'Daemon restarted. Inspect the interrupted step.',
  'Remediation limit reached. Review needs your input.',
  'Remediation limit reached.',
  'Two remediation rounds removed no findings.',
  'Implementation needs your input.',
  'Review needs your input.',
  'Workflow report needs correction.',
  'Workflow report and Open questions disagree.',
  'Operator decision required.',
  'Operator input required.',
  'Finalization needs your input before promotion.',
  'Design has open questions.',
  'Design needs an operator decision.',
  'Design identified a planning conflict.',
  'Design investigation finished. Review the evidence and answers.',
  'Scope review requires recovery: the gate is not met.',
  'Scope review has open questions.',
  'The step did not finish with a complete successful result.',
  'Step time limit reached.',
  'Integration refresh limit reached.',
  'Something an older release said.',
];
const WORKFLOW = { reassessments: 0, questions: [] } as const;

function uncoded(): ShapeRow[] {
  const stops = LEGACY_REASONS.map((reason) => ({
    name: `uncoded: needs-attention "${reason}"`,
    record: { ...record('needs-attention', {}), reason },
    history: history(ENTERED['needs-attention']!),
  }));
  const gates: ShapeRow[] = [
    {
      name: 'uncoded: awaiting-merge while the workflow waits',
      record: {
        ...record('awaiting-merge', {}),
        workflow: { ...WORKFLOW, waiting: 'Waiting for the security review.' },
      },
      history: history(ENTERED['awaiting-merge']!),
    },
    {
      name: 'uncoded: awaiting-merge with further controller reviews held',
      record: {
        ...record('awaiting-merge', {}),
        reason: 'Technical review finished. Further controller reviews are held by the roadmap.',
      },
      history: history(ENTERED['awaiting-merge']!),
    },
    {
      name: 'uncoded: awaiting-merge at an independent review',
      record: {
        ...record('awaiting-merge', { phaseWait: 'obj' }),
        reason: 'Slice wi/WI-02/domain must be verified.',
        executionScope: {
          kind: 'slice-verification',
          definitionId: ID.definition,
          bindingRevision: 1,
          sourceId: 'wi/WI-02/domain',
        },
      },
      history: history(ENTERED['awaiting-merge']!),
    },
    {
      name: 'uncoded: awaiting-merge at a finalization',
      record: withoutItem({ ...record('awaiting-merge', {}), ...FINALIZATION }),
      history: history(ENTERED['awaiting-merge']!),
    },
    {
      name: 'uncoded: awaiting-merge',
      record: record('awaiting-merge', {}),
      history: history(ENTERED['awaiting-merge']!),
    },
  ];
  // Phase blockers stored before their codes, one per rule `phaseBlockerCode` recovers them by,
  // and a resource blocker stored before its key.
  const blockers: Json[] = [
    { kind: 'authorization', message: 'Resource controlled-native-test-host needs approval.' },
    { kind: 'authorization', message: 'Resource gpu-host has no managed execution adapter.' },
    { kind: 'evidence', message: 'Checkpoint C-1 must pass.' },
    { kind: 'evidence', message: 'Required slice wi/WI-01/domain has not merged.' },
    { kind: 'evidence', message: 'Required slice wi/WI-01/domain has not been verified.' },
    { kind: 'evidence', message: 'Staged approval needs its prerequisite.' },
    { kind: 'dependency', message: 'Slice wi/WI-02/domain must be verified.' },
    { kind: 'resource', message: 'Waiting for local-development: 1/1 reservations occupied.' },
    { kind: 'review', message: 'Evidence profile needs reviewers.' },
  ];
  const waits: ShapeRow = {
    name: 'uncoded: phase blockers',
    record: { ...record('running', {}), phaseWait: { startedAt: T(20), blockers } },
    history: history(ENTERED.running!),
  };
  return [...stops, ...gates, waits];
}

/** Shapes the code writes that the corpus holds none of. */
function written(): ShapeRow[] {
  const row = (
    name: string,
    status: string,
    forms: Record<string, string>,
    extra: StoredCycle = {},
  ) => ({
    name: `written: ${name}`,
    record: record(status, forms, extra),
    history: history(ENTERED[status]!),
  });
  return [
    row('a scheduled service retry', 'running', {
      providerRecovery: 'obj',
      resultContinuations: 'zero',
    }),
    row('a scheduled service retry beside a phase wait', 'running', {
      providerRecovery: 'obj',
      phaseWait: 'obj',
    }),
    row('an output repair', 'running', {
      outputRepair: 'obj',
      housekeepingInstructions: 'empty-str',
    }),
    row('a completion continuation', 'running', {
      resultContinuations: 'num',
      stepGuidance: 'str',
    }),
    row('a paused service retry', 'paused', { providerRecovery: 'obj' }),
    row(
      'a design dependency stop keeping its wait',
      'needs-attention',
      { designWait: 'obj' },
      {
        attention: { code: 'design-dependency-unsupported', owner: 'operator' },
        step: 'design',
      },
    ),
    row(
      'a stop claimed by automation',
      'needs-attention',
      {},
      {
        attention: {
          code: 'scope-review-recovery',
          owner: 'controller',
          claim: 'scope-recovery',
          refs: { entryId: 'wi/WI-01/domain' },
        },
      },
    ),
    row(
      'a stop after output repairs',
      'needs-attention',
      {},
      {
        attention: { code: 'step-incomplete', owner: 'operator', repairAttempts: 2 },
      },
    ),
    row(
      'a merge gate with its unmet requirements',
      'awaiting-merge',
      { phaseWait: 'obj' },
      {
        attention: {
          code: 'merge-requirements',
          owner: 'operator',
          detail: 'Slice wi/WI-02/domain must be verified.',
        },
      },
    ),
    row('an operator stop beside a phase wait', 'needs-attention', { phaseWait: 'obj' }),
    row(
      'a service stop whose retry was never scheduled',
      'needs-attention',
      {},
      {
        attention: { code: 'service-retries-exhausted', owner: 'operator' },
        providerRecovery: {
          attempts: 3,
          sourceRunId: ID.parent,
          failure: { kind: 'capacity', message: 'Provider overloaded.', safeToRetry: true },
          profile: { ...PROFILE, model: 'claude-opus' },
        },
      },
    ),
    row(
      'a merge gate the controller waits at',
      'awaiting-merge',
      {},
      {
        attention: { code: 'controller-wait', owner: 'controller' },
        workflow: { ...WORKFLOW, waiting: 'Waiting for the security review.' },
      },
    ),
    {
      // A code whose plain resume is redirected, so the kept stop shows in the actions too.
      ...row(
        'a pause kept at a stop',
        'paused',
        { designWait: 'obj' },
        {
          attention: { code: 'design-open-questions', owner: 'operator' },
          step: 'design',
        },
      ),
      history: history([
        ['start', 'running'],
        ['advance', 'needs-attention'],
        ['pause', 'paused'],
      ]),
    },
  ];
}

/**
 * The stops the corpus stores, as stored (increment 1 review, LOW-1): its merge gates beside a
 * phase wait are `merge-requirements` with their detail, most of them claimed by the roadmap's
 * merge; its commonest stop carries a claim and a detail; and its one `awaiting-merge` record from
 * before codes (2f1ab211) is a slice the workflow waits on, beside a blocker stored without a code.
 * Then the order of the `awaiting-merge` derivations (NIT-5: two signals, the earlier wins), and a
 * stop whose code changed while its status stayed (LOW-3).
 */
function stops(): ShapeRow[] {
  const SCOPE = {
    definitionId: ID.definition,
    bindingRevision: 1,
    sourceId: 'wi/WI-02/domain',
  };
  const held = 'Technical review finished. Further controller reviews are held by the roadmap.';
  const waiting = { ...WORKFLOW, waiting: 'Waiting for the security review.' };
  const row = (name: string, stored: StoredCycle, entered?: [string, string][]): ShapeRow => ({
    name: `stops: ${name}`,
    record: stored,
    history: history(entered ?? ENTERED[stored.status as string]!),
  });
  return [
    row(
      'a merge gate the roadmap claims, with its unmet requirements, beside a phase wait',
      record(
        'awaiting-merge',
        { phaseWait: 'obj' },
        {
          attention: {
            code: 'merge-requirements',
            owner: 'controller',
            claim: 'roadmap-merge',
            detail: 'Slice wi/WI-02/domain must be verified.',
          },
        },
      ),
    ),
    row(
      'an operator stop automation claims, with its detail',
      record(
        'needs-attention',
        {},
        {
          attention: {
            code: 'scope-review-recovery',
            owner: 'controller',
            claim: 'prerequisite-work',
            detail: 'Waiting for wi/WI-01/domain to merge.',
          },
        },
      ),
    ),
    row('an awaiting-merge slice from before codes that the workflow waits on', {
      ...record('awaiting-merge', {}),
      reason: 'Slice wi/WI-02/domain must be verified.',
      workflow: { ...WORKFLOW, waiting: 'Waiting for the checkpoint review.' },
      executionScope: { kind: 'slice', ...SCOPE },
      phaseWait: {
        startedAt: T(20),
        blockers: [{ kind: 'dependency', message: 'Slice wi/WI-02/domain must be verified.' }],
      },
    }),
    row('from before codes, the workflow waiting and further reviews held', {
      ...record('awaiting-merge', {}),
      reason: held,
      workflow: waiting,
    }),
    row('from before codes, further reviews held at an independent review', {
      ...record('awaiting-merge', {}),
      reason: held,
      executionScope: { kind: 'slice-verification', ...SCOPE },
    }),
    row(
      'from before codes, a finalization the workflow waits on',
      withoutItem({ ...record('awaiting-merge', {}), ...FINALIZATION, workflow: waiting }),
    ),
    row('a stop whose code changed while its status stayed', record('needs-attention', {}), [
      ['start', 'running'],
      ['advance', 'needs-attention'],
      ['investigation-started', 'needs-attention'],
      ['advance', 'needs-attention'],
    ]),
  ];
}

/** Each way a cycle ends, by the audit action that entered its end (R-B4 decision 7). */
function ended(): ShapeRow[] {
  const end = (
    name: string,
    status: string,
    entered: [string, string][],
    extra: StoredCycle = {},
  ) => ({
    name: `ended: ${name}`,
    record: { ...record(status, { designWait: 'null' }), ...extra },
    history: history(entered),
  });
  return [
    {
      ...end('stopped by the operator, its waits kept', 'stopped', [
        ['start', 'running'],
        ['advance', 'needs-attention'],
        ['stop', 'stopped'],
      ]),
      record: record('stopped', { phaseWait: 'obj', designWait: 'obj' }),
    },
    end('stopped by the operator', 'stopped', [
      ['start', 'running'],
      ['advance', 'needs-attention'],
      ['stop', 'stopped'],
    ]),
    end(
      'wound down with its roadmap',
      'stopped',
      [
        ['start', 'running'],
        ['advance', 'awaiting-merge'],
        ['roadmap-wound-down', 'stopped'],
      ],
      { reason: 'Roadmap stopped. Manual flow is available.' },
    ),
    end(
      'retired by an amendment',
      'stopped',
      [
        ['start', 'running'],
        ['advance', 'needs-attention'],
        ['amendment-retired', 'stopped'],
      ],
      { reason: 'This attempt was retired by a planning amendment.' },
    ),
    end('integrated', 'completed', [
      ['start', 'running'],
      ['advance', 'awaiting-merge'],
      ['advance', 'completed'],
    ]),
    end(
      'merged by the operator, before R-B4',
      'completed',
      [
        ['start', 'running'],
        ['advance', 'awaiting-merge'],
        ['advance', 'completed'],
      ],
      { reason: 'Worktree merged by operator; cycle complete.' },
    ),
    {
      ...end(
        'its independent review recorded',
        'completed',
        [
          ['start', 'running'],
          ['advance', 'awaiting-merge'],
          ['advance', 'completed'],
        ],
        {
          reason: 'Independent scope evidence recorded; review cycle complete.',
          executionScope: {
            kind: 'slice-verification',
            definitionId: ID.definition,
            bindingRevision: 1,
            sourceId: 'wi/WI-02/domain',
          },
        },
      ),
      scopeReceipt: true,
    },
    {
      // Review again reopens only an independent review (`decideReviewAgain`, NIT-3).
      ...end(
        'its independent review reviewed again, and recorded again',
        'completed',
        [
          ['start', 'running'],
          ['advance', 'completed'],
          ['review-again', 'running'],
          ['advance', 'completed'],
          // A field-only write after the end keeps its status (no new end).
          ['checkpoint-completed', 'completed'],
        ],
        {
          reason: 'Independent scope evidence recorded; review cycle complete.',
          executionScope: {
            kind: 'parent-acceptance',
            definitionId: ID.definition,
            bindingRevision: 1,
            sourceId: 'wi/WI-02',
          },
        },
      ),
      scopeReceipt: true,
    },
  ];
}

export function cycleShapes(): readonly ShapeRow[] {
  return [...surveyed(), ...written(), ...uncoded(), ...stops(), ...ended()];
}
