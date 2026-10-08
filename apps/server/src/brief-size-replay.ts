import { basename, dirname } from 'node:path';
import {
  type AgentRun,
  type AgentRunId,
  type AgentRunRole,
  asAgentRunId,
  mapCapabilities,
  truncateUtf8Bytes,
  type WorkItem,
  type WorkspaceId,
} from '@craftingtable/domain';
import { type CraftingTableStorage, openDatabase } from '@craftingtable/storage';
import {
  type BriefDirectory,
  type BriefInput,
  type BriefPlanDocument,
  type BriefRecord,
  composeBrief,
  briefRules,
  RULES_FILE,
  RUN_RECORDS,
  SUPPLIED_DIRECTORIES,
} from './services/brief.js';
import { resolveScope, scopeNeedsKata } from './services/execution-scope.js';
import { latestReviewReport } from './services/run-handoff.js';
import { STEP_RULES } from './services/step-rules.js';
import { WORKFLOW_OBLIGATIONS_FILE, workflowRules } from './services/workflow-policy.js';

/**
 * Measures stored briefs against the same runs' briefs rebuilt by today's `composeBrief` (R-G6,
 * G6-5), over a snapshot copy:
 *
 *   pnpm controller:replay <snapshot.sqlite> --brief-sizes [--since <ISO date>] [--json <file>]
 *
 * "Before" is each run's stored brief (`agent_runs.brief`). "After" is a rebuild of that run's
 * brief from its own launch inputs. The snapshot keeps the inputs a launch reads from storage
 * (the parent's final message and review report, the worktree's scope and its map), and the
 * stored brief keeps the ones composed at launch from state the snapshot no longer holds (the
 * controller's step rules, the operator's words, paths, the handoff's warnings, the build
 * environment). So the replay parses each stored brief into those inputs, takes the rest from
 * the snapshot, and calls the new code: `composeBrief`, the role modules and `workflowRules`.
 * The step rules lose exactly the clauses R-G6 moved into the role modules or into files.
 *
 * Two inputs the replay cannot observe are taken at their largest: every worktree builds with
 * Cargo (the CARGO_TARGET_DIR paragraph is always given) and no link has expired (run
 * directories are live data, never read here). The goal share counts the section headed
 * "Objective and exit gate" before and "Goal and acceptance" after.
 */

export interface BriefSize {
  readonly runId: string;
  readonly role: string;
  readonly before: number;
  readonly after: number;
  readonly goalBefore: number;
  readonly goalAfter: number;
  /** The rules file the rebuilt brief names, which the agent reads beside it. */
  readonly rulesAfter: number;
}

export interface BriefSizeReport {
  readonly since: string;
  readonly runs: readonly BriefSize[];
  /** Runs whose stored brief could not be parsed, with why; they are left out of the medians. */
  readonly skipped: readonly { readonly runId: string; readonly reason: string }[];
  /** The rebuilt briefs' bytes per section heading, summed over all runs. */
  readonly sectionsAfter: Readonly<Record<string, number>>;
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** The section that starts at `## <heading>` and ends at the next `## ` heading, or ''. */
function sectionBytes(brief: string, heading: string): number {
  const start = brief.indexOf(`\n## ${heading}`);
  if (start < 0) return 0;
  const end = brief.indexOf('\n## ', start + 1);
  return bytes(brief.slice(start, end < 0 ? undefined : end));
}

/** The text between a heading and the first of the later headings found after it. */
function between(text: string, start: string, ends: readonly string[]): string | undefined {
  const from = text.indexOf(start);
  if (from < 0) return undefined;
  const body = from + start.length;
  const to = Math.min(
    ...ends.map((end) => text.indexOf(end, body)).filter((index) => index >= 0),
    text.length,
  );
  return text.slice(body, to);
}

/** The old brief's headings after the parent's sections, in their order. */
const LATER_HEADINGS = [
  '\n\n## Step rules (from the controller)\n\n',
  '\n\n## Operator instructions\n\n',
  '\n\n## Operator guidance for this step\n\n',
  '\n\n## Continue interrupted verification on the pinned review baseline\n\n',
  '\n\n## Correct the rejected review report\n\n',
];
/** Where the old trailer began: the pinned environment, a check-only section, the baseline. */
const TRAILERS = [
  '\n\nPinned dependency environment: ',
  '\n\nRepository checks: this run has no pinned dependency environment',
  '\n\nAdopted repository checks (version',
  '\n\nController-prepared historical baseline (characterization only):',
];

/** The clauses R-G6 moved out of the step rules: into the role modules, or gone. */
const MOVED_CLAUSES: readonly (string | RegExp)[] = [
  '\n\nEnd with exactly one section headed ## Open questions. Its entire body must be none when there are no unresolved questions. Otherwise list the questions for the operator.',
  ' Include exactly one ## Open questions section containing only none if no input is needed, otherwise list questions. Put it BEFORE ## Review report and the structured report; keep the final VERDICT line last.',
  '\n\nIf questions remain or checks fail, explain them and end with ## Resolution status followed by blocked. Only when every conflict is resolved, intended changes are staged, and checks pass, end with ## Resolution status followed by ready. A successful process exit alone is not approval.',
  /\n\nKeep the normal craftingtable-review JSON report and final VERDICT line\. Add a finalization object: [\s\S]*?all reported obligations met\./,
  '\n\nEvery final message must contain exactly one ## Open questions section, containing only none if no operator input is required. Put it before ## Review report and the structured block. Genuine questions always stop progression.',
  /\n\nEnd your final message with one craftingtable-investigation block:[\s\S]*?Your final message is the artifact; do not write report files\./,
];

type ActiveReview = Parameters<typeof workflowRules>[1];

/** The workflow paragraph, as the new code writes it, from the old one's data. */
function migrateWorkflow(rules: string): {
  readonly rules: string;
  readonly checkpointId?: string;
  readonly present: boolean;
} {
  const start = rules.indexOf('Controller workflow contract:');
  if (start < 0) return { rules, present: false };
  const obligations =
    /Current controller obligations \(required states are not successful evidence\): (.*)\n?/.exec(
      rules.slice(start),
    );
  if (!obligations) return { rules, present: false };
  const context = JSON.parse(obligations[1]!) as {
    checkpoints: { id: string; accepted: boolean }[];
  };
  const afterObligations = start + obligations.index + obligations[0].length;
  // The separate review's paragraph is the next line, if there is one.
  const next = rules.indexOf('\n\n', afterObligations);
  const activeText = rules.slice(afterObligations, next < 0 ? undefined : next);
  const active = parseActive(activeText);
  const end = active ? (next < 0 ? rules.length : next) : afterObligations;
  return {
    rules: rules.slice(0, start) + workflowRules(context.checkpoints, active) + rules.slice(end),
    ...(active?.kind === 'checkpoint' && active.checkpointId
      ? { checkpointId: active.checkpointId }
      : {}),
    present: true,
  };
}

function parseActive(text: string): ActiveReview | undefined {
  const head =
    /^This is a separate (reassessment|security|checkpoint) review\. Source run: (\S+)\. Responsibilities: (.*?)\. Read the full lineage/.exec(
      text,
    );
  if (!head) return undefined;
  const checkpoint = /Independently assess checkpoint (\S+?)\./.exec(text)?.[1];
  const claims = /Required claims: (\[.*?\])\. Required cases: (\[.*?\])\./.exec(text);
  return {
    kind: head[1] as NonNullable<ActiveReview>['kind'],
    sourceRunId: head[2]!,
    roles: head[3] ? head[3].split(', ') : [],
    ...(checkpoint ? { checkpointId: checkpoint } : {}),
    requirements: claims ? (JSON.parse(claims[1]!) as string[]) : [],
    caseIds: claims ? (JSON.parse(claims[2]!) as string[]) : [],
    contextDigest: '',
  };
}

/** Step rules R-G6 reworded, with the text the launch now gives instead. */
const REWORDED_CLAUSES: readonly (readonly [RegExp, string])[] = [
  [
    /Read craftingtable-scope-repair\.json in the supplied plan documents\.[\s\S]*?Commit intended changes; do not merge\./,
    STEP_RULES.scopeRepair,
  ],
  [
    /Keep verification commands owned by the agent session\.[^\n]*?before emitting the final outcome\./,
    STEP_RULES.detach,
  ],
  [
    /This run is one step of an operator-authorized automated cycle\. Do not merge\. Complete this step and provide a final message; the controller handles the next step\./,
    STEP_RULES.automated,
  ],
];

function migrateStepRules(rules: string) {
  let migrated = rules;
  for (const clause of MOVED_CLAUSES)
    migrated =
      typeof clause === 'string' ? migrated.split(clause).join('') : migrated.replace(clause, '');
  for (const [old, now] of REWORDED_CLAUSES) migrated = migrated.replace(old, now);
  const workflow = migrateWorkflow(migrated);
  const stage =
    /Staged finalization: .*? \((correctness|conformance|simplification|polish|final-review)\)/.exec(
      rules,
    );
  const stageId = /Add a finalization object: \{"stageId":"([^"]*)","fullChecks":(true|false)/.exec(
    rules,
  );
  return {
    rules: workflow.rules,
    workflow: workflow.present
      ? workflow.checkpointId
        ? { checkpointId: workflow.checkpointId }
        : {}
      : undefined,
    finalizationStage:
      stage && stageId ? { id: stageId[1]!, fullChecks: stageId[2] === 'true' } : undefined,
  };
}

/** The old pinned trailer's data. */
function parsePinned(trailer: string): NonNullable<BriefInput['environment']>['pinned'] {
  const manifestPath = /^Pinned dependency environment: (.*)$/m.exec(trailer)?.[1];
  const bin = /Use the controller Cargo launcher (\S+)\/cargo /.exec(trailer)?.[1];
  const policy = /^Verification policy: ([^.]+)\. (.*)$/m.exec(trailer);
  if (!manifestPath || !bin || !policy) throw new Error('unrecognized pinned environment');
  const upstream = [
    ...trailer.matchAll(
      /^- (\S+): (current pin|historical development source) ([0-9a-f]+)(?: \(moves to the current pin at (\S+?)(?:, declared by operator record (\S+?)|, declared in the map)\))?$/gm,
    ),
  ].map((match) => ({
    alias: match[1]!,
    purpose: match[2] === 'current pin' ? 'current-upstream' : 'historical',
    commitSha: match[3]!,
    ...(match[4]
      ? { transition: { slice: match[4], ...(match[5] ? { recordId: match[5] } : {}) } }
      : {}),
  }));
  const declared = between(trailer, '\n', ['Local CI: ']) ?? '';
  const checks = declared.indexOf('Adopted repository checks (version');
  return {
    manifestPath,
    binDirectory: bin,
    ...(() => {
      const approval = /Managed native verification is approved for this run \(([^)]*)\)/.exec(
        trailer,
      )?.[1];
      return approval ? { nativeApprovalId: approval } : {};
    })(),
    verification: { mode: policy[1]!, reason: policy[2]! },
    dependencies: upstream,
    adoptedChecks:
      trailer.includes('The adopted checks below are required') ||
      trailer.includes(', with the adopted checks below'),
    declaredChecks: checks < 0 ? '' : declared.slice(checks),
    ...(() => {
      const image = /Local CI: configured with image (\S+)\. /.exec(trailer)?.[1];
      return image ? { localCiImage: image } : {};
    })(),
    kata: false,
  };
}

function parseHistorical(trailer: string): NonNullable<BriefInput['environment']>['historical'] {
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(trailer)?.[1] ?? '';
  return {
    manifestPath: field('Manifest'),
    workspacePath: field('Historical workspace'),
    launcher: field('Historical Cargo'),
    receiptPath: field('Command receipts'),
  };
}

const lines = (text: string | undefined, prefix = '- ') =>
  (text ?? '')
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));

/** The dependency lines `- ID: title (status)`. */
function dependencies(text: string | undefined) {
  return lines(text).flatMap((line) => {
    const match = /^(\S+): (.*) \(([^)]*)\)$/.exec(line);
    return match
      ? [{ sourceId: match[1]!, title: match[2]!, status: match[3] as WorkItem['status'] }]
      : [];
  });
}

/** The stored source definition: its JSON, or its text when the brief truncated it. */
function sourceFields(text: string | undefined): BriefInput['workItem']['sourceFields'] {
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as BriefInput['workItem']['sourceFields'];
  } catch {
    return text;
  }
}

interface RunRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly role: string;
  readonly brief: string;
  readonly worktree_id: string;
  readonly work_item_id: string | null;
  readonly parent_run_id: string | null;
}

/** Rebuilds one run's brief with today's code, from its stored brief and the snapshot. */
export function rebuildBrief(storage: CraftingTableStorage, row: RunRow): string {
  return composeBrief(rebuildInput(storage, row));
}

/** The brief input a launch of this run would compose today, with its rules file named. */
function rebuildInput(storage: CraftingTableStorage, row: RunRow): BriefInput {
  const stored = row.brief;
  const role = row.role as AgentRunRole;
  const workspaceId = row.workspace_id as WorkspaceId;
  const header = /^# (Work item (.*?)|Plan finalization): (.*)$/m.exec(stored);
  const project = /^Project: (.*)$/m.exec(stored)?.[1];
  if (!header || project === undefined) throw new Error('no header');
  const planFinalization = header[1] === 'Plan finalization';

  // The work item as the plan writes it, and the scope, as the stored brief gave them.
  const objective = between(stored, '\n## Objective and exit gate\n\n', ['\n## ']) ?? '';
  const exitGate = /^Exit gate: (.*)$/m.exec(objective)?.[1] ?? '';
  const risk = /^Risk: (.*)$/m.exec(objective)?.[1] ?? '';
  const phase = /^Phase: (.*)$/m.exec(objective)?.[1];
  const areas = /^Primary areas: (.*)$/m.exec(objective)?.[1] ?? 'unspecified';
  const source = between(
    stored,
    '## Source definition\n\nEvery field of this work item as written in the plan:\n\n```json\n',
    ['\n```'],
  );
  const scopeText = between(stored, '\n## Controller-owned execution scope\n\n', ['\n## ']);
  let executionScope: BriefInput['executionScope'];
  let parentExitGate = exitGate;
  let parentSourceId = header[2] ?? '';
  let kata = false;
  let architectureDecisions = false;
  const tree = storage.execution.worktrees.find(workspaceId, row.worktree_id as never);
  if (scopeText !== undefined) {
    const identity = tree?.executionScope;
    if (!identity) throw new Error('scoped brief without a scoped worktree');
    const gate = /The parent exit gate remains: ([\s\S]*?)\. Do not implement excluded work/.exec(
      scopeText,
    );
    parentExitGate = gate?.[1] ?? '';
    const scope = /^Scope: (.*)$/m.exec(scopeText)?.[1] ?? '';
    const exclusions = between(scopeText, '\nExclusions:\n', ['\n{', '\nEvidence obligations:']);
    const obligations = between(scopeText, '\nEvidence obligations:\n', ['\nAssigned cases:']);
    const cases = /^Assigned cases: (.*)$/m.exec(scopeText)?.[1] ?? 'none';
    const owners = between(scopeText, 'The required slices:\n', ['\n\n']);
    executionScope = {
      identity,
      title: header[3]!,
      scope,
      excludes: lines(exclusions).filter((line) => line !== 'none'),
      requirements: lines(obligations),
      cases: cases === 'none' ? [] : cases.split(', '),
      ...(owners
        ? {
            owningSlices: lines(owners).map((line) => {
              const [id, ...rest] = line.split(': ');
              return { id: id!, scope: rest.join(': '), excludes: [] };
            }),
          }
        : {}),
    };
    try {
      const resolved = resolveScope(storage, workspaceId, tree.workItemId!, identity);
      parentSourceId = resolved.parent.id;
      kata = scopeNeedsKata(resolved);
      architectureDecisions =
        mapCapabilities(resolved.definition.source).architectureDecisions.length > 0;
    } catch {
      /* A scope since retired: no Kata, no architecture checkpoints, the stored parent id. */
      parentSourceId = identity.sourceId.split('/').slice(0, -1).join('/') || identity.sourceId;
    }
  }

  // Where the run was.
  const working = between(stored, '\n## Working environment\n\n', ['\n## ']) ?? '';
  const where = /at `(.*?)` on branch `(.*?)`,\ncreated from `(.*?)` at `(.*?)`\./.exec(working);
  if (!where) throw new Error('no working environment');
  const integration = /^Integration destination: (.*?)\. Only the daemon/m.exec(working)?.[1];
  const baseline = /^Review baseline: item commit (\S+); integration branch (\S+) at (\S+)\./m.exec(
    working,
  );
  const temporary = between(stored, '\n## Temporary files\n', ['\n## ']);
  const temporaryDirectory =
    temporary && /TMPDIR, TMP, and TEMP point to (\S+)\. /.exec(temporary)?.[1];
  const buildCache =
    temporary &&
    /CARGO_TARGET_DIR points to (\S+), this worktree’s build cache/.exec(temporary)?.[1];

  // The files.
  const documents = between(stored, '\n## Plan documents\n\n', ['\n## ']) ?? '';
  const planDocuments: BriefPlanDocument[] = [];
  const records: BriefRecord[] = [];
  const directories = new Map<string, string[]>();
  let planDirectory: string | undefined;
  for (const line of lines(documents)) {
    const match = /^(\S+): `(.*)`$/.exec(line);
    if (!match) continue;
    const [, documentRole, path] = match as unknown as [string, string, string];
    const directory = basename(dirname(path));
    if (directory === 'plan') {
      planDirectory = dirname(path);
      const name = basename(path) as keyof typeof RUN_RECORDS;
      if (name in RUN_RECORDS) records.push({ path, about: RUN_RECORDS[name] });
      else planDocuments.push({ filename: basename(path), role: documentRole, path });
    } else
      directories.set(dirname(path), [...(directories.get(dirname(path)) ?? []), basename(path)]);
  }
  const supplied: BriefDirectory[] = [...directories].map(([path, files]) => {
    const name = basename(path);
    const counted = (prefix: string) => files.filter((file) => file.startsWith(prefix)).length;
    return {
      path,
      ...(name === 'decision-preparation'
        ? SUPPLIED_DIRECTORIES.decisionPreparation(counted('source-'))
        : name === 'design-recovery'
          ? SUPPLIED_DIRECTORIES.designRecovery(counted('source-'), counted('operator-'))
          : SUPPLIED_DIRECTORIES.investigation(files)),
    };
  });

  // The parent: its message and report from the snapshot, its handoff paths from the brief.
  let parentRun: BriefInput['parentRun'];
  if (row.parent_run_id) {
    const parent = storage.execution.runs.find(workspaceId, asAgentRunId(row.parent_run_id));
    if (!parent) throw new Error('parent missing from the snapshot');
    const turn = storage.execution.runEvents.latestOfKind(workspaceId, parent.id, 'turn-completed');
    const finalMessage =
      turn?.kind === 'turn-completed'
        ? truncateUtf8Bytes(turn.payload.resultText, 256 * 1024)
        : (parent.outcomeSummary ?? '');
    const handoffText = between(stored, '\n## Handoff source files\n\n', [
      '\n## Remediation',
      '\n## Review findings to address',
      '\n## Accepted design',
      "\n## The implementation run's own summary",
      '\n## Previous ',
      ...LATER_HEADINGS.map((heading) => heading.slice(1)),
    ]);
    const manifestPath = handoffText && /`([^`]*\/manifest\.json)`/.exec(handoffText)?.[1];
    const assessment = latestReviewReport(storage.execution, parent as AgentRun);
    parentRun = {
      role: parent.role,
      ...(parent.verdict ? { verdict: parent.verdict } : {}),
      finalMessage,
      ...(assessment?.status === 'complete'
        ? {
            findings: assessment.report.findings.map((finding) => ({
              id: finding.id,
              severity: finding.severity,
              status: finding.status,
              title: finding.title,
            })),
          }
        : assessment
          ? { reportIssues: assessment.issues }
          : {}),
      ...(manifestPath
        ? {
            handoff: {
              manifestPath,
              finalMessagePath: `${dirname(manifestPath)}/0000-final.md`,
              ...(parent.role === 'review'
                ? { reportPath: `${dirname(manifestPath)}/0000-review.json` }
                : {}),
              ...(() => {
                const findings = /`([^`]*\/findings\.json)`/.exec(handoffText ?? '')?.[1];
                return findings ? { findingsPath: findings } : {};
              })(),
              warnings: lines(handoffText, 'Handoff warning: '),
            },
          }
        : {}),
    };
  }

  // The words composed at launch: the step rules, the operator's, the recovery sections.
  const later = stored.slice(
    Math.min(...LATER_HEADINGS.map((h) => stored.indexOf(h)).filter((i) => i >= 0), stored.length),
  );
  const trailerAt = Math.min(
    ...TRAILERS.map((t) => later.indexOf(t)).filter((i) => i >= 0),
    later.length,
  );
  const sections = later.slice(0, trailerAt);
  const trailer = later.slice(trailerAt);
  const section = (heading: string) =>
    between(
      sections,
      heading,
      LATER_HEADINGS.filter((h) => h !== heading),
    )?.trim();
  const stepRules = section(LATER_HEADINGS[0]!);
  const instructions = section(LATER_HEADINGS[1]!);
  const guidance = section(LATER_HEADINGS[2]!);
  const continuation = section(LATER_HEADINGS[3]!);
  const retry = section(LATER_HEADINGS[4]!);
  const migrated = stepRules === undefined ? undefined : migrateStepRules(stepRules);
  // Before R-G3 the controller's rules were in the operator's section; migrate those too.
  const migratedInstructions =
    instructions === undefined ? undefined : migrateStepRules(instructions);
  const workflow = migrated?.workflow ?? migratedInstructions?.workflow;
  const finalizationStage = migrated?.finalizationStage ?? migratedInstructions?.finalizationStage;
  if (workflow)
    records.push({
      path: `${planDirectory ?? ''}/${WORKFLOW_OBLIGATIONS_FILE}`,
      about: RUN_RECORDS[WORKFLOW_OBLIGATIONS_FILE],
    });

  // The build environment.
  const pinnedAt = trailer.indexOf('\n\nPinned dependency environment: ');
  const historicalAt = trailer.indexOf('\n\nController-prepared historical baseline');
  const pinned =
    pinnedAt < 0
      ? undefined
      : {
          ...parsePinned(trailer.slice(pinnedAt + 2, historicalAt < 0 ? undefined : historicalAt))!,
          kata,
        };
  const checkOnly =
    pinnedAt < 0 && trailer.trim() && !trailer.trimStart().startsWith('Controller-prepared')
      ? trailer.slice(0, historicalAt < 0 ? undefined : historicalAt).trim()
      : undefined;
  const historical = historicalAt < 0 ? undefined : parseHistorical(trailer.slice(historicalAt));
  const roleText = between(stored, '\n## Your role\n\n', ['\n## ']) ?? '';

  const input: BriefInput = {
    ...(executionScope ? { executionScope } : {}),
    ...(continuation
      ? {
          reviewContinuationArtifacts: JSON.parse(
            /Untracked paths present at continuation preflight: (\[.*?\])\. These are/.exec(
              continuation,
            )?.[1] ?? '[]',
          ) as string[],
        }
      : {}),
    resolvingIntegration: roleText.startsWith('Resolve the daemon-prepared integration merge'),
    planFinalization,
    ...(retry
      ? {
          reviewReportRetry: {
            issues: [/The preceding report was rejected: (.*)/.exec(retry)?.[1] ?? ''],
            reuseVerification: retry.includes('The daemon confirmed that the preceding successful'),
          },
        }
      : {}),
    ...(roleText.startsWith('You are investigating the questions') ? { investigation: true } : {}),
    ...(workflow ? { workflow } : {}),
    ...(finalizationStage ? { finalizationStage } : {}),
    ...(architectureDecisions ||
    (instructions ?? '').startsWith('Prepare an operator decision brief for')
      ? { architectureDecisions: true }
      : {}),
    ...(temporaryDirectory ? { temporaryDirectory } : {}),
    ...(buildCache ? { buildCacheDirectory: buildCache } : {}),
    cargo: true,
    ...(pinned || checkOnly || historical
      ? {
          environment: {
            ...(pinned ? { pinned } : {}),
            ...(checkOnly ? { checkOnly } : {}),
            ...(historical ? { historical } : {}),
          },
        }
      : {}),
    ...(baseline
      ? {
          reviewBranchContext: {
            headSha: baseline[1]!,
            targetBranch: baseline[2]!,
            targetSha: baseline[3]!,
          } as never,
        }
      : {}),
    role,
    projectName: project,
    workItem: {
      sourceId: executionScope ? parentSourceId : (header[2] ?? ''),
      title: executionScope ? header[3]! : header[3]!,
      risk,
      ...(phase === undefined ? {} : { phase }),
      primaryAreas: areas === 'unspecified' ? [] : areas.split(', '),
      exitGate: executionScope ? parentExitGate : exitGate,
      sourceFields: sourceFields(source),
    },
    requiredDependencies: dependencies(
      between(stored, '\n## Dependencies\n\n', ['\nRecommended predecessors:']),
    ),
    recommendedDependencies: dependencies(
      between(stored, '\nRecommended predecessors:\n', ['\n## ']),
    ),
    worktree: {
      path: where[1]!,
      branchName: where[2]!,
      baseBranch: where[3]!,
      baseSha: where[4]!,
      ...(integration ? { integrationBranch: integration } : {}),
    },
    planDocuments,
    ...(temporaryDirectory || planDirectory
      ? { runDirectory: dirname((temporaryDirectory || planDirectory)!) }
      : {}),
    ...(planDirectory ? { planDirectory } : {}),
    records,
    directories: supplied,
    ...(migratedInstructions?.rules.trim() ? { instructions: migratedInstructions.rules } : {}),
    ...(guidance ? { stepGuidance: guidance } : {}),
    ...(migrated?.rules.trim() ? { controllerInstructions: migrated.rules } : {}),
    ...(parentRun ? { parentRun } : {}),
  };
  // The daemon writes the rules the brief refers to into the plan directory and names the file.
  const runDirectory = input.runDirectory;
  return runDirectory && briefRules(input)
    ? { ...input, rulesPath: `${runDirectory}/plan/${RULES_FILE}` }
    : input;
}

/** A brief's top-level sections: split at `## ` headings outside fenced blocks. */
function topSections(text: string): string[] {
  const sections: string[] = [];
  let fence = '';
  let current: string[] = [];
  for (const line of text.split('\n')) {
    const opener = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (opener?.startsWith(fence) && line.trim() === opener) fence = '';
    } else if (opener) fence = opener;
    else if (line.startsWith('## ') && current.length) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join('\n'));
  return sections;
}

/** Every run since `since`, stored and rebuilt. */
export function replayBriefSizes(
  storage: CraftingTableStorage,
  databasePath: string,
  since: string,
): BriefSizeReport {
  const database = openDatabase(databasePath);
  let rows: RunRow[];
  try {
    rows = database
      .prepare(
        'SELECT id, workspace_id, role, brief, worktree_id, work_item_id, parent_run_id FROM agent_runs WHERE created_at >= ? ORDER BY created_at',
      )
      .all(since) as RunRow[];
  } finally {
    database.close();
  }
  const runs: BriefSize[] = [];
  const skipped: { runId: string; reason: string }[] = [];
  const sectionsAfter: Record<string, number> = {};
  for (const row of rows) {
    let after: string;
    let rules: string | undefined;
    try {
      const input = rebuildInput(storage, row);
      after = composeBrief(input);
      rules = input.rulesPath ? briefRules(input) : undefined;
    } catch (error) {
      skipped.push({
        runId: row.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const part of topSections(after)) {
      const heading = part.startsWith('## ') ? part.slice(3, part.indexOf('\n')) : '(header)';
      const key = heading
        .replace(/ \(verdict: .*\)$/, '')
        .replace(/^Previous \w+ run$/, 'Previous run');
      sectionsAfter[key] = (sectionsAfter[key] ?? 0) + bytes(part);
    }
    runs.push({
      runId: row.id as AgentRunId,
      role: row.role,
      before: bytes(row.brief),
      after: bytes(after),
      goalBefore: sectionBytes(row.brief, 'Objective and exit gate'),
      goalAfter: sectionBytes(after, 'Goal and acceptance'),
      rulesAfter: rules ? bytes(rules) : 0,
    });
  }
  return { since, runs, skipped, sectionsAfter };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function formatBriefSizes(report: BriefSizeReport): string {
  const kb = (value: number) => `${(value / 1000).toFixed(1)} KB`;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const row = (name: string, runs: readonly BriefSize[]) =>
    `${name.padEnd(10)} n=${String(runs.length).padStart(3)}  before ${kb(median(runs.map((r) => r.before)))} (largest ${kb(Math.max(0, ...runs.map((r) => r.before)))}), goal ${pct(median(runs.map((r) => r.goalBefore / r.before)))}  after ${kb(median(runs.map((r) => r.after)))} (largest ${kb(Math.max(0, ...runs.map((r) => r.after)))}), goal and acceptance ${pct(median(runs.map((r) => r.goalAfter / r.after)))}`;
  const total = Object.values(report.sectionsAfter).reduce((a, b) => a + b, 0);
  return [
    `Briefs of runs created since ${report.since}:`,
    row('all', report.runs),
    ...[...new Set(report.runs.map((r) => r.role))].sort().map((role) =>
      row(
        role,
        report.runs.filter((r) => r.role === role),
      ),
    ),
    `Rules files the rebuilt briefs name: median ${kb(median(report.runs.map((r) => r.rulesAfter)))}`,
    `Skipped (not parsed): ${report.skipped.length}${report.skipped.length ? ` (${report.skipped.map((s) => `${s.runId}: ${s.reason}`).join('; ')})` : ''}`,
    'Rebuilt bytes per section, of all rebuilt bytes:',
    ...Object.entries(report.sectionsAfter)
      .sort((a, b) => b[1] - a[1])
      .map(([heading, value]) => `  ${pct(value / total).padStart(6)}  ${heading}`),
    '',
  ].join('\n');
}
