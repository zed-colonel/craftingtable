import { describe, expect, it } from 'vitest';
import { configFromEnv } from './config.js';

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
      repositoryFeature: { enabled: false },
    });
  });

  const enabledRepositoryEnv = {
    CRAFTINGTABLE_DATA_DIR: '/var/lib/craftingtable',
    CRAFTINGTABLE_REPOSITORY_ROOTS: '/srv/repositories',
    CRAFTINGTABLE_GIT_BIN: '/usr/bin/git',
  } as const;

  it('parses bin-only, search-only, and both explicit Git resolution forms (B2-CFG-003 A2B-CFG-003 A2B-CFG-005)', () => {
    const binOnly = configFromEnv(enabledRepositoryEnv).repositoryFeature;
    expect(binOnly).toMatchObject({
      enabled: true,
      allowedSourceRoots: ['/srv/repositories'],
      reservedDataRoot: '/var/lib/craftingtable',
      artifactRoot: '/var/lib/craftingtable/artifacts',
      managedWorktreeRoot: '/var/lib/craftingtable/worktrees',
      gitExecutable: '/usr/bin/git',
      commandTimeoutMs: 5000,
      creationTimeoutMs: 15000,
      inspectionTimeoutMs: 15000,
      retryDelayMs: 5000,
    });
    expect(
      configFromEnv({
        ...enabledRepositoryEnv,
        CRAFTINGTABLE_GIT_BIN: undefined,
        CRAFTINGTABLE_GIT_SEARCH_PATH: '/opt/git/bin:/usr/local/bin',
      }).repositoryFeature,
    ).toMatchObject({ enabled: true, executableSearchPath: '/opt/git/bin:/usr/local/bin' });
    expect(
      configFromEnv({
        ...enabledRepositoryEnv,
        CRAFTINGTABLE_GIT_SEARCH_PATH: '/opt/git/bin',
      }).repositoryFeature,
    ).toMatchObject({
      enabled: true,
      gitExecutable: '/usr/bin/git',
      executableSearchPath: '/opt/git/bin',
    });
  });

  it('rejects absent roots, absent explicit Git resolution, and every empty explicit field (B2-CFG-004 A2B-CFG-004)', () => {
    expect(() => configFromEnv({ CRAFTINGTABLE_GIT_BIN: '/usr/bin/git' })).toThrow(/ROOTS/);
    expect(() =>
      configFromEnv({
        CRAFTINGTABLE_DATA_DIR: '/var/lib/craftingtable',
        CRAFTINGTABLE_REPOSITORY_ROOTS: '/srv/repositories',
      }),
    ).toThrow(/GIT_BIN or CRAFTINGTABLE_GIT_SEARCH_PATH/);
    for (const key of [
      'CRAFTINGTABLE_REPOSITORY_ROOTS',
      'CRAFTINGTABLE_ARTIFACT_ROOT',
      'CRAFTINGTABLE_MANAGED_WORKTREE_ROOT',
      'CRAFTINGTABLE_GIT_BIN',
      'CRAFTINGTABLE_GIT_SEARCH_PATH',
      'CRAFTINGTABLE_GIT_TIMEOUT_MS',
      'CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS',
      'CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS',
      'CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES',
      'CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES',
      'CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS',
      'CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS',
    ] as const) {
      expect(() => configFromEnv({ ...enabledRepositoryEnv, [key]: '' })).toThrow();
    }
  });

  it('fails closed on every lexical root-policy error (B2-CFG-005)', () => {
    for (const roots of [
      'relative',
      '/srv/repositories/../repositories',
      '/srv/repositories\0child',
      '/srv/repositories:colon',
      '/srv/repositories:/srv/repositories',
      '/srv:/srv/repositories',
      '/var/lib/craftingtable/source',
      `/srv/${'x'.repeat(4097)}`,
    ]) {
      expect(() =>
        configFromEnv({ ...enabledRepositoryEnv, CRAFTINGTABLE_REPOSITORY_ROOTS: roots }),
      ).toThrow(/ROOTS/);
    }
    expect(() =>
      configFromEnv({
        ...enabledRepositoryEnv,
        CRAFTINGTABLE_REPOSITORY_ROOTS: Array.from(
          { length: 33 },
          (_, index) => `/srv/repository-${index}`,
        ).join(':'),
      }),
    ).toThrow(/ROOTS/);
    for (const dataDir of ['/var/lib/craftingtable/', '/var/lib/other/../craftingtable']) {
      expect(() =>
        configFromEnv({ ...enabledRepositoryEnv, CRAFTINGTABLE_DATA_DIR: dataDir }),
      ).toThrow(/normalized/);
    }
  });

  it('enforces exact numeric bounds and coherence (B2-CFG-004 B2-CFG-005)', () => {
    const invalid = [
      ['CRAFTINGTABLE_GIT_TIMEOUT_MS', '99'],
      ['CRAFTINGTABLE_GIT_TIMEOUT_MS', '1.5'],
      ['CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS', '4999'],
      ['CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS', '9999'],
      ['CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES', '16383'],
      ['CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES', '1023'],
      ['CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS', '49'],
      ['CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS', '99'],
    ] as const;
    for (const [key, value] of invalid) {
      expect(() => configFromEnv({ ...enabledRepositoryEnv, [key]: value })).toThrow();
    }
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

  it('rejects malformed ports, lifetimes, origins, and relative data directories', () => {
    expect(() => configFromEnv({ CRAFTINGTABLE_PORT: '0' })).toThrow(/PORT/);
    expect(() => configFromEnv({ CRAFTINGTABLE_SESSION_LIFETIME_SECONDS: '10' })).toThrow(
      /LIFETIME/,
    );
    expect(() => configFromEnv({ CRAFTINGTABLE_PUBLIC_ORIGIN: 'ftp://localhost' })).toThrow(
      /origin/,
    );
    expect(() => configFromEnv({ CRAFTINGTABLE_DATA_DIR: './state' })).toThrow(/absolute/);
  });
});
