import { describe, expect, it } from 'vitest';
import {
  checkDeclarationFileSchema,
  repositoryCheckDeclarationSchema,
} from '../src/repository-checks.js';

describe('.craftingtable/checks.json', () => {
  it('takes up to 50 definition files per check, and refuses more (R-G17 decision 13)', () => {
    const file = (paths: number) => ({
      version: 1,
      checks: [
        {
          id: 'tests',
          argv: ['python', '-m', 'pytest'],
          definitionPaths: Array.from(
            { length: paths },
            (_, index) => `runtimes/p${index}/pyproject.toml`,
          ),
        },
      ],
    });
    expect(checkDeclarationFileSchema.safeParse(file(50)).success).toBe(true);
    expect(checkDeclarationFileSchema.safeParse(file(51)).success).toBe(false);
  });

  it('takes an optional time limit per check, in whole minutes up to a day (R-C17 part 1)', () => {
    const file = (timeoutMinutes?: unknown) => ({
      version: 1,
      checks: [
        {
          id: 'tests',
          argv: ['cargo', 'test'],
          ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
        },
      ],
    });
    // A file without one keeps parsing as before, with nothing added.
    expect(checkDeclarationFileSchema.parse(file()).checks[0]).toEqual({
      id: 'tests',
      argv: ['cargo', 'test'],
    });
    expect(checkDeclarationFileSchema.parse(file(15)).checks[0]?.timeoutMinutes).toBe(15);
    expect(checkDeclarationFileSchema.safeParse(file(1)).success).toBe(true);
    expect(checkDeclarationFileSchema.safeParse(file(1440)).success).toBe(true);
    for (const refused of [0, -5, 1441, 2.5, '15', null])
      expect(checkDeclarationFileSchema.safeParse(file(refused)).success, String(refused)).toBe(
        false,
      );
  });
});

describe('an adopted check declaration', () => {
  const record = (check: Record<string, unknown>) => ({
    id: '0b6f2f1e-8d3c-4a55-9d44-0d0c7f2a4e11',
    workspaceId: 'workspace-1',
    repositoryId: 'repository-1',
    version: 1,
    sourceCommit: 'a'.repeat(40),
    sourcePath: '.craftingtable/checks.json',
    checks: [check],
    definitionDigests: {},
    rationale: 'Adopted.',
    adoptedByUserId: 'user-1',
    adoptedAt: '2026-10-17T00:00:00.000Z',
  });

  it('keeps a check’s time limit, and reads a record without one as before (R-C17 part 1)', () => {
    const check = { id: 'tests', argv: ['cargo', 'test'], definitionPaths: [] };
    expect(repositoryCheckDeclarationSchema.parse(record(check)).checks[0]).toEqual(check);
    expect(
      repositoryCheckDeclarationSchema.parse(record({ ...check, timeoutMinutes: 15 })).checks[0],
    ).toEqual({ ...check, timeoutMinutes: 15 });
    expect(
      repositoryCheckDeclarationSchema.safeParse(record({ ...check, timeoutMinutes: 0 })).success,
    ).toBe(false);
  });
});
