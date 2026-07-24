import { createHash, randomBytes } from 'node:crypto';

export interface NewSecretToken {
  readonly raw: string;
  readonly digest: string;
}

export class SessionTokenService {
  generate(): NewSecretToken {
    const raw = randomBytes(32).toString('base64url');
    return { raw, digest: this.digest(raw) };
  }

  generateCsrfToken(): string {
    return randomBytes(32).toString('base64url');
  }

  digest(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}
