import { z } from 'zod';
const path = z
  .string()
  .min(2)
  .max(4096)
  .startsWith('/')
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
export const storagePolicySchema = z.strictObject({
  worktreeRoot: path,
  runsRoot: path,
  backupRoot: path,
  autoCleanBuildCaches: z.boolean(),
  scratchRetentionDays: z.union([z.literal(0), z.literal(30)]),
  minimumFreeGiB: z.number().int().min(1).max(1024),
  dailyBackups: z.boolean(),
  backupsToKeep: z.number().int().min(1).max(30),
});
export const saveStorageRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  policy: storagePolicySchema,
});
export type SaveStorageRequest = z.infer<typeof saveStorageRequestSchema>;
export const storageCommandSchema = z.strictObject({});
export const cleanupStorageRequestSchema = z.strictObject({ scanId: z.string().uuid() });
const volumeSchema = z.strictObject({
  label: z.string(),
  path: z.string(),
  realPath: z.string().nullable(),
  freeBytes: z.number().nonnegative().nullable(),
  totalBytes: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
});
export const storageStatusSchema = z.strictObject({
  version: z.number().int().positive(),
  policy: storagePolicySchema,
  volumes: z.array(volumeSchema),
  scan: z
    .strictObject({
      id: z.string().uuid(),
      completedAt: z.string(),
      worktreeBytes: z.number().nonnegative(),
      runBytes: z.number().nonnegative(),
      reclaimableBytes: z.number().nonnegative(),
      cacheCount: z.number().int().nonnegative(),
      expiredScratchCount: z.number().int().nonnegative(),
      protectedRuns: z.number().int().nonnegative(),
      warnings: z.array(z.string()),
    })
    .nullable(),
  backups: z.array(
    z.strictObject({ path: z.string(), createdAt: z.string(), bytes: z.number().nonnegative() }),
  ),
  busy: z.boolean(),
  lastError: z.string().nullable(),
  lastCleanup: z
    .strictObject({
      completedAt: z.string(),
      cachesRemoved: z.number().int().nonnegative(),
      bytes: z.number().nonnegative(),
    })
    .nullable(),
});
export type StorageStatus = z.infer<typeof storageStatusSchema>;
