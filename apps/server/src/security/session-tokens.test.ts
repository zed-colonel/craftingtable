import { describe, expect, it } from 'vitest';
import { SessionTokenService } from './session-tokens.js';

describe('SessionTokenService', () => {
  it('generates 256-bit raw material and a deterministic SHA-256 digest', () => {
    const service = new SessionTokenService();
    const token = service.generate();
    expect(Buffer.from(token.raw, 'base64url')).toHaveLength(32);
    expect(token.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(service.digest(token.raw)).toBe(token.digest);
    expect(token.digest).not.toContain(token.raw);
  });
});
