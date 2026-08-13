import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCraftingTableStorage } from '@craftingtable/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configFromEnv } from './config.js';
import { createServices } from './composition.js';
import type { RepositoryObservationPort } from './services/repository-observation-port.js';
import { RepositoryInspectorProvider } from './services/repository-inspector-provider.js';
import { FastTestPasswordHasher } from './test-support.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStorage() {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-a2b2a-composition-'));
  directories.push(directory);
  return {
    directory,
    storage: openCraftingTableStorage(join(directory, 'state.sqlite')),
  };
}

const fakePort = {
  inspect: vi.fn(),
  verifyStored: vi.fn(),
  verifyRegisteredIdentity: vi.fn(),
  compare: vi.fn(),
} as unknown as RepositoryObservationPort;

describe('repository provider composition', () => {
  it('preserves planning/auth composition with the repository feature disabled (B2-CFG-001 A2B-CFG-001 A2B-CFG-006)', async () => {
    const { directory, storage } = temporaryStorage();
    try {
      const config = configFromEnv({ CRAFTINGTABLE_DATA_DIR: directory });
      const factory = vi.fn();
      const services = await createServices(storage, config, {
        passwordHasher: new FastTestPasswordHasher(),
        repositoryObservationPortFactory: factory,
      });
      expect(services.authService).toBeDefined();
      expect(services.planningQueryService).toBeDefined();
      expect(storage.repositoryRegistry.repositories.list).toBeTypeOf('function');
      expect(services.repositoryInspectorProvider.status()).toBe('disabled');
      expect((await services.repositoryInspectorProvider.get()).ok).toBe(false);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      storage.close();
    }
  });

  it('composes an enabled provider without eager A1 creation (B2-CFG-003)', async () => {
    const { directory, storage } = temporaryStorage();
    try {
      const config = configFromEnv({
        CRAFTINGTABLE_DATA_DIR: directory,
        CRAFTINGTABLE_REPOSITORY_ROOTS: '/srv/repositories',
        CRAFTINGTABLE_GIT_BIN: '/usr/bin/git',
      });
      const factory = vi.fn(async () => ({ ok: true as const, port: fakePort }));
      const services = await createServices(storage, config, {
        passwordHasher: new FastTestPasswordHasher(),
        repositoryObservationPortFactory: factory,
      });
      expect(services.repositoryInspectorProvider.status()).toBe('idle');
      expect(factory).not.toHaveBeenCalled();
      expect(await services.repositoryInspectorProvider.get()).toEqual({
        ok: true,
        port: fakePort,
      });
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      storage.close();
    }
  });

  it('accepts a server-owned provider override without exposing a raw port seam', async () => {
    const { directory, storage } = temporaryStorage();
    try {
      const config = configFromEnv({ CRAFTINGTABLE_DATA_DIR: directory });
      const override = new RepositoryInspectorProvider({ enabled: false }, vi.fn());
      const services = await createServices(storage, config, {
        passwordHasher: new FastTestPasswordHasher(),
        repositoryInspectorProvider: override,
      });
      expect(services.repositoryInspectorProvider).toBe(override);
    } finally {
      storage.close();
    }
  });
});
