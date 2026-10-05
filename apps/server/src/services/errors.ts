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
  /**
   * `worktree-has-changes`: a removal would discard uncommitted work. `investigation-worktree-
   * changed`: the stop's investigation found its worktree changed, unacknowledged (R-C16).
   */
  readonly reason: 'worktree-has-changes' | 'investigation-worktree-changed';
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
 * A run needs the current pin for a consumer→upstream link whose transition the roadmap does
 * not declare (ADR-069). Stops the cycle with its own attention code instead of guessing.
 */
export class UpstreamTransitionUndeclaredError extends ExecutionRequestError {
  constructor(message: string) {
    super('conflict', message);
    this.name = 'UpstreamTransitionUndeclaredError';
  }
}

/** An upstream pin whose provider moved past the commit the saved generation pins. */
export interface MovedPin {
  readonly alias: string;
  readonly pinnedCommitSha: string;
  readonly currentCommitSha: string;
}

/**
 * A pinned upstream's integration advanced past the saved dependency generation (LIVE-15,
 * ADR-058). The cycle stops as `upstream-pin-moved`, carrying what moved, not as a controller
 * error: the dependency refresh, not a plain resume, is what makes progress.
 */
export class UpstreamPinMovedError extends ExecutionRequestError {
  constructor(
    readonly definitionId: string,
    readonly pins: readonly MovedPin[],
    message: string,
  ) {
    super('conflict', message);
    this.name = 'UpstreamPinMovedError';
  }
}

/**
 * A delegated checkpoint review ended without a complete, passing attestation (R-C13). The
 * cycle stops as `checkpoint-attestation-failed`, not as a controller error, so a plain
 * Resume that would repeat the same review can be refused.
 */
export class CheckpointAttestationError extends ExecutionRequestError {
  constructor(
    readonly checkpointId: string,
    message: string,
  ) {
    super('conflict', message);
    this.name = 'CheckpointAttestationError';
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

/**
 * A scoped run's repository has no adopted check declaration (R-G13, fail closed): the run does
 * not start until the operator adopts one.
 */
export class RepositoryChecksUndeclaredError extends ExecutionRequestError {
  constructor(
    readonly repositoryId: string,
    repositoryName: string,
  ) {
    super(
      'conflict',
      `${repositoryName} has no adopted checks. Adopt its .craftingtable/checks.json on the Repositories page, then resume.`,
    );
    this.name = 'RepositoryChecksUndeclaredError';
  }
}

/**
 * A declared check's definition files on the gated commit differ from the adopted ones
 * (R-G13): adopt the new definition, or revert the change.
 */
export class CheckDefinitionChangedError extends ExecutionRequestError {
  constructor(
    readonly repositoryId: string,
    readonly checkId: string,
    message: string,
  ) {
    super('conflict', message);
    this.name = 'CheckDefinitionChangedError';
  }
}

/**
 * A merge would adopt changed check definitions (R-G13 increment 5): only a person's merge
 * approval, naming the proposal they were shown, may record it.
 */
export class CheckAdoptionRequiredError extends ExecutionRequestError {
  constructor(
    readonly repositoryId: string,
    readonly proposalDigest: string,
    message: string,
  ) {
    super('conflict', message);
    this.name = 'CheckAdoptionRequiredError';
  }
}

/**
 * A review held to adopted checks lacks a daemon run of some of them (R-G13). The review, not
 * its code, is incomplete: a fresh review that runs them can meet the gate (LIVE-24).
 */
export class DeclaredChecksMissingError extends ExecutionRequestError {
  constructor(
    readonly missing: readonly string[],
    message: string,
  ) {
    super('conflict', message);
    this.name = 'DeclaredChecksMissingError';
  }
}
