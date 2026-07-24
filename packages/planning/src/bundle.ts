import {
  isPlanArtifactRole,
  type PlanArtifactRole,
  REPEATABLE_PLAN_ARTIFACT_ROLES,
  REQUIRED_PLAN_ARTIFACT_ROLES,
} from '@craftingtable/domain';
import { type BundleDigest, computeBundleDigest, sha256Hex } from './digest.js';
import {
  countBySeverity,
  error,
  hasFatal,
  type PlanDiagnostic,
  sortDiagnostics,
  warning,
} from './diagnostics.js';
import { analyzePlanGraph, type PlanGraph } from './graph.js';
import {
  ACCEPTED_DECLARED_MEDIA_TYPES,
  ACCEPTED_EXTENSIONS,
  type AcceptedExtension,
  CHECKSUM_EXTENSIONS,
  PLAN_BUNDLE_LIMITS,
  PLAN_LIMITS,
  YAML_EXTENSIONS,
} from './limits.js';
import { type NormalizedPlan, normalizePlan } from './normalize.js';
import { parseYamlDocument } from './parse.js';

/**
 * One uploaded part, as observed by the transport, before any interpretation.
 *
 * The role is the multipart field name — never guessed from the filename or the
 * prose inside the file (work-items/CT-03/CT-03.md §5.1).
 */
export interface PlanBundleArtifactInput {
  readonly fieldName: string;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly bytes: Uint8Array;
  /** True when the transport stopped buffering at the per-file limit. */
  readonly truncated?: boolean;
}

/** Limits the transport enforced while streaming, before the parser ran. */
export interface TransportFinding {
  readonly kind: 'too-many-artifacts' | 'total-size-exceeded';
  readonly observed: number;
}

export interface PlanBundleInput {
  readonly artifacts: readonly PlanBundleArtifactInput[];
  readonly transportFindings?: readonly TransportFinding[];
}

export interface AcceptedPlanArtifact {
  readonly role: PlanArtifactRole;
  readonly logicalFilename: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface PlanBundleAnalysis {
  readonly diagnostics: readonly PlanDiagnostic[];
  readonly errorCount: number;
  readonly warningCount: number;
  readonly fatal: boolean;
  readonly artifacts: readonly AcceptedPlanArtifact[];
  readonly totalByteLength: number;
  /**
   * Present only when the accepted artifact set is exactly what the client
   * sent. A digest over a partially-rejected set would identify a bundle nobody
   * submitted, so it is withheld rather than recorded misleadingly.
   */
  readonly digest?: BundleDigest;
  readonly plan?: NormalizedPlan;
  readonly graph?: PlanGraph;
}

const LOGICAL_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Scanned rather than matched by regex, so the intent stays legible. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function extensionOf(filename: string): AcceptedExtension | undefined {
  const lower = filename.toLowerCase();
  for (const extension of Object.keys(ACCEPTED_EXTENSIONS) as AcceptedExtension[]) {
    if (lower.endsWith(extension) && lower.length > extension.length) {
      return extension;
    }
  }
  return undefined;
}

interface ValidatedName {
  readonly logicalFilename: string;
  readonly extension: AcceptedExtension;
  readonly mediaType: string;
}

/**
 * Validates a client-supplied filename as a *label*.
 *
 * The result is never joined to a path, opened, or written — CraftingTable has
 * no filesystem import path — but a hostile label could still poison
 * downstream display, checksum matching, and digest ordering, so the accepted
 * shape is deliberately narrow.
 */
function validateFilename(raw: string): ValidatedName | PlanDiagnostic {
  const normalized = raw.normalize('NFC').trim();
  const reject = (reason: string): PlanDiagnostic =>
    error('invalid-logical-filename', `Filename "${raw}" ${reason}`, {
      artifactName: normalized.slice(0, PLAN_BUNDLE_LIMITS.maxLogicalFilenameLength),
    });

  if (normalized.length === 0) {
    return reject('is empty');
  }
  if (normalized.length > PLAN_BUNDLE_LIMITS.maxLogicalFilenameLength) {
    return reject(`exceeds ${PLAN_BUNDLE_LIMITS.maxLogicalFilenameLength} characters`);
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    return reject('contains a path separator');
  }
  if (hasControlCharacter(normalized)) {
    return reject('contains a control character');
  }
  if (normalized === '.' || normalized === '..') {
    return reject('is a relative path segment');
  }
  if (!LOGICAL_FILENAME_PATTERN.test(normalized)) {
    return reject('contains characters outside [A-Za-z0-9._-] or does not start with one');
  }
  if (normalized.endsWith('.') || normalized.endsWith('-')) {
    return reject('must not end with "." or "-"');
  }
  const extension = extensionOf(normalized);
  if (extension === undefined) {
    return error(
      'unsupported-media-type',
      `Filename "${raw}" does not use an accepted extension (${Object.keys(ACCEPTED_EXTENSIONS).join(', ')})`,
      { artifactName: normalized },
    );
  }
  return { logicalFilename: normalized, extension, mediaType: ACCEPTED_EXTENSIONS[extension] };
}

interface ChecksumEntry {
  readonly sha256: string;
  readonly filename: string;
}

function parseChecksumManifest(text: string): readonly ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (match !== null) {
      entries.push({ sha256: match[1] as string, filename: (match[2] as string).trim() });
    }
  }
  return entries;
}

function verifyChecksums(
  artifacts: readonly AcceptedPlanArtifact[],
  diagnostics: PlanDiagnostic[],
): void {
  const byName = new Map(artifacts.map((artifact) => [artifact.logicalFilename, artifact]));
  for (const manifest of artifacts) {
    if (!CHECKSUM_EXTENSIONS.some((extension) => manifest.logicalFilename.endsWith(extension))) {
      continue;
    }
    for (const entry of parseChecksumManifest(Buffer.from(manifest.bytes).toString('utf8'))) {
      const target = byName.get(entry.filename);
      if (target === undefined) {
        diagnostics.push(
          warning(
            'checksum-unmatched-entry',
            `Checksum manifest lists "${entry.filename}", which was not submitted`,
            { artifactName: manifest.logicalFilename },
          ),
        );
        continue;
      }
      if (target.sha256 !== entry.sha256) {
        diagnostics.push(
          error(
            'checksum-mismatch',
            `Checksum manifest expects ${entry.sha256} for "${entry.filename}" but the submitted bytes hash to ${target.sha256}`,
            { artifactName: manifest.logicalFilename },
          ),
        );
      }
    }
  }
}

/**
 * Validates, normalizes, and diagnoses one submitted plan bundle.
 *
 * This is the whole interpretation boundary: it accepts bytes plus logical
 * metadata and returns data. It opens no file, issues no SQL, performs no I/O,
 * and never throws for hostile input.
 */
export function analyzePlanBundle(input: PlanBundleInput): PlanBundleAnalysis {
  const diagnostics: PlanDiagnostic[] = [];

  for (const finding of input.transportFindings ?? []) {
    if (finding.kind === 'too-many-artifacts') {
      diagnostics.push(
        error(
          'too-many-artifacts',
          `Request contains ${finding.observed} files; the limit is ${PLAN_BUNDLE_LIMITS.maxArtifacts}`,
        ),
      );
    } else {
      diagnostics.push(
        error(
          'total-size-exceeded',
          `Request exceeds the ${PLAN_BUNDLE_LIMITS.maxTotalBytes} byte total upload limit`,
        ),
      );
    }
  }

  const accepted: AcceptedPlanArtifact[] = [];
  const roleCounts = new Map<PlanArtifactRole, number>();
  const namesSeen = new Map<string, string>();
  let artifactSetComplete = (input.transportFindings ?? []).length === 0;
  let totalByteLength = 0;

  for (const artifact of input.artifacts) {
    totalByteLength += artifact.bytes.byteLength;

    if (!isPlanArtifactRole(artifact.fieldName)) {
      diagnostics.push(
        error('unknown-artifact-role', `"${artifact.fieldName}" is not an accepted artifact role`, {
          artifactName: artifact.filename.slice(0, 200),
        }),
      );
      artifactSetComplete = false;
      continue;
    }
    const role = artifact.fieldName;

    const name = validateFilename(artifact.filename);
    if ('severity' in name) {
      diagnostics.push(name);
      artifactSetComplete = false;
      continue;
    }

    if (
      artifact.truncated === true ||
      artifact.bytes.byteLength > PLAN_BUNDLE_LIMITS.maxBytesPerArtifact
    ) {
      diagnostics.push(
        error(
          'artifact-too-large',
          `"${name.logicalFilename}" exceeds the ${PLAN_BUNDLE_LIMITS.maxBytesPerArtifact} byte per-file limit`,
          { artifactName: name.logicalFilename },
        ),
      );
      artifactSetComplete = false;
      continue;
    }
    if (artifact.bytes.byteLength === 0) {
      diagnostics.push(
        error('empty-artifact', `"${name.logicalFilename}" is empty`, {
          artifactName: name.logicalFilename,
        }),
      );
      artifactSetComplete = false;
      continue;
    }

    const declared = artifact.declaredMediaType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (declared !== '' && !ACCEPTED_DECLARED_MEDIA_TYPES.includes(declared)) {
      diagnostics.push(
        error(
          'unsupported-media-type',
          `"${name.logicalFilename}" was declared as "${declared}", which is not an accepted planning media type`,
          { artifactName: name.logicalFilename },
        ),
      );
      artifactSetComplete = false;
      continue;
    }

    const duplicateOf = namesSeen.get(name.logicalFilename.toLowerCase());
    if (duplicateOf !== undefined) {
      diagnostics.push(
        error(
          'duplicate-logical-filename',
          `"${name.logicalFilename}" duplicates "${duplicateOf}" within one request`,
          { artifactName: name.logicalFilename },
        ),
      );
      artifactSetComplete = false;
      continue;
    }
    namesSeen.set(name.logicalFilename.toLowerCase(), name.logicalFilename);
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    accepted.push({
      role,
      logicalFilename: name.logicalFilename,
      mediaType: name.mediaType,
      byteLength: artifact.bytes.byteLength,
      sha256: sha256Hex(artifact.bytes),
      bytes: artifact.bytes,
    });
  }

  if (accepted.length > PLAN_BUNDLE_LIMITS.maxArtifacts) {
    diagnostics.push(
      error(
        'too-many-artifacts',
        `Request contains ${accepted.length} files; the limit is ${PLAN_BUNDLE_LIMITS.maxArtifacts}`,
      ),
    );
    artifactSetComplete = false;
  }
  if (totalByteLength > PLAN_BUNDLE_LIMITS.maxTotalBytes) {
    diagnostics.push(
      error(
        'total-size-exceeded',
        `Request totals ${totalByteLength} bytes; the limit is ${PLAN_BUNDLE_LIMITS.maxTotalBytes}`,
      ),
    );
    artifactSetComplete = false;
  }

  for (const role of REQUIRED_PLAN_ARTIFACT_ROLES) {
    const count = roleCounts.get(role) ?? 0;
    if (count === 0) {
      diagnostics.push(
        error('required-artifact-missing', `A "${role}" artifact is required`, { path: role }),
      );
      artifactSetComplete = false;
    }
  }
  for (const [role, count] of roleCounts) {
    const repeatable = (REPEATABLE_PLAN_ARTIFACT_ROLES as readonly string[]).includes(role);
    if (!repeatable && count > 1) {
      diagnostics.push(
        error(
          'duplicate-artifact-role',
          `Role "${role}" was supplied ${count} times; it accepts exactly one artifact`,
          { path: role },
        ),
      );
      artifactSetComplete = false;
    }
    if (repeatable && count > PLAN_BUNDLE_LIMITS.maxSupportingArtifacts) {
      diagnostics.push(
        error(
          'too-many-artifacts',
          `Role "${role}" accepts at most ${PLAN_BUNDLE_LIMITS.maxSupportingArtifacts} artifacts`,
          { path: role },
        ),
      );
      artifactSetComplete = false;
    }
  }

  verifyChecksums(accepted, diagnostics);

  // Every artifact declared as YAML must actually be safe, parseable YAML.
  // Accepting an unparseable file we labelled `application/yaml` would make the
  // stored media type a lie.
  let plan: NormalizedPlan | undefined;
  let graph: PlanGraph | undefined;

  for (const artifact of accepted) {
    const isYaml = YAML_EXTENSIONS.some((extension) =>
      artifact.logicalFilename.toLowerCase().endsWith(extension),
    );
    const isJson = artifact.logicalFilename.toLowerCase().endsWith('.json');
    if (!isYaml && !isJson) {
      continue;
    }
    const text = Buffer.from(artifact.bytes).toString('utf8');
    if (isJson) {
      try {
        JSON.parse(text);
      } catch (cause) {
        diagnostics.push(
          error(
            'invalid-yaml',
            `JSON could not be parsed: ${cause instanceof Error ? cause.message : 'unknown error'}`,
            { artifactName: artifact.logicalFilename },
          ),
        );
      }
      continue;
    }

    const parsed = parseYamlDocument(text, artifact.logicalFilename);
    if (!parsed.ok) {
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    if (artifact.role !== 'work-breakdown') {
      continue;
    }
    const normalized = normalizePlan(parsed.value, artifact.logicalFilename);
    diagnostics.push(...normalized.diagnostics);
    if (normalized.plan !== undefined) {
      plan = normalized.plan;
      const analyzed = analyzePlanGraph(normalized.plan, artifact.logicalFilename);
      diagnostics.push(...analyzed.diagnostics);
      graph = analyzed.graph;
    }
  }

  const ordered = sortDiagnostics(diagnostics).slice(0, PLAN_LIMITS.maxDiagnostics);
  const { errorCount, warningCount } = countBySeverity(ordered);
  const fatal = hasFatal(ordered);

  return {
    diagnostics: ordered,
    errorCount,
    warningCount,
    fatal,
    artifacts: accepted,
    totalByteLength,
    ...(artifactSetComplete && accepted.length > 0
      ? { digest: computeBundleDigest(accepted) }
      : {}),
    ...(fatal || plan === undefined ? {} : { plan }),
    ...(fatal || graph === undefined ? {} : { graph }),
  };
}
