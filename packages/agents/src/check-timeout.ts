import type { ManifestDeclaredChecks } from '@craftingtable/domain';

/**
 * A check's time limit and what it says when the limit passes (R-C17 part 1, found live
 * 2026-10-16: a remediation made one Rust test far slower, and every run of the suite ended
 * "Check interrupted or timed out." at the 30-minute cap, naming nothing).
 */

const MINUTE = 60_000;
/** The limit of a check whose manifest names none, as before. */
const DEFAULT_CHECK_TIMEOUT_MS = 30 * MINUTE;
/** How long a launcher waits past the longest limit for the daemon's answer, as before. */
const LAUNCHER_GRACE_MS = 5 * MINUTE;

/**
 * How long a check may run: a declared check's own `timeoutMinutes`, ending at its step's
 * deadline at the latest (`stepLimited` then says the step cut it); without one, the run's limit
 * (`manifestTimeoutMs`), as before, whatever the step has left. A run no cycle's step owns has
 * no `stepDeadline`.
 */
export function checkTimeLimit(input: {
  readonly manifestTimeoutMs?: number;
  readonly timeoutMinutes?: number;
  readonly stepDeadline?: number;
  readonly now: number;
}): { readonly timeoutMs: number; readonly stepLimited: boolean } {
  if (input.timeoutMinutes === undefined)
    return { timeoutMs: input.manifestTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, stepLimited: false };
  const own = input.timeoutMinutes * MINUTE;
  if (input.stepDeadline === undefined || input.stepDeadline - input.now >= own)
    return { timeoutMs: own, stepLimited: false };
  return { timeoutMs: Math.max(0, input.stepDeadline - input.now), stepLimited: true };
}

/**
 * How long a run's launcher waits for the daemon's answer: past the longest limit any of its
 * checks may have, its own declared ones included, so a launcher never gives up (and cancels) a
 * check the daemon is still allowed to run.
 */
export function spoolLimitMs(manifest: {
  readonly checkTimeoutMs?: number;
  readonly declaredChecks?: Pick<ManifestDeclaredChecks, 'checks'>;
}): number {
  const own = (manifest.declaredChecks?.checks ?? []).map((c) => (c.timeoutMinutes ?? 0) * MINUTE);
  return Math.max(manifest.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, ...own) + LAUNCHER_GRACE_MS;
}

/** How much of a timed-out check's log its diagnostic quotes. */
export const TIMED_OUT_TAIL = { lines: 10, chars: 2000, lineChars: 300 } as const;

/** The output kept to find its last lines: well past what the diagnostic quotes. */
const TAIL_KEPT_CHARS = 64 * 1024;
/** The longest unfinished line kept while it waits for its end. */
const LINE_KEPT_CHARS = 8 * 1024;

/**
 * libtest's lines, which `cargo test` prints: its notice for a test still running after 60
 * seconds, a test's result, and the header of each test binary's run (doc-tests included). They
 * only choose what a diagnostic quotes; nothing is decided on them.
 */
const STILL_RUNNING = /\btest (.+?) has been running for over 60 seconds/;
// A doc-test's name has spaces: `src/lib.rs - queue::Queue::push (line 12)`.
const TEST_RESULT = /\btest (.+?) \.\.\. (?:ok|FAILED|ignored)\b/;
const RUN_START = /^running \d+ tests?$/;
/** The most tests a watch tracks as still running at once. */
const RUNNING_KEPT = 64;
/** The other still-running tests a diagnostic names beside the last. */
const OTHERS_NAMED = 5;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes are removed
const TERMINAL_CODES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Which of a check's output streams a chunk came from. */
export type OutputStream = 'out' | 'err';

/**
 * Watches a check's output as it arrives: the tests libtest reported running over 60 seconds that
 * have reported no result since (a binary's next run starts them afresh), and the end of the
 * output, both bounded however much it prints. Each stream keeps its own unfinished line, so one
 * stream's chunk cannot split the other's line.
 */
export class OutputWatch {
  /** Still-running tests, oldest first: each test's name and its notice, without colour codes. */
  private readonly running = new Map<string, string>();
  private tail = '';
  private readonly line: Record<OutputStream, string> = { out: '', err: '' };

  /** The last notice of a test that has reported no result since. */
  get stillRunning(): string | undefined {
    return [...this.running.values()].at(-1);
  }

  /** The other still-running tests, newest first. */
  get othersRunning(): string[] {
    return [...this.running.keys()].reverse().slice(1);
  }

  push(text: string, stream: OutputStream = 'out'): void {
    this.tail = `${this.tail}${text}`.slice(-TAIL_KEPT_CHARS);
    const lines = `${this.line[stream]}${text}`.split(/\r\n|\r|\n/);
    this.line[stream] = (lines.pop() ?? '').slice(-LINE_KEPT_CHARS);
    for (const line of lines) this.read(line);
    this.read(this.line[stream]);
  }

  /** The last non-blank lines of the output, each and all bounded, without colour codes. */
  lastLines(): string[] {
    const lines = this.tail
      .replace(TERMINAL_CODES, '')
      .split(/\r\n|\r|\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '')
      .slice(-TIMED_OUT_TAIL.lines)
      .map((line) =>
        line.length > TIMED_OUT_TAIL.lineChars
          ? `${line.slice(0, TIMED_OUT_TAIL.lineChars)}…`
          : line,
      );
    let total = 0;
    const kept: string[] = [];
    for (const line of lines.reverse()) {
      total += line.length + 3;
      if (total > TIMED_OUT_TAIL.chars) break;
      kept.unshift(line);
    }
    return kept;
  }

  /** One line, finished or not yet: reading it again when it grows changes nothing it read. */
  private read(line: string): void {
    const clean = line.replace(TERMINAL_CODES, '').trim();
    if (RUN_START.test(clean)) {
      this.running.clear();
      return;
    }
    const result = TEST_RESULT.exec(clean);
    if (result) {
      this.running.delete(result[1]!);
      return;
    }
    const found = STILL_RUNNING.exec(clean);
    if (!found) return;
    this.running.delete(found[1]!);
    this.running.set(found[1]!, found[0]);
    if (this.running.size > RUNNING_KEPT) this.running.delete(this.running.keys().next().value!);
  }
}

function duration(ms: number): string {
  if (ms < MINUTE) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(ms / 6000) / 10;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * A timed-out check's diagnostic: how long it had (and whether its step's deadline cut that), then
 * the test still running, or else the end of its log.
 */
export function timedOutDiagnostic(
  watch: OutputWatch,
  timeoutMs: number,
  stepLimited: boolean,
): string {
  const limit = `Check timed out after ${duration(timeoutMs)}${stepLimited ? ', the time its step had left' : ''}.`;
  if (watch.stillRunning) {
    const others = watch.othersRunning;
    const named = others.slice(0, OTHERS_NAMED).map((name) => name.slice(0, 200));
    return `${limit} Still running: ${watch.stillRunning}${
      others.length
        ? `; also still running: ${named.join(', ')}${others.length > named.length ? `, and ${others.length - named.length} more` : ''}`
        : ''
    }`;
  }
  const lines = watch.lastLines();
  return lines.length
    ? `${limit} The end of its log:\n${lines.map((line) => `  ${line}`).join('\n')}`
    : `${limit} It printed nothing.`;
}
