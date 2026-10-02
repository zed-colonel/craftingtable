import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CycleFixture,
  createCycleFixture,
  designDone,
  git,
  openQuestions,
  reviewText,
  startCycle,
  stepController,
} from './cycle-test-support.js';
import { replayStepOutcomes } from './services/step-outcome.js';

/**
 * Golden replay for the controller's step classification (R-B2).
 *
 * Each scenario drives a real daemon with scripted agents, stepping the controller, until
 * its cycle's current run reaches a characteristic outcome. The resulting database is the
 * fixture snapshot; `replayStepOutcomes` classifies every cycle in it and the result must
 * match the recorded golden file. A controller refactor that changes any decision fails
 * here. Record a deliberate change with `UPDATE_GOLDEN=1 pnpm vitest run <this file>`.
 *
 * The same replay runs against a copy of a live database with `pnpm controller:replay`.
 */

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/controller/step-outcome-replay.golden.json',
);
// Far from the real clock, so times derived from it survive normalization.
const NOW = new Date('2000-01-01T00:00:00.000Z');

const fixtures: CycleFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

async function commitChange(f: CycleFixture, name: string): Promise<void> {
  const worktree = f.backend.latest.request.cwd;
  writeFileSync(join(worktree, name), name);
  git(['add', '.'], worktree);
  git(['commit', '--no-gpg-sign', '-m', name], worktree);
}

/** Drives design → implement → review and stops with the review turn finished. */
async function throughReview(f: CycleFixture, review: string): Promise<void> {
  f.backend.latest.release(designDone);
  await stepController(f.services, 3);
  await commitChange(f, 'change.txt');
  f.backend.latest.release('Implemented and checks passed.');
  await stepController(f.services, 3);
  f.backend.latest.release(review);
  await stepController(f.services);
}

const minorFinding = {
  id: 'F-001',
  severity: 'minor',
  status: 'open',
  title: 'Boundary coverage',
  explanation: 'Cover the boundary.',
  recommendation: 'Add a regression case.',
};

const SCENARIOS: Record<string, (f: CycleFixture) => Promise<void>> = {
  'design-live': async () => {},
  'design-open-questions': async (f) => {
    f.backend.latest.release(openQuestions);
    await stepController(f.services, 2);
  },
  'implement-open-questions': async (f) => {
    f.backend.latest.release(designDone);
    await stepController(f.services, 3);
    f.backend.latest.release(openQuestions);
    await stepController(f.services, 2);
  },
  'implement-crashed': async (f) => {
    f.backend.latest.release(designDone);
    await stepController(f.services, 3);
    f.backend.latest.crash();
    await stepController(f.services, 2);
  },
  'implement-service-failure': async (f) => {
    f.backend.latest.release(designDone);
    await stepController(f.services, 3);
    f.backend.latest.failWithService({
      kind: 'capacity',
      safeToRetry: true,
      message: 'The model is overloaded.',
    } as never);
    await stepController(f.services, 2);
  },
  'review-findings': async (f) => throughReview(f, reviewText([minorFinding])),
  'review-mergeable': async (f) => {
    await throughReview(f, reviewText());
    await stepController(f.services);
  },
  'design-drain-interrupted': async (f) => {
    await f.services.daemonDrain.drain(0);
  },
};

/** Replaces generated identifiers and clock readings so the recording is stable. */
function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
        if (!ids.has(id)) ids.set(id, `<id-${ids.size + 1}>`);
        return ids.get(id) as string;
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (time) =>
        time.startsWith('2000-01-01T') ? time : '<time>',
      ),
  );
}

describe('controller golden replay (R-B2)', () => {
  it('reproduces the recorded decision for every scenario snapshot', async () => {
    const replayed: Record<string, unknown> = {};
    for (const [name, drive] of Object.entries(SCENARIOS)) {
      const f = await createCycleFixture({ workers: false });
      fixtures.push(f);
      await startCycle(f);
      await stepController(f.services);
      await drive(f);
      replayed[name] = normalize(
        replayStepOutcomes(f.context.storage, NOW).map(({ cycleId, runId, ...rest }) => rest),
      );
    }
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(replayed, null, 2)}\n`);
    }
    expect(replayed).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
