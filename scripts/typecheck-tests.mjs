#!/usr/bin/env node
/**
 * Type-checks every package's tests (R-I4, TS-M14).
 *
 * Tests and test support live in each package's `test/` directory, which its production
 * `tsconfig.json` does not compile; its `tsconfig.test.json` type-checks them without emitting.
 * The projects are found, not listed: every `apps/*` and `packages/*` directory with a
 * `tsconfig.test.json` is checked, and one whose `test/` holds a source file but has no
 * `tsconfig.test.json` fails the command, because vitest would still run those tests untyped.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GROUPS = ['apps', 'packages'];
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

/** Whether a directory holds a source file, at any depth. */
function holdsSource(directory) {
  return readdirSync(directory, { recursive: true }).some(
    (name) => SOURCE.test(String(name)) && statSync(join(directory, String(name))).isFile(),
  );
}

/**
 * The test projects under a root (`projects`, relative paths of each `tsconfig.test.json`) and
 * the package directories whose `test/` has sources but no test project (`missing`).
 */
export function testProjects(root) {
  const projects = [];
  const missing = [];
  for (const group of GROUPS) {
    let names = [];
    try {
      names = readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const directory = `${group}/${name}`;
      const project = `${directory}/tsconfig.test.json`;
      if (existsSync(join(root, project))) projects.push(project);
      else if (
        existsSync(join(root, directory, 'test')) &&
        holdsSource(join(root, directory, 'test'))
      )
        missing.push(directory);
    }
  }
  return { projects, missing };
}

/** Checks each test project with this repository's `tsc`; returns the exit status. */
export function typecheckTests(root) {
  const { projects, missing } = testProjects(root);
  for (const directory of missing)
    console.error(
      `${directory}/test holds tests but ${directory} has no tsconfig.test.json: they would run untyped.`,
    );
  if (missing.length > 0) return 1;
  if (projects.length === 0) {
    console.error(
      'Found no tsconfig.test.json under apps/ or packages/: nothing would be checked.',
    );
    return 2;
  }
  const tsc = join(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin',
    'tsc',
  );
  let status = 0;
  for (const project of projects) {
    const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', project], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.status !== 0) status = 1;
  }
  return status;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root =
    process.argv[2] === undefined
      ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
      : resolve(process.argv[2]);
  process.exit(typecheckTests(root));
}
