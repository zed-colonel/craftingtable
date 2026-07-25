import type { JsonValue } from '@craftingtable/domain';
import { parseAllDocuments } from 'yaml';
import { error, type PlanDiagnostic } from './diagnostics.js';
import { YAML_LIMITS } from './limits.js';

/**
 * Safe YAML ingestion for untrusted planning input
 * (work-items/CT-03/CT-03.md §5.16).
 *
 * The configuration below constructs plain data only: the `core` schema with
 * no custom tags cannot instantiate application objects. Anything the parser
 * reports as an error *or* a warning — unknown and unresolved tags surface as
 * warnings — is treated as fatal, because a tag we do not understand is
 * exactly the case where guessing would be unsafe.
 *
 * Alias expansion is bounded at materialisation rather than at parse:
 * `maxAliasCount` is a `toJS` option, and an alias bomb throws there.
 */
const PARSE_OPTIONS: Parameters<typeof parseAllDocuments>[1] = {
  version: '1.2',
  schema: 'core',
  customTags: [],
  strict: true,
  uniqueKeys: true,
  prettyErrors: true,
  keepSourceTokens: false,
};

export type YamlParseResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly diagnostics: readonly PlanDiagnostic[] };

function positionOf(candidate: unknown): { line?: number; column?: number } {
  if (typeof candidate !== 'object' || candidate === null || !('linePos' in candidate)) {
    return {};
  }
  const linePos = (candidate as { linePos?: readonly { line: number; col: number }[] }).linePos;
  const start = linePos?.[0];
  return start === undefined ? {} : { line: start.line, column: start.col };
}

/**
 * Rebuilds parser output as a provably JSON-serialisable value while bounding
 * depth and node count.
 *
 * `yaml` can legitimately produce values JSON cannot represent (`.inf`, `.nan`)
 * and keys that would poison a prototype chain. Both are rejected here rather
 * than in the database, so the diagnostic can name the offending path.
 */
function toJsonValue(
  value: unknown,
  path: string,
  artifactName: string,
  state: { nodes: number },
  depth: number,
  diagnostics: PlanDiagnostic[],
): JsonValue | undefined {
  state.nodes += 1;
  if (state.nodes > YAML_LIMITS.maxNodes) {
    if (diagnostics.length === 0) {
      diagnostics.push(
        error('yaml-too-complex', `Document exceeds ${YAML_LIMITS.maxNodes} nodes`, {
          artifactName,
        }),
      );
    }
    return undefined;
  }
  if (depth > YAML_LIMITS.maxDepth) {
    diagnostics.push(
      error('yaml-too-complex', `Document nests deeper than ${YAML_LIMITS.maxDepth} levels`, {
        artifactName,
        path,
      }),
    );
    return undefined;
  }

  if (value === null) {
    return null;
  }
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') {
    return value as string | boolean;
  }
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) {
      diagnostics.push(
        error('unsupported-yaml-scalar', 'Infinity and NaN are not representable', {
          artifactName,
          path,
        }),
      );
      return undefined;
    }
    return value as number;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const converted = toJsonValue(
        item,
        `${path}[${index}]`,
        artifactName,
        state,
        depth + 1,
        diagnostics,
      );
      if (converted === undefined) {
        return undefined;
      }
      items.push(converted);
    }
    return items;
  }
  if (kind === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        diagnostics.push(
          error('unsafe-yaml-key', `Key "${key}" is not permitted in planning input`, {
            artifactName,
            path: path === '' ? key : `${path}.${key}`,
          }),
        );
        return undefined;
      }
      const converted = toJsonValue(
        item,
        path === '' ? key : `${path}.${key}`,
        artifactName,
        state,
        depth + 1,
        diagnostics,
      );
      if (converted === undefined) {
        return undefined;
      }
      result[key] = converted;
    }
    return result;
  }

  diagnostics.push(
    error('unsupported-yaml-scalar', `Value of type ${kind} is not representable as JSON`, {
      artifactName,
      path,
    }),
  );
  return undefined;
}

/**
 * Parses one YAML document into plain JSON data, or returns actionable
 * diagnostics. Never throws for malformed input.
 */
export function parseYamlDocument(text: string, artifactName: string): YamlParseResult {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(text, PARSE_OPTIONS);
  } catch (cause) {
    return {
      ok: false,
      diagnostics: [
        error('invalid-yaml', `YAML could not be parsed: ${describe(cause)}`, { artifactName }),
      ],
    };
  }

  if (documents.length === 0) {
    return {
      ok: false,
      diagnostics: [error('invalid-yaml', 'YAML document is empty', { artifactName })],
    };
  }
  if (documents.length > 1) {
    return {
      ok: false,
      diagnostics: [
        error('multiple-yaml-documents', `Expected one YAML document, found ${documents.length}`, {
          artifactName,
        }),
      ],
    };
  }

  const document = documents[0];
  if (document === undefined) {
    return {
      ok: false,
      diagnostics: [error('invalid-yaml', 'YAML document is empty', { artifactName })],
    };
  }

  const parseProblems = [...document.errors, ...document.warnings];
  if (parseProblems.length > 0) {
    return {
      ok: false,
      diagnostics: parseProblems.slice(0, 10).map((problem) =>
        error('invalid-yaml', problem.message, {
          artifactName,
          ...positionOf(problem),
        }),
      ),
    };
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: YAML_LIMITS.maxAliasCount });
  } catch (cause) {
    // Alias expansion beyond maxAliasCount throws here rather than at parse.
    return {
      ok: false,
      diagnostics: [
        error('yaml-too-complex', `YAML could not be materialised: ${describe(cause)}`, {
          artifactName,
        }),
      ],
    };
  }

  const diagnostics: PlanDiagnostic[] = [];
  const value = toJsonValue(raw, '', artifactName, { nodes: 0 }, 0, diagnostics);
  if (value === undefined) {
    return {
      ok: false,
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : [error('invalid-yaml', 'YAML document produced no value', { artifactName })],
    };
  }
  return { ok: true, value };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown error';
}
