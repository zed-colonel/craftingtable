import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDaemonStorage } from './persisted-records.js';
import { replaySchedulerDecisions, type SchedulerReplay } from './scheduler-replay.js';
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

/** Keys each scheduler decision by its roadmap entry or cycle, for `--check`. */
function schedulerRecords(replay: SchedulerReplay) {
  return [
    ...replay.roadmaps.map((r) => ({ key: `roadmap:${r.roadmapId}`, value: r })),
    ...replay.entries.map((e) => ({ key: `entry:${e.roadmapId}/${e.entryId}`, value: e })),
    ...replay.cycles.map((c) => ({ key: `cycle:${c.cycleId}`, value: c })),
    ...(replay.status ?? []).flatMap((list) =>
      list.entries.map((e) => ({ key: `status:${list.roadmapId}/${e.entryId}`, value: e })),
    ),
  ];
}

async function scheduler(snapshot: string, mode?: string, golden?: string): Promise<number> {
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
      const expected = schedulerRecords(
        JSON.parse(readFileSync(golden, 'utf8')) as SchedulerReplay,
      );
      const actual = schedulerRecords(replay);
      const byKey = new Map(expected.map((r) => [r.key, JSON.stringify(r.value)]));
      const changed = actual.filter((r) => byKey.get(r.key) !== JSON.stringify(r.value));
      const missing = expected.filter((e) => !actual.some((r) => r.key === e.key));
      for (const record of changed)
        process.stdout.write(
          `changed ${record.key}\n  was ${byKey.get(record.key) ?? '(new)'}\n  now ${JSON.stringify(record.value)}\n`,
        );
      for (const record of missing) process.stdout.write(`missing ${record.key}\n`);
      process.stdout.write(
        `${actual.length} scheduler records replayed; ${changed.length} changed, ${missing.length} missing\n`,
      );
      return changed.length || missing.length ? 1 : 0;
    }
    process.stdout.write(text);
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
  const [snapshotArg, mode, goldenArg] = args.filter(
    (arg) => arg !== '--every-run' && arg !== '--scheduler',
  );
  const snapshot = snapshotArg && resolve(base, snapshotArg);
  const golden = goldenArg && resolve(base, goldenArg);
  if (
    !snapshot ||
    !existsSync(snapshot) ||
    (mode && (!['--record', '--check'].includes(mode) || !golden)) ||
    (everyRun && schedulerMode)
  ) {
    process.stderr.write(
      'Usage: pnpm controller:replay <snapshot.sqlite> [--every-run | --scheduler] [--record <golden.json> | --check <golden.json>]\n',
    );
    return 2;
  }
  if (schedulerMode) return scheduler(snapshot, mode, golden);
  const outcomes = replaySnapshot(snapshot, everyRun);
  const text = `${JSON.stringify(outcomes, null, 2)}\n`;
  if (mode === '--record' && golden) {
    writeFileSync(golden, text, { mode: 0o600 });
    process.stdout.write(`Recorded ${outcomes.length} decisions in ${golden}\n`);
    return 0;
  }
  if (mode === '--check' && golden) {
    const expected = JSON.parse(readFileSync(golden, 'utf8')) as typeof outcomes;
    const key = (outcome: (typeof outcomes)[number]) => `${outcome.cycleId}/${outcome.runId}`;
    const byKey = new Map(expected.map((outcome) => [key(outcome), outcome]));
    const changed = outcomes.filter(
      (outcome) => JSON.stringify(byKey.get(key(outcome))) !== JSON.stringify(outcome),
    );
    const missing = expected.filter((e) => !outcomes.some((o) => key(o) === key(e)));
    for (const outcome of changed)
      process.stdout.write(
        `changed ${key(outcome)}\n  was ${JSON.stringify(byKey.get(key(outcome))?.decision ?? byKey.get(key(outcome))?.error)}\n  now ${JSON.stringify(outcome.decision ?? outcome.error)}\n`,
      );
    for (const outcome of missing) process.stdout.write(`missing ${key(outcome)}\n`);
    process.stdout.write(
      `${outcomes.length} decisions replayed; ${changed.length} changed, ${missing.length} missing\n`,
    );
    return changed.length || missing.length ? 1 : 0;
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
