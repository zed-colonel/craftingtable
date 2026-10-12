import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  ClaudeCodeBackend,
  CLAUDE_SANDBOX_TMPDIR_LIMIT,
  resolveClaudeExecutable,
} from '../../src/claude-code/backend.js';

/**
 * The real Claude Code, launched as the daemon launches a run, runs one command in its command
 * sandbox (LIVE-31). Opt-in: it signs in with the operator's Claude login and costs a little, so
 * it runs only with `CRAFTINGTABLE_REAL_CLAUDE=1`:
 *
 *     CRAFTINGTABLE_REAL_CLAUDE=1 pnpm exec vitest run packages/agents/test/claude-code/sandbox-real.test.ts
 *
 * The run's scratch is as long as a live run's (78 bytes), which left the sandbox no room for its
 * sockets; the agent process gets the short directory the daemon makes for it.
 */
const real = process.env.CRAFTINGTABLE_REAL_CLAUDE === '1';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it.skipIf(!real)(
  'runs a command in the sandbox with a run-length scratch directory (LIVE-31)',
  async () => {
    const executable = resolveClaudeExecutable(process.env.CRAFTINGTABLE_CLAUDE_EXECUTABLE);
    expect(executable, 'claude on PATH').toBeDefined();
    const base = mkdtempSync(join(tmpdir(), 'ct-real-'));
    directories.push(base);
    const worktree = join(base, 'wt');
    mkdirSync(worktree);
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    // Padded so the scratch path is exactly as long as a live run's.
    const runs = join(base, 'runs');
    const scratch = join(
      runs,
      'x'.repeat(Math.max(1, 78 - Buffer.byteLength(join(runs, '/scratch')))),
      'scratch',
    );
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    expect(Buffer.byteLength(scratch)).toBeGreaterThanOrEqual(78);
    // As short as the daemon's `<data>/t/<12 hex>`, whatever the test's own TMPDIR is.
    const own = mkdtempSync('/tmp/ct-');
    directories.push(own);
    expect(Buffer.byteLength(own)).toBeLessThanOrEqual(CLAUDE_SANDBOX_TMPDIR_LIMIT);
    const cargoHome = join(base, 'cargo');
    mkdirSync(cargoHome);
    const session = await new ClaudeCodeBackend({
      executable: executable!,
      terminationGraceMs: 2000,
    }).launch({
      cwd: worktree,
      temporaryDirectory: scratch,
      processTemporaryDirectory: own,
      // As the daemon does: the run's directory, so its scratch is writable in the sandbox.
      additionalDirectories: [dirname(scratch)],
      environment: { TMPDIR: scratch, TMP: scratch, TEMP: scratch, CARGO_HOME: cargoHome },
      permissionMode: 'auto',
      model: 'haiku',
      prompt:
        'Run exactly this one Bash command, once, then reply with its output verbatim and nothing else: ' +
        'printf "TMPDIR=%s\\n" "$TMPDIR"; touch "$TMPDIR/ct-probe" && echo wrote-tmpdir; touch ct-probe && echo wrote-worktree',
      deadlineAt: new Date(Date.now() + 200_000).toISOString(),
    });
    const results: { content: string; isError: boolean }[] = [];
    const timer = setTimeout(() => session.kill(), 200_000);
    try {
      for await (const item of session.items) {
        if (item.type !== 'event') continue;
        if (item.event.kind === 'tool-result') results.push(item.event.payload);
        if (item.event.kind === 'turn-completed') session.end();
      }
    } finally {
      clearTimeout(timer);
      session.kill();
    }
    expect(results.length).toBeGreaterThan(0);
    // The sandbox started: no "Failed to create bridge sockets", and the command could write
    // its own temporary directory, beneath the short one, and the worktree.
    expect(results[0]).toMatchObject({ isError: false });
    // The command's TMPDIR is the run's scratch, as the brief says, and what it writes stays.
    expect(results[0]!.content).toContain(`TMPDIR=${scratch}\n`);
    expect(results[0]!.content).toContain('wrote-tmpdir');
    expect(results[0]!.content).toContain('wrote-worktree');
    expect(existsSync(join(scratch, 'ct-probe'))).toBe(true);
  },
);

it.skipIf(!real)(
  "denies Claude's file tools the shared list, by absolute and home-relative rule (operator decision 2026-10-12)",
  async () => {
    const executable = resolveClaudeExecutable(process.env.CRAFTINGTABLE_CLAUDE_EXECUTABLE);
    expect(executable, 'claude on PATH').toBeDefined();
    const base = mkdtempSync(join(tmpdir(), 'ct-real-'));
    directories.push(base);
    const worktree = join(base, 'wt');
    mkdirSync(worktree);
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    const allowed = join(worktree, 'allowed.txt');
    writeFileSync(allowed, 'allowed-text\n');
    // A denied file by its absolute path, and a file in a denied directory under the home. Both
    // lie where the run may otherwise read (its worktree, a directory added for it), so only the
    // deny rules refuse them: a read outside those directories is refused anyway.
    const absolute = join(worktree, 'denied-file.txt');
    writeFileSync(absolute, 'secret-absolute\n');
    const home = mkdtempSync(join(homedir(), '.cache-ct-real-deny-'));
    directories.push(home);
    const underHome = join(home, 'secret.txt');
    writeFileSync(underHome, 'secret-home\n');
    const own = mkdtempSync('/tmp/ct-');
    directories.push(own);
    const session = await new ClaudeCodeBackend({
      executable: executable!,
      terminationGraceMs: 2000,
    }).launch({
      cwd: worktree,
      temporaryDirectory: own,
      processTemporaryDirectory: own,
      readOnly: true,
      permissionMode: 'auto',
      model: 'haiku',
      additionalDirectories: [home],
      deniedReads: [absolute, `~/${relative(homedir(), home)}`],
      prompt:
        'Use the Read tool on each of these three files, one after another, even if one fails, ' +
        `then reply DONE: ${allowed} ${absolute} ${underHome}`,
      deadlineAt: new Date(Date.now() + 200_000).toISOString(),
    });
    const calls = new Map<string, string>();
    const results = new Map<string, { content: string; isError: boolean }>();
    const timer = setTimeout(() => session.kill(), 200_000);
    try {
      for await (const item of session.items) {
        if (item.type !== 'event') continue;
        if (item.event.kind === 'tool-call') {
          const input = item.event.payload.input as { file_path?: string };
          if (input.file_path) calls.set(input.file_path, item.event.payload.toolUseId);
        }
        if (item.event.kind === 'tool-result')
          results.set(item.event.payload.toolUseId, item.event.payload);
        if (item.event.kind === 'turn-completed') session.end();
      }
    } finally {
      clearTimeout(timer);
      session.kill();
    }
    const result = (path: string) => results.get(calls.get(path) ?? '');
    expect(result(allowed)).toMatchObject({ isError: false });
    expect(result(allowed)?.content).toContain('allowed-text');
    for (const [path, secret] of [
      [absolute, 'secret-absolute'],
      [underHome, 'secret-home'],
    ] as const) {
      expect(result(path), `a Read of ${path}`).toMatchObject({ isError: true });
      expect(result(path)?.content).not.toContain(secret);
    }
  },
);
