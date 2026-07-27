#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CT04_PROTECTED_MANIFEST = Object.freeze({
  'README.md': '4e857aca74d4c96f869a2f30e73f0aeb0153f8de2c0e77f972fea325647119fd',
  'CT-04-protected-acceptance-spec.yaml':
    'ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64',
});

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function verifyCt04ProtectedPackage(protectedDirectory) {
  let actualNames;
  try {
    actualNames = readdirSync(protectedDirectory).sort();
  } catch {
    return {
      ok: false,
      errors: ['protected package directory is missing or unreadable'],
    };
  }
  const expectedNames = Object.keys(CT04_PROTECTED_MANIFEST).sort();
  const errors = [];
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    errors.push('protected package file manifest differs from the pinned two-file manifest');
  }
  for (const [name, expectedHash] of Object.entries(CT04_PROTECTED_MANIFEST)) {
    const path = join(protectedDirectory, name);
    try {
      if (!statSync(path).isFile()) {
        errors.push(`${name} is not a regular file`);
      } else if (sha256(path) !== expectedHash) {
        errors.push(`${name} does not match its pinned SHA-256`);
      }
    } catch {
      errors.push(`${name} is missing or unreadable`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = verifyCt04ProtectedPackage(join(repositoryRoot, 'protected'));
  if (!result.ok) {
    console.error('CT-04 protected-package verification FAILED:');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log('CT-04 protected-package verification passed: exact two-file manifest and hashes.');
}
