import { describe, expect, it } from 'vitest';
import { Argon2PasswordHasher } from './password-hasher.js';

describe('Argon2PasswordHasher', () => {
  it('creates and verifies an Argon2id hash', async () => {
    const hasher = new Argon2PasswordHasher();
    const password = 'correct horse battery staple';
    const hash = await hasher.hash(password);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(password);
    await expect(hasher.verify(hash, password)).resolves.toBe(true);
    await expect(hasher.verify(hash, 'incorrect password')).resolves.toBe(false);
  });

  it('bounds pathological password input', async () => {
    const hasher = new Argon2PasswordHasher();
    await expect(hasher.hash('short')).rejects.toThrow(/between/);
    await expect(hasher.hash('x'.repeat(1025))).rejects.toThrow(/between/);
  });
});
