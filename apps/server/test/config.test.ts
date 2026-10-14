import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configFromEnv, outsideSourceCacheProblem, retiredSettings } from '../src/config.js';

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

  it('reads one Git command timeout, 60 s by default, from 10 s to 30 min (R-G10 D1)', () => {
    const base = { CRAFTINGTABLE_DATA_DIR: '/var/lib/craftingtable' };
    expect(configFromEnv(base).execution.gitCommandTimeoutMs).toBe(60_000);
    expect(
      configFromEnv({ ...base, CRAFTINGTABLE_GIT_COMMAND_TIMEOUT_MS: '600000' }).execution
        .gitCommandTimeoutMs,
    ).toBe(600_000);
    for (const value of ['9999', '1800001', '1.5', 'soon'])
      expect(() => configFromEnv({ ...base, CRAFTINGTABLE_GIT_COMMAND_TIMEOUT_MS: value })).toThrow(
        /CRAFTINGTABLE_GIT_COMMAND_TIMEOUT_MS must be an integer between 10000 and 1800000/,
      );
    // The retired inspector setting still only warns; it sets nothing.
    const retired = { ...base, CRAFTINGTABLE_GIT_TIMEOUT_MS: '1' };
    expect(configFromEnv(retired).execution.gitCommandTimeoutMs).toBe(60_000);
    expect(retiredSettings(retired)).toEqual(['CRAFTINGTABLE_GIT_TIMEOUT_MS']);
  });

  it('ends idle sessions after 24 hours by default, within 10 minutes and the lifetime (R-G9)', () => {
    const base = { CRAFTINGTABLE_DATA_DIR: '/var/lib/craftingtable' };
    expect(configFromEnv(base).sessionIdleSeconds).toBe(86_400);
    expect(
      configFromEnv({ ...base, CRAFTINGTABLE_SESSION_IDLE_SECONDS: '600' }).sessionIdleSeconds,
    ).toBe(600);
    for (const value of ['599', '2592001', '1.5', 'soon'])
      expect(
        () => configFromEnv({ ...base, CRAFTINGTABLE_SESSION_IDLE_SECONDS: value }),
        value,
      ).toThrow(/CRAFTINGTABLE_SESSION_IDLE_SECONDS/);
  });

  it('reads the repository roots, absolute and colon-separated, and none by default (R-G9)', () => {
    const base = { CRAFTINGTABLE_DATA_DIR: '/var/lib/craftingtable' };
    expect(configFromEnv(base).execution.repositoryRoots).toEqual([]);
    expect(
      configFromEnv({ ...base, CRAFTINGTABLE_REPOSITORY_ROOTS: '/home/keith/src::/srv/repos' })
        .execution.repositoryRoots,
    ).toEqual(['/home/keith/src', '/srv/repos']);
    expect(() => configFromEnv({ ...base, CRAFTINGTABLE_REPOSITORY_ROOTS: 'src:/srv' })).toThrow(
      /CRAFTINGTABLE_REPOSITORY_ROOTS/,
    );
    expect(() =>
      configFromEnv({ ...base, CRAFTINGTABLE_REPOSITORY_ROOTS: '/home/keith/../etc' }),
    ).toThrow(/CRAFTINGTABLE_REPOSITORY_ROOTS/);
    // It is a live setting again, no longer named as retired at startup.
    expect(retiredSettings({ CRAFTINGTABLE_REPOSITORY_ROOTS: '/home/keith/src' })).toEqual([]);
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

describe('outside sources (R-G14)', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  /** A data and a settings directory of their own, the file written as given. */
  function settings(contents?: string) {
    const base = mkdtempSync(join(tmpdir(), 'craftingtable-sources-'));
    directories.push(base);
    const data = join(base, 'data');
    const configDir = join(base, 'config');
    mkdirSync(data);
    mkdirSync(configDir);
    const file = join(configDir, 'outside-sources.json');
    if (contents !== undefined) writeFileSync(file, contents);
    const env = { CRAFTINGTABLE_DATA_DIR: data, CRAFTINGTABLE_CONFIG_DIR: configDir };
    return { base, data, configDir, file, env, read: () => configFromEnv(env).execution };
  }
  const json = (value: unknown) => JSON.stringify(value);

  it('is the cargo source with its own hosts in the daemon Cargo home when there is no file', () => {
    const { data, read } = settings();
    expect(read().outsideSources).toEqual([
      {
        kind: 'cargo',
        hosts: ['index.crates.io', 'static.crates.io'],
        caches: [join(data, 'cargo-home', 'registry'), join(data, 'cargo-home', 'git')],
      },
    ]);
  });

  it('reads the sources the file names: none, or a kind with extra exact hosts', () => {
    expect(settings(json({ version: 1, sources: [] })).read().outsideSources).toEqual([]);
    const { data, read } = settings(
      json({
        version: 1,
        sources: [
          { kind: 'cargo', extraHosts: ['mirror.example.org', 'static.crates.io', 'a.b.c.d'] },
        ],
      }),
    );
    expect(read().outsideSources).toEqual([
      {
        kind: 'cargo',
        // A host the kind already has is listed once.
        hosts: ['index.crates.io', 'static.crates.io', 'mirror.example.org', 'a.b.c.d'],
        caches: [join(data, 'cargo-home', 'registry'), join(data, 'cargo-home', 'git')],
      },
    ]);
    expect(
      settings(json({ version: 1, sources: [{ kind: 'cargo' }] })).read().outsideSources,
    ).toHaveLength(1);
  });

  it('refuses to start on a file it cannot take whole, naming the file and the problem', () => {
    const refusals: [string, RegExp][] = [
      ['{', /not valid JSON/],
      [json([]), /JSON object/],
      [json({ version: 2, sources: [] }), /"version": 1/],
      [json({ sources: [] }), /"version": 1/],
      [json({ version: 1 }), /"sources"/],
      [json({ version: 1, sources: {} }), /"sources"/],
      [json({ version: 1, sources: [], extra: true }), /unknown key "extra"/],
      [json({ version: 1, sources: ['cargo'] }), /source 1/],
      [json({ version: 1, sources: [{ kind: 'npm' }] }), /unknown kind "npm"/],
      [json({ version: 1, sources: [{ kind: 'toString' }] }), /unknown kind "toString"/],
      [json({ version: 1, sources: [{}] }), /unknown kind/],
      [json({ version: 1, sources: [{ kind: 'cargo' }, { kind: 'cargo' }] }), /"cargo" twice/],
      [json({ version: 1, sources: [{ kind: 'cargo', hosts: [] }] }), /unknown key "hosts"/],
      [json({ version: 1, sources: [{ kind: 'cargo', extraHosts: 'a.b.c' }] }), /"extraHosts"/],
      [json({ version: 1, sources: [{ kind: 'cargo', extraHosts: null }] }), /"extraHosts"/],
    ];
    for (const host of [
      '*.example.org',
      '**.example.org',
      '*',
      '10.0.0.1',
      '1.2.3.4',
      'mirror.example.org:8080',
      '[::1]',
      '::1',
      'example.org',
      'crates.io',
      'localhost',
      'Mirror.example.org',
      'mirror.example.org.',
      '-bad.example.org',
      'bad-.example.org',
      'mirror..example.org',
      'mirror_1.example.org',
      `${'a'.repeat(64)}.example.org`,
      `${'abcdefghi.'.repeat(26)}org`,
      '',
      ' mirror.example.org',
      'https://mirror.example.org',
      7,
      null,
    ])
      refusals.push([
        json({ version: 1, sources: [{ kind: 'cargo', extraHosts: [host] }] }),
        /exact lowercase host name/,
      ]);
    for (const [contents, problem] of refusals) {
      const { file, read } = settings(contents);
      expect(read, contents).toThrow(problem);
      expect(read, contents).toThrow(file);
    }
  });

  it('refuses a link, a directory or an oversized file in its place', () => {
    const linked = settings();
    const elsewhere = join(linked.base, 'elsewhere.json');
    writeFileSync(elsewhere, json({ version: 1, sources: [] }));
    symlinkSync(elsewhere, linked.file);
    expect(linked.read).toThrow(/regular file/);
    // A link that names nothing is not an absent file.
    const dangling = settings();
    symlinkSync(join(dangling.base, 'missing.json'), dangling.file);
    expect(dangling.read).toThrow(/regular file/);
    const directory = settings();
    mkdirSync(directory.file);
    expect(directory.read).toThrow(/regular file/);
    const padded = `{"version": 1, "sources": []}${' '.repeat(64 * 1024)}`;
    expect(settings(padded).read).toThrow(/64 KiB/);
    expect(settings(padded.slice(0, 64 * 1024)).read().outsideSources).toEqual([]);
  });

  it('never reads the file from where agents write, as written or through links', () => {
    const at = settings();
    const configured = (env: Record<string, string>) => () => configFromEnv({ ...at.env, ...env });
    // The settings directory inside the worktree root, the runs root or the agents' temporary
    // root, all of which agents write.
    expect(
      configured({
        CRAFTINGTABLE_CONFIG_DIR: join(at.data, 'worktrees', 'repo', '.craftingtable'),
      }),
    ).toThrow(/outside-sources\.json.*worktree root/);
    expect(configured({ CRAFTINGTABLE_RUNS_ROOT: at.configDir })).toThrow(
      /outside-sources\.json.*runs root/,
    );
    expect(configured({ CRAFTINGTABLE_CONFIG_DIR: join(at.data, 't', 'settings') })).toThrow(
      /outside-sources\.json.*agents' temporary root/,
    );
    // A settings directory that is a link into the worktree root.
    mkdirSync(join(at.data, 'worktrees', 'repo'), { recursive: true });
    symlinkSync(join(at.data, 'worktrees', 'repo'), join(at.base, 'settings-link'));
    expect(configured({ CRAFTINGTABLE_CONFIG_DIR: join(at.base, 'settings-link') })).toThrow(
      /outside-sources\.json.*worktree root/,
    );
  });

  it('refuses a pipe in place of the file at once, never waiting for a writer', async () => {
    const at = settings();
    execFileSync('mkfifo', [at.file]);
    // Should the read wait on the pipe, a writer opens it after two seconds, so a regression
    // fails on the time taken instead of hanging the run.
    const writer = spawn('sh', ['-c', 'sleep 2; exec 3<>"$0"; sleep 1', at.file], {
      stdio: 'ignore',
    });
    try {
      const started = Date.now();
      expect(at.read).toThrow(/regular file/);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      writer.kill();
    }
  });

  it("keeps a source's caches in its own directory, with no link on the way (R-G14 review)", () => {
    // `cargo-home`, `registry` or `git` as a link could lead a cache onto any of the daemon's
    // files, listed or not (its checksum store, the database): each is refused.
    const links: [string, string][] = [
      ['cargo-home', 'state'],
      ['cargo-home', 'crates-io'],
      ['cargo-home', 'runs'],
      ['cargo-home', 'worktrees'],
      ['cargo-home', 'check-logs'],
      [join('cargo-home', 'registry'), 'crates-io'],
      [join('cargo-home', 'git'), 'backups'],
    ];
    for (const [linked, target] of links) {
      const at = settings(json({ version: 1, sources: [{ kind: 'cargo' }] }));
      if (linked !== 'cargo-home') mkdirSync(join(at.data, 'cargo-home'));
      mkdirSync(join(at.data, target), { recursive: true });
      symlinkSync(join(at.data, target), join(at.data, linked));
      expect(at.read, linked).toThrow(/cache .* must not be reached through a link/);
    }
    // Nor one that leads out of the data directory, as the operator's own Cargo home would.
    const outside = settings();
    mkdirSync(join(outside.base, 'operator-cargo'));
    symlinkSync(join(outside.base, 'operator-cargo'), join(outside.data, 'cargo-home'));
    expect(outside.read).toThrow(/cache .* must not be reached through a link/);
    // Real directories are taken.
    const real = settings();
    mkdirSync(join(real.data, 'cargo-home', 'registry'), { recursive: true });
    mkdirSync(join(real.data, 'cargo-home', 'git'));
    expect(real.read().outsideSources).toHaveLength(1);
    // Without a source the daemon still seeds its Cargo home at every start, and check units
    // write its caches, so the same link is refused (R-G14 stray review).
    const none = settings(json({ version: 1, sources: [] }));
    mkdirSync(join(none.data, 'state'));
    symlinkSync(join(none.data, 'state'), join(none.data, 'cargo-home'));
    expect(none.read).toThrow(/cache .* must not be reached through a link/);
  });

  it("refuses a cache outside its kind's own directory, naming a directory it cannot check (R-G14 stray review)", () => {
    const at = settings();
    const cargoHome = join(at.data, 'cargo-home');
    const caches = (...paths: string[]) => [
      { kind: 'cargo' as const, hosts: ['index.crates.io'], caches: paths },
    ];
    expect(
      outsideSourceCacheProblem(caches(join(cargoHome, 'registry')), { cargo: cargoHome }),
    ).toBeUndefined();
    // A cache must lie directly in the kind's directory, however a source came to name it.
    for (const stray of [join(at.data, 'state'), join(cargoHome, 'registry', 'index'), cargoHome])
      expect(
        outsideSourceCacheProblem(caches(join(cargoHome, 'git'), stray), { cargo: cargoHome }),
        stray,
      ).toBe(`The cargo source's cache ${stray} must lie directly in ${cargoHome}`);
    // A kind's directory that cannot be checked is named itself, not after its first cache.
    writeFileSync(join(at.base, 'file'), '');
    const unreadable = join(at.base, 'file', 'cargo-home');
    expect(
      outsideSourceCacheProblem(caches(join(unreadable, 'registry')), { cargo: unreadable }),
    ).toBe(`The cargo source's directory ${unreadable} could not be checked: ENOTDIR`);
  });

  it("keeps the daemon's other roots out of a source's caches, either way round", () => {
    // Each root reaches into the cache from its own side: by a setting or by a link of its own.
    const cache = (data: string, ...rest: string[]) =>
      join(data, 'cargo-home', 'registry', ...rest);
    const cases: [string, (at: ReturnType<typeof settings>) => Record<string, string>][] = [
      [
        'runs root',
        (at) => {
          symlinkSync(cache(at.data, 'runs'), join(at.base, 'runs-link'));
          return { CRAFTINGTABLE_RUNS_ROOT: join(at.base, 'runs-link') };
        },
      ],
      [
        'worktree root',
        (at) => {
          symlinkSync(cache(at.data, 'trees'), join(at.base, 'trees-link'));
          return { CRAFTINGTABLE_WORKTREE_ROOT: join(at.base, 'trees-link') };
        },
      ],
      [
        'check logs',
        (at) => {
          symlinkSync(cache(at.data, 'logs'), join(at.data, 'check-logs'));
          return {};
        },
      ],
      [
        "database's directory",
        (at) => {
          symlinkSync(cache(at.data, 'state'), join(at.data, 'state'));
          return {};
        },
      ],
      [
        'backups',
        (at) => {
          symlinkSync(cache(at.data, 'backups'), join(at.data, 'backups'));
          return {};
        },
      ],
      // The settings directory inside a cache, which agents write.
      ['settings directory', (at) => ({ CRAFTINGTABLE_CONFIG_DIR: cache(at.data, 'ct') })],
    ];
    // With no source too: the daemon seeds its Cargo caches at every start and check units
    // write them, whatever the sources (R-G14 stray review).
    for (const contents of [undefined, json({ version: 1, sources: [] })])
      for (const [label, place] of cases) {
        const at = settings(contents);
        for (const name of ['runs', 'trees', 'logs', 'state', 'backups', 'ct'])
          mkdirSync(cache(at.data, name), { recursive: true });
        mkdirSync(join(at.data, 'cargo-home', 'git'));
        const env = { ...at.env, ...place(at) };
        // The file goes with a settings directory placed elsewhere.
        if (contents !== undefined)
          writeFileSync(join(env.CRAFTINGTABLE_CONFIG_DIR, 'outside-sources.json'), contents);
        expect(() => configFromEnv(env), `${label} ${contents}`).toThrow(
          new RegExp(`cache .* must not overlap the ${label}`),
        );
      }
  });
});

describe('toolchains (R-G17)', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  /** A data and a settings directory of their own, `toolchains.json` written as given. */
  function settings(contents?: string) {
    const base = mkdtempSync(join(tmpdir(), 'craftingtable-toolchains-'));
    directories.push(base);
    const data = join(base, 'data');
    const configDir = join(base, 'config');
    mkdirSync(data);
    mkdirSync(configDir);
    const file = join(configDir, 'toolchains.json');
    if (contents !== undefined) writeFileSync(file, contents);
    const env = { CRAFTINGTABLE_DATA_DIR: data, CRAFTINGTABLE_CONFIG_DIR: configDir };
    return { base, data, configDir, file, env, read: () => configFromEnv(env).execution };
  }
  const json = (value: unknown) => JSON.stringify(value);
  // Root-owned files every Arch workstation has; the start does not run them.
  const python = { interpreter: '/usr/bin/python3.14', version: '3.14' };
  const uv = { path: '/usr/bin/env', version: '0.12' };

  it('is no Python profile and the default caps without a file', () => {
    expect(settings().read().toolchains).toEqual({ limits: { memoryMax: '8G', tasksMax: 1024 } });
  });

  it('reads a Python profile with uv, media and caps', () => {
    const { read } = settings(
      json({
        version: 1,
        python,
        uv,
        media: { ffmpeg: '/usr/bin/env', ffprobe: '/usr/bin/env', fonts: ['/usr/bin/env'] },
        limits: { memoryMax: '6G', tasksMax: 2048 },
      }),
    );
    expect(read().toolchains).toEqual({
      python: {
        ...python,
        uv,
        media: { ffmpeg: '/usr/bin/env', ffprobe: '/usr/bin/env', fonts: ['/usr/bin/env'] },
      },
      limits: { memoryMax: '6G', tasksMax: 2048 },
    });
    // Caps alone, and one cap alone, are a file of their own.
    expect(settings(json({ version: 1, limits: { tasksMax: 4096 } })).read().toolchains).toEqual({
      limits: { memoryMax: '8G', tasksMax: 4096 },
    });
  });

  it('refuses to start on a file it cannot take whole, naming the file and the problem', () => {
    const owned = join(tmpdir(), 'not-root-owned');
    const refusals: [string, RegExp][] = [
      ['{', /not valid JSON/],
      [json([]), /JSON object/],
      [json({ version: 2 }), /"version": 1/],
      [json({ version: 1, extra: 1 }), /unknown key "extra"/],
      [json({ version: 1, python }), /"python" and "uv" together/],
      [json({ version: 1, uv }), /"python" and "uv" together/],
      [json({ version: 1, media: { fonts: [] } }), /"media".*with "python"/],
      [json({ version: 1, python: { ...python, extra: 1 }, uv }), /unknown key "extra"/],
      [json({ version: 1, python: { interpreter: python.interpreter }, uv }), /version/],
      [json({ version: 1, python: { ...python, version: '3.x' }, uv }), /version/],
      [json({ version: 1, python: { ...python, version: '' }, uv }), /version/],
      [json({ version: 1, python, uv: { path: uv.path } }), /version/],
      [json({ version: 1, python: { ...python, interpreter: 'python3' }, uv }), /absolute/],
      [
        json({ version: 1, python: { ...python, interpreter: '/usr/bin/../bin/env' }, uv }),
        /absolute, normalized/,
      ],
      // Through a link: /usr/bin/python3 names python3.14.
      [
        json({ version: 1, python: { ...python, interpreter: '/usr/bin/python3' }, uv }),
        /is a link/,
      ],
      [
        json({ version: 1, python: { ...python, interpreter: '/usr/bin/no-such-python' }, uv }),
        /does not exist/,
      ],
      [
        json({ version: 1, python: { ...python, interpreter: '/usr/bin' }, uv }),
        /not a regular file/,
      ],
      [json({ version: 1, python, uv, media: { fonts: 'x' } }), /"fonts"/],
      [json({ version: 1, python, uv, media: { other: '/usr/bin/env' } }), /unknown key "other"/],
      [
        json({ version: 1, python, uv, media: { fonts: Array(65).fill('/usr/bin/env') } }),
        /at most 64/,
      ],
      [json({ version: 1, limits: { memoryMax: '8' } }), /"memoryMax"/],
      [json({ version: 1, limits: { memoryMax: '100M' } }), /"memoryMax"/],
      [json({ version: 1, limits: { memoryMax: '1T' } }), /"memoryMax"/],
      [json({ version: 1, limits: { memoryMax: 8 } }), /"memoryMax"/],
      [json({ version: 1, limits: { tasksMax: 10 } }), /"tasksMax"/],
      [json({ version: 1, limits: { tasksMax: 1.5 } }), /"tasksMax"/],
      [json({ version: 1, limits: { tasksMax: '1024' } }), /"tasksMax"/],
      [json({ version: 1, limits: { cpu: 4 } }), /unknown key "cpu"/],
    ];
    writeFileSync(owned, '');
    refusals.push([
      json({ version: 1, python: { ...python, interpreter: owned }, uv }),
      /not owned by root|writable by its group or by others/,
    ]);
    try {
      for (const [contents, problem] of refusals) {
        const { file, read } = settings(contents);
        expect(read, contents).toThrow(problem);
        expect(read, contents).toThrow(file);
      }
    } finally {
      rmSync(owned, { force: true });
    }
  });

  it('refuses a link, a directory, a pipe or an oversized file in its place', () => {
    const linked = settings();
    const elsewhere = join(linked.base, 'elsewhere.json');
    writeFileSync(elsewhere, json({ version: 1 }));
    symlinkSync(elsewhere, linked.file);
    expect(linked.read).toThrow(/toolchains\.json must be a regular file/);
    const directory = settings();
    mkdirSync(directory.file);
    expect(directory.read).toThrow(/regular file/);
    const pipe = settings();
    execFileSync('mkfifo', [pipe.file]);
    expect(pipe.read).toThrow(/regular file/);
    expect(settings(`{"version": 1}${' '.repeat(64 * 1024)}`).read).toThrow(/64 KiB/);
  });

  it('never reads the file from where agents write: its directory is the settings directory, checked at start', () => {
    const at = settings();
    const inWorktrees = join(at.data, 'worktrees', 'repo', '.craftingtable');
    mkdirSync(inWorktrees, { recursive: true });
    writeFileSync(
      join(inWorktrees, 'toolchains.json'),
      json({ version: 1, limits: { tasksMax: 64 } }),
    );
    expect(() => configFromEnv({ ...at.env, CRAFTINGTABLE_CONFIG_DIR: inWorktrees })).toThrow(
      /must lie outside the worktree root/,
    );
  });
});
