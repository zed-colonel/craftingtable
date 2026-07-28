import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
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
  hasLiteralCurrentMigrationAssertion,
  isNonProductionPackage,
  isTestModule,
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
      'node:child_process',
      'node:net',
      'node:http',
      'node:https',
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
    expect(isForbiddenInA2a('@craftingtable/domain')).toBe(false);
    expect(isForbiddenInA2a('better-sqlite3')).toBe(false);
  });

  it('fails the workspace check for filesystem or socket authority in production A2a source', () => {
    for (const specifier of [
      'node:fs',
      'node:fs/promises',
      'node:net',
      'node:http',
      'node:https',
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
