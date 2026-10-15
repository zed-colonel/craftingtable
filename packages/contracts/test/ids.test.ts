import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  concurrencyDefinitionIdSchema,
  evidenceSubmissionIdSchema,
  finalizationIdSchema,
  importedArchiveIdSchema,
  workCycleIdSchema,
} from '../src/ids.js';
import { roadmapIdSchema } from '../src/roadmap.js';

it("checks a route's id of a kind the daemon generates as the UUID its record holds (R-H7)", () => {
  const schemas = {
    workCycleIdSchema,
    finalizationIdSchema,
    evidenceSubmissionIdSchema,
    importedArchiveIdSchema,
    concurrencyDefinitionIdSchema,
    roadmapIdSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const id = randomUUID();
    expect(schema.safeParse(id), name).toEqual({ success: true, data: id });
    for (const malformed of ['not-a-uuid', ` ${id}`, `${id} `, '', 'cycle-1', id.slice(0, 35)])
      expect(schema.safeParse(malformed).success, `${name} "${malformed}"`).toBe(false);
  }
});
