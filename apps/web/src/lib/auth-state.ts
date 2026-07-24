export type AuthenticationStatus =
  | 'checking'
  | 'authenticated'
  | 'unauthenticated'
  | 'expired'
  | 'error';

export function authenticationMessage(status: AuthenticationStatus): string | undefined {
  switch (status) {
    case 'expired':
      return 'Your session expired or was revoked. Sign in again.';
    case 'error':
      return 'CraftingTable could not verify your session. Check that the daemon is running.';
    default:
      return undefined;
  }
}
