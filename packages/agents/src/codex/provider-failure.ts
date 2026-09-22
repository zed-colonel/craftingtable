import type { ProviderFailure } from '@craftingtable/domain';
import { isRecord } from '../bounded.js';

/** Only app-server's structured CodexErrorInfo is authoritative, never message text. */
export function codexProviderFailure(info: unknown): ProviderFailure {
  const failure = (
    kind: ProviderFailure['kind'],
    message: string,
    safeToRetry = false,
  ): ProviderFailure => ({ kind, message, safeToRetry });
  if (info === 'serverOverloaded')
    return failure('capacity', 'The selected model is at capacity.', true);
  if (info === 'internalServerError')
    return failure('unavailable', 'The model service reported an internal failure.', true);
  if (info === 'unauthorized')
    return failure('authentication', 'The model service requires authentication.');
  if (['usageLimitExceeded', 'sessionBudgetExceeded', 'rateLimitExceeded'].includes(String(info)))
    return failure('quota', 'The model service reported an allowance or rate limit.');
  if (isRecord(info)) {
    const keys = Object.keys(info);
    const key = keys[0];
    if (
      keys.length === 1 &&
      key &&
      [
        'httpConnectionFailed',
        'responseStreamConnectionFailed',
        'responseStreamDisconnected',
        'responseTooManyFailedAttempts',
      ].includes(key)
    ) {
      const value = info[key];
      const status = isRecord(value) ? value.httpStatusCode : undefined;
      if (status === 401 || status === 403)
        return failure('authentication', 'The model service rejected authentication.');
      if (status === 402 || status === 429)
        return failure('quota', 'The model service reported an allowance or rate limit.');
      if (status === null || (typeof status === 'number' && status >= 500 && status <= 599))
        return failure('transport', 'The connection to the model service failed.', true);
    }
  }
  return failure('unknown', 'The backend failed without a recognized temporary service error.');
}
