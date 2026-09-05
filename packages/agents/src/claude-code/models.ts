import type { AgentModelOption } from '../index.js';

/**
 * Models offered in the launch form. The aliases resolve inside Claude Code to
 * its current model of that tier, so they stay valid as new releases arrive;
 * the explicit ids pin a specific model. `CRAFTINGTABLE_CLAUDE_MODELS`
 * replaces this list without a code change.
 */
export const CLAUDE_CODE_MODELS: readonly AgentModelOption[] = [
  { id: 'opus', label: 'Opus (current)' },
  { id: 'sonnet', label: 'Sonnet (current)' },
  { id: 'haiku', label: 'Haiku (current)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/**
 * Parses `id=Label,id2=Label 2,id3` into model options. Malformed entries are
 * skipped rather than failing startup; an empty result falls back to the
 * built-in list.
 */
export function parseModelList(value: string | undefined): readonly AgentModelOption[] {
  if (value === undefined || value.trim().length === 0) {
    return CLAUDE_CODE_MODELS;
  }
  const options: AgentModelOption[] = [];
  for (const entry of value.split(',')) {
    const [rawId, ...rest] = entry.split('=');
    const id = rawId?.trim() ?? '';
    if (!MODEL_ID.test(id)) {
      continue;
    }
    const label = rest.join('=').trim();
    options.push({ id, label: label.length === 0 ? id : label.slice(0, 100) });
  }
  return options.length === 0 ? CLAUDE_CODE_MODELS : options;
}
