import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  storedCycle,
  storedRun,
} from './cycle-test-support.js';
import { replayEveryRun } from './services/step-outcome.js';

/**
 * R-C2: a final report that fails a structural check is sent back to the same agent
 * session with the validator's issues, up to two times, before the step stops for the
 * operator. Listed open questions still stop at once. Everything is stepped.
 */

const fixtures: CycleFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

async function liveDesign() {
  const f = await createCycleFixture({ workers: false });
  fixtures.push(f);
  const started = await startCycle(f);
  await stepController(f.services);
  return { f, started };
}

describe('automatic output-format repair (R-C2)', () => {
  it('resumes the session with the issues and continues once the report is corrected', async () => {
    const { f, started } = await liveDesign();
    const designRunId = storedCycle(f, started.id).currentRunId;

    f.backend.latest.release('Design settled; nothing to ask.');
    // Classify and reserve the repair, then launch it.
    await stepController(f.services, 3);
    expect(f.backend.sessions).toHaveLength(2);
    const repair = f.backend.launches[1];
    expect(repair).toMatchObject({ resumeSessionId: 'vendor-session-1', model: 'design-model' });
    expect(repair?.prompt).toContain('automatic repair 1 of 2');
    expect(repair?.prompt).toContain('“## Open questions”');
    expect(repair?.additionalDirectories).toContain(
      join(f.context.config.execution.runsRoot, designRunId),
    );
    const repairing = storedCycle(f, started.id);
    expect(repairing).toMatchObject({
      status: 'running',
      step: 'design',
      parentRunId: designRunId,
      outputRepair: { attempts: 1, sourceRunId: designRunId, code: 'design-open-questions' },
    });
    expect(repairing.attention).toBeUndefined();

    f.backend.latest.release(designDone);
    await stepController(f.services, 3);
    const advanced = storedCycle(f, started.id);
    expect(advanced.step).toBe('implement');
    expect(advanced.outputRepair ?? null).toBeNull();
    expect(f.backend.launches[2]?.resumeSessionId).toBeUndefined();

    // Replaying every recorded run, not only the current one, shows the repair decision for
    // the report that is no longer current (`controller:replay --every-run`).
    const replayed = replayEveryRun(f.context.storage, new Date());
    expect(replayed.find((outcome) => outcome.runId === designRunId)?.decision).toMatchObject({
      kind: 'repair-output',
      code: 'design-open-questions',
    });
  });

  it('stops for the operator after two failed repairs and records them', async () => {
    const { f, started } = await liveDesign();
    for (let turn = 0; turn < 3; turn += 1) {
      f.backend.latest.release('```craftingtable-design\n{');
      await stepController(f.services, 3);
    }
    expect(f.backend.sessions).toHaveLength(3);
    expect(f.backend.launches[2]?.prompt).toContain('automatic repair 2 of 2');
    const stopped = storedCycle(f, started.id);
    expect(stopped).toMatchObject({
      status: 'needs-attention',
      attention: { code: 'design-report-invalid', owner: 'operator', repairAttempts: 2 },
    });
    expect(stopped.reason).toContain('2 automatic format repairs did not produce a valid report.');
  });

  it('stops at once when the design lists real questions', async () => {
    const { f, started } = await liveDesign();
    f.backend.latest.release(openQuestions);
    await stepController(f.services, 3);
    expect(f.backend.sessions).toHaveLength(1);
    const stopped = storedCycle(f, started.id);
    expect(stopped.attention).toMatchObject({ code: 'design-open-questions' });
    expect(stopped.attention?.repairAttempts).toBeUndefined();
  });

  it('does not carry spent repairs past the stop they ended in', async () => {
    const { f, started } = await liveDesign();
    f.backend.latest.release('Design settled; nothing to ask.');
    await stepController(f.services, 3);
    expect(storedCycle(f, started.id).outputRepair?.attempts).toBe(1);
    // The repaired report lists real questions: the step stops, and the budget ends with it,
    // so the run the operator's answer starts gets its own two repairs.
    f.backend.latest.release(openQuestions);
    await stepController(f.services, 3);
    const stopped = storedCycle(f, started.id);
    expect(stopped.attention).toMatchObject({ code: 'design-open-questions' });
    expect(stopped.outputRepair ?? null).toBeNull();
  });

  it('repairs a review report on its pinned review baseline', async () => {
    const { f, started } = await liveDesign();
    f.backend.latest.release(designDone);
    await stepController(f.services, 3);
    const worktree = f.backend.latest.request.cwd;
    writeFileSync(join(worktree, 'change.txt'), 'implemented');
    git(['add', '.'], worktree);
    git(['commit', '--no-gpg-sign', '-m', 'implementation'], worktree);
    f.backend.latest.release('Implemented and checks passed.');
    await stepController(f.services, 3);
    const review = storedRun(f, storedCycle(f, started.id).currentRunId);
    expect(review).toMatchObject({ role: 'review', status: 'running' });

    f.backend.latest.release('Looks good to me.\n\n## Open questions\nnone');
    await stepController(f.services, 3);
    expect(f.backend.launches[3]).toMatchObject({
      resumeSessionId: 'vendor-session-3',
      model: 'review-model',
    });
    expect(f.backend.launches[3]?.prompt).toContain(
      'A complete, valid structured review report is required.',
    );
    const repaired = storedRun(f, storedCycle(f, started.id).currentRunId);
    expect(repaired?.role).toBe('review');
    expect(repaired?.reviewBranchContext?.headSha).toBe(review?.reviewBranchContext?.headSha);

    f.backend.latest.release(reviewText());
    await stepController(f.services, 2);
    expect(storedCycle(f, started.id).status).toBe('awaiting-merge');
  });
});
