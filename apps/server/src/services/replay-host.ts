/**
 * The host a replay runs as (R-B4b). A native approval names the workstation it was given on
 * (`nativeHostDigest`: its hostname, kernel release and native tools), so replayed on a later
 * kernel every approval in a snapshot reads as lapsed, and its goldens no longer match. The replay
 * tool pins the digest current when the snapshot's goldens were recorded; only it sets the pin and
 * only `workstation.ts` reads it (check:scope rule 12), so the daemon always compares an approval
 * with the live digest.
 */
const HOST_DIGEST = /^[0-9a-f]{64}$/;
let pinned: string | undefined;

/** Pins the host digest for this process's replay, or with `undefined` takes the pin away. */
export function pinReplayHost(digest: string | undefined): void {
  if (digest !== undefined && !HOST_DIGEST.test(digest))
    throw new Error('A replay host is a 64-digit SHA-256 digest (lower-case hex).');
  pinned = digest;
}

/** The pinned host digest, when a replay pinned one. */
export function replayHost(): string | undefined {
  return pinned;
}
