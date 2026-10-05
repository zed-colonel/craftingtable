import { MODEL_ALIAS_SECTION } from '@craftingtable/domain';
import type { AgentModelOption } from '../index.js';

/**
 * Claude Code's tier aliases. They resolve inside Claude Code to its current model of that
 * tier, so they stay valid as new releases arrive, and they are offered beside the catalog.
 */
export const CLAUDE_CODE_ALIASES: readonly AgentModelOption[] = [
  { id: 'opus', label: 'Opus (current)', section: MODEL_ALIAS_SECTION, hidden: false },
  { id: 'sonnet', label: 'Sonnet (current)', section: MODEL_ALIAS_SECTION, hidden: false },
  { id: 'haiku', label: 'Haiku (current)', section: MODEL_ALIAS_SECTION, hidden: false },
];

/**
 * Models offered until Claude Code's own catalog has been read (R-G15), or when it cannot be.
 * The explicit ids pin a specific model. `CRAFTINGTABLE_CLAUDE_MODELS` replaces the list and
 * the catalog without a code change.
 */
export const CLAUDE_CODE_MODELS: readonly AgentModelOption[] = [
  ...CLAUDE_CODE_ALIASES,
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', section: 'main', hidden: false },
  { id: 'claude-opus-5', label: 'Claude Opus 5', section: 'main', hidden: false },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', section: 'main', hidden: false },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', section: 'main', hidden: false },
];
