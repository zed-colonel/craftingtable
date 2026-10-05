import type { AgentModelOption } from './index.js';
import { MODEL_ID } from './model-catalog.js';

/**
 * Parses `id=Label,id2=Label 2,id3` into model options. Malformed entries are
 * skipped rather than failing startup; an empty result falls back to the
 * built-in list.
 */
export function parseModelList(
  value: string | undefined,
  fallback: readonly AgentModelOption[],
): readonly AgentModelOption[] {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const options: AgentModelOption[] = [];
  for (const entry of value.split(',')) {
    const [rawId, ...rest] = entry.split('=');
    const id = rawId?.trim() ?? '';
    if (!MODEL_ID.test(id)) {
      continue;
    }
    const label = rest.join('=').trim();
    options.push({
      id,
      label: label.length === 0 ? id : label.slice(0, 100),
      section: 'main',
      hidden: false,
    });
  }
  return options.length === 0 ? fallback : options;
}
