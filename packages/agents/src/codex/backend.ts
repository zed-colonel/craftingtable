import { isAbsolute } from 'node:path';
import {
  type AgentBackend,
  type AgentBackendDescriptor,
  AgentLaunchError,
  type AgentLaunchRequest,
  type AgentModelOption,
  type AgentSession,
} from '../index.js';
import { CODEX_MODELS } from './models.js';
import { codexIsolationArguments, probeCodexInventory } from './isolation.js';
import { CodexSession, codexEnvironment } from './session.js';

export interface CodexBackendOptions {
  readonly executable: string;
  /** Where the child's named variables come from; only allowlisted names pass (R-G5). */
  readonly env?: NodeJS.ProcessEnv;
  /** Further variable names the operator lets through (`CRAFTINGTABLE_AGENT_ENV_ALLOW`). */
  readonly allowEnvironment?: readonly string[];
  readonly terminationGraceMs?: number;
  readonly requestTimeoutMs?: number;
  readonly models?: readonly AgentModelOption[];
}
export class CodexBackend implements AgentBackend {
  readonly kind = 'codex' as const;
  constructor(private readonly options: CodexBackendOptions) {}
  describe(): AgentBackendDescriptor {
    return {
      kind: this.kind,
      label: 'Codex',
      executable: this.options.executable,
      models: this.options.models ?? CODEX_MODELS,
    };
  }
  launch(request: AgentLaunchRequest): Promise<AgentSession> {
    if (!isAbsolute(request.cwd) || request.prompt.length === 0) {
      return Promise.reject(
        new AgentLaunchError('invalid-request', 'Launch requires an absolute cwd and a prompt'),
      );
    }
    // The operator's MCP servers and user skills are found fresh for every run and switched off
    // for it (R-G5, AGT-14); a run whose configuration cannot be read does not start.
    return probeCodexInventory({
      executable: this.options.executable,
      env: codexEnvironment(this.options, request),
      cwd: request.cwd,
      timeoutMs: this.options.requestTimeoutMs ?? 30000,
    })
      .then(
        (inventory) => new CodexSession(this.options, request, codexIsolationArguments(inventory)),
      )
      .catch((error: unknown) => {
        // Covers a configuration name the switches cannot address too (R-G5 review).
        throw new AgentLaunchError(
          'spawn-failed',
          `Codex could not report its configuration, so the run was not started isolated: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
