import type { AgentModel, ModelCatalogIssue, ModelCatalogStatus } from '@craftingtable/domain';

/** At most this many models are kept from one catalog; the wire contract allows as many. */
export const MODEL_CATALOG_LIMIT = 100;

/** A model id a CLI can be sent: also the bound `CRAFTINGTABLE_*_MODELS` entries meet. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** A catalog's section name; anything else makes the catalog unsupported. */
export const MODEL_SECTION = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * A display name: 1 to 100 UTF-16 code units (the wire contract's measure), none of them
 * controls.
 */
export function modelLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 100 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && (codePoint < 127 || codePoint > 159);
    })
  );
}

/** Why a look at a catalog gave nothing usable; the code is what the daemon reports. */
export class ModelCatalogError extends Error {
  constructor(
    readonly issue: ModelCatalogIssue,
    message: string,
  ) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}

/** What one look at a CLI's catalog found. */
export interface ModelDiscovery {
  readonly models: readonly AgentModel[];
  /** The list is usable, but something was left out of it. */
  readonly issue?: ModelCatalogIssue;
}

export interface ModelCatalogSnapshot {
  readonly models: readonly AgentModel[];
  readonly status: ModelCatalogStatus;
  /** Why the last look failed, for the daemon's log; never sent to the browser. */
  readonly detail?: string;
}

/**
 * A backend's model list (R-G15): the release's own list until the CLI's catalog is read, then
 * the last catalog read. A failed look keeps the list in use and says why. An operator's
 * `CRAFTINGTABLE_*_MODELS` list (no `discover`) replaces the catalog and is never refreshed.
 */
export class ModelCatalog {
  private snapshot: ModelCatalogSnapshot;
  private pending: Promise<ModelCatalogSnapshot> | undefined;

  constructor(
    private readonly discover: (() => Promise<ModelDiscovery>) | undefined,
    initial: readonly AgentModel[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.snapshot = {
      // An operator's list is cut like a catalog: the execution status carries at most this many.
      models: initial.slice(0, MODEL_CATALOG_LIMIT),
      status: { source: discover === undefined ? 'environment' : 'fallback' },
    };
  }

  current(): ModelCatalogSnapshot {
    return this.snapshot;
  }

  /** Reads the catalog again; looks already under way are shared, not repeated. */
  refresh(): Promise<ModelCatalogSnapshot> {
    const discover = this.discover;
    if (discover === undefined) return Promise.resolve(this.snapshot);
    this.pending ??= this.look(discover).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async look(discover: () => Promise<ModelDiscovery>): Promise<ModelCatalogSnapshot> {
    let found: ModelDiscovery | undefined;
    let issue: ModelCatalogIssue | undefined;
    let detail: string | undefined;
    try {
      found = await discover();
    } catch (error) {
      issue = error instanceof ModelCatalogError ? error.issue : 'catalog-request-failed';
      detail = error instanceof Error ? error.message : String(error);
    }
    const checkedAt = this.now().toISOString();
    const seen = new Set<string>();
    const models = (found?.models ?? [])
      .filter((model) => !seen.has(model.id) && seen.add(model.id))
      .slice(0, MODEL_CATALOG_LIMIT);
    if (found !== undefined && models.length === 0) issue = 'catalog-empty';
    if (issue === undefined) {
      this.snapshot = {
        models,
        status: {
          source: 'catalog',
          listedAt: checkedAt,
          checkedAt,
          ...(found?.issue === undefined ? {} : { issue: found.issue }),
        },
      };
    } else {
      const { source, listedAt } = this.snapshot.status;
      this.snapshot = {
        models: this.snapshot.models,
        status: { source, ...(listedAt === undefined ? {} : { listedAt }), checkedAt, issue },
        ...(detail === undefined ? {} : { detail }),
      };
    }
    return this.snapshot;
  }
}
