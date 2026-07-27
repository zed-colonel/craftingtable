import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NODE_FILE_SYSTEM_BOUNDARY,
  admitRepositoryPath,
  createRootPolicy,
} from '../src/path-policy.js';
import { createInspectionError } from '../src/types.js';
import { createRepositoryInspector } from '../src/index.js';
import { createRepositoryFixture, repositoryInspectorOptions } from './test-support.js';

const EFFECTIVE_UID = process.geteuid?.() ?? -1;

describe('source and reserved root topology', () => {
  it('enforces source and reserved root count bounds', async () => {
    const fixture = createRepositoryFixture();
    try {
      expect((await createRootPolicy([], [])).ok).toBe(false);
      expect(
        (
          await createRootPolicy(
            Array.from({ length: 33 }, (_, index) => join(fixture.root, `source-${String(index)}`)),
            [],
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await createRootPolicy(
            [fixture.sourceRoot],
            Array.from({ length: 33 }, (_, index) =>
              join(fixture.root, `reserved-${String(index)}`),
            ),
          )
        ).ok,
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts canonical disjoint roots including a nonexisting reserved suffix', async () => {
    const fixture = createRepositoryFixture();
    try {
      const reserved = join(fixture.root, 'future-data', 'repositories');
      const result = await createRootPolicy([fixture.sourceRoot], [reserved]);
      expect(result.ok).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects duplicate, nested, and cross-set overlap in both directions', async () => {
    const fixture = createRepositoryFixture();
    try {
      const nested = join(fixture.sourceRoot, 'nested');
      mkdirSync(nested);
      const sibling = join(fixture.root, 'reserved');
      mkdirSync(sibling);
      for (const [sources, reserved] of [
        [[fixture.sourceRoot, fixture.sourceRoot], []],
        [[fixture.sourceRoot, nested], []],
        [[fixture.sourceRoot], [fixture.sourceRoot]],
        [[fixture.sourceRoot], [nested]],
        [[nested], [fixture.sourceRoot]],
        [[fixture.sourceRoot], [sibling, sibling]],
      ] as const) {
        const result = await createRootPolicy(sources, reserved);
        expect(result.ok).toBe(false);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects symlinked source and reserved components', async () => {
    const fixture = createRepositoryFixture();
    try {
      const sourceLink = join(fixture.root, 'source-link');
      symlinkSync(fixture.sourceRoot, sourceLink);
      const sourceResult = await createRootPolicy([sourceLink], []);
      expect(sourceResult.ok).toBe(false);

      const reservedTarget = join(fixture.root, 'reserved-target');
      mkdirSync(reservedTarget);
      const reservedLink = join(fixture.root, 'reserved-link');
      symlinkSync(reservedTarget, reservedLink);
      const reservedResult = await createRootPolicy([fixture.sourceRoot], [reservedLink]);
      expect(reservedResult.ok).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('repository path admission', () => {
  it('rejects equal-root, relative, outside, missing, and nondirectory requests before Git', async () => {
    const fixture = createRepositoryFixture();
    try {
      const creation = await createRepositoryInspector(repositoryInspectorOptions(fixture));
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const cases = [
        [fixture.sourceRoot, 'outside-allowed-root'],
        ['relative/repository', 'invalid-path'],
        [join(fixture.root, 'outside'), 'outside-allowed-root'],
        [join(fixture.sourceRoot, 'missing'), 'path-unavailable'],
        [join(fixture.repository, 'README.md'), 'path-unavailable'],
      ] as const;
      for (const [requestedPath, code] of cases) {
        const result = await creation.inspector.inspect({ requestedPath });
        expect(result.ok, requestedPath).toBe(false);
        if (!result.ok) {
          expect(result.error.code, requestedPath).toBe(code);
        }
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a symlink at the requested path without following it', async () => {
    const fixture = createRepositoryFixture();
    try {
      const linked = join(fixture.sourceRoot, 'linked');
      symlinkSync(fixture.repository, linked);
      const creation = await createRepositoryInspector(repositoryInspectorOptions(fixture));
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const result = await creation.inspector.inspect({ requestedPath: linked });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('symlink-rejected');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('checks a pre-aborted request before every filesystem operation', async () => {
    let accesses = 0;
    const failingFs = {
      lstat: async () => {
        accesses += 1;
        throw new Error('must not run');
      },
      stat: async () => {
        accesses += 1;
        throw new Error('must not run');
      },
      realpath: async () => {
        accesses += 1;
        throw new Error('must not run');
      },
      readdir: async () => {
        accesses += 1;
        throw new Error('must not run');
      },
      access: async () => {
        accesses += 1;
        throw new Error('must not run');
      },
    };
    const result = await admitRepositoryPath(
      '/source/repository',
      { allowedSourceRoots: ['/source'], reservedRoots: [] },
      1000,
      () => createInspectionError('aborted', 'inspect-path'),
      failingFs,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('aborted');
    }
    expect(accesses).toBe(0);
  });

  it('keeps reserved-overlap and ownership refusal distinguishable', async () => {
    const fixture = createRepositoryFixture();
    try {
      const reserved = await admitRepositoryPath(
        fixture.repository,
        {
          allowedSourceRoots: [fixture.sourceRoot],
          reservedRoots: [fixture.repository],
        },
        EFFECTIVE_UID,
        () => undefined,
      );
      expect(reserved.ok).toBe(false);
      if (!reserved.ok) {
        expect(reserved.error.code).toBe('reserved-root-overlap');
      }

      const ownership = await admitRepositoryPath(
        fixture.repository,
        { allowedSourceRoots: [fixture.sourceRoot], reservedRoots: [] },
        EFFECTIVE_UID + 1,
        () => undefined,
      );
      expect(ownership.ok).toBe(false);
      if (!ownership.ok) {
        expect(ownership.error.code).toBe('ownership-refused');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('reports deterministic unreadable metadata faults as unavailable evidence', async () => {
    const fixture = createRepositoryFixture();
    try {
      const configPath = join(fixture.repository, '.git', 'config');
      const result = await admitRepositoryPath(
        fixture.repository,
        { allowedSourceRoots: [fixture.sourceRoot], reservedRoots: [] },
        EFFECTIVE_UID,
        () => undefined,
        {
          ...NODE_FILE_SYSTEM_BOUNDARY,
          access: async (path, mode) => {
            if (path === configPath) {
              const error = new Error('denied') as NodeJS.ErrnoException;
              error.code = 'EACCES';
              throw error;
            }
            await NODE_FILE_SYSTEM_BOUNDARY.access(path, mode);
          },
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('repository-metadata-unreadable');
      }
    } finally {
      fixture.cleanup();
    }
  });
});
