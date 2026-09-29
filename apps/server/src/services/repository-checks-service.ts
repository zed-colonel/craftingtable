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

/** What adopting the file at a ref would record; `issues` says why it cannot be, if so. */
export interface CheckDeclarationProposal {
  readonly ref: string;
  readonly commitSha: string;
  readonly sourcePath: string;
  readonly checks: readonly DeclaredCheck[];
  readonly definitionDigests: Readonly<Record<string, string>>;
  readonly issues: readonly string[];
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
    const commit = await this.git.resolveCommit(repository.rootPath, ref);
    if (!commit.ok) throw new ExecutionRequestError('invalid-request', `${ref} is not a commit.`);
    const tree = await this.git.exportCommit(repository.rootPath, commit.value.commitSha);
    if (!tree.ok) throw new ExecutionRequestError('unavailable', `${ref} could not be read.`);
    const files = new Map(tree.value.map((f) => [f.path, f.content]));
    const base = {
      ref,
      commitSha: commit.value.commitSha,
      sourcePath: CHECK_DECLARATION_PATH,
      checks: [] as readonly DeclaredCheck[],
      definitionDigests: {} as Record<string, string>,
    };
    const raw = files.get(CHECK_DECLARATION_PATH);
    if (!raw) return { ...base, issues: [`${CHECK_DECLARATION_PATH} is not in ${ref}.`] };
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      return { ...base, issues: [`${CHECK_DECLARATION_PATH} is not JSON.`] };
    }
    const parsed = checkDeclarationFileSchema.safeParse(json);
    if (!parsed.success)
      return {
        ...base,
        issues: parsed.error.issues.map(
          (i) => `${CHECK_DECLARATION_PATH}: ${i.path.join('.') || 'file'}: ${i.message}.`,
        ),
      };
    const checks: readonly DeclaredCheck[] = parsed.data.checks.map((c) => ({
      id: c.id,
      argv: c.argv,
      // A script the check runs defines it unless the file names its definition files.
      definitionPaths: c.definitionPaths ?? (c.argv[0]!.includes('/') ? [c.argv[0]!] : []),
    }));
    const issues: string[] = [];
    const definitionDigests: Record<string, string> = {};
    for (const path of new Set(checks.flatMap((c) => c.definitionPaths))) {
      const content = files.get(path);
      if (content) definitionDigests[path] = sha256(content);
      else issues.push(`${path}, a definition file of a declared check, is not in ${ref}.`);
    }
    return { ...base, checks, definitionDigests, issues };
  }
}

/** SHA-256 of a definition file's contents, as the declaration and receipts record it. */
export const definitionDigest = sha256;
