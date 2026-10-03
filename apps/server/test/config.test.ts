import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configFromEnv, retiredSettings } from '../src/config.js';

// The account's entry in the user database, which a test may replace (TS-H3).
const account = vi.hoisted(() => ({
  replace: undefined as undefined | (() => { readonly homedir: string }),
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => (account.replace ?? actual.userInfo)() };
});
afterEach(() => {
  account.replace = undefined;
});

describe('configFromEnv', () => {
  it('defaults to loopback, XDG storage, and a 30-day session', () => {
    const config = configFromEnv({ HOME: '/home/test', XDG_DATA_HOME: '/tmp/xdg' });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 4600,
      dataDir: '/tmp/xdg/craftingtable',
      databasePath: '/tmp/xdg/craftingtable/state/craftingtable.sqlite',
      publicOrigin: 'http://127.0.0.1:5173',
      secureCookies: false,
      sessionLifetimeSeconds: 2_592_000,
      drainTimeoutMs: 180_000,
    });
  });

  it('ignores the removed repository-inspector settings instead of failing startup (GIT-04)', () => {
    const env = {
      CRAFTINGTABLE_DATA_DIR: '/var/lib/craftingtable',
      CRAFTINGTABLE_GIT_BIN: '/usr/bin/git',
      CRAFTINGTABLE_GIT_TIMEOUT_MS: '1',
    };
    const config = configFromEnv(env);
    expect(config.dataDir).toBe('/var/lib/craftingtable');
    expect(config).not.toHaveProperty('repositoryFeature');
    // The old git binary setting does not choose git; startup names it instead (R-B8).
    expect(config).not.toHaveProperty('gitExecutable');
    expect(retiredSettings(env)).toEqual(['CRAFTINGTABLE_GIT_BIN', 'CRAFTINGTABLE_GIT_TIMEOUT_MS']);
    expect(retiredSettings({ CRAFTINGTABLE_GIT_EXECUTABLE: '/usr/bin/git' })).toEqual([]);
  });

  it('accepts explicit loopback hosts, HTTPS origin, and an absolute test directory', () => {
    const config = configFromEnv({
      CRAFTINGTABLE_HOST: '::1',
      CRAFTINGTABLE_PORT: '5000',
      CRAFTINGTABLE_PUBLIC_ORIGIN: 'https://[::1]:5173',
      CRAFTINGTABLE_DATA_DIR: '/tmp/craftingtable-test',
    });
    expect(config.host).toBe('::1');
    expect(config.port).toBe(5000);
    expect(config.secureCookies).toBe(true);
  });

  it('allows LAN hosts only with TLS or an HTTPS public origin', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'craftingtable.lan']) {
      expect(() => configFromEnv({ CRAFTINGTABLE_HOST: host })).toThrow(/TLS/);
      const proxied = configFromEnv({
        CRAFTINGTABLE_HOST: host,
        CRAFTINGTABLE_PUBLIC_ORIGIN: 'https://craftingtable.lan',
      });
      expect(proxied.lanExposed).toBe(true);
      expect(proxied.secureCookies).toBe(true);
      const direct = configFromEnv({
        CRAFTINGTABLE_HOST: host,
        CRAFTINGTABLE_PUBLIC_ORIGIN: 'https://craftingtable.lan:4600',
        CRAFTINGTABLE_TLS_CERT: '/etc/craftingtable/cert.pem',
        CRAFTINGTABLE_TLS_KEY: '/etc/craftingtable/key.pem',
      });
      expect(direct.tls).toEqual({
        certPath: '/etc/craftingtable/cert.pem',
        keyPath: '/etc/craftingtable/key.pem',
      });
    }
    expect(() => configFromEnv({ CRAFTINGTABLE_HOST: 'not a host' })).toThrow(/HOST/);
    expect(() => configFromEnv({ CRAFTINGTABLE_TLS_CERT: '/only/cert.pem' })).toThrow(/together/);
    expect(() =>
      configFromEnv({ CRAFTINGTABLE_TLS_CERT: 'cert.pem', CRAFTINGTABLE_TLS_KEY: 'key.pem' }),
    ).toThrow(/absolute/);
    expect(configFromEnv({}).lanExposed).toBe(false);
    expect(configFromEnv({ CRAFTINGTABLE_WEB_DIST: '' }).webDistDir).toBeUndefined();
    expect(configFromEnv({ CRAFTINGTABLE_WEB_DIST: '/srv/ct/dist' }).webDistDir).toBe(
      '/srv/ct/dist',
    );
  });

  it('derives execution roots below the data directory and validates overrides', () => {
    const config = configFromEnv({ CRAFTINGTABLE_DATA_DIR: '/tmp/craftingtable-test' });
    expect(config.execution.worktreeRoot).toBe('/tmp/craftingtable-test/worktrees');
    expect(config.execution.runsRoot).toBe('/tmp/craftingtable-test/runs');
    // Short, for the sockets Claude Code's sandbox makes in an agent's TMPDIR (LIVE-31).
    expect(config.execution.agentTemporaryRoot).toBe('/tmp/craftingtable-test/t');
    expect(
      configFromEnv({
        CRAFTINGTABLE_DATA_DIR: '/tmp/craftingtable-test',
        CRAFTINGTABLE_AGENT_TMP_ROOT: '/tmp/ct-agents',
      }).execution.agentTemporaryRoot,
    ).toBe('/tmp/ct-agents');
    expect(() => configFromEnv({ CRAFTINGTABLE_AGENT_TMP_ROOT: 'ct-agents' })).toThrow(
      /AGENT_TMP_ROOT must be a normalized absolute path/,
    );
    // It may not lie inside a root agents or checks write.
    expect(() =>
      configFromEnv({
        CRAFTINGTABLE_DATA_DIR: '/tmp/craftingtable-test',
        CRAFTINGTABLE_WORKTREE_ROOT: '/tmp/craftingtable-test/t',
      }),
    ).toThrow(/temporary directories must lie outside/);
    expect(config.execution.maxPatchBytes).toBe(4 * 1024 * 1024);
    expect(() => configFromEnv({ CRAFTINGTABLE_CLAUDE_EXECUTABLE: 'claude' })).toThrow(
      /CLAUDE_EXECUTABLE/,
    );
    expect(() =>
      configFromEnv({
        CRAFTINGTABLE_WORKTREE_ROOT: '/tmp/shared',
        CRAFTINGTABLE_RUNS_ROOT: '/tmp/shared/runs',
      }),
    ).toThrow(/overlap/);
    expect(() => configFromEnv({ CRAFTINGTABLE_DIFF_LIMIT_BYTES: '10' })).toThrow(/DIFF_LIMIT/);
  });

  it("refuses an agents' temporary root that holds the database or files of the operator's (TS-H3, R-G5)", () => {
    const data = '/srv/ct/data';
    const home = '/home/someone';
    const root = (value: string, env: Record<string, string> = {}) =>
      configFromEnv({
        CRAFTINGTABLE_DATA_DIR: data,
        HOME: home,
        CRAFTINGTABLE_AGENT_TMP_ROOT: value,
        ...env,
      }).execution.agentTemporaryRoot;
    // At or above the system's shared and runtime temporary directories, a home, or the file
    // system: each named by the entry that refuses it.
    for (const [refused, shared] of [
      ['/', '/'],
      ['/tmp', '/tmp'],
      ['/var', '/var/tmp'],
      ['/var/tmp', '/var/tmp'],
      ['/dev', '/dev/shm'],
      ['/dev/shm', '/dev/shm'],
      ['/run', '/run'],
      ['/home', home],
      [home, home],
    ] as [string, string][])
      expect(() => root(refused), refused).toThrow(`not ${shared} or a directory above it`);
    // The process's runtime directory and TMPDIR, wherever they are.
    const env = { XDG_RUNTIME_DIR: '/srv/runtime/1234', TMPDIR: '/scratch/tmp' };
    for (const refused of ['/srv/runtime/1234', '/srv/runtime', '/scratch/tmp', '/scratch'])
      expect(() => root(refused, env), refused).toThrow(/directory of its own/);
    // The database's directory, at, above or inside it, and the data directory.
    for (const refused of [`${data}/state`, `${data}/state/t`, data, '/srv'])
      expect(() => root(refused), refused).toThrow(
        /AGENT_TMP_ROOT must lie outside the database's directory/,
      );
    // The database backups' default directory, with the daemon's other roots.
    for (const refused of [`${data}/backups`, `${data}/backups/t`])
      expect(() => root(refused), refused).toThrow(/outside the daemon's other roots/);
    // A directory of its own stays allowed, beneath a home or /tmp included: the default
    // `<data>/t` is under the home, and the e2e daemon's is `/tmp/cte-…`.
    for (const accepted of [
      `${data}/t`,
      '/tmp/cte-x',
      '/var/tmp/ct',
      '/dev/shm/ct',
      '/run/ct',
      `${home}/x`,
    ])
      expect(root(accepted)).toBe(accepted);
    for (const accepted of ['/srv/runtime/1234/ct', '/scratch/tmp/ct'])
      expect(root(accepted, env)).toBe(accepted);
    expect(
      configFromEnv({ HOME: home, CRAFTINGTABLE_DATA_DIR: `${home}/.local/share/craftingtable` })
        .execution.agentTemporaryRoot,
    ).toBe(`${home}/.local/share/craftingtable/t`);
  });

  it("refuses the account's own home whatever HOME says, and starts without one (TS-H3, R-G5)", () => {
    const env = { CRAFTINGTABLE_DATA_DIR: '/srv/ct/data', HOME: '/home/elsewhere' };
    account.replace = () => ({ homedir: '/home/account' });
    expect(() => configFromEnv({ ...env, CRAFTINGTABLE_AGENT_TMP_ROOT: '/home/account' })).toThrow(
      'not /home/account or a directory above it',
    );
    // No entry in the user database (a container's arbitrary user): HOME still counts.
    account.replace = () => {
      throw new Error('uv_os_get_passwd returned ENOENT (no such file or directory)');
    };
    expect(
      configFromEnv({ ...env, CRAFTINGTABLE_AGENT_TMP_ROOT: '/home/account' }).execution
        .agentTemporaryRoot,
    ).toBe('/home/account');
    expect(() =>
      configFromEnv({ ...env, CRAFTINGTABLE_AGENT_TMP_ROOT: '/home/elsewhere' }),
    ).toThrow(/directory of its own/);
  });

  it("compares an agents' temporary root through links where its path exists (TS-H3, R-G5)", () => {
    const base = mkdtempSync(join(tmpdir(), 'craftingtable-config-'));
    try {
      const data = join(base, 'data');
      mkdirSync(join(data, 'state'), { recursive: true });
      // Links to the database's directory, and to the data directory.
      symlinkSync(join(data, 'state'), join(base, 'state-link'));
      symlinkSync(data, join(base, 'data-link'));
      symlinkSync('/tmp', join(base, 'tmp-link'));
      const root = (value: string, dataDir = data, env: Record<string, string> = {}) =>
        configFromEnv({
          CRAFTINGTABLE_DATA_DIR: dataDir,
          CRAFTINGTABLE_AGENT_TMP_ROOT: value,
          ...env,
        }).execution.agentTemporaryRoot;
      for (const refused of [join(base, 'state-link'), join(base, 'state-link', 'not-yet')])
        expect(() => root(refused), refused).toThrow(/database's directory/);
      // The data directory named through a link, the root by its real path.
      expect(() => root(join(data, 'state'), join(base, 'data-link'))).toThrow(
        /database's directory/,
      );
      expect(() => root(join(base, 'tmp-link'))).toThrow(/directory of its own/);
      // A link that names nothing yet is followed to where it points.
      symlinkSync(join(data, 'state', 'later'), join(base, 'dangling-link'));
      expect(() => root(join(base, 'dangling-link'))).toThrow(/database's directory/);
      // Through a chain of such links, and from a relative target.
      symlinkSync(join(base, 'dangling-link'), join(base, 'chain-link'));
      expect(() => root(join(base, 'chain-link'))).toThrow(/database's directory/);
      symlinkSync(join('data', 'state', 'later'), join(base, 'relative-link'));
      expect(() => root(join(base, 'relative-link'))).toThrow(/database's directory/);
      // A relative target climbs from the link's real directory, not the path as written.
      mkdirSync(join(base, 'real', 'sub'), { recursive: true });
      symlinkSync(join(base, 'real', 'sub'), join(base, 'via-parent'));
      symlinkSync(join('..', '..', 'data', 'state', 'x'), join(base, 'real', 'sub', 'climb'));
      expect(() => root(join(base, 'via-parent', 'climb'))).toThrow(/database's directory/);
      // Named inside the database's directory, it is refused whatever the link reaches.
      mkdirSync(join(base, 'agents'));
      symlinkSync(join(base, 'agents'), join(data, 'state', 'agents-link'));
      expect(() => root(join(data, 'state', 'agents-link'))).toThrow(/database's directory/);
      // The daemon's other roots are compared through links too.
      mkdirSync(join(base, 'runs'));
      symlinkSync(join(base, 'runs'), join(base, 'runs-link'));
      expect(() =>
        root(join(base, 'runs-link'), data, { CRAFTINGTABLE_RUNS_ROOT: join(base, 'runs') }),
      ).toThrow(/outside the daemon's other roots/);
      // A link to a directory of its own is that directory.
      symlinkSync(join(base, 'agents'), join(base, 'agents-link'));
      expect(root(join(base, 'agents-link'))).toBe(join(base, 'agents-link'));
      // A root whose links cannot be read, or that loops, is refused, not passed unseen.
      mkdirSync(join(base, 'locked', 'inner'), { recursive: true });
      chmodSync(join(base, 'locked'), 0o000);
      expect(() => root(join(base, 'locked', 'inner', 't'))).toThrow(
        /CRAFTINGTABLE_AGENT_TMP_ROOT .* could not be resolved: EACCES/,
      );
      symlinkSync(join(base, 'loop-b'), join(base, 'loop-a'));
      symlinkSync(join(base, 'loop-a'), join(base, 'loop-b'));
      expect(() => root(join(base, 'loop-a', 't'))).toThrow(/could not be resolved: ELOOP/);
      // The default root is named as the default, not by a variable that is not set.
      expect(() =>
        configFromEnv({ CRAFTINGTABLE_DATA_DIR: join(base, 'locked', 'inner', 'data') }),
      ).toThrow(/^The agents' default temporary root .* could not be resolved: EACCES/);
      // An unreadable HOME or TMPDIR, or one that loops, is no reason to refuse the start: it
      // is compared as far as it can be read.
      for (const unreadable of [
        { HOME: join(base, 'locked', 'inner', 'home') },
        { TMPDIR: join(base, 'locked', 'inner', 'tmp') },
        { TMPDIR: join(base, 'loop-a', 'tmp') },
        { XDG_RUNTIME_DIR: join(base, 'loop-b') },
      ] as Record<string, string>[])
        expect(root(join(base, 'agents'), data, unreadable), JSON.stringify(unreadable)).toBe(
          join(base, 'agents'),
        );
      // And it is still refused as a root, or above one.
      expect(() =>
        root(join(base, 'locked'), data, { HOME: join(base, 'locked', 'inner', 'home') }),
      ).toThrow(/directory of its own/);
    } finally {
      if (existsSync(join(base, 'locked'))) chmodSync(join(base, 'locked'), 0o700);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects malformed ports, lifetimes, origins, and relative data directories', () => {
    expect(() => configFromEnv({ CRAFTINGTABLE_PORT: '0' })).toThrow(/PORT/);
    expect(() => configFromEnv({ CRAFTINGTABLE_SESSION_LIFETIME_SECONDS: '10' })).toThrow(
      /LIFETIME/,
    );
    expect(() => configFromEnv({ CRAFTINGTABLE_PUBLIC_ORIGIN: 'ftp://localhost' })).toThrow(
      /origin/,
    );
    expect(() => configFromEnv({ CRAFTINGTABLE_DATA_DIR: './state' })).toThrow(/absolute/);
    expect(() => configFromEnv({ CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '-1' })).toThrow(/DRAIN/);
    expect(() => configFromEnv({ CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '1.5' })).toThrow(/DRAIN/);
    expect(configFromEnv({ CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '0' }).drainTimeoutMs).toBe(0);
  });
});

it('validates Codex configuration like Claude configuration', () => {
  expect(() => configFromEnv({ CRAFTINGTABLE_CODEX_EXECUTABLE: 'relative/codex' })).toThrow(
    /CRAFTINGTABLE_CODEX_EXECUTABLE/,
  );
  expect(
    configFromEnv({
      CRAFTINGTABLE_CODEX_EXECUTABLE: '/tools/codex',
      CRAFTINGTABLE_CODEX_MODELS: 'custom=Custom',
    }).execution,
  ).toMatchObject({ codexExecutable: '/tools/codex', codexModels: 'custom=Custom' });
});
