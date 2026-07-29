import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  A2A_ALLOWED_NODE_BUILTINS,
  B1_ALLOWED_IMPORTS,
  b1DisallowedImports,
  findForbiddenImports,
  findManifestViolations,
  isForbidden,
  runCheck,
  findImports,
  findNulByte,
  isForbiddenCapability,
  isForbiddenInPlanning,
  isForbiddenInA2a,
  isA2aSource,
  isA2aTestFixtureBuiltin,
  isDevelopmentToolingModule,
  hasLiteralCurrentMigrationAssertion,
  isNonProductionPackage,
  isTestModule,
  nodeBuiltinName,
  resolvesIntoDevelopmentTooling,
} from './check-forbidden-scope.mjs';

function scopeFixture(relativeSourcePath, source) {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-scope-'));
  writeFileSync(join(root, 'package.json'), '{"name":"scope-fixture"}');
  mkdirSync(join(root, 'apps'));
  const packageRoot = join(root, 'packages', relativeSourcePath.split('/')[0]);
  mkdirSync(join(packageRoot, 'src'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"fixture-package"}');
  const sourcePath = join(root, 'packages', relativeSourcePath);
  mkdirSync(join(sourcePath, '..'), { recursive: true });
  writeFileSync(sourcePath, source);
  return root;
}

describe('isForbidden', () => {
  it('matches every forbidden repository name in any casing or hyphenation', () => {
    for (const name of [
      'actionqueue',
      'action-queue',
      '@exo/ActionQueue',
      'worldinterface',
      'world-interface',
      'exoskeleton',
      '@exo/exoskeleton-core',
      '../../exoskeleton/src/lib',
    ]) {
      expect(isForbidden(name), name).toBe(true);
    }
  });

  it('leaves legitimate specifiers alone', () => {
    for (const name of ['fastify', 'zod', 'react', './events.js', '@craftingtable/domain']) {
      expect(isForbidden(name), name).toBe(false);
    }
  });
});

describe('findForbiddenImports', () => {
  it('detects every supported import form (CT01-R4)', () => {
    const forms = [
      `import 'exoskeleton';`,
      `import "actionqueue";`,
      `import x from 'exoskeleton';`,
      `import { y } from "world-interface";`,
      `import * as z from 'action-queue';`,
      `export * from 'actionqueue-utils';`,
      `export { a } from "exoskeleton";`,
      `const m = await import('exoskeleton');`,
      `const n = require('world-interface');`,
      `import '../exoskeleton/lib';`,
    ];
    for (const source of forms) {
      expect(findForbiddenImports(source), source).toHaveLength(1);
    }
  });

  it('ignores clean sources', () => {
    const clean = `
      import { fastify } from 'fastify';
      import { z } from "zod";
      import './styles/tokens.css';
      export * from './ids.js';
      const dynamic = await import('./lazy.js');
      const legacy = require('node:path');
    `;
    expect(findForbiddenImports(clean)).toEqual([]);
  });
});

describe('findManifestViolations', () => {
  it('flags forbidden names in every dependency field', () => {
    const manifest = {
      dependencies: { fastify: '^5.0.0', '@exo/actionqueue': '1.0.0' },
      devDependencies: { exoskeleton: '0.1.0' },
      peerDependencies: { 'world-interface': '2.0.0' },
      optionalDependencies: { WorldInterface: '2.0.0' },
    };
    expect(findManifestViolations(manifest)).toHaveLength(4);
  });

  it('passes a clean manifest', () => {
    expect(findManifestViolations({ dependencies: { zod: '^4.0.0' } })).toEqual([]);
  });
});

describe('runCheck', () => {
  it('passes against the actual repository', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    expect(runCheck(root)).toEqual([]);
  });
});

describe('CT-03 capability and boundary guards', () => {
  it('flags real Git, process execution, and vendor agent SDKs', () => {
    for (const specifier of [
      'simple-git',
      'isomorphic-git',
      'node:child_process',
      'child_process',
      'execa',
      'node-pty',
      'openai',
      '@anthropic-ai/sdk',
      '@modelcontextprotocol/sdk',
    ]) {
      expect(isForbiddenCapability(specifier), specifier).toBe(true);
    }
  });

  it('permits ordinary modules CT-03 legitimately uses', () => {
    for (const specifier of [
      'node:crypto',
      'yaml',
      'zod',
      'fastify',
      '@fastify/multipart',
      'better-sqlite3',
      '@craftingtable/planning',
    ]) {
      expect(isForbiddenCapability(specifier), specifier).toBe(false);
    }
  });

  it('treats the future/test packages as non-production seams', () => {
    expect(isNonProductionPackage('@craftingtable/agents')).toBe(true);
    expect(isNonProductionPackage('@craftingtable/git')).toBe(true);
    expect(isNonProductionPackage('@craftingtable/testing')).toBe(true);
    expect(isNonProductionPackage('@craftingtable/planning')).toBe(false);
    expect(isNonProductionPackage('@craftingtable/storage')).toBe(false);
  });

  it('keeps the pure planning package away from I/O and UI', () => {
    for (const specifier of [
      'node:fs',
      'node:fs/promises',
      'node:path',
      'node:child_process',
      'node:net',
      'fastify',
      '@fastify/multipart',
      'react',
      'react-dom',
      'better-sqlite3',
      '@craftingtable/storage',
      '@craftingtable/server',
      '@craftingtable/web',
    ]) {
      expect(isForbiddenInPlanning(specifier), specifier).toBe(true);
    }
    // Hashing is computation, not I/O (ADR-012).
    expect(isForbiddenInPlanning('node:crypto')).toBe(false);
    expect(isForbiddenInPlanning('yaml')).toBe(false);
    expect(isForbiddenInPlanning('@craftingtable/domain')).toBe(false);
  });

  it('recognizes structurally placed tests, which may use wider capabilities', () => {
    expect(isTestModule('packages/planning/src/parse.test.ts')).toBe(true);
    expect(isTestModule('packages/git/test/test-support.ts')).toBe(true);
    expect(isTestModule('apps/web/src/features/planning/views.test.tsx')).toBe(true);
    expect(isTestModule('packages/planning/src/test-support.ts')).toBe(true);
    expect(isTestModule('packages/storage/src/x-test-support.ts')).toBe(false);
    expect(isTestModule('packages/planning/src/parse.ts')).toBe(false);
  });

  it('collects every import specifier, not only forbidden ones', () => {
    const source = "import { a } from 'alpha';\nexport * from 'beta';\nconst c = require('gamma');";
    expect(findImports(source)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('CT-04A1 anchored process authority', () => {
  it('rejects a production filename-based test-support escape', () => {
    const root = scopeFixture(
      'storage/src/x-test-support.ts',
      "import { spawn } from 'node:child_process';",
    );
    try {
      expect(runCheck(root)).toContain(
        'packages/storage/src/x-test-support.ts: imports CT-04+ capability module "node:child_process"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows node:child_process only at the exact Git runner path', () => {
    const root = scopeFixture(
      'git/src/command-runner.ts',
      "import { spawn } from 'node:child_process';",
    );
    try {
      expect(runCheck(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CT-04A2a authority-free boundary', () => {
  it('scans A2a production and test files', () => {
    expect(isA2aSource('packages/domain/src/repository.ts')).toBe(true);
    expect(isA2aSource('packages/contracts/src/repository.test.ts')).toBe(true);
    expect(isA2aSource('packages/storage/src/repositories/repository-registry/index.ts')).toBe(
      true,
    );
    expect(isA2aSource('packages/git/src/types.ts')).toBe(false);
  });

  it('rejects filesystem, network, Git, process, server, route, event, notifier, and browser authority (A2-SCOPE-001)', () => {
    for (const specifier of [
      '@craftingtable/git',
      'node:fs',
      'node:fs/promises',
      'fs',
      'fs/promises',
      'node:child_process',
      'child_process',
      'node:net',
      'node:http',
      'node:https',
      'node:dns',
      'node:dgram',
      'node:worker_threads',
      'node:vm',
      'node:v8',
      'node:inspector',
      'node:cluster',
      'fastify',
      '@fastify/cookie',
      '@craftingtable/server',
      '@craftingtable/web',
      'react',
      '../../routes/repository.js',
      '../workspace-events.js',
      '../notifier.js',
    ]) {
      expect(isForbiddenInA2a(specifier), specifier).toBe(true);
    }
    expect(isForbiddenInA2a('node:crypto')).toBe(false);
    expect(isForbiddenInA2a('crypto')).toBe(false);
    expect(isForbiddenInA2a('@craftingtable/domain')).toBe(false);
    expect(isForbiddenInA2a('better-sqlite3')).toBe(false);
    expect(isForbiddenInA2a('zod')).toBe(false);
    expect(isForbiddenInA2a('./rows.js')).toBe(false);
  });

  it('admits only the allowlisted builtins, so an unnamed one cannot slip through', () => {
    // The point of the allowlist: a builtin nobody thought to deny is still
    // denied. `builtinModules` is the source of truth, and any `node:` prefixed
    // specifier counts even if this release does not list it.
    for (const builtin of builtinModules) {
      const permitted = A2A_ALLOWED_NODE_BUILTINS.includes(builtin.split('/')[0]);
      expect(isForbiddenInA2a(builtin), builtin).toBe(!permitted);
      expect(isForbiddenInA2a(`node:${builtin}`), `node:${builtin}`).toBe(!permitted);
    }
    expect(nodeBuiltinName('node:not-yet-invented')).toBe('not-yet-invented');
    expect(isForbiddenInA2a('node:not-yet-invented')).toBe(true);
    expect(nodeBuiltinName('@craftingtable/domain')).toBeUndefined();
    expect(nodeBuiltinName('./local.js')).toBeUndefined();
  });

  it('lets structural tests read fixtures but not open sockets', () => {
    expect(isA2aTestFixtureBuiltin('node:fs')).toBe(true);
    expect(isA2aTestFixtureBuiltin('fs/promises')).toBe(true);
    expect(isA2aTestFixtureBuiltin('node:os')).toBe(true);
    expect(isA2aTestFixtureBuiltin('node:path')).toBe(true);
    expect(isA2aTestFixtureBuiltin('node:net')).toBe(false);
    expect(isA2aTestFixtureBuiltin('node:child_process')).toBe(false);
  });

  it('fails the workspace check for filesystem or socket authority in production A2a source', () => {
    for (const specifier of [
      'node:fs',
      'node:fs/promises',
      'fs',
      'node:net',
      'node:http',
      'node:https',
      'node:dns',
      'node:worker_threads',
    ]) {
      const root = scopeFixture(
        'storage/src/repository.ts',
        `import authority from '${specifier}';\nvoid authority;`,
      );
      try {
        expect(runCheck(root)).toContain(
          `packages/storage/src/repository.ts: CT-04A2a authority-free source imports "${specifier}"`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects literal current-version assertions but allows discovered support (A2-SCOPE-003)', () => {
    expect(
      hasLiteralCurrentMigrationAssertion('expect(storage.migrationStatus.currentVersion).toBe(3)'),
    ).toBe(true);
    expect(
      hasLiteralCurrentMigrationAssertion(
        'expect(storage.migrationStatus.currentVersion).toBe(storage.migrationStatus.supportedVersion)',
      ),
    ).toBe(false);
  });
});

describe('CT-04A2b1 exact-path dependency boundary', () => {
  it('B1-SCOPE-001 pins every production target to an exact allowed-specifier set', () => {
    expect([...B1_ALLOWED_IMPORTS.keys()].toSorted()).toEqual(
      [
        'packages/domain/src/workspace-events.ts',
        'packages/contracts/src/workspace-event.ts',
        'packages/storage/src/types.ts',
        'packages/storage/src/repositories/workspace-events.ts',
        'apps/web/src/lib/workspace-projection.ts',
        'apps/web/src/components/ActivityPanel.tsx',
        'apps/web/src/App.tsx',
      ].toSorted(),
    );
    expect(
      b1DisallowedImports(
        'packages/storage/src/types.ts',
        "import type { A } from './repository-types.js';",
      ),
    ).toEqual([]);
    expect(
      b1DisallowedImports(
        'packages/contracts/src/workspace-event.ts',
        "import type { A } from './repository.js';",
      ),
    ).toEqual([]);
  });

  it('rejects Git, process, Fastify, server-service, and reverse event edges', () => {
    const cases = [
      ['packages/domain/src/workspace-events.ts', '@craftingtable/git'],
      ['packages/contracts/src/workspace-event.ts', 'node:child_process'],
      ['packages/storage/src/repositories/workspace-events.ts', 'fastify'],
      ['apps/web/src/lib/workspace-projection.ts', '@craftingtable/server'],
      ['apps/web/src/components/ActivityPanel.tsx', '../../server/src/services/repository.js'],
      ['packages/storage/src/repository-types.ts', './workspace-event.js'],
    ];
    for (const [path, specifier] of cases) {
      if (path === 'packages/storage/src/repository-types.ts') {
        expect(isForbiddenInA2a(specifier), specifier).toBe(true);
        continue;
      }
      expect(b1DisallowedImports(path, `import value from '${specifier}';`), specifier).toEqual([
        specifier,
      ]);
    }
  });

  it('fails the workspace check for an unapproved B1 dependency edge', () => {
    const root = scopeFixture(
      'domain/src/workspace-events.ts',
      "import { repository } from '@craftingtable/git';\nvoid repository;",
    );
    try {
      expect(runCheck(root)).toContain(
        'packages/domain/src/workspace-events.ts: CT-04A2b1 exact-path source imports unapproved module "@craftingtable/git"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('development tooling separation', () => {
  it('classifies repository-root scripts as tooling and application source as shipped', () => {
    expect(isDevelopmentToolingModule('scripts/check-forbidden-scope.mjs')).toBe(true);
    expect(isDevelopmentToolingModule('scripts/nested/tool.mjs')).toBe(true);
    expect(isDevelopmentToolingModule('packages/storage/src/scripts/helper.ts')).toBe(false);
    expect(isDevelopmentToolingModule('apps/server/src/cli.ts')).toBe(false);
  });

  it('resolves specifiers rather than pattern-matching them', () => {
    const root = '/repo';
    expect(
      resolvesIntoDevelopmentTooling(root, 'apps/server/src/cli.ts', '../../../scripts/tool.mjs'),
    ).toBe(true);
    // A package's own src/scripts directory is untouched by the rule.
    expect(
      resolvesIntoDevelopmentTooling(root, 'packages/storage/src/index.ts', './scripts/helper.js'),
    ).toBe(false);
    expect(resolvesIntoDevelopmentTooling(root, 'apps/server/src/cli.ts', 'node:fs')).toBe(false);
    expect(
      resolvesIntoDevelopmentTooling(root, 'apps/server/src/cli.ts', '@craftingtable/storage'),
    ).toBe(false);
  });

  it('fails the workspace check when application source imports tooling', () => {
    const root = scopeFixture(
      'storage/src/index.ts',
      "import { runCheck } from '../../../scripts/check-forbidden-scope.mjs';\nvoid runCheck;",
    );
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'scripts', 'check-forbidden-scope.mjs'), 'export const a = 1;\n');
      expect(runCheck(root)).toContain(
        'packages/storage/src/index.ts: application source imports development tooling "../../../scripts/check-forbidden-scope.mjs"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unanchored process authority in tooling and permits the anchored one', () => {
    const root = scopeFixture('storage/src/index.ts', 'export const a = 1;\n');
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(
        join(root, 'scripts', 'rogue-tool.mjs'),
        "import { execFileSync } from 'node:child_process';\nvoid execFileSync;",
      );
      expect(runCheck(root)).toContain(
        'scripts/rogue-tool.mjs: development tooling imports unanchored capability module "node:child_process"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const anchored = scopeFixture('storage/src/index.ts', 'export const a = 1;\n');
    try {
      mkdirSync(join(anchored, 'scripts'), { recursive: true });
      writeFileSync(
        join(anchored, 'scripts', 'check-ct04-protected-package.mjs'),
        "import { execFileSync } from 'node:child_process';\nvoid execFileSync;",
      );
      expect(runCheck(anchored)).toEqual([]);
    } finally {
      rmSync(anchored, { recursive: true, force: true });
    }
  });

  it('still scans tooling for Exo Stack dependencies and NUL bytes', () => {
    const root = scopeFixture('storage/src/index.ts', 'export const a = 1;\n');
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'scripts', 'tool.mjs'), "import 'exoskeleton';\n");
      expect(runCheck(root)).toContain('scripts/tool.mjs: imports forbidden module "exoskeleton"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('source integrity (CT03-R7)', () => {
  it('locates a NUL byte and its offset', () => {
    expect(findNulByte(Buffer.from('clean source'))).toBe(-1);
    expect(findNulByte(Buffer.from([0x61, 0x62, 0x00, 0x63]))).toBe(2);
  });

  it('passes over the real repository, which contains no NUL bytes', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    expect(runCheck(root).filter((violation) => violation.includes('NUL byte'))).toEqual([]);
  });
});
