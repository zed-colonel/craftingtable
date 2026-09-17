import { expect, it } from 'vitest';
import { nativeArguments, nativeHostDigest, nativeUnit } from './native-environment.js';
it('bounds native execution and rejects unowned unit identifiers', () => {
  expect(() => nativeUnit('../other.service')).toThrow('Invalid native');
  const args = nativeArguments(nativeUnit('run-1'), '/tmp/check', 99999, ['/usr/bin/true']);
  expect(args).toContain('--property=RuntimeMaxSec=1800');
  expect(args).toContain('--property=MemoryMax=8G');
  expect(args).toContain('--property=KillMode=control-group');
  expect(args).toContain('--property=NoNewPrivileges=yes');
  expect(args.slice(-2)).toEqual(['--', '/usr/bin/true']);
  expect(nativeHostDigest()).toMatch(/^[a-f0-9]{64}$/);
});
