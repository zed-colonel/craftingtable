/**
 * The request spool between a run's check launchers and the daemon (R-G4, SEC-01).
 *
 * A launcher on the agent's PATH does not run the check. It leaves a request in its run's
 * spool directory and relays what the daemon writes back. The daemon runs the command in its
 * own supervised process, outside the agent's process tree, and records the receipt in its
 * database; nothing the agent can write is read as a receipt. Files, not a socket: a Codex
 * sandbox without network cannot connect to any Unix socket, but can write inside its roots.
 *
 * Per request `<id>`: the launcher writes `<id>.request` into the spool (atomically, by
 * rename); the daemon claims it by renaming it to `<id>.claimed`. The daemon answers in a reply
 * directory of its own, outside every writable root of the run, so the agent can read the
 * answer but cannot redirect where the daemon writes it: it appends output to `<id>.out` and
 * finally writes `<id>.exit`. The launcher asks for cancellation with `<id>.cancel` in the spool.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const CHECK_TOOLS = ['ct-check', 'ct-act', 'ct-native', 'cargo'] as const;
export type CheckTool = (typeof CHECK_TOOLS)[number];

export interface CheckRequest {
  readonly version: 1;
  readonly tool: CheckTool;
  readonly args: readonly string[];
}

/** What a request may weigh, and how many arguments it may carry. */
const REQUEST_LIMIT_BYTES = 64 * 1024;
const ARGUMENT_LIMIT = 512;
const ID_PATTERN = /^[A-Za-z0-9-]{8,80}$/;
const path = (spool: string, id: string, suffix: string) => join(spool, `${id}.${suffix}`);

/* --------------------------------- launcher --------------------------------- */

/**
 * Leaves one request and relays the daemon's output until it reports an exit code. A request
 * the daemon has not claimed within `claimMs` fails: the daemon is stopped or does not serve
 * this run. `limitMs` bounds the whole wait; the daemon enforces the check's own time limit.
 */
export async function submitCheck(
  spool: string,
  replies: string,
  tool: CheckTool,
  args: readonly string[],
  limitMs: number,
  claimMs = 30_000,
  pollMs = 200,
): Promise<void> {
  const id = randomUUID();
  const request: CheckRequest = { version: 1, tool, args };
  const staged = path(spool, id, 'staged');
  writeFileSync(staged, JSON.stringify(request), { mode: 0o600 });
  renameSync(staged, path(spool, id, 'request'));
  let cancelledAt: number | undefined;
  const cancel = () => {
    if (cancelledAt !== undefined) return;
    cancelledAt = Date.now();
    try {
      writeFileSync(path(spool, id, 'cancel'), '', { mode: 0o600 });
    } catch {
      /* the daemon stops the check with the run in any case */
    }
  };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  const started = Date.now();
  let offset = 0;
  const relay = () => {
    const out = path(replies, id, 'out');
    if (!existsSync(out)) return;
    const size = statSync(out).size;
    if (size <= offset) return;
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(out, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
      closeSync(fd);
    }
    offset = size;
    process.stdout.write(buffer);
  };
  try {
    for (;;) {
      relay();
      const exit = path(replies, id, 'exit');
      if (existsSync(exit)) {
        relay();
        const result = JSON.parse(readFileSync(exit, 'utf8')) as {
          exitCode: number;
          diagnostic?: string;
        };
        if (result.diagnostic) console.error(result.diagnostic);
        process.exitCode = result.exitCode;
        return;
      }
      const elapsed = Date.now() - started;
      if (existsSync(path(spool, id, 'request')) && elapsed > claimMs) {
        console.error('CraftingTable did not pick up this check; the daemon may be stopped.');
        process.exitCode = 1;
        return;
      }
      // Interrupted: give the daemon a moment to stop the check and answer, then leave.
      if (cancelledAt !== undefined && Date.now() - cancelledAt > 10_000) {
        process.exitCode = 143;
        return;
      }
      if (elapsed > limitMs) {
        cancel();
        console.error('CraftingTable did not report this check within its time limit.');
        process.exitCode = 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
}

/* ---------------------------------- daemon ---------------------------------- */

/** Requests waiting in a spool, oldest name first. */
export function pendingCheckRequests(spool: string): string[] {
  let names: string[];
  try {
    names = readdirSync(spool);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.request'))
    .map((name) => name.slice(0, -'.request'.length))
    .filter((id) => ID_PATTERN.test(id))
    .sort();
}

/**
 * Takes one request so no other pass handles it. Returns undefined when another pass took it
 * first, and a reason when the request is malformed; the reason is answered to the launcher.
 */
export function claimCheckRequest(
  spool: string,
  id: string,
): { readonly request: CheckRequest } | { readonly refused: string } | undefined {
  if (!ID_PATTERN.test(id)) return { refused: 'Invalid check request.' };
  const claimed = path(spool, id, 'claimed');
  try {
    renameSync(path(spool, id, 'request'), claimed);
  } catch {
    return undefined;
  }
  let fd: number | undefined;
  try {
    // The agent owns the spool: never follow a link or block on a FIFO it left there.
    fd = openSync(claimed, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > REQUEST_LIMIT_BYTES)
      return { refused: 'Invalid check request.' };
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, buffer.length, 0);
    const value = JSON.parse(buffer.toString('utf8')) as Partial<CheckRequest>;
    if (
      value.version !== 1 ||
      !CHECK_TOOLS.includes(value.tool as CheckTool) ||
      !Array.isArray(value.args) ||
      value.args.length > ARGUMENT_LIMIT ||
      !value.args.every((a) => typeof a === 'string' && !a.includes('\0'))
    )
      return { refused: 'Invalid check request.' };
    return { request: { version: 1, tool: value.tool as CheckTool, args: [...value.args] } };
  } catch {
    return { refused: 'Invalid check request.' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A new file in the spool, created by the daemon alone: never an existing file or link. */
const createExclusive = (file: string) =>
  openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );

/**
 * The daemon's answer to one claimed request: relayed output, then the exit code, in the
 * daemon's reply directory. Every file it writes there is created exclusively and without
 * following links.
 */
export class CheckReply {
  private readonly spool: string;
  private readonly replies: string;
  private readonly id: string;
  private out: number | undefined;
  private failed = false;
  // Plain fields: launchers load this module through Node's type stripping.
  constructor(spool: string, replies: string, id: string) {
    this.spool = spool;
    this.replies = replies;
    this.id = id;
  }
  write(text: string): void {
    if (this.failed) return;
    try {
      this.out ??= createExclusive(path(this.replies, this.id, 'out'));
      writeSync(this.out, text);
    } catch {
      // Output relay is best effort; the retained log is the daemon's.
      this.failed = true;
    }
  }
  cancelRequested(): boolean {
    try {
      return lstatSync(path(this.spool, this.id, 'cancel')) !== undefined;
    } catch {
      return false;
    }
  }
  finish(exitCode: number, diagnostic?: string): void {
    if (this.out !== undefined) closeSync(this.out);
    this.out = undefined;
    const staged = path(this.replies, this.id, `exit-${randomUUID()}`);
    try {
      const fd = createExclusive(staged);
      try {
        writeSync(fd, JSON.stringify({ exitCode, ...(diagnostic ? { diagnostic } : {}) }));
      } finally {
        closeSync(fd);
      }
      renameSync(staged, path(this.replies, this.id, 'exit'));
    } catch {
      /* the run ended and its directory went with it */
    }
  }
}
