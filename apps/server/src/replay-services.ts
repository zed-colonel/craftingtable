import { join } from 'node:path';
import {
  type AgentBackend,
  CLAUDE_CODE_MODELS,
  ClaudeCodeBackend,
  CODEX_MODELS,
  CodexBackend,
} from '@craftingtable/agents';
import type { AgentBackendKind } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import { createServices, type ServiceSet } from './composition.js';
import { configFromEnv } from './config.js';
import type { openDaemonStorage } from './persisted-records.js';

/**
 * The daemon's services over a snapshot copy, for a replay that runs one real controller pass
 * (the scheduler replay, R-I10; the cycles replay, R-B4). Nothing can launch or touch Git: the
 * backends have the default models, so settings validate as on the host, but no executable; and
 * every Git call goes to `onGit`, which records it and throws, so the pass stops there. No restart
 * recovery runs: the pass meets the snapshot as the live daemon's next pass would, live runs
 * included. The stored capacities replace the daemon's configured defaults, because plan evidence
 * is bound to them.
 */
export function replayServices(
  storage: ReturnType<typeof openDaemonStorage>,
  dataDir: string,
  now: Date,
  onGit: (method: string) => never,
): Promise<ServiceSet> {
  const capacity = (key: string) => String(storage.phaseScheduling.capacity(key));
  const config = configFromEnv({
    CRAFTINGTABLE_DATA_DIR: dataDir,
    // Its own credentials file, never the operator's (R-G9).
    CRAFTINGTABLE_CONFIG_DIR: join(dataDir, 'config'),
    CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
    CRAFTINGTABLE_LOG_LEVEL: 'silent',
    CRAFTINGTABLE_WEB_DIST: '',
    CRAFTINGTABLE_DEVELOPMENT_CAPACITY: capacity('local-development'),
    CRAFTINGTABLE_VERIFICATION_CAPACITY: capacity('local-verification'),
  });
  const missing = join(dataDir, 'no-agent-executable');
  // The replay cannot follow a pass past Git, read or write: it records where it stopped.
  const git = new Proxy({} as GitOperations, {
    get: (_target, method) => () => onGit(String(method)),
  });
  return createServices(storage, config, {
    gitOperations: git,
    agentBackends: new Map<AgentBackendKind, AgentBackend>([
      ['claude-code', new ClaudeCodeBackend({ executable: missing, models: CLAUDE_CODE_MODELS })],
      ['codex', new CodexBackend({ executable: missing, models: CODEX_MODELS })],
    ]),
    now: () => now,
    notificationTransport: { send: async () => ({ status: 'accepted' }) },
    // The snapshot as the live daemon's next pass finds it, live runs included: no restart.
    restartRecovery: false,
  });
}
