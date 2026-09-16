import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readArchive } from './archive.js';
import { zipFixture } from './archive-test-support.js';
import { inspectPlanArchive, previewSelectedPlanArchive } from './plan-archive.js';

const bytes = Buffer.from('hello');
describe('bounded ZIP import', () => {
  it('reads bytes without extracting members', () => {
    expect(readArchive(zipFixture([{ path: 'package/plan.md', bytes }]))[0]?.bytes).toEqual(bytes);
  });
  it.each(['../evil', '/absolute', 'a/../evil', 'a\\evil', 'C:/evil', 'a//evil', 'a/./evil'])(
    'rejects unsafe path %s',
    (path) => {
      expect(() => readArchive(zipFixture([{ path, bytes }]))).toThrow(/Unsafe/);
    },
  );
  it('rejects duplicate names and links', () => {
    expect(() =>
      readArchive(
        zipFixture([
          { path: 'a', bytes },
          { path: 'A', bytes },
        ]),
      ),
    ).toThrow(/Duplicate/);
    expect(() => readArchive(zipFixture([{ path: 'link', bytes, mode: 0xa1ff }]))).toThrow(/Links/);
  });
  it('rejects truncated, oversized and forged expansion records', () => {
    const valid = zipFixture([{ path: 'a', bytes }]);
    expect(() => readArchive(valid.subarray(0, -1))).toThrow();
    expect(() =>
      readArchive(zipFixture([{ path: 'large', bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }])),
    ).toThrow(/limit/);
    const forged = zipFixture([{ path: 'bomb', bytes: Buffer.alloc(1024 * 1024) }]);
    forged.writeUInt32LE(1, 22);
    const center = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    forged.writeUInt32LE(1, center + 24);
    expect(() => readArchive(forged)).toThrow(/oversized/);
  });
  it.each([
    ['wi-fabric-2-foundational-package-r5-aq-baseline-alignment.zip', 14, 27],
    ['exo-v3-comprehensive-design-package-r6-aq-baseline-alignment.zip', 19, 28],
  ])('imports the current plan from full %s', (name, count, artifacts) => {
    const data = readFileSync(new URL(`../../../fixtures/concurrency/${name}`, import.meta.url));
    const inspected = inspectPlanArchive(data);
    expect(inspected.implementationPlans).toHaveLength(1);
    expect(inspected.workBreakdowns).toHaveLength(1);
    const preview = previewSelectedPlanArchive(data, {
      implementationPlan: inspected.implementationPlans[0]!,
      workBreakdown: inspected.workBreakdowns[0]!,
    });
    expect(preview.diagnostics).toEqual([]);
    expect(preview.valid).toBe(true);
    expect(preview.itemCount).toBe(count);
    expect(preview.selectedPaths).toHaveLength(artifacts);
    expect(preview.selectedPaths.some((p) => p.includes('/provenance/') || p.endsWith('.py'))).toBe(
      false,
    );
  });
});
