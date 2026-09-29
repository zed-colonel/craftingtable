import type { DeclaredCheck, RepositoryCheckDeclaration } from '@craftingtable/domain';
import { z } from 'zod';
import { gitShaSchema } from './execution.js';
import { sourceRepositoryIdSchema, userIdSchema, workspaceIdSchema } from './ids.js';
import { equivalentSchema } from './type-equivalence.js';

/**
 * Declared per-repository checks (R-G13). The repository's file is parsed with
 * `checkDeclarationFileSchema`; the adopted record is `repositoryCheckDeclarationSchema`.
 */

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** A check's name: lowercase letters, digits and hyphens. */
export const checkIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/** A path inside the repository: relative, without `..` or empty segments. */
export const repositoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\0') &&
      !path.includes('\\') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    { message: 'A repository path is relative and has no empty, "." or ".." segment' },
  );

const argument = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), { message: 'An argument has no NUL' });

/**
 * One check as a repository proposes it. Its program is a name on PATH or a repository path;
 * its definition files default to the program when that is a repository path.
 */
export const proposedCheckSchema = z
  .strictObject({
    id: checkIdSchema,
    argv: z.array(argument).min(1).max(64),
    definitionPaths: z.array(repositoryPathSchema).max(20).optional(),
  })
  .refine((check) => !check.argv[0]!.startsWith('-'), {
    message: 'A check starts with its program, not an option',
  })
  .refine(
    (check) =>
      !check.argv[0]!.includes('/') || repositoryPathSchema.safeParse(check.argv[0]).success,
    { message: 'A check program with a path is a repository path' },
  );

/** `.craftingtable/checks.json`: the checks a repository proposes. */
export const checkDeclarationFileSchema = z
  .strictObject({
    version: z.literal(1),
    checks: z.array(proposedCheckSchema).min(1).max(20),
  })
  .refine((file) => new Set(file.checks.map((c) => c.id)).size === file.checks.length, {
    message: 'Each check has its own id',
  });

export const declaredCheckSchema = equivalentSchema<DeclaredCheck>()(
  z.strictObject({
    id: checkIdSchema,
    argv: z.array(argument).min(1).max(64),
    definitionPaths: z.array(repositoryPathSchema).max(20),
  }),
);

export const repositoryCheckDeclarationSchema = equivalentSchema<RepositoryCheckDeclaration>()(
  z.strictObject({
    id: z.uuid(),
    workspaceId: workspaceIdSchema,
    repositoryId: sourceRepositoryIdSchema,
    version: z.number().int().positive().safe(),
    sourceCommit: gitShaSchema,
    sourcePath: repositoryPathSchema,
    checks: z.array(declaredCheckSchema).min(1).max(20),
    definitionDigests: z.record(repositoryPathSchema, digest),
    rationale: z.string().min(1).max(2000),
    adoptedByUserId: userIdSchema,
    adoptedAt: z.iso.datetime(),
  }),
);

/** A repository's adopted checks: the current version first, then earlier ones. */
export const repositoryChecksViewSchema = z.strictObject({
  repositoryId: sourceRepositoryIdSchema,
  declarations: z.array(repositoryCheckDeclarationSchema),
});
export type RepositoryChecksView = z.infer<typeof repositoryChecksViewSchema>;

/** What adopting the file at a ref would record, read by the daemon at that commit. */
export const checkDeclarationPreviewSchema = z.strictObject({
  ref: z.string(),
  commitSha: gitShaSchema,
  sourcePath: repositoryPathSchema,
  checks: z.array(declaredCheckSchema),
  definitionDigests: z.record(repositoryPathSchema, digest),
  /** Each definition file for review, with its text when it is short UTF-8. */
  definitions: z.array(
    z.strictObject({
      path: repositoryPathSchema,
      digest,
      bytes: z.number().int().nonnegative(),
      text: z.string().optional(),
      truncated: z.boolean().optional(),
    }),
  ),
  /** Why the file cannot be adopted as it is; empty when it can. */
  issues: z.array(z.string()),
  /** What the operator should weigh before adopting it. */
  warnings: z.array(z.string()),
});
export type CheckDeclarationPreview = z.infer<typeof checkDeclarationPreviewSchema>;

export const checkDeclarationPreviewRequestSchema = z.strictObject({
  ref: z.string().trim().min(1).max(256),
});

export const adoptCheckDeclarationRequestSchema = z.strictObject({
  ref: z.string().trim().min(1).max(256),
  /** The commit the operator reviewed; adoption is refused if the ref has moved since. */
  expectedCommit: gitShaSchema,
  rationale: z.string().trim().min(1).max(2000),
});
export type AdoptCheckDeclarationRequest = z.infer<typeof adoptCheckDeclarationRequestSchema>;
