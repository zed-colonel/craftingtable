import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { targetClosure, concurrencyMilestones } from '@craftingtable/domain';
import { analyzeConcurrencyArchive } from './concurrency.js';
const source = analyzeConcurrencyArchive(
  readFileSync(
    new URL(
      '../../../fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip',
      import.meta.url,
    ),
  ),
).source!;
describe('target milestone selection', () => {
  it('keeps the native WI proof independent of EXO and Kata, retaining excluded parents', () => {
    const c = targetClosure(source, 'WI-EMBEDDED-WORKER-PROOF-1', 'target-only');
    expect(c.nodes.length).toBeGreaterThan(20);
    expect(c.nodes.some((n) => n.repository === 'exo')).toBe(false);
    expect(
      c.nodes.some((n) => n.requirement.kind === 'work_item' && n.requirement.id === 'wi/WI-14'),
    ).toBe(false);
    expect(
      c.excluded.some((n) => n.requirement.kind === 'work_item' && n.requirement.id === 'wi/WI-14'),
    ).toBe(true);
    for (const node of c.nodes)
      for (const key of node.requires)
        expect(
          c.nodes.some((n) => n.key === key),
          `${node.key} missing ${key}`,
        ).toBe(true);
  });
  it('distinguishes target scope from full scope priority without dropping later obligations', () => {
    const partial = targetClosure(source, 'EXO-EMBEDDED-VIABILITY-1', 'target-only'),
      full = targetClosure(source, 'EXO-EMBEDDED-VIABILITY-1', 'prioritize-full');
    expect(full.nodes).toHaveLength(concurrencyMilestones(source).length);
    expect(full.excluded).toHaveLength(0);
    expect([...full.priority]).toEqual(partial.nodes.map((n) => n.key));
    expect(full.nodes.slice(0, partial.nodes.length)).toEqual(partial.nodes);
    expect(partial.nodes.some((n) => n.requirement.id === 'EXO-PUBLISHED')).toBe(false);
    expect(full.nodes.some((n) => n.requirement.id === 'EXO-PUBLISHED')).toBe(true);
    expect(() => targetClosure(source, 'invented', 'target-only')).toThrow();
  });
});
