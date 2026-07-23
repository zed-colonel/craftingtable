import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findForbiddenImports,
  findManifestViolations,
  isForbidden,
  runCheck,
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
