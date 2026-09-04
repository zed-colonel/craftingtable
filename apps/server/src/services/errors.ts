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
export class ExecutionRequestError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionRequestError';
  }
}
