import type { AgentModel } from '@craftingtable/domain';
import { isRecord } from '../bounded.js';
import {
  MODEL_CATALOG_LIMIT,
  MODEL_ID,
  ModelCatalogError,
  type ModelDiscovery,
  modelLabel,
} from '../model-catalog.js';
import { withCodexAppServer } from './isolation.js';

/** Pages of `model/list` read at most; a catalog longer than that is cut, not refused. */
const MAX_PAGES = 5;

/** One `model/list` page's models, or why its shape is not the one this release reads. */
function parsePage(result: unknown): { models: AgentModel[]; next?: string } {
  const unsupported = (what: string) =>
    new ModelCatalogError(
      'catalog-format-unsupported',
      `Codex's model/list answer has an unsupported ${what}.`,
    );
  if (!isRecord(result) || !Array.isArray(result.data)) throw unsupported('shape');
  const next = result.nextCursor;
  if (next !== undefined && next !== null && typeof next !== 'string') throw unsupported('cursor');
  const models = result.data.map((entry): AgentModel => {
    if (!isRecord(entry)) throw unsupported('model entry');
    // `model` is the slug a thread is started with; `id` names the catalog's preset.
    const { model, displayName, hidden } = entry;
    if (typeof model !== 'string' || !MODEL_ID.test(model)) throw unsupported('model id');
    if (!modelLabel(displayName)) throw unsupported('display name');
    if (typeof hidden !== 'boolean') throw unsupported('hidden flag');
    return { id: model, label: displayName, section: 'main', hidden };
  });
  return { models, ...(typeof next === 'string' && next.length > 0 ? { next } : {}) };
}

/**
 * Codex's own model catalog (R-G15), from its app-server's `model/list`: in the published
 * protocol, but marked experimental, so its answer is read strictly. Hidden models are listed
 * too, flagged, since they remain valid ids.
 */
export function listCodexModels(options: {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<ModelDiscovery> {
  // One bound for the whole look, however many pages, so a refresh or a shutdown never waits
  // on it longer (R-G15 review).
  return withCodexAppServer({ ...options, deadlineMs: options.timeoutMs }, async (rpc) => {
    const models: AgentModel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && models.length < MODEL_CATALOG_LIMIT; page++) {
      let result: unknown;
      try {
        result = await rpc.request('model/list', {
          includeHidden: true,
          limit: MODEL_CATALOG_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        throw new ModelCatalogError(
          'catalog-request-failed',
          `Codex did not list its models: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const parsed = parsePage(result);
      models.push(...parsed.models);
      cursor = parsed.next;
      if (cursor === undefined) break;
    }
    return { models };
  });
}
