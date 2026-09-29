import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CratesIoChecksums, sparseIndexPath } from './crate-checksums.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cacheFile = () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ct-crate-checksums-'));
  roots.push(root);
  return join(root, 'crate-checksums.json');
};
const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
const line = (name: string, vers: string, cksum: string) =>
  JSON.stringify({ name, vers, deps: [], cksum, features: {}, yanked: false });

it('lays out crate names as the sparse index does', () => {
  expect(['a', 'ab', 'abc', 'itoa', 'Serde_Json'].map(sparseIndexPath)).toEqual([
    '1/a',
    '2/ab',
    '3/a/abc',
    'it/oa/itoa',
    'se/rd/serde_json',
  ]);
});

it("learns a crate's published checksums from crates.io's own index once, and keeps them (R-G13 review, operator decision 2026-09-29)", async () => {
  const file = cacheFile();
  const requests: string[] = [];
  const index = new CratesIoChecksums(file, async (url) => {
    requests.push(url);
    return new Response(
      [
        line('itoa', '1.0.17', 'a'.repeat(64)),
        line('itoa', '1.0.18', 'b'.repeat(64)),
        // Another crate's entry, or a malformed one, teaches nothing.
        line('other', '1.0.18', 'c'.repeat(64)),
        line('itoa', '1.0.19', 'not a checksum'),
        '{not json',
      ].join('\n'),
    );
  });
  expect(await index.checksum(CRATES_IO, 'itoa', '1.0.18')).toBe('b'.repeat(64));
  expect(await index.checksum('sparse+https://index.crates.io/', 'itoa', '1.0.17')).toBe(
    'a'.repeat(64),
  );
  expect(await index.checksum(CRATES_IO, 'itoa', '1.0.19')).toBeUndefined();
  expect(requests[0]).toBe('https://index.crates.io/it/oa/itoa');
  // A published version never changes, so a restarted daemon asks no one.
  const restarted = new CratesIoChecksums(file, async () => {
    throw new Error('no network');
  });
  expect(await restarted.checksum(CRATES_IO, 'itoa', '1.0.18')).toBe('b'.repeat(64));
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ 'itoa@1.0.18': 'b'.repeat(64) });
});

it('trusts no other registry, and leaves a crate unverified when the index cannot answer (R-G13 review)', async () => {
  let asked = 0;
  const failing = new CratesIoChecksums(cacheFile(), async () => {
    asked++;
    throw new Error('offline');
  });
  expect(await failing.checksum(CRATES_IO, 'itoa', '1.0.18')).toBeUndefined();
  const refused = new CratesIoChecksums(cacheFile(), async () => new Response('', { status: 404 }));
  expect(await refused.checksum(CRATES_IO, 'itoa', '1.0.18')).toBeUndefined();
  const other = new CratesIoChecksums(cacheFile(), async () => {
    asked++;
    return new Response(line('itoa', '1.0.18', 'b'.repeat(64)));
  });
  expect(
    await other.checksum('sparse+https://registry.example.invalid/', 'itoa', '1.0.18'),
  ).toBeUndefined();
  expect(await other.checksum(CRATES_IO, '../../etc', '1.0.0')).toBeUndefined();
  expect(asked).toBe(1);
});
