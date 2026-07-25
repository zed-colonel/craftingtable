import { describe, expect, it } from 'vitest';
import { analyzePlanBundle, type PlanBundleArtifactInput } from './bundle.js';
import { PLAN_BUNDLE_LIMITS } from './limits.js';
import { readInvalidFixtureText, syntheticBundle } from './test-support.js';

/** CT03-A13 and CT03-A23: bundle shape, filename, media-type, and limit rules. */

const VALID_BREAKDOWN =
  'document: X\npull_requests:\n- id: WI-01\n  title: T\n  depends_on: []\n  risk: low\n  primary_areas: [core]\n  exit_gate: G\n';

const encoder = new TextEncoder();

const MINIMAL_PLAN_ARTIFACT: PlanBundleArtifactInput = {
  fieldName: 'implementation-plan',
  filename: 'plan.md',
  declaredMediaType: 'text/markdown',
  bytes: new TextEncoder().encode('# Plan\n'),
};

function artifact(overrides: Partial<PlanBundleArtifactInput> = {}): PlanBundleArtifactInput {
  return {
    fieldName: 'supporting',
    filename: 'extra.md',
    declaredMediaType: 'text/markdown',
    bytes: encoder.encode('extra\n'),
    ...overrides,
  };
}

function codesFor(artifacts: readonly PlanBundleArtifactInput[]): readonly string[] {
  return analyzePlanBundle({ artifacts }).diagnostics.map((diagnostic) => diagnostic.code);
}

describe('plan bundle validation', () => {
  it('accepts a minimal valid bundle', () => {
    const analysis = analyzePlanBundle({ artifacts: syntheticBundle(VALID_BREAKDOWN) });
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.fatal).toBe(false);
    expect(analysis.plan?.workItems).toHaveLength(1);
    expect(analysis.digest).toBeDefined();
  });

  it('requires both the implementation plan and the work breakdown (CT03-A13)', () => {
    const onlyPlan = syntheticBundle(VALID_BREAKDOWN).filter(
      (a) => a.fieldName === 'implementation-plan',
    );
    const missing = analyzePlanBundle({ artifacts: onlyPlan }).diagnostics.filter(
      (d) => d.code === 'required-artifact-missing',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe('work-breakdown');
    expect(missing[0]?.severity).toBe('error');

    const none = analyzePlanBundle({ artifacts: [] }).diagnostics.filter(
      (d) => d.code === 'required-artifact-missing',
    );
    expect(none.map((d) => d.path).toSorted()).toEqual(['implementation-plan', 'work-breakdown']);
  });

  it('withholds the digest when the artifact set is incomplete (CT03-A13)', () => {
    // A digest over a partially rejected set would name a bundle nobody sent.
    expect(analyzePlanBundle({ artifacts: [] }).digest).toBeUndefined();
    expect(
      analyzePlanBundle({ artifacts: [artifact({ filename: '../escape.md' })] }).digest,
    ).toBeUndefined();
  });

  it('rejects duplicate logical filenames, case-insensitively (CT03-A23)', () => {
    const base = syntheticBundle(VALID_BREAKDOWN);
    expect(codesFor([...base, artifact({ filename: 'plan.md' })])).toContain(
      'duplicate-logical-filename',
    );
    expect(codesFor([...base, artifact({ filename: 'PLAN.md' })])).toContain(
      'duplicate-logical-filename',
    );
  });

  it('rejects path separators, traversal, NUL, and control characters (CT03-A23)', () => {
    for (const filename of [
      '../escape.md',
      'nested/plan.md',
      'nested\\plan.md',
      'plan\u0000.md',
      'plan\u001f.md',
      '.',
      '..',
      '.hidden.md',
      '-leading.md',
      '',
      ' ',
    ]) {
      const codes = codesFor([artifact({ filename })]);
      expect(
        codes.includes('invalid-logical-filename') || codes.includes('unsupported-media-type'),
        `expected ${JSON.stringify(filename)} to be rejected, got ${codes.join(', ')}`,
      ).toBe(true);
    }
  });

  it('accepts ordinary hyphenated and dotted planning filenames', () => {
    // The rejection list above is deliberately narrow: it must not reject the
    // shapes real planning bundles actually use.
    for (const filename of [
      'aq-cont-1-work-breakdown.yaml',
      'aq-cont-1-implementation-plan.sha256',
      'plan.v2.md',
      'trailing-.md',
      'UPPER_case-1.txt',
    ]) {
      expect(codesFor([artifact({ filename })])).not.toContain('invalid-logical-filename');
    }
  });

  it('rejects filenames longer than the logical limit (CT03-A23)', () => {
    const filename = `${'a'.repeat(PLAN_BUNDLE_LIMITS.maxLogicalFilenameLength)}.md`;
    expect(codesFor([artifact({ filename })])).toContain('invalid-logical-filename');
  });

  it('rejects unsupported extensions and declared media types (CT03-A23)', () => {
    expect(codesFor([artifact({ filename: 'payload.exe' })])).toContain('unsupported-media-type');
    expect(codesFor([artifact({ filename: 'payload.zip' })])).toContain('unsupported-media-type');
    expect(codesFor([artifact({ declaredMediaType: 'application/zip' })])).toContain(
      'unsupported-media-type',
    );
    expect(codesFor([artifact({ declaredMediaType: 'text/html' })])).toContain(
      'unsupported-media-type',
    );
  });

  it('derives the canonical media type from the extension, not the client (CT03-A21)', () => {
    // A browser labelling YAML as octet-stream must still produce the digest a
    // browser labelling it application/yaml produces.
    const declaredYaml = analyzePlanBundle({ artifacts: syntheticBundle(VALID_BREAKDOWN) });
    const declaredOctet = analyzePlanBundle({
      artifacts: syntheticBundle(VALID_BREAKDOWN).map((a) =>
        a.fieldName === 'work-breakdown'
          ? { ...a, declaredMediaType: 'application/octet-stream' }
          : a,
      ),
    });
    expect(declaredOctet.digest?.hex).toBe(declaredYaml.digest?.hex);
    expect(declaredOctet.artifacts.find((a) => a.role === 'work-breakdown')?.mediaType).toBe(
      'application/yaml',
    );
  });

  it('rejects an unknown artifact role (CT03-A23)', () => {
    expect(codesFor([artifact({ fieldName: 'arbitrary-upload' })])).toContain(
      'unknown-artifact-role',
    );
  });

  it('rejects a repeated single-instance role (CT03-A23)', () => {
    const base = syntheticBundle(VALID_BREAKDOWN);
    const codes = codesFor([
      ...base,
      { ...(base[0] as PlanBundleArtifactInput), filename: 'plan-two.md' },
    ]);
    expect(codes).toContain('duplicate-artifact-role');
  });

  it('rejects an oversized or truncated artifact without buffering it (CT03-A23)', () => {
    expect(codesFor([artifact({ truncated: true })])).toContain('artifact-too-large');
    expect(
      codesFor([artifact({ bytes: new Uint8Array(PLAN_BUNDLE_LIMITS.maxBytesPerArtifact + 1) })]),
    ).toContain('artifact-too-large');
  });

  it('rejects an empty artifact (CT03-A23)', () => {
    expect(codesFor([artifact({ bytes: new Uint8Array(0) })])).toContain('empty-artifact');
  });

  it('surfaces transport-enforced count and total-size limits (CT03-A23)', () => {
    const tooMany = analyzePlanBundle({
      artifacts: syntheticBundle(VALID_BREAKDOWN),
      transportFindings: [{ kind: 'too-many-artifacts', observed: 13 }],
    });
    expect(tooMany.diagnostics.map((d) => d.code)).toContain('too-many-artifacts');
    expect(tooMany.fatal).toBe(true);
    expect(tooMany.digest).toBeUndefined();

    const tooBig = analyzePlanBundle({
      artifacts: syntheticBundle(VALID_BREAKDOWN),
      transportFindings: [{ kind: 'total-size-exceeded', observed: 9_000_000 }],
    });
    expect(tooBig.diagnostics.map((d) => d.code)).toContain('total-size-exceeded');
    expect(tooBig.fatal).toBe(true);
  });

  it('rejects more supporting artifacts than the role permits (CT03-A23)', () => {
    const extras = Array.from({ length: PLAN_BUNDLE_LIMITS.maxSupportingArtifacts + 1 }, (_, i) =>
      artifact({ filename: `extra-${i}.md` }),
    );
    expect(codesFor([...syntheticBundle(VALID_BREAKDOWN), ...extras])).toContain(
      'too-many-artifacts',
    );
  });

  it('rejects a checksum manifest that disagrees with the submitted bytes', () => {
    const manifest = `${'0'.repeat(64)}  breakdown.yaml\n`;
    const codes = codesFor([
      ...syntheticBundle(VALID_BREAKDOWN),
      artifact({
        fieldName: 'validation-manifest',
        filename: 'sums.sha256',
        declaredMediaType: 'application/octet-stream',
        bytes: encoder.encode(manifest),
      }),
    ]);
    expect(codes).toContain('checksum-mismatch');
  });

  it('warns when a checksum manifest names an artifact that was not submitted', () => {
    const manifest = `${'0'.repeat(64)}  absent.md\n`;
    const analysis = analyzePlanBundle({
      artifacts: [
        ...syntheticBundle(VALID_BREAKDOWN),
        artifact({
          fieldName: 'validation-manifest',
          filename: 'sums.sha256',
          declaredMediaType: 'application/octet-stream',
          bytes: encoder.encode(manifest),
        }),
      ],
    });
    expect(analysis.diagnostics.map((d) => d.code)).toContain('checksum-unmatched-entry');
    expect(analysis.fatal).toBe(false);
  });

  it('rejects a supporting YAML artifact that is not safe YAML', () => {
    const codes = codesFor([
      ...syntheticBundle(VALID_BREAKDOWN),
      artifact({
        filename: 'supporting.yaml',
        declaredMediaType: 'application/yaml',
        bytes: encoder.encode(readInvalidFixtureText('unknown-tag.yaml')),
      }),
    ]);
    expect(codes).toContain('invalid-yaml');
  });

  it('rejects a JSON artifact that is not valid JSON', () => {
    const codes = codesFor([
      ...syntheticBundle(VALID_BREAKDOWN),
      artifact({
        filename: 'data.json',
        declaredMediaType: 'application/json',
        bytes: encoder.encode('{ "a": '),
      }),
    ]);
    expect(codes).toContain('invalid-yaml');
  });

  it('does not interpret Markdown prose as planning data', () => {
    const analysis = analyzePlanBundle({
      artifacts: syntheticBundle(VALID_BREAKDOWN).map((a) =>
        a.fieldName === 'implementation-plan'
          ? {
              ...a,
              bytes: encoder.encode('# Plan\n\nWI-02 depends on WI-01 and blocks WI-03.\n'),
            }
          : a,
      ),
    });
    // Only the work breakdown defines the graph (CT-03 §5.4).
    expect(analysis.plan?.workItems.map((i) => i.sourceId)).toEqual(['WI-01']);
    expect(analysis.graph?.requiredEdges).toEqual([]);
  });

  it('orders diagnostics deterministically regardless of discovery order', () => {
    const first = analyzePlanBundle({
      artifacts: [artifact({ filename: 'b.exe' }), artifact({ filename: 'a.exe' })],
    }).diagnostics;
    const second = analyzePlanBundle({
      artifacts: [artifact({ filename: 'a.exe' }), artifact({ filename: 'b.exe' })],
    }).diagnostics;
    expect(first).toEqual(second);
  });
});

/**
 * CT03-R4 regression cover.
 *
 * The first review found that a required role could be supplied in the wrong
 * source class, and that such a bundle failed with an *empty* diagnostics
 * array — an unactionable failure.
 */
describe('required role source classes (CT03-R4)', () => {
  const workBreakdownJson = JSON.stringify({
    document: 'X',
    pull_requests: [
      {
        id: 'WI-01',
        title: 'T',
        depends_on: [],
        risk: 'low',
        primary_areas: ['core'],
        exit_gate: 'G',
      },
    ],
  });

  it('rejects a JSON work breakdown rather than parsing it as generic JSON', () => {
    const analysis = analyzePlanBundle({
      artifacts: [
        MINIMAL_PLAN_ARTIFACT,
        {
          fieldName: 'work-breakdown',
          filename: 'breakdown.json',
          declaredMediaType: 'application/json',
          bytes: encoder.encode(workBreakdownJson),
        },
      ],
    });
    expect(analysis.fatal).toBe(true);
    expect(analysis.diagnostics.map((d) => d.code)).toContain('artifact-role-format-mismatch');
    expect(analysis.plan).toBeUndefined();
    expect(analysis.digest).toBeUndefined();
  });

  it('rejects a YAML implementation plan', () => {
    const analysis = analyzePlanBundle({
      artifacts: [
        {
          fieldName: 'implementation-plan',
          filename: 'plan.yaml',
          declaredMediaType: 'application/yaml',
          bytes: encoder.encode('document: X\n'),
        },
        {
          fieldName: 'work-breakdown',
          filename: 'breakdown.yaml',
          declaredMediaType: 'application/yaml',
          bytes: encoder.encode(VALID_BREAKDOWN),
        },
      ],
    });
    expect(analysis.diagnostics.map((d) => d.code)).toContain('artifact-role-format-mismatch');
    expect(analysis.fatal).toBe(true);
  });

  it('still accepts every permitted spelling of the required roles', () => {
    for (const [planName, breakdownName] of [
      ['plan.md', 'breakdown.yaml'],
      ['plan.markdown', 'breakdown.yml'],
    ] as const) {
      const analysis = analyzePlanBundle({
        artifacts: [
          {
            fieldName: 'implementation-plan',
            filename: planName,
            declaredMediaType: 'text/markdown',
            bytes: encoder.encode('# Plan\n'),
          },
          {
            fieldName: 'work-breakdown',
            filename: breakdownName,
            declaredMediaType: 'application/yaml',
            bytes: encoder.encode(VALID_BREAKDOWN),
          },
        ],
      });
      expect(analysis.diagnostics, `${planName}/${breakdownName}`).toEqual([]);
      expect(analysis.plan?.workItems).toHaveLength(1);
    }
  });

  it('leaves optional roles free to use any accepted source class', () => {
    const analysis = analyzePlanBundle({
      artifacts: [
        ...syntheticBundle(VALID_BREAKDOWN),
        {
          fieldName: 'supporting',
          filename: 'notes.json',
          declaredMediaType: 'application/json',
          bytes: encoder.encode('{"note":"ok"}'),
        },
      ],
    });
    expect(analysis.fatal).toBe(false);
  });

  it('never reports a fatal analysis with an empty diagnostics list', () => {
    // Every shape that can prevent a usable plan must still explain itself.
    for (const artifacts of [
      [],
      [MINIMAL_PLAN_ARTIFACT],
      [
        MINIMAL_PLAN_ARTIFACT,
        {
          fieldName: 'work-breakdown',
          filename: 'breakdown.json',
          declaredMediaType: 'application/json',
          bytes: encoder.encode(workBreakdownJson),
        },
      ],
      [
        MINIMAL_PLAN_ARTIFACT,
        {
          fieldName: 'work-breakdown',
          filename: 'breakdown.txt',
          declaredMediaType: 'text/plain',
          bytes: encoder.encode('not a plan'),
        },
      ],
    ]) {
      const analysis = analyzePlanBundle({ artifacts });
      expect(analysis.plan, JSON.stringify(artifacts.map((a) => a.filename))).toBeUndefined();
      expect(analysis.fatal).toBe(true);
      expect(analysis.errorCount).toBeGreaterThan(0);
      expect(analysis.diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
    }
  });
});
