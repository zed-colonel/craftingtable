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
