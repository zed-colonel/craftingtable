import { retryableControllerError } from './cycle/core/effect-decisions.js';
import { ExecutionRequestError, TypedRefusalError } from './errors.js';

/**
 * A review continuation's capture of its branch context (R-C2): a refusal it meets is the
 * continuation's, `review-capture-failed`, unless it already names its own stop (a predecessor's
 * missing merge, the worktree's state, a refused launch), which it keeps (R-B4 increment 4
 * review). Contention and the unexpected pass through.
 */
export async function reviewCapture<T>(capture: () => Promise<T>): Promise<T> {
  try {
    return await capture();
  } catch (error) {
    if (
      error instanceof ExecutionRequestError &&
      !(error instanceof TypedRefusalError) &&
      !retryableControllerError(error)
    )
      throw new TypedRefusalError('review-capture-failed', error.message);
    throw error;
  }
}
