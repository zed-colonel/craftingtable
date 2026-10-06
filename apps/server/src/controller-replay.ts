import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { EvidenceSubmission } from '@craftingtable/domain';
import { join, resolve } from 'node:path';
import { type EvidenceViewReplay, replayEvidenceViews } from './evidence-view-replay.js';
import { formatPageLoads, replayPageLoads } from './page-load-replay.js';
import { openDaemonStorage } from './persisted-records.js';
import {
  canonicalJson,
  compareRecords,
  differs,
  formatCheck,
  type ReplayCheck,
} from './replay-check.js';
import { submissionSummary } from './services/runtime-evidence-service.js';
import {
  checkSchedulerReplay,
  replaySchedulerDecisions,
  type SchedulerReplay,
} from './scheduler-replay.js';
import { replayEveryRun, replayStepOutcomes } from './services/step-outcome.js';

/**
 * Replays the controller's step classification over a database snapshot (R-B2).
 *
 *   pnpm controller:replay <snapshot.sqlite>                   print the decisions
 *   pnpm controller:replay <snapshot.sqlite> --record <file>    save them as the golden file
 *   pnpm controller:replay <snapshot.sqlite> --check <file>     compare with a golden file
 *   pnpm controller:replay <snapshot.sqlite> --every-run [...]  classify every finished or
 *       failed run as if it were current, not only each cycle's current run (R-C2)
 *   pnpm controller:replay <snapshot.sqlite> --scheduler [...]  record the decision one roadmap
 *       scheduler pass takes for every roadmap entry, and checkpoint readiness (R-I10)
 *   pnpm controller:replay <snapshot.sqlite> --evidence-view [...]  render each map's evidence
 *       view with Git stubbed, and print its size and CPU (R-H4)
 *   pnpm controller:replay <snapshot.sqlite> --page-load [--json <file>]  load every work item
 *       page through the daemon's routes with Git stubbed, and print its requests and server
 *       time (R-D5)
 *   ... --check <file> --report <report.json>   also write the comparison as JSON; the
 *       versioned replay gate reads it (`pnpm replays`, `scripts/replays.mjs`)
 *
 * Take the snapshot with SQLite's backup API (for example the Storage page's backup) and
 * keep it and its golden file outside the repository: they hold real plans and agent
 * output. The snapshot itself is never modified; the replay reads a private copy.
 */

const REPLAY_NOW = new Date('2000-01-01T00:00:00.000Z');

export function replaySnapshot(snapshot: string, everyRun = false) {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-replay-'));
  try {
    const copy = join(directory, 'snapshot.sqlite');
    copyFileSync(snapshot, copy);
    const storage = openDaemonStorage(copy);
    try {
      return (everyRun ? replayEveryRun : replayStepOutcomes)(storage, REPLAY_NOW);
    } finally {
      storage.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The scheduler pass runs just after the snapshot's last controller write. */
function snapshotTime(snapshot: string): Date {
  const storage = openDaemonStorage(snapshot);
  try {
    const times = [
      ...storage.roadmaps.list().map((r) => r.updatedAt),
      ...storage.execution.cycles.listActive().map((c) => c.updatedAt),
    ].sort();
    return new Date(times.at(-1) ?? REPLAY_NOW.toISOString());
  } finally {
    storage.close();
  }
}

/** Writes the comparison where `--report` asked for it. */
function report(check: ReplayCheck, path: string | undefined): void {
  if (path) writeFileSync(path, `${JSON.stringify(check, null, 2)}\n`, { mode: 0o600 });
}

async function scheduler(
  snapshot: string,
  mode?: string,
  golden?: string,
  reportPath?: string,
): Promise<number> {
  const copy = mkdtempSync(join(tmpdir(), 'craftingtable-replay-'));
  try {
    const path = join(copy, 'snapshot.sqlite');
    copyFileSync(snapshot, path);
    const replay = await replaySchedulerDecisions(path, copy, snapshotTime(path));
    const text = `${JSON.stringify(replay, null, 2)}\n`;
    if (mode === '--record' && golden) {
      writeFileSync(golden, text, { mode: 0o600 });
      process.stdout.write(
        `Recorded ${replay.entries.length} entry decisions and ${replay.cycles.length} cycles in ${golden}\n`,
      );
      return 0;
    }
    if (mode === '--check' && golden) {
      const check = checkSchedulerReplay(
        JSON.parse(readFileSync(golden, 'utf8')) as SchedulerReplay,
        replay,
      );
      report(check, reportPath);
      process.stdout.write(formatCheck(check, 'scheduler records'));
      return differs(check) ? 1 : 0;
    }
    process.stdout.write(text);
    return 0;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/**
 * Keys each evidence view's content by definition and field, and each submission's full record
 * by its id, for `--check`. A golden recorded before R-H4 listed full records in the view; they
 * compare as the summaries the view now sends, and as the records read on demand.
 */
function evidenceViewRecords(
  views: readonly EvidenceViewReplay[],
): { key: string; value: unknown }[] {
  return views.flatMap(({ definitionId, view, records }) => {
    // A golden from before R-H4 carries artifact contents; decide per view, not per submission,
    // since a submission with no artifacts looks the same in both.
    const legacy = view.submissions.some(({ submission }) =>
      submission.artifacts.some((a) => 'content' in a),
    );
    const full = legacy
      ? view.submissions.map(({ submission }) => submission as unknown as EvidenceSubmission)
      : [];
    const summarized = {
      ...view,
      submissions: view.submissions.map((v) => ({
        ...v,
        submission: full.length
          ? submissionSummary(v.submission as unknown as EvidenceSubmission)
          : v.submission,
      })),
    };
    return [
      ...Object.entries(summarized).flatMap(([field, value]) =>
        Array.isArray(value)
          ? value.map((item: unknown, index) => ({
              key: `${definitionId}/${field}/${index}`,
              value: item,
            }))
          : [{ key: `${definitionId}/${field}`, value: value as unknown }],
      ),
      ...(records ?? full).map((record) => ({
        key: `${definitionId}/record/${record.id}`,
        value: record,
      })),
    ];
  });
}

async function evidenceView(
  snapshot: string,
  mode?: string,
  golden?: string,
  reportPath?: string,
): Promise<number> {
  const copy = mkdtempSync(join(tmpdir(), 'craftingtable-replay-'));
  try {
    const path = join(copy, 'snapshot.sqlite');
    copyFileSync(snapshot, path);
    const { views, measures } = await replayEvidenceViews(path, copy, snapshotTime(path));
    for (const m of measures)
      process.stdout.write(
        `view ${m.definitionId}: ${m.bytes} bytes, CPU ${m.cpuMs.join('/')} ms, ${m.gitCalls} Git calls\n  ${Object.entries(
          m.fields,
        )
          .sort((a, b) => b[1] - a[1])
          .map(([field, bytes]) => `${field} ${bytes}`)
          .join(', ')}\n`,
      );
    if (mode === '--record' && golden) {
      writeFileSync(golden, `${JSON.stringify(views, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`Recorded ${views.length} evidence views in ${golden}\n`);
      return 0;
    }
    if (mode === '--check' && golden) {
      // Field order follows the schema that parsed a record; the comparison is canonical.
      const check = compareRecords(
        evidenceViewRecords(JSON.parse(readFileSync(golden, 'utf8')) as EvidenceViewReplay[]),
        evidenceViewRecords(views),
      );
      report(check, reportPath);
      process.stdout.write(
        formatCheck(check, 'evidence view records', (value) => canonicalJson(value).slice(0, 400)),
      );
      return differs(check) ? 1 : 0;
    }
    return 0;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

async function pageLoad(snapshot: string, jsonPath?: string): Promise<number> {
  const copy = mkdtempSync(join(tmpdir(), 'craftingtable-replay-'));
  try {
    const path = join(copy, 'snapshot.sqlite');
    copyFileSync(snapshot, path);
    const replay = await replayPageLoads(path, copy, snapshotTime(path));
    process.stdout.write(formatPageLoads(replay));
    if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(replay, null, 2)}\n`, { mode: 0o600 });
    return 0;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

async function main(args: readonly string[]): Promise<number> {
  // pnpm runs the script in the server package; paths are relative to where it was invoked.
  const base = process.env.INIT_CWD ?? process.cwd();
  const everyRun = args.includes('--every-run');
  const schedulerMode = args.includes('--scheduler');
  const viewMode = args.includes('--evidence-view');
  if (args.includes('--page-load')) {
    const [snapshotArg, flag, jsonArg, extra] = args.filter((arg) => arg !== '--page-load');
    const snapshot = snapshotArg && resolve(base, snapshotArg);
    if (!snapshot || !existsSync(snapshot) || extra || (flag && (flag !== '--json' || !jsonArg))) {
      process.stderr.write(
        'Usage: pnpm controller:replay <snapshot.sqlite> --page-load [--json <file>]\n',
      );
      return 2;
    }
    return pageLoad(snapshot, jsonArg && resolve(base, jsonArg));
  }
  const reportAt = args.indexOf('--report');
  const reportArg = reportAt < 0 ? undefined : args[reportAt + 1];
  const [snapshotArg, mode, goldenArg, extra] = args.filter(
    (arg, index) =>
      arg !== '--every-run' &&
      arg !== '--scheduler' &&
      arg !== '--evidence-view' &&
      (reportAt < 0 || (index !== reportAt && index !== reportAt + 1)),
  );
  const snapshot = snapshotArg && resolve(base, snapshotArg);
  const golden = goldenArg && resolve(base, goldenArg);
  const reportPath = reportArg && resolve(base, reportArg);
  if (
    !snapshot ||
    !existsSync(snapshot) ||
    extra !== undefined ||
    (mode && (!['--record', '--check'].includes(mode) || !golden)) ||
    (reportAt >= 0 && (mode !== '--check' || !reportArg)) ||
    [everyRun, schedulerMode, viewMode].filter(Boolean).length > 1
  ) {
    process.stderr.write(
      'Usage: pnpm controller:replay <snapshot.sqlite> [--every-run | --scheduler | --evidence-view] [--record <golden.json> | --check <golden.json> [--report <report.json>]]\n',
    );
    return 2;
  }
  if (schedulerMode) return scheduler(snapshot, mode, golden, reportPath);
  if (viewMode) return evidenceView(snapshot, mode, golden, reportPath);
  const outcomes = replaySnapshot(snapshot, everyRun);
  const text = `${JSON.stringify(outcomes, null, 2)}\n`;
  if (mode === '--record' && golden) {
    writeFileSync(golden, text, { mode: 0o600 });
    process.stdout.write(`Recorded ${outcomes.length} decisions in ${golden}\n`);
    return 0;
  }
  if (mode === '--check' && golden) {
    const records = (list: typeof outcomes) =>
      list.map((outcome) => ({ key: `${outcome.cycleId}/${outcome.runId}`, value: outcome }));
    const check = compareRecords(
      records(JSON.parse(readFileSync(golden, 'utf8')) as typeof outcomes),
      records(outcomes),
    );
    report(check, reportPath);
    process.stdout.write(
      formatCheck(check, 'decisions', (value) => {
        const outcome = value as (typeof outcomes)[number];
        return JSON.stringify(outcome.decision ?? outcome.error);
      }),
    );
    return differs(check) ? 1 : 0;
  }
  process.stdout.write(text);
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMain)
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
