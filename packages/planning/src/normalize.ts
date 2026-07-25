import { type JsonValue, isWorkItemRisk, type WorkItemRisk } from '@craftingtable/domain';
import { error, type PlanDiagnostic, warning } from './diagnostics.js';
import {
  REQUIRED_TOP_LEVEL_FIELDS,
  SOURCE_PROFILE,
  WORK_ITEM_COLLECTION_FIELD,
} from './exo-work-breakdown-schema.js';
import { PLAN_LIMITS } from './limits.js';

export interface NormalizedWorkItem {
  readonly sourceId: string;
  /** Position in the source array; display order, never semantic identity. */
  readonly ordinal: number;
  readonly title: string;
  readonly risk: WorkItemRisk;
  readonly phase?: string;
  readonly primaryAreas: readonly string[];
  readonly exitGate: string;
  readonly requiredDependencies: readonly string[];
  readonly recommendedDependencies: readonly string[];
  /** Every source key of this item, verbatim. */
  readonly sourceFields: JsonValue;
}

export interface NormalizedPlan {
  readonly sourceProfile: typeof SOURCE_PROFILE;
  readonly document: string;
  readonly repository?: string;
  readonly baselineCommit?: string;
  readonly contract?: string;
  readonly stackRevision?: string;
  readonly status?: string;
  readonly phase?: string;
  /** Every top-level source key, verbatim. */
  readonly metadata: JsonValue;
  readonly workItems: readonly NormalizedWorkItem[];
}

export interface NormalizeResult {
  readonly plan?: NormalizedPlan;
  readonly diagnostics: readonly PlanDiagnostic[];
}

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  record: { readonly [key: string]: JsonValue },
  key: string,
): string | undefined {
  const raw = record[key];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const value = raw.normalize('NFC').trim();
  return value.length === 0 ? undefined : value;
}

/**
 * Reads a dependency list. Absent and null both mean "no dependencies"; any
 * other non-array shape is a field error rather than a silent empty list, so a
 * typo cannot quietly drop a real edge.
 */
function dependencyList(
  record: { readonly [key: string]: JsonValue },
  key: string,
  sourceId: string,
  itemPath: string,
  diagnostics: PlanDiagnostic[],
  artifactName: string,
): readonly string[] {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    diagnostics.push(
      error('invalid-work-item-field', `"${key}" must be a list of work-item identifiers`, {
        artifactName,
        path: `${itemPath}.${key}`,
        workItemSourceId: sourceId,
      }),
    );
    return [];
  }
  if (raw.length > PLAN_LIMITS.maxDependenciesPerItem) {
    diagnostics.push(
      error(
        'invalid-work-item-field',
        `"${key}" exceeds ${PLAN_LIMITS.maxDependenciesPerItem} entries`,
        { artifactName, path: `${itemPath}.${key}`, workItemSourceId: sourceId },
      ),
    );
    return [];
  }
  const values: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string') {
      diagnostics.push(
        error('invalid-work-item-field', `"${key}" entries must be strings`, {
          artifactName,
          path: `${itemPath}.${key}[${index}]`,
          workItemSourceId: sourceId,
        }),
      );
      continue;
    }
    const value = entry.normalize('NFC').trim();
    if (value.length === 0 || !SOURCE_ID_PATTERN.test(value)) {
      diagnostics.push(
        error('invalid-work-item-id', `"${entry}" is not a well-formed work-item identifier`, {
          artifactName,
          path: `${itemPath}.${key}[${index}]`,
          workItemSourceId: sourceId,
        }),
      );
      continue;
    }
    values.push(value);
  }
  return values;
}

function primaryAreas(
  record: { readonly [key: string]: JsonValue },
  sourceId: string,
  itemPath: string,
  diagnostics: PlanDiagnostic[],
  artifactName: string,
): readonly string[] {
  const raw = record.primary_areas;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    diagnostics.push(
      error('invalid-work-item-field', '"primary_areas" must be a list of strings', {
        artifactName,
        path: `${itemPath}.primary_areas`,
        workItemSourceId: sourceId,
      }),
    );
    return [];
  }
  const areas: string[] = [];
  for (const [index, entry] of raw.slice(0, PLAN_LIMITS.maxPrimaryAreas).entries()) {
    if (typeof entry !== 'string') {
      diagnostics.push(
        error('invalid-work-item-field', '"primary_areas" entries must be strings', {
          artifactName,
          path: `${itemPath}.primary_areas[${index}]`,
          workItemSourceId: sourceId,
        }),
      );
      continue;
    }
    const value = entry.normalize('NFC').trim().slice(0, PLAN_LIMITS.maxPrimaryAreaLength);
    if (value.length > 0) {
      areas.push(value);
    }
  }
  return areas;
}

/**
 * Normalizes risk into the closed domain vocabulary.
 *
 * An unmodelled risk word must never fail an import: it becomes `unspecified`
 * with a warning, and the raw value survives in `sourceFields`.
 */
function normalizeRisk(
  record: { readonly [key: string]: JsonValue },
  sourceId: string,
  itemPath: string,
  diagnostics: PlanDiagnostic[],
  artifactName: string,
): WorkItemRisk {
  const raw = record.risk;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    diagnostics.push(
      error('invalid-work-item-field', '"risk" is required and must be a non-empty string', {
        artifactName,
        path: `${itemPath}.risk`,
        workItemSourceId: sourceId,
      }),
    );
    return 'unspecified';
  }
  const value = raw.normalize('NFC').trim().toLowerCase();
  if (isWorkItemRisk(value) && value !== 'unspecified') {
    return value;
  }
  diagnostics.push(
    warning('unrecognized-risk', `Risk "${raw}" is not recognized; recorded as unspecified`, {
      artifactName,
      path: `${itemPath}.risk`,
      workItemSourceId: sourceId,
    }),
  );
  return 'unspecified';
}

function requiredText(
  record: { readonly [key: string]: JsonValue },
  key: string,
  maxLength: number,
  sourceId: string,
  itemPath: string,
  diagnostics: PlanDiagnostic[],
  artifactName: string,
): string | undefined {
  const raw = record[key];
  if (typeof raw !== 'string') {
    diagnostics.push(
      error('invalid-work-item-field', `"${key}" is required and must be a string`, {
        artifactName,
        path: `${itemPath}.${key}`,
        workItemSourceId: sourceId,
      }),
    );
    return undefined;
  }
  const value = raw.normalize('NFC').trim();
  if (value.length === 0) {
    diagnostics.push(
      error('invalid-work-item-field', `"${key}" must not be empty`, {
        artifactName,
        path: `${itemPath}.${key}`,
        workItemSourceId: sourceId,
      }),
    );
    return undefined;
  }
  return value.slice(0, maxLength);
}

/**
 * Validates and normalizes a parsed work-breakdown document.
 *
 * Structural problems are collected rather than thrown, so one import reports
 * every actionable problem instead of only the first.
 */
export function normalizePlan(value: JsonValue, artifactName: string): NormalizeResult {
  const diagnostics: PlanDiagnostic[] = [];

  if (!isRecord(value)) {
    return {
      diagnostics: [
        error('invalid-work-breakdown', 'Work breakdown must be a YAML mapping', { artifactName }),
      ],
    };
  }

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (value[field] === undefined) {
      diagnostics.push(
        error('invalid-work-breakdown', `Required top-level field "${field}" is missing`, {
          artifactName,
          path: field,
        }),
      );
    }
  }

  const document = optionalString(value, 'document');
  if (value.document !== undefined && document === undefined) {
    diagnostics.push(
      error('invalid-work-breakdown', '"document" must be a non-empty string', {
        artifactName,
        path: 'document',
      }),
    );
  }

  const collection = value[WORK_ITEM_COLLECTION_FIELD];
  if (collection !== undefined && !Array.isArray(collection)) {
    diagnostics.push(
      error('invalid-work-breakdown', `"${WORK_ITEM_COLLECTION_FIELD}" must be a list`, {
        artifactName,
        path: WORK_ITEM_COLLECTION_FIELD,
      }),
    );
    return { diagnostics };
  }
  const entries = Array.isArray(collection) ? collection : [];
  if (Array.isArray(collection) && entries.length === 0) {
    diagnostics.push(
      error('missing-work-items', 'Work breakdown contains no work items', {
        artifactName,
        path: WORK_ITEM_COLLECTION_FIELD,
      }),
    );
  }
  if (entries.length > PLAN_LIMITS.maxWorkItems) {
    return {
      diagnostics: [
        ...diagnostics,
        error(
          'too-many-work-items',
          `Work breakdown contains ${entries.length} items; the limit is ${PLAN_LIMITS.maxWorkItems}`,
          { artifactName, path: WORK_ITEM_COLLECTION_FIELD },
        ),
      ],
    };
  }

  const workItems: NormalizedWorkItem[] = [];
  const seen = new Map<string, number>();

  for (const [ordinal, entry] of entries.entries()) {
    const itemPath = `${WORK_ITEM_COLLECTION_FIELD}[${ordinal}]`;
    if (!isRecord(entry)) {
      diagnostics.push(
        error('invalid-work-breakdown', 'Each work item must be a mapping', {
          artifactName,
          path: itemPath,
        }),
      );
      continue;
    }

    const rawId = entry.id;
    if (typeof rawId !== 'string') {
      diagnostics.push(
        error('invalid-work-item-id', '"id" is required and must be a string', {
          artifactName,
          path: `${itemPath}.id`,
        }),
      );
      continue;
    }
    const sourceId = rawId.normalize('NFC').trim();
    if (
      sourceId.length === 0 ||
      sourceId.length > PLAN_LIMITS.maxSourceIdLength ||
      !SOURCE_ID_PATTERN.test(sourceId)
    ) {
      diagnostics.push(
        error('invalid-work-item-id', `"${rawId}" is not a well-formed work-item identifier`, {
          artifactName,
          path: `${itemPath}.id`,
        }),
      );
      continue;
    }

    const firstOrdinal = seen.get(sourceId);
    if (firstOrdinal !== undefined) {
      diagnostics.push(
        error(
          'duplicate-work-item-id',
          `Work-item identifier "${sourceId}" appears at positions ${firstOrdinal} and ${ordinal}`,
          { artifactName, path: `${itemPath}.id`, workItemSourceId: sourceId },
        ),
      );
      continue;
    }
    seen.set(sourceId, ordinal);

    const title = requiredText(
      entry,
      'title',
      PLAN_LIMITS.maxTitleLength,
      sourceId,
      itemPath,
      diagnostics,
      artifactName,
    );
    const exitGate = requiredText(
      entry,
      'exit_gate',
      PLAN_LIMITS.maxExitGateLength,
      sourceId,
      itemPath,
      diagnostics,
      artifactName,
    );
    if (entry.depends_on === undefined) {
      diagnostics.push(
        error('invalid-work-item-field', '"depends_on" is required', {
          artifactName,
          path: `${itemPath}.depends_on`,
          workItemSourceId: sourceId,
        }),
      );
    }
    if (entry.primary_areas === undefined) {
      diagnostics.push(
        error('invalid-work-item-field', '"primary_areas" is required', {
          artifactName,
          path: `${itemPath}.primary_areas`,
          workItemSourceId: sourceId,
        }),
      );
    }

    const risk = normalizeRisk(entry, sourceId, itemPath, diagnostics, artifactName);
    const phase = optionalString(entry, 'phase');

    if (title === undefined || exitGate === undefined) {
      continue;
    }

    workItems.push({
      sourceId,
      ordinal,
      title,
      risk,
      ...(phase === undefined ? {} : { phase }),
      primaryAreas: primaryAreas(entry, sourceId, itemPath, diagnostics, artifactName),
      exitGate,
      requiredDependencies: dependencyList(
        entry,
        'depends_on',
        sourceId,
        itemPath,
        diagnostics,
        artifactName,
      ),
      recommendedDependencies: dependencyList(
        entry,
        'recommends',
        sourceId,
        itemPath,
        diagnostics,
        artifactName,
      ),
      sourceFields: entry,
    });
  }

  if (document === undefined) {
    return { diagnostics };
  }

  const repository = optionalString(value, 'repository');
  const baselineCommit = optionalString(value, 'baseline_commit');
  const contract = optionalString(value, 'contract');
  const stackRevision = optionalString(value, 'stack_revision');
  const status = optionalString(value, 'status');
  const phase = optionalString(value, 'phase');

  return {
    diagnostics,
    plan: {
      sourceProfile: SOURCE_PROFILE,
      document: document.slice(0, PLAN_LIMITS.maxDocumentLength),
      ...(repository === undefined ? {} : { repository }),
      ...(baselineCommit === undefined ? {} : { baselineCommit }),
      ...(contract === undefined ? {} : { contract }),
      ...(stackRevision === undefined ? {} : { stackRevision }),
      ...(status === undefined ? {} : { status }),
      ...(phase === undefined ? {} : { phase }),
      metadata: value,
      workItems,
    },
  };
}
