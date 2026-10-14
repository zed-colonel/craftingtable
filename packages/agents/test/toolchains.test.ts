import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  identifyTool,
  observeToolchain,
  toolchainProfileDigest,
  trustedFileProblem,
  versionFits,
} from '../src/toolchains.js';

/** The operator's toolchain on this workstation (R-G17 setup), when it is installed. */
const OPT_PYTHON = '/opt/craftingtable/python/cpython-3.12.15-linux-x86_64-gnu/bin/python3.12';
const OPT_UV = '/opt/craftingtable/bin/uv';
const optToolchain = existsSync(OPT_PYTHON) && existsSync(OPT_UV);
/** A root-owned interpreter every Arch workstation has. */
const SYSTEM_PYTHON = '/usr/bin/python3.14';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-toolchains-'));
  scratch.push(directory);
  return directory;
}
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('the root-owned toolchain rule (R-G17 decision 2)', () => {
  it('accepts a regular file whose every path component root owns and only root may write', () => {
    expect(trustedFileProblem('/usr/bin/env')).toBeUndefined();
  });

  it('refuses a file the daemon account owns, as agents run as that account', () => {
    // Under the home, which the account owns and no one else may write, so only the owner
    // rule refuses it (a temporary root may be /tmp, which the writable rule refuses first).
    const directory = mkdtempSync(join(homedir(), '.cache', 'craftingtable-toolchains-'));
    scratch.push(directory);
    chmodSync(directory, 0o755);
    const file = join(directory, 'python3');
    writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    expect(trustedFileProblem(file)?.code).toBe('untrusted-owner');
  });

  it('refuses a root-owned file in a directory writable by others', () => {
    expect(trustedFileProblem('/tmp')?.code).toBe('writable');
  });

  it('refuses a path through a link, even to a root-owned file', () => {
    const link = join(temporary(), 'env');
    symlinkSync('/usr/bin/env', link);
    // The directory holding the link is the account's own, so any of these refusals fails closed.
    expect(trustedFileProblem(link)?.code).toMatch(/^(linked|untrusted-owner|writable)$/);
    // A link root owns, in a root-owned directory: /usr/bin/python3 names python3.14.
    expect(trustedFileProblem('/usr/bin/python3')?.code).toBe('linked');
  });

  it('refuses a missing file, a directory and a relative path', () => {
    expect(trustedFileProblem('/usr/bin/craftingtable-no-such-tool')?.code).toBe('missing');
    expect(trustedFileProblem('/usr/bin')?.code).toBe('not-regular');
    expect(trustedFileProblem('usr/bin/env')?.code).toBe('linked');
  });
});

describe('versions (R-G17 decision 5, amended)', () => {
  it('fits the configured version as a dotted prefix, so a patch release is recorded, not refused', () => {
    expect(versionFits('3.12.15', '3.12')).toBe(true);
    expect(versionFits('3.12.16', '3.12')).toBe(true);
    expect(versionFits('3.12.15', '3.12.15')).toBe(true);
    expect(versionFits('3.13.0', '3.12')).toBe(false);
    expect(versionFits('3.120.1', '3.12')).toBe(false);
    expect(versionFits('0.12.23', '0.12.22')).toBe(false);
    expect(versionFits(undefined, '3.12')).toBe(false);
  });
});

describe('fixed probes (R-G17 decision 4)', () => {
  it("records a root-owned interpreter's real path, owner, mode, digest, version, platform and libc", async () => {
    const observed = await identifyTool('python', SYSTEM_PYTHON, { configuredVersion: '3' });
    expect(observed.problem).toBeUndefined();
    expect(observed.identity).toMatchObject({
      tool: 'python',
      path: SYSTEM_PYTHON,
      uid: 0,
      mode: '0755',
      sha256: sha256(SYSTEM_PYTHON),
    });
    expect(observed.identity?.version).toMatch(/^3\.14\.\d+$/);
    expect(observed.identity?.platform).toMatch(/^linux-/);
    expect(observed.identity?.libc).toMatch(/^glibc \d+\.\d+/);
  });

  it('refuses an interpreter that no longer fits its configured version', async () => {
    const observed = await identifyTool('python', SYSTEM_PYTHON, { configuredVersion: '3.12' });
    expect(observed.problem?.code).toBe('version-mismatch');
    expect(observed.problem?.message).toContain('3.12');
    // What it found is still recorded.
    expect(observed.identity?.version).toMatch(/^3\.14\./);
  });

  it('refuses a tool whose probe fails, never reading its output as a version', async () => {
    const observed = await identifyTool('uv', '/usr/bin/false', { configuredVersion: '0.12' });
    expect(observed.problem?.code).toBe('probe-failed');
  });

  it('records a font by its identity alone, with no probe', async () => {
    const font = '/usr/bin/env';
    const observed = await identifyTool('font', font);
    expect(observed.problem).toBeUndefined();
    expect(observed.identity).toMatchObject({ tool: 'font', path: font, sha256: sha256(font) });
    expect(observed.identity?.version).toBeUndefined();
  });

  it('does not run a tool that fails the ownership rule', async () => {
    const directory = temporary();
    const marker = join(directory, 'ran');
    const fake = join(directory, 'uv');
    writeFileSync(fake, `#!/bin/sh\ntouch ${marker}\necho 'uv 0.12.22'\n`);
    chmodSync(fake, 0o755);
    const observed = await identifyTool('uv', fake, { configuredVersion: '0.12' });
    expect(observed.problem?.code).toMatch(/^(untrusted-owner|writable)$/);
    expect(observed.identity).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(!optToolchain)(
    "identifies the operator's CPython 3.12 and uv 0.12 under /opt/craftingtable",
    async () => {
      const profile = {
        interpreter: OPT_PYTHON,
        version: '3.12',
        uv: { path: OPT_UV, version: '0.12' },
      };
      const observations = await observeToolchain(profile);
      expect(observations.map((o) => [o.tool, o.problem?.code])).toEqual([
        ['python', undefined],
        ['uv', undefined],
      ]);
      expect(observations[0]?.identity?.version).toMatch(/^3\.12\.\d+$/);
      expect(observations[1]?.identity?.version).toMatch(/^0\.12\.\d+$/);
    },
  );

  it('observes the media tools and fonts the profile lists, after Python and uv', async () => {
    const directory = temporary();
    const copy = join(directory, 'font.ttf');
    copyFileSync('/usr/bin/env', copy);
    const observations = await observeToolchain({
      interpreter: SYSTEM_PYTHON,
      version: '3',
      uv: { path: '/usr/bin/false', version: '0.12' },
      media: { fonts: ['/usr/bin/env', copy] },
    });
    expect(observations.map((o) => [o.tool, o.path, o.problem?.code])).toEqual([
      ['python', SYSTEM_PYTHON, undefined],
      ['uv', '/usr/bin/false', 'probe-failed'],
      ['font', '/usr/bin/env', undefined],
      ['font', copy, expect.stringMatching(/^(untrusted-owner|writable)$/)],
    ]);
  });
});

describe('the profile digest', () => {
  it('changes with any configured path or version, and not with key order', () => {
    const a = {
      interpreter: '/opt/p/bin/python3.12',
      version: '3.12',
      uv: { path: '/opt/u/uv', version: '0.12' },
    };
    const b = {
      uv: { version: '0.12', path: '/opt/u/uv' },
      version: '3.12',
      interpreter: a.interpreter,
    };
    expect(toolchainProfileDigest(a)).toBe(toolchainProfileDigest(b));
    expect(toolchainProfileDigest({ ...a, version: '3.13' })).not.toBe(toolchainProfileDigest(a));
    expect(toolchainProfileDigest({ ...a, media: { fonts: ['/f'] } })).not.toBe(
      toolchainProfileDigest(a),
    );
  });
});
