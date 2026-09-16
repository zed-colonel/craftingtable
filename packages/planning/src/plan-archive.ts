import { type ArchiveEntry, ArchiveError, decodeUtf8, readArchive } from './archive.js';
import { analyzePlanBundle, type PlanBundleInput } from './bundle.js';
import { sha256Hex } from './digest.js';
import { ACCEPTED_EXTENSIONS } from './limits.js';

export interface PlanArchiveSelection {
  readonly implementationPlan: string;
  readonly workBreakdown: string;
}
const basename = (path: string) => path.split('/').at(-1) as string;
const dirname = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const sourceType = (path: string) =>
  Object.entries(ACCEPTED_EXTENSIONS).find(([ext]) => path.toLowerCase().endsWith(ext))?.[1];
const active = (path: string) =>
  !path
    .split('/')
    .some((part) => ['provenance', 'archive', 'source-snapshots', '__MACOSX'].includes(part));

export function inspectPlanArchive(bytes: Uint8Array) {
  const entries = readArchive(bytes);
  return {
    archiveDigest: sha256Hex(bytes),
    entries: entries.map((e) => ({ path: e.path, byteLength: e.bytes.length, sha256: e.sha256 })),
    implementationPlans: entries
      .filter((e) => active(e.path) && /implementation-plan\.md$/i.test(e.path))
      .map((e) => e.path),
    workBreakdowns: entries
      .filter((e) => active(e.path) && /work-breakdown\.ya?ml$/i.test(e.path))
      .map((e) => e.path),
  };
}

export function preparePlanArchive(
  bytes: Uint8Array,
  selection: PlanArchiveSelection,
): {
  bundle: PlanBundleInput;
  entries: readonly ArchiveEntry[];
  selectedPaths: readonly string[];
} {
  const entries = readArchive(bytes);
  const plan = entries.find((e) => e.path === selection.implementationPlan);
  const breakdown = entries.find((e) => e.path === selection.workBreakdown);
  if (
    !plan ||
    !breakdown ||
    !active(plan.path) ||
    !active(breakdown.path) ||
    dirname(plan.path) !== dirname(breakdown.path)
  )
    throw new ArchiveError(
      'invalid-plan-selection',
      'Choose current plan and work-breakdown files in the same archive directory.',
    );
  const root = dirname(plan.path);
  // Preserve scripts, historical documents and manifests in the original ZIP only.
  // Agent-facing artifacts are current, text planning files in the selected package directory.
  const selected = entries.filter(
    (e) => dirname(e.path) === root && sourceType(e.path) && !e.path.endsWith('.sha256'),
  );
  if (!selected.includes(plan) || !selected.includes(breakdown))
    throw new ArchiveError('invalid-plan-selection', 'Plan files must use supported text formats.');
  const manifests = entries.filter(
    (e) =>
      dirname(e.path) === root && (basename(e.path) === 'SHA256SUMS' || e.path.endsWith('.sha256')),
  );
  for (const manifest of manifests) {
    const text = decodeUtf8(manifest.bytes);
    const namedFiles = text
      .split('\n')
      .map((line) => /^([a-f0-9]{64}) [ *](.+)$/.exec(line.trimEnd())?.[2]);
    // Package manifests identify the selected plan. External source-tree manifests
    // can contain colliding names such as README.md and must not be applied here.
    if (!namedFiles.includes(basename(plan.path)) && !namedFiles.includes(plan.path)) continue;
    for (const line of text.split('\n')) {
      const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line.trimEnd());
      if (!match) continue;
      const path = match[2] as string;
      const target = entries.find((e) => e.path === root + path || e.path === path);
      // A package-scoped manifest must match every named member.
      if (!target || target.sha256 !== match[1])
        throw new ArchiveError('checksum-mismatch', `Archive checksum mismatch: ${path}`);
    }
  }
  const bundle: PlanBundleInput = {
    artifacts: selected.map((e) => ({
      fieldName:
        e === plan ? 'implementation-plan' : e === breakdown ? 'work-breakdown' : 'supporting',
      filename: basename(e.path),
      declaredMediaType: sourceType(e.path) as string,
      bytes: e.bytes,
    })),
  };
  // Validate UTF-8 even for Markdown, which the legacy discrete-file parser preserves as bytes.
  for (const entry of selected) decodeUtf8(entry.bytes);
  return { bundle, entries, selectedPaths: selected.map((e) => e.path) };
}
export function previewSelectedPlanArchive(bytes: Uint8Array, selection: PlanArchiveSelection) {
  const prepared = preparePlanArchive(bytes, selection);
  const analysis = analyzePlanBundle(prepared.bundle);
  return {
    ...inspectPlanArchive(bytes),
    selectedPaths: prepared.selectedPaths,
    diagnostics: analysis.diagnostics,
    itemCount: analysis.plan?.workItems.length ?? 0,
    valid: !analysis.fatal,
  };
}
