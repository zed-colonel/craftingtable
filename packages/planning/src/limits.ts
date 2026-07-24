/**
 * Bounds for one plan-bundle import (work-items/CT-03/CT-03.md §5.1).
 *
 * These live in the pure package and are imported by the server for its
 * multipart plugin configuration, so upload-stream enforcement and validation
 * policy cannot drift apart.
 */
export const PLAN_BUNDLE_LIMITS = {
  maxArtifacts: 12,
  maxBytesPerArtifact: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFields: 8,
  maxParts: 24,
  maxFieldByteLength: 512,
  maxHeaderPairs: 200,
  maxLogicalFilenameLength: 200,
  maxSupportingArtifacts: 10,
} as const;

/** Bounds applied to parsed YAML before it is trusted as data. */
export const YAML_LIMITS = {
  maxAliasCount: 100,
  maxDepth: 32,
  maxNodes: 20_000,
} as const;

/** Bounds applied to the normalized work breakdown. */
export const PLAN_LIMITS = {
  maxWorkItems: 2000,
  maxSourceIdLength: 64,
  maxTitleLength: 300,
  maxDocumentLength: 300,
  maxExitGateLength: 1000,
  maxPrimaryAreas: 32,
  maxPrimaryAreaLength: 64,
  maxDependenciesPerItem: 64,
  maxReportedCycles: 20,
  maxDiagnostics: 500,
} as const;

/**
 * Accepted logical filename extensions and the canonical media type each one
 * implies.
 *
 * The canonical media type is derived from the validated extension rather than
 * from the client-declared content type, so a browser that labels `.yaml` as
 * `application/octet-stream` still produces the same canonical bundle digest as
 * one that labels it `application/yaml`. Digest stability across clients is
 * what makes duplicate detection (CT03-A29) trustworthy.
 */
export const ACCEPTED_EXTENSIONS = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.sha256': 'text/plain',
} as const satisfies Record<string, string>;

export type AcceptedExtension = keyof typeof ACCEPTED_EXTENSIONS;

/**
 * Client-declared content types we tolerate. `application/octet-stream` is
 * included because browsers routinely send it for `.yaml` and `.sha256`; the
 * canonical type still comes from the extension.
 */
export const ACCEPTED_DECLARED_MEDIA_TYPES: readonly string[] = [
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'application/json',
  'application/yaml',
  'text/yaml',
  'application/x-yaml',
  'text/x-yaml',
  'application/octet-stream',
];

/**
 * The source class each artifact role must be supplied in.
 *
 * CT-03 §5.1 requires "one implementation-plan Markdown file" and "one
 * work-breakdown YAML file". Dispatching on extension alone let a JSON
 * work-breakdown be accepted as generic JSON and never parsed as a plan, so the
 * required roles are pinned to their formats here.
 */
export const REQUIRED_ROLE_SOURCE_CLASSES = {
  'implementation-plan': ['markdown'],
  'work-breakdown': ['yaml'],
} as const satisfies Record<string, readonly string[]>;

export type SourceClass = 'markdown' | 'yaml' | 'json' | 'text';

export const EXTENSION_SOURCE_CLASSES = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.txt': 'text',
  '.sha256': 'text',
} as const satisfies Record<string, SourceClass>;

/** Extensions whose bytes are parsed as YAML. */
export const YAML_EXTENSIONS: readonly AcceptedExtension[] = ['.yaml', '.yml'];

/** Extensions whose bytes are parsed as a checksum manifest. */
export const CHECKSUM_EXTENSIONS: readonly AcceptedExtension[] = ['.sha256'];
