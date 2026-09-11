import { validTimeZone } from '@craftingtable/domain';
import { z } from 'zod';
export const notificationPreferencesSchema = z.strictObject({
  enabled: z.boolean(),
  mergeReady: z.boolean(),
  needsAttention: z.boolean(),
  timeZone: z.string().min(1).max(100).refine(validTimeZone),
  dailyTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  device: z.string().regex(/^[A-Za-z0-9_-]{0,25}$/),
});
export const saveNotificationsRequestSchema = z.strictObject({
  preferences: notificationPreferencesSchema,
  expectedVersion: z.number().int().nonnegative(),
  applicationToken: z
    .string()
    .regex(/^[A-Za-z0-9]{30}$/)
    .optional(),
  userKey: z
    .string()
    .regex(/^[A-Za-z0-9]{30}$/)
    .optional(),
  clearCredentials: z.boolean().optional(),
});
export type SaveNotificationsRequest = z.infer<typeof saveNotificationsRequestSchema>;
export const notificationStatusSchema = z.strictObject({
  preferences: notificationPreferencesSchema,
  version: z.number().int().nonnegative(),
  credentialsConfigured: z.boolean(),
  blockedReason: z.string().nullable(),
  retryAt: z.string().nullable(),
  records: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.enum(['merge', 'attention', 'test']),
      title: z.string(),
      message: z.string(),
      path: z.string(),
      state: z.enum(['active', 'resolved']),
      createdAt: z.string(),
      lastSentAt: z.string().nullable(),
      nextAttemptAt: z.string(),
      deliveredCount: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
    }),
  ),
});
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

export const testNotificationsRequestSchema = z.strictObject({});
