import { readFileSync } from 'node:fs';
import type { PlanArtifactRole } from '@craftingtable/domain';
import type { PlanBundleArtifactInput } from './bundle.js';

/**
 * Test-only fixture loading. Production modules in this package never touch the
 * filesystem; acceptance requires real-file fixtures, so the I/O lives here.
 */

const REPOSITORY_ROOT = new URL('../../../', import.meta.url);
const AQ_FIXTURE_DIR = new URL('fixtures/plan-bundles/aq-cont-1/', REPOSITORY_ROOT);
const INVALID_FIXTURE_DIR = new URL('fixtures/plan-bundles/invalid/', REPOSITORY_ROOT);
const EXPECTATIONS = new URL('work-items/CT-03/CT-03-aq-import-expectations.yaml', REPOSITORY_ROOT);

/** Media types a browser plausibly sends for each fixture file. */
const DECLARED: Record<string, string> = {
  '.md': 'text/markdown',
  '.yaml': 'application/yaml',
  '.sha256': 'application/octet-stream',
};

function declaredTypeFor(filename: string): string {
  for (const [extension, mediaType] of Object.entries(DECLARED)) {
    if (filename.endsWith(extension)) {
      return mediaType;
    }
  }
  return 'application/octet-stream';
}

export function readFixtureBytes(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(filename, AQ_FIXTURE_DIR)));
}

export function readInvalidFixtureText(filename: string): string {
  return readFileSync(new URL(filename, INVALID_FIXTURE_DIR), 'utf8');
}

export function readExpectationsText(): string {
  return readFileSync(EXPECTATIONS, 'utf8');
}

/** Role assignment for the AQ-CONT-1 bundle, as an operator would supply it. */
export const AQ_BUNDLE_ROLES: readonly (readonly [PlanArtifactRole, string])[] = [
  ['implementation-plan', 'aq-cont-1-implementation-plan.md'],
  ['work-breakdown', 'aq-cont-1-work-breakdown.yaml'],
  ['validation-manifest', 'aq-cont-1-implementation-plan.sha256'],
  ['supporting', 'aq-cont-1-planning-package-README.md'],
  ['supporting', 'constitutional-stack-implementation-contracts.yaml'],
  ['supporting', 'actionqueue-hardening-implementation-ready.md'],
];

export function aqBundleArtifacts(): readonly PlanBundleArtifactInput[] {
  return AQ_BUNDLE_ROLES.map(([role, filename]) => ({
    fieldName: role,
    filename,
    declaredMediaType: declaredTypeFor(filename),
    bytes: readFixtureBytes(filename),
  }));
}

/** A minimal, valid two-item bundle for tests that only need a happy path. */
export function syntheticBundle(workBreakdownYaml: string): readonly PlanBundleArtifactInput[] {
  return [
    {
      fieldName: 'implementation-plan',
      filename: 'plan.md',
      declaredMediaType: 'text/markdown',
      bytes: new TextEncoder().encode('# Plan\n'),
    },
    {
      fieldName: 'work-breakdown',
      filename: 'breakdown.yaml',
      declaredMediaType: 'application/yaml',
      bytes: new TextEncoder().encode(workBreakdownYaml),
    },
  ];
}
