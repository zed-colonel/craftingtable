import type { SourceRepositoryId, UserId, WorkspaceId } from './ids.js';

/**
 * Declared per-repository checks (R-G13, operator decision 2026-09-29). A repository proposes
 * its checks in a file; the operator adopts them, read by the daemon at a named commit, as an
 * immutable record. Scoped gates are met only by daemon-recorded receipts of the adopted checks.
 */

/** Where a repository proposes its checks. The file is a proposal; the adopted record rules. */
export const CHECK_DECLARATION_PATH = '.craftingtable/checks.json';

/** One declared check: its name, the command the daemon runs, and the files that define it. */
export interface DeclaredCheck {
  readonly id: string;
  /** The command and its arguments; the first is a program on PATH or a repository path. */
  readonly argv: readonly string[];
  /** Repository files whose contents define the check, such as its script. */
  readonly definitionPaths: readonly string[];
}

export interface RepositoryCheckDeclaration {
  readonly id: string;
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
}

/**
 * The declared checks a run was held to, as its launch manifest records them: which adoption,
 * and each check with the digests its definition files must still have.
 */
export interface ManifestDeclaredChecks {
  readonly declarationId: string;
  readonly version: number;
  readonly checks: readonly (DeclaredCheck & {
    readonly definitionDigests: Readonly<Record<string, string>>;
  })[];
}

/**
 * Files Cargo reads to choose a check's toolchain and configuration (R-G13, operator decision
 * 2026-09-30): an adopted check that runs Cargo must name each one its commit has as a
 * definition file, so an edit stops as `check-definition-changed`.
 */
export const CARGO_DEFINITION_FILES = [
  '.cargo/config.toml',
  '.cargo/config',
  'rust-toolchain.toml',
  'rust-toolchain',
] as const;

/** Whether an adopted argv runs Cargo: as its program, or named in a shell string it runs. */
export function argvRunsCargo(argv: readonly string[]): boolean {
  return argv.some((token) => /(^|[\s/;&|(])cargo(\s|$)/.test(token));
}
