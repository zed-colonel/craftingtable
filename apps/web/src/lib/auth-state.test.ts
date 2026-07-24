import { describe, expect, it } from 'vitest';
import { authenticationMessage } from './auth-state.js';

describe('authentication state', () => {
  it('makes expiry and daemon errors visible', () => {
    expect(authenticationMessage('expired')).toMatch(/expired/);
    expect(authenticationMessage('error')).toMatch(/daemon/);
    expect(authenticationMessage('authenticated')).toBeUndefined();
  });
});
