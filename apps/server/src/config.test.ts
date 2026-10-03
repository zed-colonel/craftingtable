import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFromEnv, retiredSettings } from './config.js';

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
    const root = (value: string) =>
      configFromEnv({
        CRAFTINGTABLE_DATA_DIR: data,
        HOME: home,
        XDG_RUNTIME_DIR: '/run/user/1234',
        TMPDIR: '/scratch/tmp',
        CRAFTINGTABLE_AGENT_TMP_ROOT: value,
      }).execution.agentTemporaryRoot;
    // At or above the system's shared and runtime temporary directories, the process's TMPDIR,
    // a home, or the file system.
    for (const refused of [
      '/',
      '/tmp',
      '/var/tmp',
      '/var',
      '/dev/shm',
      '/run',
      '/run/user',
      '/run/user/1234',
      '/scratch/tmp',
      '/scratch',
      home,
      '/home',
      homedir(),
    ])
      expect(() => root(refused), refused).toThrow(/directory of its own/);
    // The database's directory, at, above or inside it, and the data directory.
    for (const refused of [`${data}/state`, `${data}/state/t`, data, '/srv'])
      expect(() => root(refused), refused).toThrow(
        /AGENT_TMP_ROOT must lie outside the database's directory/,
      );
    // A directory of its own stays allowed, beneath a home or /tmp included: the default
    // `<data>/t` is under the home, and the e2e daemon's is `/tmp/cte-…`.
    for (const accepted of [
      `${data}/t`,
      '/tmp/cte-x',
      '/var/tmp/ct',
      '/run/user/1234/ct',
      '/scratch/tmp/ct',
      `${home}/x`,
      `${homedir()}/x`,
    ])
      expect(root(accepted)).toBe(accepted);
    expect(
      configFromEnv({ HOME: home, CRAFTINGTABLE_DATA_DIR: `${home}/.local/share/craftingtable` })
        .execution.agentTemporaryRoot,
    ).toBe(`${home}/.local/share/craftingtable/t`);
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
      const root = (value: string, dataDir = data) =>
        configFromEnv({ CRAFTINGTABLE_DATA_DIR: dataDir, CRAFTINGTABLE_AGENT_TMP_ROOT: value })
          .execution.agentTemporaryRoot;
      for (const refused of [join(base, 'state-link'), join(base, 'state-link', 'not-yet')])
        expect(() => root(refused), refused).toThrow(/database's directory/);
      // The data directory named through a link, the root by its real path.
      expect(() => root(join(data, 'state'), join(base, 'data-link'))).toThrow(
        /database's directory/,
      );
      expect(() => root(join(base, 'tmp-link'))).toThrow(/directory of its own/);
      // A link to a directory of its own is that directory.
      mkdirSync(join(base, 'agents'));
      symlinkSync(join(base, 'agents'), join(base, 'agents-link'));
      expect(root(join(base, 'agents-link'))).toBe(join(base, 'agents-link'));
      // A path whose links cannot be read is refused, not passed unseen.
      mkdirSync(join(base, 'locked', 'inner'), { recursive: true });
      chmodSync(join(base, 'locked'), 0o000);
      expect(() => root(join(base, 'locked', 'inner', 't'))).toThrow(/could not be resolved/);
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
