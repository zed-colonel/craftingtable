export class AuthenticationError extends Error {
  constructor() {
    super('Invalid username or password');
    this.name = 'AuthenticationError';
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'UnauthenticatedError';
  }
}

export class NotFoundError extends Error {
  constructor() {
    super('Resource not found');
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('Request forbidden');
    this.name = 'ForbiddenError';
  }
}

export class BootstrapRefusedError extends Error {
  constructor() {
    super('Bootstrap refused because a user already exists');
    this.name = 'BootstrapRefusedError';
  }
}

/**
 * A request the execution services could not honour: a path that is not a
 * repository, a Git command that failed, a run that is no longer live. The
 * message is composed by the daemon and safe to return to the operator.
 */
export interface ExecutionErrorDetail {
  readonly reason: 'worktree-has-changes';
  readonly paths: readonly string[];
  readonly pathCount?: number;
}

export class ExecutionRequestError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'conflict' | 'unavailable',
    message: string,
    readonly detail?: ExecutionErrorDetail,
  ) {
    super(message);
    this.name = 'ExecutionRequestError';
  }
}

/**
 * An optimistic-concurrency miss: another worker or command committed a newer version of
 * the aggregate first. Callers answer the request as a conflict; the scheduling loops
 * treat it as retryable because the next pass reads the newer version.
 */
export class ConcurrentModificationError extends ExecutionRequestError {
  constructor(message: string) {
    super('conflict', message);
    this.name = 'ConcurrentModificationError';
  }
}

/**
 * The daemon is draining for a restart (R-B9) and admits no new agent runs. Controller
 * loops treat it as a wait; a command receives 503 and can be retried after the restart.
 */
export class DaemonDrainingError extends ExecutionRequestError {
  constructor() {
    super(
      'unavailable',
      'CraftingTable is draining for a restart and is not starting new agent runs. Try again after it restarts.',
    );
    this.name = 'DaemonDrainingError';
  }
}
