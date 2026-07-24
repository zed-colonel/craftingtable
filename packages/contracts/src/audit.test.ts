import { describe, expect, it } from 'vitest';
import { workspaceAuditPageResponseSchema } from './audit.js';

describe('audit contracts', () => {
  it('accepts only the safe audit summary shape', () => {
    const record = {
      sequence: 1,
      id: 'audit-1',
      occurredAt: '2026-07-24T00:00:00.000Z',
      actorKind: 'system',
      workspaceId: 'workspace-1',
      action: 'workspace.created',
      outcome: 'succeeded',
      metadata: { name: 'Default workspace' },
    };
    expect(workspaceAuditPageResponseSchema.safeParse({ records: [record] }).success).toBe(true);
    expect(
      workspaceAuditPageResponseSchema.safeParse({
        records: [{ ...record, password: 'secret' }],
      }).success,
    ).toBe(false);
  });
});
