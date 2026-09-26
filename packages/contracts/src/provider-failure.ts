import { z } from 'zod';
export const providerFailureSchema = z.strictObject({
  kind: z.enum([
    'capacity',
    'unavailable',
    'transport',
    'authentication',
    'credential-rejected',
    'quota',
    'unknown',
  ]),
  message: z.string().min(1).max(1000),
  safeToRetry: z.boolean(),
  resetsAt: z.iso.datetime().optional(),
  evidence: z.string().min(1).max(1000).optional(),
});
