/**
 * The models an agent backend offers, read from each CLI's own catalog (R-G15, LIVE-34).
 *
 * A catalog entry has an id, which is what the CLI is sent, and a display name, which is only
 * shown. LIVE-34's run failed because a display name (`GPT-6.1-Sol`) was sent as the id
 * (`gpt-6.1-sol`); `modelSpelling` is the one check that catches that, in the picker and
 * before a launch.
 */

export interface AgentModel {
  /** What the backend is sent: an alias or a model id. */
  readonly id: string;
  /** The catalog's display name. */
  readonly label: string;
  /** The catalog's group, such as `main` or `overflow`; the picker groups by it. */
  readonly section: string;
  /** Listed by the CLI but kept out of its own picker. Still a valid id. */
  readonly hidden: boolean;
}

/** Claude Code's tier aliases, which resolve inside the CLI to its current model of the tier. */
export const MODEL_ALIAS_SECTION = 'alias';

/**
 * Where a backend's list came from: the CLI's catalog, the release's built-in list (no catalog
 * has been read), or the operator's `CRAFTINGTABLE_{CLAUDE,CODEX}_MODELS`, which replaces it.
 */
export const MODEL_CATALOG_SOURCES = ['catalog', 'fallback', 'environment'] as const;
export type ModelCatalogSource = (typeof MODEL_CATALOG_SOURCES)[number];

/** Why the last look at a CLI's catalog did not give a full list. */
export const MODEL_CATALOG_ISSUES = [
  /** The CLI has not written a catalog. */
  'catalog-missing',
  /** A catalog that could not be read or parsed. */
  'catalog-unreadable',
  /** A format version or shape this release does not know; nothing of it is used. */
  'catalog-format-unsupported',
  /** A valid catalog that lists no usable model. */
  'catalog-empty',
  /** The CLI could not be asked: it did not start, answer in time, or answered with an error. */
  'catalog-request-failed',
  /** The CLI's version could not be read, so entries that need a version were left out. */
  'cli-version-unknown',
] as const;
export type ModelCatalogIssue = (typeof MODEL_CATALOG_ISSUES)[number];

export interface ModelCatalogStatus {
  readonly source: ModelCatalogSource;
  /** When the list in use was read from the CLI; absent unless `source` is `catalog`. */
  readonly listedAt?: string;
  /** When the CLI was last asked. */
  readonly checkedAt?: string;
  readonly issue?: ModelCatalogIssue;
}

export type ModelSpelling =
  /** The text is a listed id, hidden or not. */
  | { readonly kind: 'listed' }
  /** Another spelling of a listed id, or an entry's display name: `id` is what to send. */
  | { readonly kind: 'misnamed'; readonly id: string; readonly label: string }
  /** Not in the list at all. A catalog can lag a release, so this is a warning, never a block. */
  | { readonly kind: 'unlisted' };

/**
 * How `typed` relates to a backend's list. An exact id is listed. Otherwise a case-insensitive
 * match with an id, then with a display name, names the entry the operator meant.
 */
export function modelSpelling(models: readonly AgentModel[], typed: string): ModelSpelling {
  const text = typed.trim();
  if (models.some((model) => model.id === text)) return { kind: 'listed' };
  const folded = text.toLowerCase();
  const match =
    models.find((model) => model.id.toLowerCase() === folded) ??
    models.find((model) => model.label.toLowerCase() === folded);
  return match ? { kind: 'misnamed', id: match.id, label: match.label } : { kind: 'unlisted' };
}
