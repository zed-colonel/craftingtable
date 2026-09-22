import { z } from 'zod';
export const saveHostSchedulingSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  verificationCapacity: z.number().int().min(1).max(32),
  expectedDevelopmentVersion: z.number().int().positive(),
  developmentCapacity: z.number().int().min(1).max(32),
});
export type SaveHostScheduling = z.infer<typeof saveHostSchedulingSchema>;
const linkSchema = z.strictObject({
  workspaceId: z.string().uuid(),
  workItemId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  label: z.string(),
  phase: z.string(),
  resourceKey: z.enum(['local-development', 'local-verification']),
});
export const hostSchedulingSchema = z.strictObject({
  version: z.number().int().positive(),
  verificationCapacity: z.number().int().min(1).max(32),
  developmentCapacity: z.number().int().min(1).max(32),
  developmentVersion: z.number().int().positive(),
  developmentSource: z.enum(['daemon-environment', 'saved-setting']),
  source: z.enum(['daemon-environment', 'saved-setting']),
  updatedAt: z.string().nullable(),
  reservations: z.array(linkSchema.extend({ id: z.string(), acquiredAt: z.string() })),
  waiting: z.array(linkSchema.extend({ id: z.string(), reason: z.string(), paused: z.boolean() })),
  roadmaps: z.array(
    z.strictObject({
      id: z.string(),
      workspaceId: z.string().uuid(),
      name: z.string(),
      status: z.string(),
      crossProject: z.boolean(),
    }),
  ),
});
export type HostSchedulingStatus = z.infer<typeof hostSchedulingSchema>;
