import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  argumentsFor,
  createBoundedCommandRunner,
  readExecutableEvidence,
} from '../src/command-runner.js';
import { BASE_GIT_ENVIRONMENT, environmentFor } from '../src/environment.js';
import { parseIdentityOutcome, parseRiskSignalOutcome } from '../src/repository-inspector.js';
import { createRepositoryFixture, makeExecutableProxy } from './test-support.js';

async function runnerFor(
  executable: string,
  overrides: Partial<{
    commandTimeoutMs: number;
    stdoutLimitBytes: number;
    stderrLimitBytes: number;
    terminationGraceMs: number;
  }> = {},
) {
  const evidence = await readExecutableEvidence(executable);
  if (evidence === undefined) {
    throw new Error('proxy evidence unavailable');
  }
  return createBoundedCommandRunner(evidence, {
    commandTimeoutMs: 1000,
    stdoutLimitBytes: 16384,
    stderrLimitBytes: 1024,
    terminationGraceMs: 50,
    ...overrides,
  });
}

describe('closed Git command construction', () => {
  it('constructs exactly the three reviewed argv variants', () => {
    expect(argumentsFor({ kind: 'version', cwd: '/source' })).toEqual(['--version']);
    expect(
      argumentsFor({
        kind: 'identity',
        cwd: '/source/-repo',
        expectedTopLevel: '/source/-repo',
        expectedGitDirectory: '/source/-repo/.git',
        ancestorCandidates: [],
      }),
    ).toEqual([
      '-c',
      'core.fsmonitor=false',
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-common-dir',
      '--is-bare-repository',
      '--is-inside-work-tree',
      '--show-object-format=storage',
    ]);
    expect(argumentsFor({ kind: 'local-risk-signal-names', cwd: '/source/repository' })).toEqual([
      '-c',
      'core.fsmonitor=false',
      'config',
      '--local',
      '--no-includes',
      '--null',
      '--name-only',
      '--get-regexp',
      '^(extensions\\.worktreeconfig|core\\.(hookspath|fsmonitor|worktree)|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process)|include\\.path|includeif\\..*\\.path)$',
    ]);
  });

  it('keeps hostile user paths out of argv and constructs the environment from scratch', () => {
    const hostile = '/source/--upload-pack=$(touch should-not-run)\nrepo';
    const command = {
      kind: 'identity',
      cwd: hostile,
      expectedTopLevel: hostile,
      expectedGitDirectory: `${hostile}/.git`,
      ancestorCandidates: [],
    } as const;
    expect(argumentsFor(command).join('\0')).not.toContain(hostile);
    expect(environmentFor(command)).toEqual({
      ...BASE_GIT_ENVIRONMENT,
      GIT_CEILING_DIRECTORIES: dirname(hostile),
    });
    for (const key of [
      'HOME',
      'PATH',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'GIT_TRACE',
    ]) {
      expect(environmentFor(command)).not.toHaveProperty(key);
    }
  });
});

describe('bounded fixed process runner', () => {
  it('passes only the reviewed version argv and ten-field environment', async () => {
    const fixture = createRepositoryFixture();
    try {
      const proxy = makeExecutableProxy(
        fixture.root,
        'capture',
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env }));',
      );
      const runner = await runnerFor(proxy);
      const result = await runner.run({ kind: 'version', cwd: fixture.sourceRoot });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const capture = JSON.parse(result.outcome.stdout.toString('utf8'));
        expect(capture.argv).toEqual(['--version']);
        expect(capture.env).toEqual(BASE_GIT_ENVIRONMENT);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('enforces independent stdout and stderr overflow bounds', async () => {
    const fixture = createRepositoryFixture();
    try {
      const atBoundProxy = makeExecutableProxy(
        fixture.root,
        'stdout-at-bound',
        "process.stdout.write('1234');",
      );
      const atBoundRunner = await runnerFor(atBoundProxy, { stdoutLimitBytes: 4 });
      const atBound = await atBoundRunner.run({
        kind: 'version',
        cwd: fixture.sourceRoot,
      });
      expect(atBound.ok).toBe(true);
      if (atBound.ok) {
        expect(atBound.outcome.stdout.toString('utf8')).toBe('1234');
      }

      const stdoutProxy = makeExecutableProxy(
        fixture.root,
        'stdout-overflow',
        "process.stdout.write('12345');",
      );
      const stdoutRunner = await runnerFor(stdoutProxy, { stdoutLimitBytes: 4 });
      const stdout = await stdoutRunner.run({ kind: 'version', cwd: fixture.sourceRoot });
      expect(stdout.ok).toBe(false);
      if (!stdout.ok) {
        expect(stdout.error.code).toBe('stdout-overflow');
      }

      const stderrProxy = makeExecutableProxy(
        fixture.root,
        'stderr-overflow',
        "process.stderr.write('12345');",
      );
      const stderrRunner = await runnerFor(stderrProxy, { stderrLimitBytes: 4 });
      const stderr = await stderrRunner.run({ kind: 'version', cwd: fixture.sourceRoot });
      expect(stderr.ok).toBe(false);
      if (!stderr.ok) {
        expect(stderr.error.code).toBe('stderr-overflow');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('times out a TERM-resistant process and treats closed stdin as EOF', async () => {
    const fixture = createRepositoryFixture();
    try {
      const hanging = makeExecutableProxy(
        fixture.root,
        'hanging',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      );
      const hangingRunner = await runnerFor(hanging, {
        commandTimeoutMs: 100,
        terminationGraceMs: 50,
      });
      const timeout = await hangingRunner.run({ kind: 'version', cwd: fixture.sourceRoot });
      expect(timeout.ok).toBe(false);
      if (!timeout.ok) {
        expect(timeout.error.code).toBe('timed-out');
      }

      const prompt = makeExecutableProxy(
        fixture.root,
        'prompt',
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'));",
      );
      const promptRunner = await runnerFor(prompt);
      const eof = await promptRunner.run({ kind: 'version', cwd: fixture.sourceRoot });
      expect(eof.ok).toBe(true);
      if (eof.ok) {
        expect(eof.outcome.stdout.toString('utf8')).toBe('eof');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('aborts a running process and detects executable replacement before spawn', async () => {
    const fixture = createRepositoryFixture();
    try {
      const hanging = makeExecutableProxy(
        fixture.root,
        'abortable',
        'setInterval(() => {}, 1000);',
      );
      const hangingRunner = await runnerFor(hanging);
      const controller = new AbortController();
      const pending = hangingRunner.run(
        { kind: 'version', cwd: fixture.sourceRoot },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 50);
      const aborted = await pending;
      expect(aborted.ok).toBe(false);
      if (!aborted.ok) {
        expect(aborted.error.code).toBe('aborted');
      }

      const replaceable = makeExecutableProxy(
        fixture.root,
        'replaceable',
        "process.stdout.write('git version 2.54.0\\n');",
      );
      const replaceableRunner = await runnerFor(replaceable);
      appendFileSync(replaceable, '\n// replacement');
      const changed = await replaceableRunner.run({
        kind: 'version',
        cwd: fixture.sourceRoot,
      });
      expect(changed.ok).toBe(false);
      if (!changed.ok) {
        expect(changed.error.code).toBe('git-executable-changed');
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe('identity and risk-output discrimination', () => {
  const identityOutcome = (stdout: Buffer, stderr = Buffer.alloc(0), exitCode = 0) => ({
    commandKind: 'identity' as const,
    stdout,
    stderr,
    exitCode,
  });

  it('keeps exact raw-byte identity success newline-safe', () => {
    const top = '/source/repo\nwith-newline';
    const git = `${top}/.git`;
    const parsed = parseIdentityOutcome(
      identityOutcome(Buffer.from(`${top}\n${git}\n${git}\nfalse\ntrue\nsha1\n`)),
      top,
      git,
      [],
    );
    expect(parsed).toEqual({ ok: true, objectFormat: 'sha1' });
  });

  it('distinguishes repository class, object format, and malformed framing', () => {
    const top = '/source/repository';
    const git = `${top}/.git`;
    const cases = [
      [`${top}\n${git}\n${git}\ntrue\nfalse\nsha1\n`, 'not-primary-repository'],
      [`${top}\n${git}\n${git}\nfalse\ntrue\nsha512\n`, 'unsupported-object-format'],
      [`${top}\n${git}\n${git}\nfalse\ntrue\nsha1`, 'malformed-identity-output'],
    ] as const;
    for (const [stdout, code] of cases) {
      const parsed = parseIdentityOutcome(identityOutcome(Buffer.from(stdout)), top, git, []);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(code);
      }
    }
    const workTree = parseIdentityOutcome(
      identityOutcome(
        Buffer.alloc(0),
        Buffer.from('fatal: this operation must be run in a work tree\n'),
        128,
      ),
      top,
      git,
      [],
    );
    expect(workTree.ok).toBe(false);
    if (!workTree.ok) {
      expect(workTree.error.code).toBe('not-primary-repository');
    }
  });

  it('enforces feature framing, count, and byte-safe signal names', () => {
    const noMatch = parseRiskSignalOutcome({
      commandKind: 'local-risk-signal-names',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 1,
    });
    expect(noMatch).toEqual({ ok: true, signals: [] });

    const signals = parseRiskSignalOutcome({
      commandKind: 'local-risk-signal-names',
      stdout: Buffer.from('core.hookspath\0core.worktree\0'),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    });
    expect(signals).toEqual({
      ok: true,
      signals: ['core-hooks-path', 'core-worktree-redirection'],
    });

    const tooMany = parseRiskSignalOutcome({
      commandKind: 'local-risk-signal-names',
      stdout: Buffer.from(`${Array.from({ length: 257 }, () => 'core.hookspath').join('\0')}\0`),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.error.code).toBe('feature-count-exceeded');
    }

    const exitOneWithOutput = parseRiskSignalOutcome({
      commandKind: 'local-risk-signal-names',
      stdout: Buffer.from('unexpected'),
      stderr: Buffer.alloc(0),
      exitCode: 1,
    });
    expect(exitOneWithOutput.ok).toBe(false);
    if (!exitOneWithOutput.ok) {
      expect(exitOneWithOutput.error.code).toBe('malformed-feature-output');
    }

    const invalidUtf8 = parseRiskSignalOutcome({
      commandKind: 'local-risk-signal-names',
      stdout: Buffer.from([0xff, 0x00]),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    });
    expect(invalidUtf8.ok).toBe(false);
    if (!invalidUtf8.ok) {
      expect(invalidUtf8.error.code).toBe('invalid-output-encoding');
    }
  });
});
