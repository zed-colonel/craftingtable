import { SESSION_STATUSES, USER_STATUSES } from '@craftingtable/domain';
import { z } from 'zod';
import { sessionIdSchema, userIdSchema } from './ids.js';

export const apiErrorCodeSchema = z.enum([
  'invalid-request',
  'invalid-credentials',
  'unauthenticated',
  'forbidden',
  'not-found',
  'conflict',
  'unavailable',
  /** Too many attempts: wait before the next (R-G9). */
  'rate-limited',
  'internal-error',
]);

/** Machine-readable refinements of an error code that the browser can act on. */
export const apiErrorReasonSchema = z.enum([
  /** A worktree removal was refused because it would discard uncommitted work. */
  'worktree-has-changes',
  /**
   * A stop's command was refused: its investigation found the worktree changed, and the change
   * is not acknowledged (R-C16). `paths` names what differs from HEAD.
   */
  'investigation-worktree-changed',
  /** Sign-in refused: too many failed attempts for the username or the client (R-G9). */
  'login-rate-limited',
]);

export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    reason: apiErrorReasonSchema.optional(),
    /** A bounded sample of the paths the reason concerns. */
    paths: z.array(z.string().min(1).max(4096)).max(50).optional(),
    /** How many such paths exist, when known; may exceed `paths.length`. */
    pathCount: z.number().int().nonnegative().optional(),
  }),
});

export const loginRequestSchema = z.strictObject({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
});

export const authenticatedUserSchema = z.strictObject({
  id: userIdSchema,
  username: z.string().min(1).max(64),
  status: z.enum(USER_STATUSES),
});

export const sessionSummarySchema = z.strictObject({
  id: sessionIdSchema,
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  status: z.enum(SESSION_STATUSES),
  current: z.boolean(),
  userAgent: z.string().max(256).optional(),
});

export const authenticatedSessionResponseSchema = z.strictObject({
  user: authenticatedUserSchema,
  session: sessionSummarySchema.extend({ current: z.literal(true) }),
  csrfToken: z.string().min(32).max(256),
});

export const sessionListResponseSchema = z.strictObject({
  sessions: z.array(sessionSummarySchema),
});

export const logoutRequestSchema = z.strictObject({});
export const revokeSessionRequestSchema = z.strictObject({});

export const revokeSessionResponseSchema = z.strictObject({
  revokedSessionId: sessionIdSchema,
  currentSessionRevoked: z.boolean(),
});

export const logoutResponseSchema = z.strictObject({
  success: z.literal(true),
});

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

export const changePasswordResponseSchema = z.strictObject({
  success: z.literal(true),
  /** Every other session was revoked; the current one stays signed in. */
  revokedSessionCount: z.number().int().nonnegative(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthenticatedSessionResponse = z.infer<typeof authenticatedSessionResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;
export type RevokeSessionRequest = z.infer<typeof revokeSessionRequestSchema>;
export type RevokeSessionResponse = z.infer<typeof revokeSessionResponseSchema>;
