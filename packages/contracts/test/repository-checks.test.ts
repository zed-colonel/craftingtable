import { describe, expect, it } from 'vitest';
import { checkDeclarationFileSchema } from '../src/repository-checks.js';

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
});
