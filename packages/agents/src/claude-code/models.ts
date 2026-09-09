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
