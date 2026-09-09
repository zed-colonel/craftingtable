import type { AgentModelOption } from '../index.js';

/** https://learn.chatgpt.com/docs/models; override with CRAFTINGTABLE_CODEX_MODELS. */
export const CODEX_MODELS: readonly AgentModelOption[] = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
];
