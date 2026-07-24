/**
 * The `exo-work-breakdown-v1` source profile (work-items/CT-03/CT-03.md §5.3).
 *
 * Recognition is not the same as retention. Every source field is retained
 * verbatim in `metadata` / `sourceFields` regardless of whether it appears
 * below (CT03-I16); these lists only say which fields CraftingTable projects
 * into first-class normalized properties.
 */

export const SOURCE_PROFILE = 'exo-work-breakdown-v1' as const;

/** Top-level keys the importer must find. */
export const REQUIRED_TOP_LEVEL_FIELDS = ['document', 'pull_requests'] as const;

/** Top-level keys the importer projects into normalized properties. */
export const RECOGNIZED_TOP_LEVEL_FIELDS = [
  'document',
  'pull_requests',
  'repository',
  'baseline_commit',
  'contract',
  'stack_revision',
  'status',
  'phase',
  'clean_break',
  'integration_branch',
  'tag',
  'release_order',
  'forbidden_release_symbols',
] as const;

/** Per-item keys every work item must supply. */
export const REQUIRED_WORK_ITEM_FIELDS = [
  'id',
  'title',
  'depends_on',
  'risk',
  'primary_areas',
  'exit_gate',
] as const;

/** Per-item keys the importer projects into normalized properties. */
export const RECOGNIZED_WORK_ITEM_FIELDS = [
  ...REQUIRED_WORK_ITEM_FIELDS,
  'recommends',
  'phase',
  'status',
  'repository',
  'baseline_commit',
  'contract',
  'stack_revision',
  'clean_break',
  'integration_branch',
  'tag',
  'release_order',
  'forbidden_release_symbols',
] as const;

/** Source key holding the work-item array. */
export const WORK_ITEM_COLLECTION_FIELD = 'pull_requests';
