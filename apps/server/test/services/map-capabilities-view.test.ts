import { mapCapabilitiesViewSchema } from '@craftingtable/contracts';
import type { ConcurrencySource } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { mapCapabilitiesView } from '../../src/services/map-capabilities-view.js';
import { renamed, rewordedSource, v03Source } from '../map-rewording.js';

const source = v03Source();

it("shows the v0.3 map's one gap and every slice's build classification (R-F2 part 5)", () => {
  const view = mapCapabilitiesView(source);
  expect(mapCapabilitiesViewSchema.parse(view)).toEqual(view);
  expect(view.gaps).toEqual([
    { code: 'resource-adapter-missing', resourceId: 'kata-instance-test-host' },
  ]);
  expect(view.builds.map((b) => b.sliceId)).toEqual(source.slices.map((s) => s.id));
  const modes = new Set(view.builds.map((b) => b.mode));
  expect(modes).toEqual(new Set(['scoped-checks', 'current-upstream-build']));
});

it('is unchanged by rewording the prose, and names a reworded contract or renamed role as a typed gap', () => {
  expect(mapCapabilitiesView(rewordedSource(source))).toEqual(mapCapabilitiesView(source));
  const role = mapCapabilitiesView(renamed(source, 'repository-maintainer', 'maintainer'));
  expect(role.gaps.map((g) => g.code)).toContain('decision-contract-changed');
  const plan = structuredClone(source) as ConcurrencySource;
  const checkpoint = plan.checkpoints.find((c) => c.kind === 'plan_approval')!;
  (checkpoint as unknown as { pass_criteria: string[] }).pass_criteria = ['Reworded criteria.'];
  expect(mapCapabilitiesView(plan).gaps).toContainEqual(
    expect.objectContaining({ code: 'plan-contract-changed', fields: ['pass_criteria'] }),
  );
});

it('moves a slice whose maturity word is reworded to a current-upstream build, with no gap (R-F2, L4)', () => {
  // An implementation slice is scoped only under an independent parent (ADR-053).
  const slice = mapCapabilitiesView(source)
    .builds.filter((b) => b.mode === 'scoped-checks')
    .map((b) => source.slices.find((s) => s.id === b.sliceId)!)
    .find((s) => s.mode === 'implementation')!;
  expect(slice).toBeDefined();
  const changed = structuredClone(source) as ConcurrencySource;
  const parent = changed.work_items.find((w) => w.id === slice.work_item)! as unknown as {
    source_maturity: string;
  };
  parent.source_maturity = parent.source_maturity.replace(/^\S+/, 'Standalone');
  const view = mapCapabilitiesView(changed);
  expect(view.builds.find((b) => b.sliceId === slice.id)?.mode).toBe('current-upstream-build');
  expect(view.gaps).toEqual(mapCapabilitiesView(source).gaps);
});
