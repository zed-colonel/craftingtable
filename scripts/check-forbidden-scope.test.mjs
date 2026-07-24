import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findForbiddenImports,
  findManifestViolations,
  isForbidden,
  runCheck,
  findImports,
  isForbiddenCapability,
  isForbiddenInPlanning,
  isNonProductionPackage,
  isTestModule,
} from './check-forbidden-scope.mjs';

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

  it('recognizes test modules, which may use wider capabilities', () => {
    expect(isTestModule('packages/planning/src/parse.test.ts')).toBe(true);
    expect(isTestModule('packages/planning/src/test-support.ts')).toBe(true);
    expect(isTestModule('apps/web/src/features/planning/views.test.tsx')).toBe(true);
    expect(isTestModule('packages/planning/src/parse.ts')).toBe(false);
  });

  it('collects every import specifier, not only forbidden ones', () => {
    const source = "import { a } from 'alpha';\nexport * from 'beta';\nconst c = require('gamma');";
    expect(findImports(source)).toEqual(['alpha', 'beta', 'gamma']);
  });
});
