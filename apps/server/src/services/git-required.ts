/**
 * The daemon's Git, or the refusal a daemon without a Git executable answers (R-B7): one rule for
 * the execution service and the merge modules made from it.
 */
import type { GitOperations } from '@craftingtable/git';
import { ExecutionRequestError } from './errors.js';

export function requireGit(git: GitOperations | undefined): GitOperations {
  if (git === undefined) {
    throw new ExecutionRequestError(
      'unavailable',
      'No Git executable was found; set CRAFTINGTABLE_GIT_EXECUTABLE or add git to PATH',
    );
  }
  return git;
}
