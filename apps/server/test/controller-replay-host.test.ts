import { afterEach, expect, it, vi } from 'vitest';
import { hostDigestArguments, main } from '../src/controller-replay.js';
import { pinReplayHost, replayHost } from '../src/services/replay-host.js';

/**
 * `controller:replay --host-digest` (R-B4b's first step): the replay tool pins the host its
 * goldens were recorded on before it runs any mode, and refuses a flag it cannot use. A regression
 * here would show only as the replays failing as they did after the kernel update.
 */
const HOST = 'ab5c03931fe4cc09f7fb06c93b6d224a12ae7067f6607574d704a4a53016fa45';
afterEach(() => {
  pinReplayHost(undefined);
  vi.restoreAllMocks();
});

it('takes the flag out of the arguments wherever it stands', () => {
  expect(hostDigestArguments(['s.sqlite', '--cycles'])).toEqual({ rest: ['s.sqlite', '--cycles'] });
  expect(hostDigestArguments(['s.sqlite', '--host-digest', HOST, '--cycles'])).toEqual({
    digest: HOST,
    rest: ['s.sqlite', '--cycles'],
  });
  expect(hostDigestArguments(['--host-digest', HOST, 's.sqlite'])).toEqual({
    digest: HOST,
    rest: ['s.sqlite'],
  });
  for (const argv of [
    ['s.sqlite', '--host-digest'],
    ['s.sqlite', '--host-digest', HOST, '--host-digest', HOST],
    ['s.sqlite', '--host-digest', '--host-digest'],
  ])
    expect(hostDigestArguments(argv)).toEqual({ error: 'once, with a value' });
});

it('pins the digest before the replay runs, and refuses one it cannot use', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  // A missing snapshot is the replay's own usage error, after the pin.
  expect(await main(['--host-digest', HOST, '/nonexistent/snapshot.sqlite'])).toBe(2);
  expect(replayHost()).toBe(HOST);
  pinReplayHost(undefined);
  for (const argv of [
    ['/nonexistent/snapshot.sqlite', '--host-digest'],
    ['/nonexistent/snapshot.sqlite', '--host-digest', 'abc'],
    ['/nonexistent/snapshot.sqlite', '--host-digest', HOST, '--host-digest', HOST],
  ]) {
    expect(await main(argv)).toBe(2);
    expect(replayHost()).toBeUndefined();
  }
  expect(
    stderr.mock.calls.map(([text]) => String(text)).filter((t) => t.includes('--host-digest')),
  ).toHaveLength(3);
});
