import { createHash, randomUUID } from 'node:crypto';
import {
  type AdoptCheckDeclarationRequest,
  checkDeclarationFileSchema,
  type RepositoryCheckReceipts,
} from '@craftingtable/contracts';
import {
  asAuditEventId,
  CARGO_FILE_PATTERN,
  CHECK_DECLARATION_PATH,
  type DeclaredCheck,
  type RepositoryCheckDeclaration,
  type SourceRepository,
  type SourceRepositoryId,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from '@craftingtable/domain';
import type { CommitFile, GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import type { BuildReceipt } from './build-receipt-policy.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
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
  /** On the Repositories page: the adopted version, where the file differs from it. */
  readonly previous?: CheckDefinitionFile;
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
  /**
   * Each integration branch the repository's plans merge into, and how this commit stands to
   * it (LIVE-30): whether the branch contains it, and which proposed files differ at its head.
   */
  readonly branches: readonly CheckSourceBranch[];
}

export interface CheckSourceBranch {
  readonly branch: string;
  readonly headSha: string;
  readonly contains: boolean;
  readonly differing: readonly string[];
}

/**
 * A check definition file (or the checks file) at each commit that decides who changed it
 * (R-G13 increment 5, LIVE-30): the adoption, the reviewed head, the head's merge base with
 * its integration branch, and that branch's head. Each is the SHA-256 of the file's contents,
 * `link` for a link, or null where there is no file.
 */
export interface CheckDefinitionPath {
  readonly path: string;
  readonly adopted: string | null;
  readonly head: string | null;
  readonly base: string | null;
  readonly target: string | null;
}

/** What a merge would adopt: the checks its result proposes, against the current adoption. */
export interface MergeAdoption {
  /** The merge's predicted tree; absent when the merge would conflict. */
  readonly tree?: string;
  readonly proposal?: CheckDeclarationProposal;
  /** The digest an approval names; it covers the checks and their definitions. */
  readonly proposalDigest?: string;
  /** The proposal is exactly the current adoption: the merge adopts nothing. */
  readonly unchanged: boolean;
  /** The checks adopted now, beside the proposal's, so a changed check shows both. */
  readonly adoptedChecks?: readonly DeclaredCheck[];
  readonly checks: readonly {
    readonly id: string;
    readonly change: 'added' | 'removed' | 'changed';
  }[];
  readonly definitions: readonly {
    readonly path: string;
    readonly adopted: CheckDefinitionFile | null;
    readonly proposed: CheckDefinitionFile | null;
  }[];
  /** Why the merge cannot adopt its result; empty when it can. */
  readonly issues: readonly string[];
  /** What the operator should weigh, as the Repositories page's preview says it. */
  readonly warnings?: readonly string[];
}

/**
 * Where a reviewed slice's check definitions stand (R-G13 increment 5, LIVE-30): which files
 * the slice changed, which differ between the adoption and the integration branch, and, when
 * the slice changes any, what merging it would adopt.
 */
export interface CheckDefinitionDiagnosis {
  readonly repositoryId: SourceRepositoryId;
  readonly declaration: {
    readonly id: string;
    readonly version: number;
    readonly sourceCommit: string;
  };
  readonly headSha: string;
  readonly targetBranch: string;
  readonly targetSha: string;
  readonly baseSha: string;
  readonly paths: readonly CheckDefinitionPath[];
  /** Files the slice changed since its merge base. */
  readonly sliceChanged: readonly string[];
  /** Definition files whose adopted version differs from the integration branch's head. */
  readonly targetDiffers: readonly string[];
  /** Present when the slice changed a file to other than its adopted version. */
  readonly merge?: MergeAdoption;
}

/** The most text of one definition a merge's approval shows; a longer one is not adopted. */
const MERGE_TEXT_LIMIT = 1024 * 1024;
/** The most text all changed definitions of one merge may hold together. */
const MERGE_TOTAL_LIMIT = 4 * 1024 * 1024;

/**
 * The first character a person could not see, or could mistake (R-G13 increment 5, second
 * verification): anything but tab, newline, printable ASCII, and letters, numbers,
 * punctuation and symbols that are not default-ignorable. An allowlist, not a list of
 * invisible characters: spaces other than ASCII's, format and control characters, combining
 * marks, variation selectors, tags and separators all fall outside it.
 */
export function unseenCharacter(
  text: string,
): { readonly codePoint: string; readonly line: number } | undefined {
  let line = 1;
  for (const c of text) {
    if (c === '\n') {
      line += 1;
      continue;
    }
    if (c === '\t' || (c >= ' ' && c <= '~')) continue;
    if (/[\p{L}\p{N}\p{P}\p{S}]/u.test(c) && !/\p{Default_Ignorable_Code_Point}/u.test(c)) continue;
    return {
      codePoint: `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
      line,
    };
  }
  return undefined;
}

/** Each place in a proposal a person could not see exactly: definitions, commands and paths. */
function unseenIn(
  checks: readonly DeclaredCheck[],
  definitions: readonly { path: string; text?: string }[],
): string[] {
  const found: string[] = [];
  for (const d of definitions) {
    const at = d.text === undefined ? undefined : unseenCharacter(d.text);
    if (at) found.push(`${d.path} holds ${at.codePoint} at line ${at.line}`);
  }
  for (const check of checks) {
    const command = check.argv.map((a) => unseenCharacter(a)).find((at) => at);
    if (command) found.push(`check ${check.id} holds ${command.codePoint} in its command`);
    const path = check.definitionPaths.map((p) => unseenCharacter(p)).find((at) => at);
    if (path)
      found.push(`check ${check.id} names a definition file whose path holds ${path.codePoint}`);
  }
  return found;
}

/** The digest an operator's approval names: the checks and their definition files' digests. */
export function proposalDigest(
  proposal: Pick<CheckDeclarationProposal, 'checks' | 'definitionDigests'>,
): string {
  return sha256(
    JSON.stringify({
      checks: proposal.checks,
      definitionDigests: Object.entries(proposal.definitionDigests).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    }),
  );
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

  /**
   * Where a worktree's newest review stands against the adopted check definitions (R-G13
   * increment 5). Undefined when no review of it was held to adopted checks.
   */
  async definitionsOf(
    context: AuthContext,
    ws: WorkspaceId,
    worktreeId: WorktreeId,
  ): Promise<CheckDefinitionDiagnosis | undefined> {
    this.workspaces.requireAuthorized(context, ws);
    const tree = this.storage.execution.worktrees.find(ws, worktreeId);
    if (!tree) throw new NotFoundError();
    const review = this.storage.execution.runs
      .listForWorktree(ws, worktreeId)
      .find((r) => r.role === 'review' && r.reviewBranchContext);
    if (!review?.reviewBranchContext) return undefined;
    if (!this.storage.runtimeEvidence.run(ws, review.id)?.checkDeclarationId) return undefined;
    return this.diagnose(tree, review.reviewBranchContext);
  }

  /**
   * The repository's recent check receipts, labelled (R-G13 increment 5). Who asked for a
   * check is read only from receipts the daemon recorded: a run that wrote its own receipt
   * file (before R-G4) could write any `origin`, so its requester is unknown (L4).
   */
  receipts(
    context: AuthContext,
    ws: WorkspaceId,
    repositoryId: SourceRepositoryId,
  ): RepositoryCheckReceipts {
    this.workspaces.requireAuthorized(context, ws);
    this.repository(ws, repositoryId);
    const declarations = new Map(
      this.storage.runtimeEvidence.checkDeclarations(ws, repositoryId).map((d) => [d.id, d]),
    );
    const runs: RepositoryCheckReceipts['runs'][number][] = [];
    for (const run of this.storage.execution.runs.listRecentForRepository(ws, repositoryId, 60)) {
      if (runs.length >= 20) break;
      const env = this.storage.runtimeEvidence.run(ws, run.id);
      if (!env) continue;
      const daemon = env.receiptAuthority === 'daemon';
      const frozen = this.storage.runtimeEvidence.build(ws, run.id);
      const lines = frozen
        ? frozen.receipts.split('\n')
        : daemon
          ? this.storage.runtimeEvidence.checkReceipts(ws, run.id).map((r) => r.receipt)
          : [];
      const receipts = lines
        .filter((line) => line.trim() !== '')
        .slice(0, 50)
        .flatMap((line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return [];
          }
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? [receiptView(parsed as Record<string, unknown>, daemon, declarations)]
            : [];
        });
      if (!receipts.length) continue;
      runs.push({
        runId: run.id,
        role: run.role,
        worktreeId: run.worktreeId,
        status: run.status,
        createdAt: run.createdAt,
        recordedBy: daemon ? 'daemon' : 'run',
        ...(env.checkDeclarationId && declarations.get(env.checkDeclarationId)
          ? { declarationVersion: declarations.get(env.checkDeclarationId)!.version }
          : {}),
        receipts,
      });
    }
    return { repositoryId, runs };
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
    // A branch or an exact commit, never a tag or another ref a name falls back to: anyone who
    // can write refs in the repository, agents included, could shadow a branch (R-G13 review).
    const exact = /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(ref);
    const named = exact ? undefined : await this.git.exactBranchCommit(repository.rootPath, ref);
    const commit =
      named?.ok === false
        ? named
        : await this.git.resolveCommit(repository.rootPath, named?.value ?? ref);
    if (!commit.ok)
      throw new ExecutionRequestError(
        'invalid-request',
        `${ref} is not a branch or a complete commit ID of ${repository.displayName}.`,
      );
    const proposal = await this.proposalAt(repository, commit.value.commitSha, ref);
    const branches = await this.boundBranches(repository, proposal);
    // Each definition that differs from the current adoption, beside its adopted text.
    const current = this.storage.runtimeEvidence.checkDeclarations(ws, repositoryId)[0];
    const changed = current
      ? proposal.definitions.filter((d) => current.definitionDigests[d.path] !== d.digest)
      : [];
    const before = current
      ? await this.files(
          repository,
          current.sourceCommit,
          changed.map((d) => d.path).filter((p) => current.definitionDigests[p]),
        ).catch(() => new Map<string, CommitFile>())
      : new Map<string, CommitFile>();
    const definitions = proposal.definitions.map((d) => {
      const old = before.get(d.path);
      return old?.kind === 'file' && sha256(old.content) === current?.definitionDigests[d.path]
        ? { ...d, previous: definitionPreview(d.path, old.content) }
        : d;
    });
    return {
      ...proposal,
      definitions,
      warnings: [
        ...proposal.warnings,
        ...unseenIn(proposal.checks, proposal.definitions).map(
          (unseen) =>
            `${unseen}, a character that does not show, or shows as something else; it is shown here as U+…. Adopt it only if you meant it.`,
        ),
        ...branches.flatMap((b) => [
          ...(b.contains
            ? []
            : [
                `${ref} is not on ${b.branch}, an integration branch of this repository: checks adopted from it may differ from what slices merged there carry.`,
              ]),
          ...(b.differing.length
            ? [
                `${b.differing.join(', ')} ${b.differing.length === 1 ? 'differs' : 'differ'} at the head of ${b.branch}: every slice that carries that branch's version will stop as check-definition-changed.`,
              ]
            : []),
        ]),
      ],
      branches,
    };
  }

  /**
   * The integration branches this repository's plans merge into, and how the proposal's commit
   * stands to each (LIVE-30). A branch that no longer exists is left out.
   */
  private async boundBranches(
    repository: SourceRepository,
    proposal: CheckDeclarationProposal,
  ): Promise<CheckSourceBranch[]> {
    const names = [
      ...new Set(
        this.storage.execution.branchSettings
          .list()
          .filter(
            (s) => s.workspaceId === repository.workspaceId && s.repositoryId === repository.id,
          )
          .map((s) => s.integrationBranch),
      ),
    ].slice(0, 10);
    const paths = [proposal.sourcePath, ...Object.keys(proposal.definitionDigests)];
    const result: CheckSourceBranch[] = [];
    for (const branch of names) {
      const head = await this.git!.exactBranchCommit(repository.rootPath, branch);
      if (!head.ok) continue;
      const contains = await this.git!.isAncestor(
        repository.rootPath,
        proposal.commitSha,
        head.value,
      );
      const there = await this.digests(repository, head.value, paths);
      const here = await this.digests(repository, proposal.commitSha, paths);
      result.push({
        branch,
        headSha: head.value,
        contains: contains.ok && contains.value,
        differing: paths.filter((path) => there.get(path) !== here.get(path)),
      });
    }
    return result;
  }

  /** Each path's contents digest at a commit or tree: `link` for a link, null when absent. */
  private async digests(
    repository: SourceRepository,
    at: string,
    paths: readonly string[],
  ): Promise<Map<string, string | null>> {
    const files = await this.files(repository, at, paths);
    return new Map(
      paths.map((path) => {
        const file = files.get(path);
        return [path, !file ? null : file.kind === 'link' ? 'link' : sha256(file.content)];
      }),
    );
  }

  /** `readCommitFiles` for any number of paths (it reads at most 32 at once). */
  private async files(
    repository: SourceRepository,
    at: string,
    paths: readonly string[],
  ): Promise<Map<string, CommitFile>> {
    const unique = [...new Set(paths)];
    const files = new Map<string, CommitFile>();
    for (let i = 0; i < unique.length; i += 32) {
      const read = await this.git!.readCommitFiles(
        repository.rootPath,
        at,
        unique.slice(i, i + 32),
      );
      if (!read.ok)
        throw new ExecutionRequestError(
          'unavailable',
          `Check definitions could not be read: ${read.failure.message}`,
        );
      for (const [path, file] of read.value) files.set(path, file);
    }
    return files;
  }

  /**
   * Where a reviewed head's check definitions stand against the repository's current adoption
   * (R-G13 increment 5, LIVE-30). Undefined when the repository has adopted none.
   */
  async diagnose(
    tree: Pick<Worktree, 'workspaceId' | 'repositoryId'>,
    review: { readonly headSha: string; readonly targetBranch: string; readonly targetSha: string },
  ): Promise<CheckDefinitionDiagnosis | undefined> {
    const repository = this.repository(tree.workspaceId, tree.repositoryId);
    if (!this.git) throw new ExecutionRequestError('unavailable', 'Git is unavailable.');
    const declaration = this.storage.runtimeEvidence.checkDeclarations(
      tree.workspaceId,
      tree.repositoryId,
    )[0];
    if (!declaration) return undefined;
    const base = await this.git.commonAncestor(
      repository.rootPath,
      review.headSha,
      review.targetSha,
    );
    if (!base.ok)
      throw new ExecutionRequestError(
        'unavailable',
        `The slice's merge base could not be found: ${base.failure.message}`,
      );
    const definitionPaths = [...new Set(declaration.checks.flatMap((c) => c.definitionPaths))];
    const paths = [declaration.sourcePath, ...definitionPaths];
    const [head, at, target, adoptedFile] = await Promise.all([
      this.digests(repository, review.headSha, paths),
      this.digests(repository, base.value, paths),
      this.digests(repository, review.targetSha, paths),
      // The adopted checks file, read at its commit; unknown when that commit is gone.
      this.digests(repository, declaration.sourceCommit, [declaration.sourcePath]).catch(
        () => new Map<string, string | null>(),
      ),
    ]);
    const rows: CheckDefinitionPath[] = paths.map((path) => ({
      path,
      adopted:
        path === declaration.sourcePath
          ? (adoptedFile.get(path) ?? null)
          : (declaration.definitionDigests[path] ?? null),
      head: head.get(path) ?? null,
      base: at.get(path) ?? null,
      target: target.get(path) ?? null,
    }));
    const sliceChanged = rows.filter((r) => r.head !== r.base).map((r) => r.path);
    // A change the operator already adopted (on the Repositories page) leaves the merge
    // nothing to adopt.
    const unadopted = rows.filter((r) => r.head !== r.base && r.head !== r.adopted);
    const diagnosis: CheckDefinitionDiagnosis = {
      repositoryId: tree.repositoryId,
      declaration: {
        id: declaration.id,
        version: declaration.version,
        sourceCommit: declaration.sourceCommit,
      },
      headSha: review.headSha,
      targetBranch: review.targetBranch,
      targetSha: review.targetSha,
      baseSha: base.value,
      paths: rows,
      sliceChanged,
      targetDiffers: rows
        .filter((r) => r.path !== declaration.sourcePath && r.target !== r.adopted)
        .map((r) => r.path),
    };
    return unadopted.length
      ? { ...diagnosis, merge: await this.mergeAdoption(repository, declaration, review) }
      : diagnosis;
  }

  /** What merging the reviewed head into its integration branch would adopt. */
  private async mergeAdoption(
    repository: SourceRepository,
    declaration: RepositoryCheckDeclaration,
    review: { readonly headSha: string; readonly targetBranch: string; readonly targetSha: string },
  ): Promise<MergeAdoption> {
    const tree = await this.git!.mergeTree(repository.rootPath, review.targetSha, review.headSha);
    if (!tree.ok)
      return {
        unchanged: false,
        checks: [],
        definitions: [],
        issues: [
          tree.failure.kind === 'merge-conflict'
            ? `The slice does not merge cleanly into ${review.targetBranch}; refresh it first.`
            : `The merge could not be predicted: ${tree.failure.message}`,
        ],
      };
    const proposal = await this.proposalAt(
      repository,
      tree.value,
      `the merge into ${review.targetBranch}`,
    );
    const adopted = new Map(declaration.checks.map((c) => [c.id, c]));
    const proposed = new Map(proposal.checks.map((c) => [c.id, c]));
    const checks = [
      ...proposal.checks
        .filter((c) => JSON.stringify(adopted.get(c.id)) !== JSON.stringify(c))
        .map((c) => ({
          id: c.id,
          change: adopted.has(c.id) ? ('changed' as const) : ('added' as const),
        })),
      ...declaration.checks
        .filter((c) => !proposed.has(c.id))
        .map((c) => ({ id: c.id, change: 'removed' as const })),
    ];
    const definitionPaths = [
      ...new Set([
        ...Object.keys(declaration.definitionDigests),
        ...Object.keys(proposal.definitionDigests),
      ]),
    ].filter((p) => declaration.definitionDigests[p] !== proposal.definitionDigests[p]);
    // Both sides in full: the operator approves exactly what the merge adopts (review F1).
    const [before, after] = await Promise.all([
      // The adopted text, where the adopted commit still has the adopted bytes.
      this.files(repository, declaration.sourceCommit, definitionPaths).catch(
        () => new Map<string, CommitFile>(),
      ),
      this.files(repository, tree.value, definitionPaths),
    ]);
    const issues = [...proposal.issues];
    const definitions = definitionPaths.map((path) => {
      const old = before.get(path);
      const adoptedFile =
        old?.kind === 'file' && sha256(old.content) === declaration.definitionDigests[path]
          ? definitionPreview(path, old.content, MERGE_TEXT_LIMIT)
          : declaration.definitionDigests[path]
            ? { path, digest: declaration.definitionDigests[path]!, bytes: 0 }
            : null;
      const next = after.get(path);
      const proposed =
        next?.kind === 'file' && proposal.definitionDigests[path] !== undefined
          ? definitionPreview(path, next.content, MERGE_TEXT_LIMIT)
          : null;
      if (proposed && (proposed.text === undefined || proposed.truncated))
        issues.push(
          `${path} is not short UTF-8 text, so it cannot be shown in full before a merge adopts it (${proposed.bytes} bytes; at most ${MERGE_TEXT_LIMIT / 1024} KiB of UTF-8 is shown). Keep it shorter, or adopt it on the Repositories page after reading it in the repository.`,
        );
      return { path, adopted: adoptedFile, proposed };
    });
    // What the person approves must be exactly what is adopted: a character they cannot see,
    // in a changed definition or a changed check, refuses adoption at merge.
    for (const unseen of unseenIn(
      proposal.checks.filter((c) => checks.some((x) => x.id === c.id)),
      definitions.flatMap((d) =>
        d.proposed?.text === undefined ? [] : [{ path: d.path, text: d.proposed.text }],
      ),
    ))
      issues.push(
        `${unseen}, a character that does not show, or shows as something else; a merge adopts only what it can show exactly. Remove it, or adopt the checks on the Repositories page after reading them in the repository.`,
      );
    const shown = definitions.reduce((sum, d) => sum + (d.proposed?.bytes ?? 0), 0);
    if (shown > MERGE_TOTAL_LIMIT)
      issues.push(
        `The changed definitions hold ${shown} bytes; a merge adopts at most ${MERGE_TOTAL_LIMIT / 1024 / 1024} MiB of definitions shown with it. Adopt them on the Repositories page after reading them in the repository.`,
      );
    return {
      tree: tree.value,
      proposal,
      proposalDigest: proposalDigest(proposal),
      unchanged: !checks.length && !definitions.length,
      adoptedChecks: declaration.checks,
      checks,
      definitions,
      issues,
      warnings: proposal.warnings,
    };
  }

  /**
   * The proposal at an exact commit or tree, checked by the adoption rules. `ref` names it in
   * messages. It reads only through the daemon's Git, never a worktree.
   */
  async proposalAt(
    repository: SourceRepository,
    at: string,
    ref: string,
  ): Promise<CheckDeclarationProposal> {
    const read = (paths: readonly string[]) =>
      this.git!.readCommitFiles(repository.rootPath, at, paths);
    const base = {
      ref,
      commitSha: at,
      sourcePath: CHECK_DECLARATION_PATH,
      checks: [] as readonly DeclaredCheck[],
      definitionDigests: {} as Record<string, string>,
      definitions: [] as CheckDefinitionFile[],
      branches: [] as CheckSourceBranch[],
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
    // Every Cargo configuration and toolchain file the commit tracks, at any depth: the check
    // runner refuses a tree holding one its check was not adopted with (R-G13 posture review).
    const listed = await this.git!.listCommitPaths(repository.rootPath, at);
    if (!listed.ok)
      throw new ExecutionRequestError(
        'unavailable',
        `${ref} could not be listed: ${listed.failure.message}`,
      );
    const cargoFiles = listed.value.filter((path) => CARGO_FILE_PATTERN.test(path));
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
      // Cargo reads these to choose its toolchain, wrapper and aliases, and may run beneath any
      // command: every check is held to them (R-G13, operator decision 2026-09-30 and its review).
      for (const path of cargoFiles)
        if (!check.definitionPaths.includes(path))
          issues.push(
            `Check ${check.id} does not name ${path} as a definition file; the commit has it, and Cargo reads it.`,
          );
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
function definitionPreview(
  path: string,
  content: Uint8Array,
  limit = 64 * 1024,
): CheckDefinitionFile {
  let text: string | undefined;
  try {
    // The whole file must be UTF-8; the text shown is cut at a character, never inside one.
    // A byte order mark is kept: the text shown is the file's, and the mark changes what runs
    // (verification of the R-G13 increment 5 review).
    const whole = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(content.subarray(0, limit));
    if (content.byteLength > limit && text.endsWith('\uFFFD') && !whole.startsWith(text))
      text = text.slice(0, -1);
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

/**
 * Why a review's check definitions stop it (R-G13 increment 5, LIVE-30): the slice's own
 * change that its merge cannot adopt, or an adoption that differs from what the slice carries
 * from its integration branch.
 */
export function definitionChangeReason(
  diagnosis: CheckDefinitionDiagnosis,
  merges: boolean,
): string {
  const short = (sha: string) => sha.slice(0, 12);
  const sliceMade = diagnosis.paths
    .filter((p) => diagnosis.sliceChanged.includes(p.path) && p.head !== p.adopted)
    .map((p) => p.path);
  const inherited = diagnosis.paths
    .filter((p) => p.path !== CHECK_DECLARATION_PATH)
    .filter((p) => p.head !== p.adopted && !sliceMade.includes(p.path))
    .map((p) => p.path);
  const parts: string[] = [];
  if (inherited.length)
    parts.push(
      `This slice did not change ${inherited.join(', ')}: adoption version ${diagnosis.declaration.version} (from ${short(diagnosis.declaration.sourceCommit)}) differs from what it carries from ${diagnosis.targetBranch}${diagnosis.targetDiffers.some((p) => inherited.includes(p)) ? ` (head ${short(diagnosis.targetSha)})` : ''}. Adopt the checks from ${diagnosis.targetBranch} on the Repositories page, then resume for a fresh review.`,
    );
  if (sliceMade.length) {
    const issues = diagnosis.merge?.issues ?? [];
    parts.push(
      !merges
        ? `This slice changes ${sliceMade.join(', ')}, and this review does not merge, so nothing can adopt the change. Adopt it on the Repositories page, then resume for a fresh review; or stop this cycle and revert the change in a new attempt.`
        : issues.length
          ? `This slice changes ${sliceMade.join(', ')}, and its merge cannot adopt the change: ${issues.join(' ')} Fix it in the slice, or adopt it on the Repositories page, then resume for a fresh review; or stop this cycle and revert the change in a new attempt.`
          : `This slice changes ${sliceMade.join(', ')}, and its checks, run as adoption version ${diagnosis.declaration.version} defines them, cannot meet the gate with the definitions it proposes. Adopt the checks from the slice's commit ${short(diagnosis.headSha)} on the Repositories page, then resume for a fresh review; or stop this cycle and revert the change in a new attempt.`,
    );
  }
  return (
    parts.join(' ') ||
    'A declared check ran with definitions that differ from the adopted ones. Resume for a fresh review.'
  );
}

/**
 * One receipt as the Checks panel shows it (R-G13 increment 5). A receipt the daemon recorded
 * is labelled from its fields; one a run wrote itself is "self-reported", whatever it claims,
 * and every field is checked before use (review F4).
 */
function receiptView(
  r: Record<string, unknown>,
  daemon: boolean,
  declarations: ReadonlyMap<string, RepositoryCheckDeclaration>,
): RepositoryCheckReceipts['runs'][number]['receipts'][number] {
  const args = Array.isArray(r.args) ? r.args.map((a) => String(a)) : [];
  const base = {
    success: r.success === true,
    clean: r.clean === true,
    headSha: typeof r.headSha === 'string' && /^[0-9a-f]{40,64}$/.test(r.headSha) ? r.headSha : '',
  };
  const command = (program: string) => [program, ...args].join(' ').slice(0, 200);
  const program = typeof r.command === 'string' ? r.command : '';
  if (!daemon)
    return { ...base, kind: 'self-reported', command: command(program), requestedBy: 'unknown' };
  const declared = (r as Partial<BuildReceipt>).declaredCheck;
  const adoption =
    declared && typeof declared.declarationId === 'string'
      ? declarations.get(declared.declarationId)
      : undefined;
  const check = adoption?.checks.find((c) => c.id === declared?.id);
  return {
    ...base,
    kind: check
      ? 'declared'
      : r.kind === 'scoped-check'
        ? 'supplemental'
        : r.kind === 'local-ci'
          ? 'local-ci'
          : r.kind === 'native-check'
            ? 'native'
            : 'pinned-build',
    ...(check ? { checkId: check.id, declarationVersion: adoption!.version } : {}),
    command: check
      ? `ct-check --declared ${check.id}`
      : r.kind === undefined
        ? command('cargo')
        : command(program),
    requestedBy: r.origin === 'daemon' ? 'daemon' : 'agent',
    ...(check
      ? {
          definitions: check.definitionPaths.every(
            (path) => declared!.definitionDigests?.[path] === adoption!.definitionDigests[path],
          )
            ? ('adopted' as const)
            : ('differ' as const),
        }
      : {}),
  };
}
