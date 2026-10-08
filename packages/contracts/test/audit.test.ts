import { describe, expect, it } from 'vitest';
import { workspaceAuditPageResponseSchema } from '../src/audit.js';

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

  it('no longer accepts the retired repository registry actions (R-H6)', () => {
    // Their catalog rows stay (the catalog is append-only); no stored audit record uses them.
    const record = {
      sequence: 1,
      id: 'audit-1',
      occurredAt: '2026-07-24T00:00:00.000Z',
      actorKind: 'user',
      workspaceId: 'workspace-1',
      outcome: 'succeeded',
      metadata: {},
    };
    for (const action of [
      'repository.register',
      'repository.inspect',
      'repository.reaffirm',
      'repository.retire',
      'repository.bind-project',
      'repository.unbind-project',
    ])
      expect(
        workspaceAuditPageResponseSchema.safeParse({ records: [{ ...record, action }] }).success,
        action,
      ).toBe(false);
    expect(
      workspaceAuditPageResponseSchema.safeParse({
        records: [{ ...record, action: 'source-repository.register' }],
      }).success,
    ).toBe(true);
  });
});
