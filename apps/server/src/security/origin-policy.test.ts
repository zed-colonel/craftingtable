import { describe, expect, it } from 'vitest';
import { isAllowedBrowserRequest } from './origin-policy.js';

describe('browser origin policy', () => {
  const origin = 'http://127.0.0.1:5173';

  it('accepts the configured origin and non-browser requests', () => {
    expect(isAllowedBrowserRequest({ origin, secFetchSite: 'same-origin' }, origin)).toBe(true);
    expect(isAllowedBrowserRequest({}, origin)).toBe(true);
  });

  it('rejects cross-site fetch metadata and a foreign origin', () => {
    expect(isAllowedBrowserRequest({ secFetchSite: 'cross-site' }, origin)).toBe(false);
    expect(isAllowedBrowserRequest({ origin: 'https://evil.example' }, origin)).toBe(false);
  });
});
