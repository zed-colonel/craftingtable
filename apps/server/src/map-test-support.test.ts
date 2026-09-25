import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { analyzeConcurrencyArchive, concurrencySourceIssues } from '@craftingtable/planning';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupExecutionFixtures, slicedFixture } from './execution-test-support.js';
import {
  localMapArchive,
  localScopeSource,
  sealLocalMap,
  withoutScaffolding,
} from './map-test-support.js';
import { unverifiedRecords } from './test-support.js';

afterEach(cleanupExecutionFixtures);

describe('local scope map fixture (R-F3, FMT-15)', () => {
  it('passes the v0.3 importer and the stored-format check', () => {
    const analysis = analyzeConcurrencyArchive(localMapArchive(localScopeSource()));
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.source?.work_items.map((p) => p.id)).toEqual(['local/AQ-01']);
    expect(concurrencySourceIssues(analysis.source)).toEqual([]);
  });

  it('keeps what the test wrote and only adds the scaffolding v0.3 requires', () => {
    const { source } = sealLocalMap(localScopeSource());
    expect(source.repositories.map((r) => [r.id, r.role])).toEqual([
      ['local', 'planned_application'],
      ['base', 'implemented_upstream'],
      ['peer', 'planned_application'],
    ]);
    expect(source.slices.map((s) => s.id)).toEqual(['local/AQ-01/a', 'local/AQ-01/b']);
    expect(source.checkpoints.map((c) => c.id)).toEqual([
      'LOCAL-CASES',
      'BASE-ACCEPTED',
      'BASE-PUBLISHED',
    ]);
  });

  it('does not repair invalid content, so the importer still rejects it', () => {
    const base = localScopeSource();
    const unknown = analyzeConcurrencyArchive(
      localMapArchive({
        ...base,
        slices: base.slices.map((s) => ({
          ...s,
          start_requires: [{ kind: 'checkpoint', id: 'MISSING-PROOF', state: 'passed' }],
        })),
      }),
    );
    expect(unknown.source).toBeUndefined();
    expect(unknown.diagnostics.map((d) => d.code)).toContain('unknown-reference');
    const localIds = analyzeConcurrencyArchive(
      localMapArchive({
        ...base,
        work_items: base.work_items.map((p) => ({ ...p, id: 'AQ-01' })),
      }),
    );
    expect(localIds.diagnostics.map((d) => d.code)).toEqual(['unsupported-map-schema']);
  });

  it('gives a map without local cases an inert peer case, and stores a schema-valid local map', () => {
    const base = localScopeSource();
    const caseless = {
      ...base,
      acceptance_coverage: [],
      work_items: base.work_items.map((p) => ({ ...p, source_profile_case_ids: [] })),
    };
    for (const local of [base, caseless]) {
      const analysis = analyzeConcurrencyArchive(localMapArchive(local));
      expect(analysis.diagnostics).toEqual([]);
      const stored = withoutScaffolding(analysis.source!, local);
      expect(stored.repositories.map((r) => r.id)).toEqual(['local']);
      expect(stored.work_items.map((p) => p.id)).toEqual(['local/AQ-01']);
      expect(stored.slices.map((s) => s.id)).toEqual(['local/AQ-01/a', 'local/AQ-01/b']);
      expect(concurrencySourceIssues(stored)).toEqual([]);
    }
    const stored = withoutScaffolding(
      analyzeConcurrencyArchive(localMapArchive(caseless)).source!,
      caseless,
    );
    expect(stored.acceptance_coverage.map((c) => [c.id, c.owner_work_item])).toEqual([
      ['PEER-CASE', 'peer/PE-01'],
    ]);
  });

  it('makes test cleanup refuse a stored map the v0.3 schema rejects', async () => {
    const f = await slicedFixture();
    const { storage } = f.state.context;
    expect(unverifiedRecords(storage)).toEqual([]);
    // The shape the scope fixtures stored before FMT-15: a parent id without its repository.
    const stored = storage.imports.definition(f.state.workspaceId, f.parentScope.definitionId)!;
    storage.imports.addDefinition({
      ...stored,
      id: randomUUID(),
      mapId: 'hand-built',
      source: {
        ...stored.source,
        map_id: 'hand-built',
        work_items: stored.source.work_items.map((p) => ({ ...p, id: 'AQ-01' })),
      },
    });
    expect(unverifiedRecords(storage).join('\n')).toContain('/work_items/0/id');
    await expect(f.state.context.cleanup()).rejects.toThrow('break their contracts (R-H3)');
    rmSync(f.state.context.directory, { recursive: true, force: true });
  });
});
