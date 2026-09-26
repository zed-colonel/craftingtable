import type { ProviderFailure } from '@craftingtable/domain';
import { isRecord } from '../bounded.js';

/** How the Codex session is signed in, from app-server's `account/read`. */
export type CodexAuthMode = 'chatgpt' | 'api-key' | 'unknown';

/**
 * The structured CodexErrorInfo is authoritative. One exception reads the message (R-C11):
 * Codex reports a provider-side credential rejection only as `other`, with the backend's
 * status line in the text. The line names an API key while a ChatGPT-mode login never
 * sends one, so it is the provider rejecting credentials the host did not supply.
 */
const PROVIDER_REJECTION =
  /unexpected status 401 Unauthorized: Incorrect API key provided: (sk-[A-Za-z]{0,5})[A-Za-z0-9_-]{0,200}?\*{0,400}([A-Za-z0-9]{4})[.,][^\n]{0,600}?url: (https:\/\/chatgpt\.com\/backend-api\/[^\s,]{1,200})(?:[^\n]{0,600}?request id: ([0-9A-Fa-f-]{8,64}))?/;
/** The status line sits near the start of a message; the rest is never read. */
const SCANNED_CHARACTERS = 4096;

/**
 * The observed facts of a provider-side rejection, or undefined when the text is not one.
 * Every quantifier is bounded and stays within one line, so a pathological message cannot
 * stall the daemon, and the endpoint and request id are the rejection's own. The key is shown
 * no wider than the vendor's own masking: a short prefix and the last four characters.
 */
export function codexCredentialRejection(message: string): string | undefined {
  const match = PROVIDER_REJECTION.exec(message.slice(0, SCANNED_CHARACTERS));
  if (!match) return undefined;
  const [, prefix, suffix, url, request] = match;
  return `HTTP 401 from ${url} naming an API key ${prefix}…${suffix}${
    request ? ` (request ${request})` : ''
  }`;
}

/** A rejection seen while the local login is ChatGPT mode: the provider's side, retried. */
export function credentialRejected(evidence: string, safeToRetry = true): ProviderFailure {
  return {
    kind: 'credential-rejected',
    message:
      'Codex rejected its credentials: a provider-side outage is suspected; the local login is ChatGPT mode and sends no API key.',
    safeToRetry,
    evidence: evidence.slice(0, 1000),
  };
}

/** The local login itself needs the operator: sign in again on the workstation. */
export function localAuthenticationFailure(evidence?: string): ProviderFailure {
  return {
    kind: 'authentication',
    message:
      "Codex's local login was rejected or has expired. Sign in again on the workstation (codex login), then resume.",
    safeToRetry: false,
    ...(evidence ? { evidence: evidence.slice(0, 1000) } : {}),
  };
}

export function codexProviderFailure(
  info: unknown,
  message = '',
  auth: CodexAuthMode = 'unknown',
): ProviderFailure {
  const failure = (
    kind: ProviderFailure['kind'],
    text: string,
    safeToRetry = false,
  ): ProviderFailure => ({ kind, message: text, safeToRetry });
  if (info === 'serverOverloaded')
    return failure('capacity', 'The selected model is at capacity.', true);
  if (info === 'internalServerError')
    return failure('unavailable', 'The model service reported an internal failure.', true);
  // Codex reports its own login failing, e.g. a token refresh that failed.
  if (info === 'unauthorized') return localAuthenticationFailure();
  if (['usageLimitExceeded', 'sessionBudgetExceeded', 'rateLimitExceeded'].includes(String(info)))
    return failure('quota', 'The model service reported an allowance or rate limit.');
  if (info === 'other' || info === undefined || info === null) {
    const rejected = codexCredentialRejection(message);
    // With an API-key login, a rejected key is the operator's to replace.
    if (rejected)
      return auth === 'chatgpt'
        ? credentialRejected(rejected)
        : localAuthenticationFailure(rejected);
  }
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
