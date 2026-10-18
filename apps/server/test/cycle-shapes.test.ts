import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workCycleSchema } from '@craftingtable/contracts';
import {
  cycleActions,
  effectiveCycleAttention,
  type PhaseBlocker,
  phaseBlockerCode,
  phaseBlockerResourceKey,
  type WorkCycle,
} from '@craftingtable/domain';
import { afterAll, expect, it } from 'vitest';
import { checkTransition } from '../src/services/cycle/core/transitions.js';
import { cycleStep } from '../src/services/entry-waits.js';
import { cycleShapes, type ShapeRow } from './cycle-shapes.js';

/**
 * R-B4b's characterization (increment 1; program rule 3): what today's readers answer for every
 * cycle record shape stored today (`cycle-shapes.ts`). R-B4b reshapes the stop, the waits, the
 * step attempt and the retired finalization's fields, and its migration must map every stored
 * record one to one: increment 2 reads each row back through the migration and must answer the
 * same. The answers are `fixtures/cycle-shapes.json`; `UPDATE_CYCLE_SHAPES=1` re-records them.
 */

const RECORD = join(import.meta.dirname, '../../../fixtures/cycle-shapes.json');
const UPDATE = process.env.UPDATE_CYCLE_SHAPES === '1';
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
const recorded: Record<string, Json> = existsSync(RECORD)
  ? (JSON.parse(readFileSync(RECORD, 'utf8')) as Record<string, Json>)
  : {};
const observed: Record<string, Json> = {};
afterAll(() => {
  if (UPDATE) writeFileSync(RECORD, `${JSON.stringify(observed, null, 2)}\n`);
});

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json;
const ATTEMPT = [
  'stepGuidance',
  'housekeepingInstructions',
  'resultContinuations',
  'outputRepair',
  'providerRecovery',
] as const;

/** What each reader answers for a stored record, in the shape every release before R-B4b wrote. */
function answers(row: ShapeRow): Json {
  const cycle = row.record as unknown as WorkCycle;
  const contract = workCycleSchema.safeParse(row.record);
  let keeps = 'kept';
  try {
    checkTransition(cycle, cycle, 'advance');
  } catch (error) {
    keeps = (error as Error).message;
  }
  const phase = cycle.phaseWait;
  return json({
    contract: contract.success ? 'valid' : contract.error.issues.map((i) => i.path.join('.')),
    stop: effectiveCycleAttention(cycle),
    actions: cycleActions(cycle, cycle.currentRunId),
    entry: cycleStep(cycle),
    keeps,
    waits: {
      phase: phase
        ? {
            since: phase.startedAt,
            blockers: phase.blockers.map((blocker: PhaseBlocker) => ({
              ...blocker,
              code: phaseBlockerCode(blocker),
              resourceKey: phaseBlockerResourceKey(blocker) ?? null,
            })),
          }
        : null,
      design: cycle.designWait
        ? { since: cycle.designWait.startedAt, requirements: cycle.designWait.requirements }
        : null,
    },
    attempt: Object.fromEntries(
      ATTEMPT.filter((field) => field in row.record).map((field) => [field, row.record[field]]),
    ),
    retired: {
      polishRound: cycle.polishRound ?? null,
      deferredNits: cycle.deferredNits ?? null,
    },
  });
}

const rows = cycleShapes();

it('names each stored shape once, and covers the survey, the decoders and every end', () => {
  const names = rows.map((row) => row.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names.filter((name) => name.startsWith('stored: '))).toHaveLength(41);
  expect(names.filter((name) => name.startsWith('uncoded: '))).toHaveLength(27);
  expect(names.filter((name) => name.startsWith('ended: '))).toHaveLength(7);
});

it.each(rows.map((row) => [row.name, row] as const))('%s', (name, row) => {
  const answer = answers(row);
  observed[name] = answer;
  // Every stored shape is one the contract reads today.
  expect((answer as { contract: Json }).contract).toBe('valid');
  if (!UPDATE) expect(answer).toEqual(recorded[name]);
});
