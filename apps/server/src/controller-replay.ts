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
import { openCraftingTableStorage } from '@craftingtable/storage';
import { replayStepOutcomes } from './services/step-outcome.js';

/**
 * Replays the controller's step classification over a database snapshot (R-B2).
 *
 *   pnpm controller:replay <snapshot.sqlite>                   print the decisions
 *   pnpm controller:replay <snapshot.sqlite> --record <file>    save them as the golden file
 *   pnpm controller:replay <snapshot.sqlite> --check <file>     compare with a golden file
 *
 * Take the snapshot with SQLite's backup API (for example the Storage page's backup) and
 * keep it and its golden file outside the repository: they hold real plans and agent
 * output. The snapshot itself is never modified; the replay reads a private copy.
 */

const REPLAY_NOW = new Date('2000-01-01T00:00:00.000Z');

export function replaySnapshot(snapshot: string) {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-replay-'));
  try {
    const copy = join(directory, 'snapshot.sqlite');
    copyFileSync(snapshot, copy);
    const storage = openCraftingTableStorage(copy);
    try {
      return replayStepOutcomes(storage, REPLAY_NOW);
    } finally {
      storage.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main(args: readonly string[]): number {
  // pnpm runs the script in the server package; paths are relative to where it was invoked.
  const base = process.env.INIT_CWD ?? process.cwd();
  const [snapshotArg, mode, goldenArg] = args;
  const snapshot = snapshotArg && resolve(base, snapshotArg);
  const golden = goldenArg && resolve(base, goldenArg);
  if (!snapshot || !existsSync(snapshot) || (mode && !['--record', '--check'].includes(mode))) {
    process.stderr.write(
      'Usage: pnpm controller:replay <snapshot.sqlite> [--record <golden.json> | --check <golden.json>]\n',
    );
    return 2;
  }
  const outcomes = replaySnapshot(snapshot);
  const text = `${JSON.stringify(outcomes, null, 2)}\n`;
  if (mode === '--record' && golden) {
    writeFileSync(golden, text, { mode: 0o600 });
    process.stdout.write(`Recorded ${outcomes.length} decisions in ${golden}\n`);
    return 0;
  }
  if (mode === '--check' && golden) {
    const expected = JSON.parse(readFileSync(golden, 'utf8')) as typeof outcomes;
    const byCycle = new Map(expected.map((outcome) => [outcome.cycleId, outcome]));
    const changed = outcomes.filter(
      (outcome) => JSON.stringify(byCycle.get(outcome.cycleId)) !== JSON.stringify(outcome),
    );
    const missing = expected.filter((e) => !outcomes.some((o) => o.cycleId === e.cycleId));
    for (const outcome of changed)
      process.stdout.write(
        `changed ${outcome.cycleId}\n  was ${JSON.stringify(byCycle.get(outcome.cycleId)?.decision ?? byCycle.get(outcome.cycleId)?.error)}\n  now ${JSON.stringify(outcome.decision ?? outcome.error)}\n`,
      );
    for (const outcome of missing) process.stdout.write(`missing ${outcome.cycleId}\n`);
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
if (isMain) process.exitCode = main(process.argv.slice(2));
