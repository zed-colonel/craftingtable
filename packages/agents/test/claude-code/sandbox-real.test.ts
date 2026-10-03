import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
 *     CRAFTINGTABLE_REAL_CLAUDE=1 pnpm exec vitest run packages/agents/src/claude-code/sandbox-real.test.ts
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
