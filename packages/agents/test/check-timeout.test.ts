import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asDeclaredCheckId, asRepositoryCheckDeclarationId } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkTimeLimit,
  OutputWatch,
  spoolLimitMs,
  TIMED_OUT_TAIL,
  timedOutDiagnostic,
} from '../src/check-timeout.js';
import {
  type CheckExecution,
  executeCheck,
  prepareCheckManifest,
  resolveGitDirectories,
} from '../src/local-check.js';
import type { CheckOnlyManifest } from '../src/pinned-cargo.js';
import { hostGit } from './host-tools-test-support.js';
import { testTimeScale } from './test-time.js';

/**
 * R-C17 part 1: a declared check may set its own time limit in `checks.json`, ending at its
 * step's deadline at the latest; without it, the run's limit applies as before. A check that
 * times out names what was still running: libtest's "has been running for over 60 seconds"
 * line, or the end of its log.
 */

const MINUTE = 60_000;

describe('a check’s time limit', () => {
  const now = 1_000_000;
  it.each([
    [
      'no limit of its own: the run’s, whatever the step has left',
      { manifestTimeoutMs: 20 * MINUTE, stepDeadline: now + MINUTE },
      20 * MINUTE,
      false,
    ],
    ['no limit of its own, none in the manifest: 30 minutes', {}, 30 * MINUTE, false],
    [
      'its own, inside the step',
      { manifestTimeoutMs: 30 * MINUTE, timeoutMinutes: 15, stepDeadline: now + 120 * MINUTE },
      15 * MINUTE,
      false,
    ],
    [
      'its own, past today’s 30-minute cap',
      { manifestTimeoutMs: 30 * MINUTE, timeoutMinutes: 45, stepDeadline: now + 120 * MINUTE },
      45 * MINUTE,
      false,
    ],
    [
      'its own, cut to what the step has left',
      { manifestTimeoutMs: 30 * MINUTE, timeoutMinutes: 15, stepDeadline: now + 5 * MINUTE },
      5 * MINUTE,
      true,
    ],
    ['its own, the step’s deadline passed', { timeoutMinutes: 15, stepDeadline: now - 1 }, 0, true],
    [
      'its own, a run with no step',
      { manifestTimeoutMs: 30 * MINUTE, timeoutMinutes: 45 },
      45 * MINUTE,
      false,
    ],
  ] as const)('%s', (_label, input, timeoutMs, stepLimited) => {
    expect(checkTimeLimit({ ...input, now })).toEqual({ timeoutMs, stepLimited });
  });

  it('bounds the launcher’s wait by the longest limit a check of the run may have', () => {
    expect(spoolLimitMs({ checkTimeoutMs: 30 * MINUTE })).toBe(35 * MINUTE);
    expect(spoolLimitMs({})).toBe(35 * MINUTE);
    const declared = (minutes: (number | undefined)[]) => ({
      declarationId: asRepositoryCheckDeclarationId(randomUUID()),
      version: 1,
      checks: minutes.map((timeoutMinutes, i) => ({
        id: asDeclaredCheckId(`c${i}`),
        argv: ['true'],
        definitionPaths: [],
        definitionDigests: {},
        ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
      })),
    });
    expect(
      spoolLimitMs({ checkTimeoutMs: 30 * MINUTE, declaredChecks: declared([undefined, 10]) }),
    ).toBe(35 * MINUTE);
    expect(spoolLimitMs({ checkTimeoutMs: 30 * MINUTE, declaredChecks: declared([45, 10]) })).toBe(
      50 * MINUTE,
    );
  });
});

describe('what a timed-out check was still running', () => {
  it('keeps the last libtest still-running line, across output chunks', () => {
    const watch = new OutputWatch();
    watch.push('running 3 tests\ntest a ... ok\ntest slow_one has been running for over 60 seco');
    watch.push('nds\ntest b ... ok\n');
    expect(watch.stillRunning).toBe('test slow_one has been running for over 60 seconds');
    watch.push('test slow_two has been running for over 60 seconds\nprogress\n');
    expect(watch.stillRunning).toBe('test slow_two has been running for over 60 seconds');
  });

  it('keeps a still-running line long after it scrolled out of the tail, and reads an unfinished last line', () => {
    const watch = new OutputWatch();
    watch.push('test hung has been running for over 60 seconds\n');
    for (let i = 0; i < 2000; i++) watch.push(`noise line ${i}\n`);
    expect(watch.stillRunning).toBe('test hung has been running for over 60 seconds');
    const unfinished = new OutputWatch();
    unfinished.push('test last has been running for over 60 seconds');
    expect(unfinished.stillRunning).toBe('test last has been running for over 60 seconds');
  });

  it('names the still-running test, and how long the check had', () => {
    const watch = new OutputWatch();
    watch.push(
      '\u001b[32mtest flow_capacity_is_enforced has been running for over 60 seconds\u001b[0m\n',
    );
    expect(timedOutDiagnostic(watch, 15 * MINUTE, false)).toBe(
      'Check timed out after 15 minutes. Still running: test flow_capacity_is_enforced has been running for over 60 seconds',
    );
    expect(timedOutDiagnostic(watch, 5.5 * MINUTE, true)).toBe(
      'Check timed out after 5.5 minutes, the time its step had left. Still running: test flow_capacity_is_enforced has been running for over 60 seconds',
    );
  });

  it('otherwise quotes the end of its log, bounded', () => {
    const watch = new OutputWatch();
    for (let i = 1; i <= 40; i++) watch.push(`line ${i}\n`);
    watch.push(`${'x'.repeat(5000)}\n\n`);
    const diagnostic = timedOutDiagnostic(watch, 2_000, false);
    expect(diagnostic.startsWith('Check timed out after 2 seconds. The end of its log:\n')).toBe(
      true,
    );
    const quoted = diagnostic.split('\n').slice(1);
    expect(quoted.length).toBeLessThanOrEqual(TIMED_OUT_TAIL.lines);
    expect(quoted.at(-1)?.startsWith('  xxx')).toBe(true);
    expect(quoted.at(-2)).toBe('  line 40');
    expect(diagnostic).not.toContain('line 1\n');
    expect(diagnostic.length).toBeLessThanOrEqual(TIMED_OUT_TAIL.chars + 200);
    expect(timedOutDiagnostic(new OutputWatch(), 2_000, false)).toBe(
      'Check timed out after 2 seconds. It printed nothing.',
    );
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync(hostGit(), args, { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** A repository with one declared check, `c`, running `script`, held to by a check-only run. */
function fixture(script: string, timeoutMinutes?: number) {
  const root = mkdtempSync(join(tmpdir(), 'ct-check-timeout-'));
  roots.push(root);
  const workspacePath = join(root, 'repository');
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, 'check.sh'), script, { mode: 0o755 });
  git(['init', '-q', '-b', 'main'], workspacePath);
  git(['add', '.'], workspacePath);
  git(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c'],
    workspacePath,
  );
  const m: CheckOnlyManifest = {
    kind: 'checks',
    runId: 'run',
    gitExecutable: hostGit(),
    ...resolveGitDirectories(hostGit(), workspacePath),
    workspacePath,
    declaredChecks: {
      declarationId: asRepositoryCheckDeclarationId(randomUUID()),
      version: 1,
      checks: [
        {
          id: asDeclaredCheckId('c'),
          argv: ['./check.sh'],
          definitionPaths: ['check.sh'],
          definitionDigests: { 'check.sh': sha256(script) },
          ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
        },
      ],
    },
  };
  const directory = join(root, 'run', 'checks');
  const prepared = prepareCheckManifest(directory, m, {
    directory: join(directory, 'requests'),
    replies: join(root, 'daemon', 'replies'),
    limitMs: 60_000,
  });
  // No Cargo on PATH: the host this manifest is for may have none.
  const bin = join(root, 'no-cargo-bin');
  mkdirSync(bin);
  for (const tool of ['sh', 'env', 'git', 'sleep', 'seq', 'echo', 'true'])
    for (const directory of ['/usr/bin', '/bin'])
      if (existsSync(join(directory, tool)) && !existsSync(join(bin, tool)))
        symlinkSync(join(directory, tool), join(bin, tool));
  const execute = async (overrides: Partial<CheckExecution> = {}) => {
    let output = '';
    const logPath = join(root, 'daemon', 'logs', `${randomUUID()}.log`);
    const started = Date.now();
    const outcome = await executeCheck({
      tool: 'ct-check',
      manifestPath: prepared.manifestPath,
      manifestDigest: prepared.manifestDigest,
      manifest: prepared.manifest,
      args: ['--declared', 'c'],
      logPath,
      logReference: 'check-logs/run/c.log',
      privateDirectory: join(root, 'daemon', `${randomUUID()}.private`),
      declaredTargetDirectory: join(root, 'daemon', 'declared-target'),
      confinement: 'none',
      unitName: 'unused',
      writablePaths: [workspacePath],
      environment: { PATH: bin },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
      ...overrides,
    });
    return {
      ...outcome,
      output,
      elapsed: Date.now() - started,
      log: readFileSync(logPath, 'utf8'),
    };
  };
  return { execute };
}

describe('a declared check with its own time limit', () => {
  it('ends at the step’s deadline and names the test still running', async () => {
    const f = fixture(
      '#!/bin/sh\necho "running 2 tests"\necho "test quick ... ok"\necho "test flow_capacity_is_enforced has been running for over 60 seconds"\nexec sleep 600\n',
      1,
    );
    const outcome = await f.execute({ stepDeadline: Date.now() + 1_500 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.elapsed).toBeLessThan(20_000 * testTimeScale());
    expect(outcome.diagnostic).toMatch(
      /^Check timed out after [\d.]+ seconds?, the time its step had left\. Still running: test flow_capacity_is_enforced has been running for over 60 seconds$/,
    );
    expect(outcome.receipt).toMatchObject({
      success: false,
      exitCode: null,
      diagnostic: outcome.diagnostic,
    });
    expect(outcome.log).toContain(outcome.diagnostic);
  });

  it('otherwise names the end of its log', async () => {
    const f = fixture(
      '#!/bin/sh\nfor i in $(seq 1 40); do echo "step $i"; done\nexec sleep 600\n',
      1,
    );
    const outcome = await f.execute({ stepDeadline: Date.now() + 1_500 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.diagnostic).toContain('The end of its log:\n');
    expect(outcome.diagnostic).toContain('  step 40');
    expect(outcome.diagnostic).not.toContain('  step 1\n');
  });

  it('without a limit of its own keeps the run’s limit, past the step’s deadline', async () => {
    const f = fixture('#!/bin/sh\nsleep 1\necho finished\n');
    const outcome = await f.execute({ stepDeadline: Date.now() + 100 });
    expect(outcome.exitCode, outcome.diagnostic).toBe(0);
    expect(outcome.output).toContain('finished');
  });
});
