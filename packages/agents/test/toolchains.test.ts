import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  type Stats,
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
  modeText,
  observeToolchain,
  toolchainProfileDigest,
  pythonInstallProblem,
  trustedDirectoryProblem,
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

describe('the rule for the directories an interpreter loads from (its prefix and standard library)', () => {
  it('accepts a root-owned directory only root may write, and refuses others', () => {
    expect(trustedDirectoryProblem('/usr/lib')).toBeUndefined();
    expect(trustedDirectoryProblem('/usr/lib/')).toBeUndefined();
    expect(trustedDirectoryProblem(homedir())?.code).toBe('untrusted-owner');
    expect(trustedDirectoryProblem('/tmp')?.code).toBe('writable');
    expect(trustedDirectoryProblem('/usr/bin/env')?.code).toBe('not-regular');
    expect(trustedDirectoryProblem('/usr/lib/craftingtable-no-such')?.code).toBe('missing');
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

/** A stand-in for `lstat`: every path root-owned and 0755 unless `overrides` says otherwise. */
function fakeStat(
  overrides: Readonly<Record<string, { uid?: number; mode?: number; link?: boolean }>>,
) {
  return (path: string) => {
    const real = lstatSync(path);
    const override = overrides[path] ?? {};
    return {
      ...real,
      uid: override.uid ?? 0,
      mode: (real.mode & ~0o7777) | (override.mode ?? 0o755),
      isFile: () => real.isFile(),
      isDirectory: () => real.isDirectory(),
      isSymbolicLink: () => override.link ?? real.isSymbolicLink(),
    } as unknown as Stats;
  };
}

describe('the rule, part by part (review L-2)', () => {
  it("refuses a file the account owns inside root-owned directories, as `cp -p` or root's `tar x` leave", () => {
    expect(
      trustedFileProblem('/usr/bin/env', fakeStat({ '/usr/bin/env': { uid: 1000 } }))?.code,
    ).toBe('untrusted-owner');
  });

  it('refuses a directory its group may write, not only others', () => {
    expect(
      trustedFileProblem('/usr/bin/env', fakeStat({ '/usr/bin': { mode: 0o775 } }))?.code,
    ).toBe('writable');
    expect(trustedFileProblem('/usr/bin/env', fakeStat({ '/usr': { mode: 0o757 } }))?.code).toBe(
      'writable',
    );
  });

  it('refuses a path with a trailing slash', () => {
    expect(trustedFileProblem('/usr/bin/env/')?.code).toBe('linked');
  });
});

describe("an interpreter's install, held to the rule before it runs (review L-2)", () => {
  function install() {
    const prefix = temporary();
    for (const directory of ['bin', 'lib/python3.12/json', 'lib/python3.12/lib-dynload'])
      mkdirSync(join(prefix, directory), { recursive: true });
    writeFileSync(join(prefix, 'bin', 'python3.12'), '');
    writeFileSync(join(prefix, 'lib', 'libpython3.12.so'), '');
    writeFileSync(join(prefix, 'lib', 'python3.12', 'os.py'), '');
    writeFileSync(join(prefix, 'lib', 'python3.12', 'json', '__init__.py'), '');
    return { prefix, interpreter: join(prefix, 'bin', 'python3.12') };
  }
  it('accepts an install root owns throughout', () => {
    expect(pythonInstallProblem(install().interpreter, fakeStat({}))).toBeUndefined();
  });

  it('refuses a module, a shared library or a neighbour of the interpreter that the account owns or others may write', () => {
    const { prefix, interpreter } = install();
    for (const [path, override, code] of [
      [join(prefix, 'lib', 'python3.12', 'json', '__init__.py'), { uid: 1000 }, 'untrusted-owner'],
      [join(prefix, 'lib', 'libpython3.12.so'), { mode: 0o666 }, 'writable'],
      [join(prefix, 'lib', 'python3.12', 'lib-dynload'), { mode: 0o777 }, 'writable'],
      [join(prefix, 'lib'), { uid: 1000 }, 'untrusted-owner'],
    ] as const)
      expect(pythonInstallProblem(interpreter, fakeStat({ [path]: override }))?.code, path).toBe(
        code,
      );
  });

  it('refuses a link in the standard library that leads somewhere the account may write', () => {
    const { prefix, interpreter } = install();
    const outside = temporary();
    writeFileSync(join(outside, 'planted.py'), '');
    symlinkSync(join(outside, 'planted.py'), join(prefix, 'lib', 'python3.12', 'planted.py'));
    // Everything root's but the link's target, which lies in the account's directory.
    const stat = (path: string) =>
      path.startsWith(outside) ? lstatSync(path) : fakeStat({})(path);
    expect(pythonInstallProblem(interpreter, stat)?.code).toMatch(/^(untrusted-owner|writable)$/);
  });

  it('refuses an interpreter with no standard library beside it', () => {
    const prefix = temporary();
    mkdirSync(join(prefix, 'bin'));
    mkdirSync(join(prefix, 'lib'));
    writeFileSync(join(prefix, 'bin', 'python3.12'), '');
    expect(pythonInstallProblem(join(prefix, 'bin', 'python3.12'), fakeStat({}))?.code).toBe(
      'missing',
    );
  });
});

describe('identifyTool, with the rule satisfied (review L-2, T6)', () => {
  it('never runs an interpreter whose install holds a module the account owns', async () => {
    const prefix = temporary();
    const marker = join(prefix, 'ran');
    for (const directory of ['bin', 'lib/python3.12'])
      mkdirSync(join(prefix, directory), { recursive: true });
    const interpreter = join(prefix, 'bin', 'python3.12');
    writeFileSync(interpreter, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const planted = join(prefix, 'lib', 'python3.12', 'json.py');
    writeFileSync(planted, '');
    const observed = await identifyTool('python', interpreter, {
      stat: fakeStat({ [planted]: { uid: 1000 } }),
    });
    expect(observed.problem?.code).toBe('untrusted-owner');
    expect(existsSync(marker)).toBe(false);
  });

  it('probes with the fixed environment only, never the daemon’s own', async () => {
    const directory = temporary();
    const uv = join(directory, 'uv');
    writeFileSync(
      uv,
      [
        '#!/bin/sh',
        'if [ -z "$CRAFTINGTABLE_PROBE_LEAK" ] && [ "$UV_NO_CONFIG" = 1 ] && [ "$PATH" = /usr/bin:/bin ] && [ "$LC_ALL" = C ] && [ "$(pwd)" = / ]',
        'then echo "uv 0.12.22"; else echo "uv 9.9.9"; fi',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env.CRAFTINGTABLE_PROBE_LEAK = 'the daemon environment';
    try {
      const observed = await identifyTool('uv', uv, { stat: fakeStat({}) });
      expect(observed.identity?.version).toBe('0.12.22');
    } finally {
      delete process.env.CRAFTINGTABLE_PROBE_LEAK;
    }
  });
});

it('formats a mode below 0100 with three digits, as the status contract reads it (review L-7)', () => {
  // A root-owned 0044 file is readable by the daemon's account through its other bits.
  expect(modeText(0o100044)).toBe('0044');
  expect(modeText(0o100755)).toBe('0755');
});
