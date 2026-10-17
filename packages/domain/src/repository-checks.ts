import type {
  AgentRunId,
  DeclaredCheckId,
  MergeOperationId,
  RepositoryCheckDeclarationId,
  SourceRepositoryId,
  UserId,
  WorkspaceId,
  WorktreeId,
} from './ids.js';

/**
 * Declared per-repository checks (R-G13, operator decision 2026-09-29). A repository proposes
 * its checks in a file; the operator adopts them, read by the daemon at a named commit, as an
 * immutable record. Scoped gates are met only by daemon-recorded receipts of the adopted checks.
 */

/** Where a repository proposes its checks. The file is a proposal; the adopted record rules. */
export const CHECK_DECLARATION_PATH = '.craftingtable/checks.json';

/** One declared check: its name, the command the daemon runs, and the files that define it. */
export interface DeclaredCheck {
  readonly id: DeclaredCheckId;
  /** The command and its arguments; the first is a program on PATH or a repository path. */
  readonly argv: readonly string[];
  /** Repository files whose contents define the check, such as its script. */
  readonly definitionPaths: readonly string[];
  /**
   * How long the daemon lets the check run, in minutes, ending at its step's deadline at the
   * latest (R-C17 part 1); without it, the run's limit applies, as before.
   */
  readonly timeoutMinutes?: number;
}

export interface RepositoryCheckDeclaration {
  readonly id: RepositoryCheckDeclarationId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: SourceRepositoryId;
  /** 1 for the first adoption in the repository, then one more for each. */
  readonly version: number;
  /** The commit the daemon read the file from, and the file. */
  readonly sourceCommit: string;
  readonly sourcePath: string;
  readonly checks: readonly DeclaredCheck[];
  /** SHA-256 of each definition file's contents at `sourceCommit`. */
  readonly definitionDigests: Readonly<Record<string, string>>;
  readonly rationale: string;
  readonly adoptedByUserId: UserId;
  readonly adoptedAt: string;
  /**
   * Set when the operator's approval of a merge adopted the checks at the merge commit
   * (R-G13 increment 5): which merge, of which worktree, reviewed by which run.
   */
  readonly adoptedAtMerge?: {
    readonly operationId: MergeOperationId;
    readonly worktreeId: WorktreeId;
    readonly reviewRunId: AgentRunId;
  };
}

/**
 * The declared checks a run was held to, as its launch manifest records them: which adoption,
 * and each check with the digests its definition files must still have.
 */
export interface ManifestDeclaredChecks {
  readonly declarationId: RepositoryCheckDeclarationId;
  readonly version: number;
  readonly checks: readonly (DeclaredCheck & {
    readonly definitionDigests: Readonly<Record<string, string>>;
  })[];
}

/**
 * Files Cargo reads to choose a check's toolchain and configuration (R-G13, operator decision
 * 2026-09-30, and its reviews): a Cargo configuration (legacy or not) or a toolchain file, at any
 * depth, or a `.cargo` that is itself a file or link. Every adopted check must name each one its
 * commit tracks as a definition file, and a check's tree may hold no other.
 */
export const CARGO_FILE_PATTERN = /(^|\/)(\.cargo(\/config(\.toml)?)?|rust-toolchain(\.toml)?)$/;

/**
 * A Python project's environment and tool configuration files (R-G17 decision 13): uv's project,
 * lock and settings, the interpreter pin, and pytest's (all four of its own file names, each read
 * before `pyproject.toml`; increment 3 review H1), coverage's, tox's, setuptools', Ruff's and
 * mypy's configuration, at any depth. They decide what a Python check installs and how its tools
 * run, so every adopted check must name each one its commit tracks as a definition file, as for
 * Cargo's, and a check's tree may hold no other. `conftest.py` and the tests stay the reviewer's.
 */
export const PYTHON_ENVIRONMENT_FILE_PATTERN =
  /(^|\/)(pyproject\.toml|uv\.lock|uv\.toml|\.python-version|\.?pytest\.(ini|toml)|\.coveragerc|tox\.ini|setup\.cfg|\.?ruff\.toml|\.?mypy\.ini)$/;

/** Whether an adopted argv runs Cargo: as its program, or named in a shell string it runs. */
export function argvRunsCargo(argv: readonly string[]): boolean {
  return argv.some((token) => /(^|[\s/;&|(])cargo(\s|$)/.test(token));
}
