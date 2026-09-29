import { createHash, randomUUID } from 'node:crypto';
import {
  type AdoptCheckDeclarationRequest,
  checkDeclarationFileSchema,
} from '@craftingtable/contracts';
import {
  asAuditEventId,
  CHECK_DECLARATION_PATH,
  type DeclaredCheck,
  type RepositoryCheckDeclaration,
  type SourceRepositoryId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError } from './errors.js';
import type { WorkspaceService } from './workspace-service.js';

const sha256 = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');

/** A repository's adopted checks, newest version first. */
export interface RepositoryChecks {
  readonly repositoryId: SourceRepositoryId;
  readonly declarations: readonly RepositoryCheckDeclaration[];
}

/** A definition file shown for review: its digest, and its text when it is short UTF-8. */
export interface CheckDefinitionFile {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly text?: string;
  readonly truncated?: boolean;
}

/**
 * What adopting the file at a ref would record; `issues` says why it cannot be, and
 * `warnings` what the operator should know before adopting it.
 */
export interface CheckDeclarationProposal {
  readonly ref: string;
  readonly commitSha: string;
  readonly sourcePath: string;
  readonly checks: readonly DeclaredCheck[];
  readonly definitionDigests: Readonly<Record<string, string>>;
  readonly definitions: readonly CheckDefinitionFile[];
  readonly issues: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Declared per-repository checks (R-G13, operator decision 2026-09-29). The operator adopts a
 * repository's `.craftingtable/checks.json`, read by the daemon's own Git at a commit the
 * operator names, never from an agent's branch or worktree. Each adoption is a new immutable
 * version; scoped gates are met only by daemon receipts of the adopted checks.
 */
export class RepositoryChecksService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitOperations | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  view(context: AuthContext, ws: WorkspaceId, repositoryId: SourceRepositoryId): RepositoryChecks {
    this.workspaces.requireAuthorized(context, ws);
    this.repository(ws, repositoryId);
    return {
      repositoryId,
      declarations: this.storage.runtimeEvidence.checkDeclarations(ws, repositoryId),
    };
  }

  /** What adopting the file at `ref` would record. It changes nothing. */
  async preview(
    context: AuthContext,
    ws: WorkspaceId,
    repositoryId: SourceRepositoryId,
    ref: string,
  ): Promise<CheckDeclarationProposal> {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    return this.read(ws, repositoryId, ref);
  }

  async adopt(
    context: AuthContext,
    ws: WorkspaceId,
    repositoryId: SourceRepositoryId,
    input: AdoptCheckDeclarationRequest,
  ): Promise<RepositoryChecks> {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const preview = await this.read(ws, repositoryId, input.ref);
    if (preview.commitSha !== input.expectedCommit)
      throw new ExecutionRequestError(
        'conflict',
        `${input.ref} has moved since it was reviewed. Preview it again before adopting.`,
      );
    if (preview.issues.length)
      throw new ExecutionRequestError('conflict', preview.issues.join(' '));
    this.storage.transaction((tx) => {
      this.workspaces.requireRole(context, ws, ['owner', 'editor']);
      const latest = tx.runtimeEvidence.checkDeclarations(ws, repositoryId)[0];
      const at = this.now().toISOString();
      const record: RepositoryCheckDeclaration = {
        id: randomUUID(),
        workspaceId: ws,
        repositoryId,
        version: (latest?.version ?? 0) + 1,
        sourceCommit: preview.commitSha,
        sourcePath: preview.sourcePath,
        checks: preview.checks,
        definitionDigests: preview.definitionDigests,
        rationale: input.rationale,
        adoptedByUserId: context.user.id,
        adoptedAt: at,
      };
      tx.runtimeEvidence.addCheckDeclaration(record);
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: at,
        actorKind: 'user',
        actorUserId: context.user.id,
        workspaceId: ws,
        action: 'repository-checks.adopted',
        targetType: 'source-repository',
        targetId: repositoryId,
        outcome: 'succeeded',
        metadata: {
          declarationId: record.id,
          version: record.version,
          sourceCommit: record.sourceCommit,
          checks: record.checks.map((c) => c.id),
        },
      });
    });
    return this.view(context, ws, repositoryId);
  }

  private repository(ws: WorkspaceId, repositoryId: SourceRepositoryId) {
    const repository = this.storage.execution.sourceRepositories.find(ws, repositoryId);
    if (repository?.status !== 'active')
      throw new ExecutionRequestError('invalid-request', 'Repository not found.');
    return repository;
  }

  /** Reads and checks the proposal at `ref` with the daemon's own Git. */
  private async read(
    ws: WorkspaceId,
    repositoryId: SourceRepositoryId,
    ref: string,
  ): Promise<CheckDeclarationProposal> {
    const repository = this.repository(ws, repositoryId);
    if (!this.git) throw new ExecutionRequestError('unavailable', 'Git is unavailable.');
    // A branch or an exact commit, never a tag: anyone who can write refs in the repository,
    // agents included, could shadow a branch name with a tag (R-G13 review).
    const exact = /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(ref);
    const commit = await this.git.resolveCommit(
      repository.rootPath,
      exact ? ref : `refs/heads/${ref}`,
    );
    if (!commit.ok)
      throw new ExecutionRequestError(
        'invalid-request',
        `${ref} is not a branch or a complete commit ID of ${repository.displayName}.`,
      );
    const at = commit.value.commitSha;
    const read = (paths: readonly string[]) =>
      this.git!.readCommitFiles(repository.rootPath, at, paths);
    const base = {
      ref,
      commitSha: at,
      sourcePath: CHECK_DECLARATION_PATH,
      checks: [] as readonly DeclaredCheck[],
      definitionDigests: {} as Record<string, string>,
      definitions: [] as CheckDefinitionFile[],
    };
    const declared = await read([CHECK_DECLARATION_PATH]);
    if (!declared.ok)
      throw new ExecutionRequestError(
        'unavailable',
        `${ref} could not be read: ${declared.failure.message}`,
      );
    const raw = declared.value.get(CHECK_DECLARATION_PATH);
    if (raw?.kind !== 'file')
      return {
        ...base,
        issues: [`${CHECK_DECLARATION_PATH} is not a file in ${ref}.`],
        warnings: [],
      };
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.content));
    } catch {
      return { ...base, issues: [`${CHECK_DECLARATION_PATH} is not JSON.`], warnings: [] };
    }
    const parsed = checkDeclarationFileSchema.safeParse(json);
    if (!parsed.success)
      return {
        ...base,
        issues: parsed.error.issues.map(
          (i) => `${CHECK_DECLARATION_PATH}: ${i.path.join('.') || 'file'}: ${i.message}.`,
        ),
        warnings: [],
      };
    const checks: readonly DeclaredCheck[] = parsed.data.checks.map((c) => {
      const program = c.argv[0]!;
      // A repository program always defines its check, with any other files the file names.
      const own = program.includes('/') ? [program] : [];
      return {
        id: c.id,
        argv: c.argv,
        definitionPaths: [...new Set([...own, ...(c.definitionPaths ?? [])])],
      };
    });
    const issues: string[] = [];
    const warnings: string[] = [];
    const definitionDigests: Record<string, string> = {};
    const definitions: CheckDefinitionFile[] = [];
    const paths = [...new Set(checks.flatMap((c) => c.definitionPaths))];
    const files = await read(paths);
    if (!files.ok)
      throw new ExecutionRequestError(
        'unavailable',
        `${ref} could not be read: ${files.failure.message}`,
      );
    for (const path of paths) {
      const file = files.value.get(path);
      if (file?.kind !== 'file') {
        issues.push(
          `${path}, a definition file of a declared check, is ${file ? 'a link' : 'not a file'} in ${ref}.`,
        );
        continue;
      }
      definitionDigests[path] = sha256(file.content);
      definitions.push(definitionPreview(path, file.content));
    }
    for (const check of checks) {
      const program = check.argv[0]!;
      const file = program.includes('/') ? files.value.get(program) : undefined;
      if (file?.kind === 'file' && !file.executable)
        issues.push(`${program}, the program of check ${check.id}, is not executable in ${ref}.`);
      if (!check.definitionPaths.length)
        warnings.push(
          `Check ${check.id} runs ${program} from PATH and names no definition files, so edits to what it reads (a Makefile, package.json, Cargo.toml or build script) will not stop a review. Name them in definitionPaths to hold the check to them.`,
        );
    }
    return { ...base, checks, definitionDigests, definitions, issues, warnings };
  }
}

/** A definition file as the preview shows it: its digest and, if text and short, its contents. */
function definitionPreview(path: string, content: Uint8Array): CheckDefinitionFile {
  const limit = 64 * 1024;
  let text: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, limit));
  } catch {
    text = undefined;
  }
  return {
    path,
    digest: sha256(content),
    bytes: content.byteLength,
    ...(text === undefined ? {} : { text, truncated: content.byteLength > limit }),
  };
}

/** SHA-256 of a definition file's contents, as the declaration and receipts record it. */
export const definitionDigest = sha256;
