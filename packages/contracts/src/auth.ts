import { SESSION_STATUSES, USER_STATUSES } from '@craftingtable/domain';
import { z } from 'zod';
import { sessionIdSchema, userIdSchema } from './ids.js';

const apiErrorCodeSchema = z.enum([
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
const apiErrorReasonSchema = z.enum([
  /** A worktree removal was refused because it would discard uncommitted work. */
  'worktree-has-changes',
  /**
   * A stop's command was refused: its investigation found the worktree changed, and the change
   * is not acknowledged (R-C16). `paths` names what differs from HEAD.
   */
  'investigation-worktree-changed',
  /** Sign-in refused: too many failed attempts for the username or the client (R-G9). */
  'login-rate-limited',
  /** The command needs the operator's password again first (R-G9): `POST /api/auth/step-up`. */
  'step-up-required',
  /** The password given for a step-up did not match (R-G9): the browser asks again. */
  'step-up-failed',
  /** A repository outside `CRAFTINGTABLE_REPOSITORY_ROOTS` cannot be registered (R-G9). */
  'repository-outside-roots',
  /** A merge's destination branch moved after the merge read it; nothing was merged (R-G10). */
  'target-moved',
  /** A merge's destination is checked out, rebased or bisected in another worktree (R-G10). */
  'target-checked-out',
  /** A promotion into the primary checkout meets uncommitted tracked changes, in `paths` (R-G10). */
  'checkout-dirty',
  /** A promotion would overwrite files the primary checkout does not track, in `paths` (R-G10). */
  'checkout-would-overwrite',
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

const authenticatedUserSchema = z.strictObject({
  id: userIdSchema,
  username: z.string().min(1).max(64),
  status: z.enum(USER_STATUSES),
});

const sessionSummarySchema = z.strictObject({
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

/** The current password again, before an unrestricted run or a final promotion (R-G9). */
export const stepUpRequestSchema = z.strictObject({
  password: z.string().min(1).max(1024),
});

export const stepUpResponseSchema = z.strictObject({
  /** Until when this session may run commands that need step-up. */
  steppedUpUntil: z.iso.datetime(),
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
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;
