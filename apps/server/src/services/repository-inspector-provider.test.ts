import { describe, expect, it, vi } from 'vitest';
import type { RepositoryFeatureConfig } from '../config.js';
import {
  type MonotonicClock,
  RepositoryInspectorProvider,
  type RepositoryObservationPortFactory,
} from './repository-inspector-provider.js';
import type { RepositoryObservationPort } from './repository-observation-port.js';

const enabledFeature: RepositoryFeatureConfig = {
  enabled: true,
  allowedSourceRoots: ['/srv/repositories'],
  reservedDataRoot: '/var/lib/craftingtable',
  artifactRoot: '/var/lib/craftingtable/artifacts',
  managedWorktreeRoot: '/var/lib/craftingtable/worktrees',
  gitExecutable: '/usr/bin/git',
  commandTimeoutMs: 5000,
  creationTimeoutMs: 15000,
  inspectionTimeoutMs: 15000,
  stdoutLimitBytes: 65536,
  stderrLimitBytes: 65536,
  terminationGraceMs: 250,
  retryDelayMs: 5000,
};

const fakePort = {
  inspect: vi.fn(),
  verifyStored: vi.fn(),
  verifyRegisteredIdentity: vi.fn(),
  compare: vi.fn(),
} as unknown as RepositoryObservationPort;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('RepositoryInspectorProvider', () => {
  it('keeps the absent feature disabled with zero factory calls (B2-CFG-001/002 A2B-CFG-001/002)', async () => {
    const factory = vi.fn<RepositoryObservationPortFactory>();
    const provider = new RepositoryInspectorProvider({ enabled: false }, factory);
    const first = await provider.get();
    const second = await provider.get();
    expect(provider.status()).toBe('disabled');
    expect(first).toBe(second);
    expect(first).toEqual({
      ok: false,
      failure: { kind: 'feature-disabled', reason: 'feature-disabled' },
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('shares one concurrent first-use promise/result and memoizes success (B2-CFG-003/006 B2A-SRC-008)', async () => {
    const pending = deferred<{ readonly ok: true; readonly port: RepositoryObservationPort }>();
    const factory = vi.fn<RepositoryObservationPortFactory>(() => pending.promise);
    const provider = new RepositoryInspectorProvider(enabledFeature, factory);
    const firstPromise = provider.get();
    const secondPromise = provider.get();
    expect(provider.status()).toBe('creating');
    expect(firstPromise).toBe(secondPromise);
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, port: fakePort });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toBe(second);
    expect(provider.status()).toBe('available');
    expect(await provider.get()).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('uses an exact monotonic cooldown and deduplicates the retry (B2-CFG-007 A2B-CFG-007 B2A-SRC-009)', async () => {
    let now = 100;
    const clock: MonotonicClock = { now: () => now };
    const factory = vi
      .fn<RepositoryObservationPortFactory>()
      .mockResolvedValueOnce({
        ok: false,
        failure: { reason: 'creation-failed', retryability: 'retryable' },
      })
      .mockResolvedValueOnce({ ok: true, port: fakePort });
    const provider = new RepositoryInspectorProvider(enabledFeature, factory, clock);
    const failure = await provider.get();
    expect(provider.status()).toBe('cooldown');
    now = 5099;
    expect(await provider.get()).toBe(failure);
    expect(factory).toHaveBeenCalledTimes(1);
    now = 5100;
    const [retryA, retryB] = await Promise.all([provider.get(), provider.get()]);
    expect(retryA).toBe(retryB);
    expect(retryA).toEqual({ ok: true, port: fakePort });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('caches configuration-required creation failures permanently but rechecks in a new process instance (B2-CFG-005/007)', async () => {
    const factory = vi.fn<RepositoryObservationPortFactory>().mockResolvedValue({
      ok: false,
      failure: { reason: 'creation-failed', retryability: 'configuration-required' },
    });
    const provider = new RepositoryInspectorProvider(enabledFeature, factory);
    const first = await provider.get();
    expect(provider.status()).toBe('permanently-unavailable');
    expect(await provider.get()).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);

    const restarted = new RepositoryInspectorProvider(enabledFeature, factory);
    expect(restarted.status()).toBe('idle');
    await restarted.get();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('demotes available permanently when the guarded port reports invariant drift (B2-ADP-002 B2A-EVID-006)', async () => {
    let reportFault!: Parameters<RepositoryObservationPortFactory>[0];
    const factory: RepositoryObservationPortFactory = async (callback) => {
      reportFault = callback;
      return { ok: true, port: fakePort };
    };
    const provider = new RepositoryInspectorProvider(enabledFeature, factory);
    expect(await provider.get()).toEqual({ ok: true, port: fakePort });
    reportFault({ kind: 'adapter-error', reason: 'adapter-invariant-fault' });
    expect(provider.status()).toBe('permanently-unavailable');
    expect(await provider.get()).toEqual({
      ok: false,
      failure: { kind: 'permanently-unavailable', reason: 'adapter-invariant-fault' },
    });
  });

  it('normalizes throws without disclosing configuration or roots (B2-CFG-008 A2B-CFG-008)', async () => {
    const provider = new RepositoryInspectorProvider(enabledFeature, async () => {
      throw new Error('/secret/root must not escape');
    });
    expect(await provider.get()).toEqual({
      ok: false,
      failure: { kind: 'permanently-unavailable', reason: 'adapter-invariant-fault' },
    });
    expect(JSON.stringify(await provider.get())).not.toContain('secret');
  });
});
