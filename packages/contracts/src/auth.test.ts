import { describe, expect, it } from 'vitest';
import {
  authenticatedSessionResponseSchema,
  loginRequestSchema,
  logoutRequestSchema,
  revokeSessionRequestSchema,
  sessionListResponseSchema,
} from './auth.js';

const authenticated = {
  user: { id: 'user-1', username: 'keith', status: 'active' },
  session: {
    id: 'session-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    lastSeenAt: '2026-07-24T00:00:00.000Z',
    expiresAt: '2026-08-23T00:00:00.000Z',
    status: 'active',
    current: true,
  },
  csrfToken: 'a'.repeat(43),
};

describe('authentication contracts', () => {
  it('accepts strict login and authenticated-session payloads', () => {
    expect(
      loginRequestSchema.safeParse({ username: 'keith', password: 'a passphrase' }).success,
    ).toBe(true);
    expect(authenticatedSessionResponseSchema.safeParse(authenticated).success).toBe(true);
    expect(sessionListResponseSchema.safeParse({ sessions: [authenticated.session] }).success).toBe(
      true,
    );
  });

  it('rejects secrets and unknown response fields', () => {
    expect(
      authenticatedSessionResponseSchema.safeParse({
        ...authenticated,
        rawSessionToken: 'secret',
      }).success,
    ).toBe(false);
  });

  it('requires strict empty mutation bodies', () => {
    expect(logoutRequestSchema.safeParse({}).success).toBe(true);
    expect(revokeSessionRequestSchema.safeParse({}).success).toBe(true);
    expect(logoutRequestSchema.safeParse({ arbitrary: true }).success).toBe(false);
    expect(revokeSessionRequestSchema.safeParse(undefined).success).toBe(false);
  });
});
