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
import { CodexSession } from './session.js';

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
    return Promise.resolve(new CodexSession(this.options, request));
  }
}
