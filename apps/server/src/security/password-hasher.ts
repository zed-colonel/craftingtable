import * as argon2 from 'argon2';

const MIN_PASSWORD_BYTES = 12;
const MAX_PASSWORD_BYTES = 1024;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(encodedHash: string, password: string): Promise<boolean>;
}

function validatePassword(password: string): void {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < MIN_PASSWORD_BYTES || bytes > MAX_PASSWORD_BYTES) {
    throw new Error(
      `Password must be between ${MIN_PASSWORD_BYTES} and ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }
}

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    validatePassword(password);
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(encodedHash: string, password: string): Promise<boolean> {
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      return false;
    }
    try {
      return await argon2.verify(encodedHash, password);
    } catch {
      return false;
    }
  }
}
