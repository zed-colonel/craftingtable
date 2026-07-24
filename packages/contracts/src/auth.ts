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
  'internal-error',
]);

export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
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

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthenticatedSessionResponse = z.infer<typeof authenticatedSessionResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type RevokeSessionRequest = z.infer<typeof revokeSessionRequestSchema>;
export type RevokeSessionResponse = z.infer<typeof revokeSessionResponseSchema>;
