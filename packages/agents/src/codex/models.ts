import type { AgentModelOption } from '../index.js';

/**
 * Models offered until Codex's own catalog has been read (R-G15), or when it cannot be.
 * https://learn.chatgpt.com/docs/models; `CRAFTINGTABLE_CODEX_MODELS` replaces the list and
 * the catalog.
 */
export const CODEX_MODELS: readonly AgentModelOption[] = [
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', section: 'main', hidden: false },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', section: 'main', hidden: false },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', section: 'main', hidden: false },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', section: 'main', hidden: false },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', section: 'main', hidden: false },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', section: 'main', hidden: false },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', section: 'main', hidden: false },
];
