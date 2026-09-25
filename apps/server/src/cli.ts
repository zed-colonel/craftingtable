import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { inspectMigrationStatus, MigrationValidationError } from '@craftingtable/storage';
import { configFromEnv } from './config.js';
import { acquireInstanceLock, InstanceLockedError } from './instance-lock.js';
import { openDaemonStorage } from './persisted-records.js';
import { Argon2PasswordHasher } from './security/password-hasher.js';
import { BootstrapService } from './services/bootstrap-service.js';
import { BootstrapRefusedError } from './services/errors.js';
import { compactJournal, type RunCompaction } from './services/journal-compaction.js';
import { PasswordResetService } from './services/password-reset-service.js';
import { WorkspaceEventNotifier } from './services/workspace-event-notifier.js';

export interface ParsedCliCommand {
  readonly command: 'bootstrap' | 'reset-password' | 'db-migrate' | 'db-status' | 'compact-journal';
  readonly username?: string;
  /** compact-journal: rewrite the journal (otherwise a dry run), then reclaim space, and where bodies go. */
  readonly apply?: boolean;
  readonly vacuum?: boolean;
  readonly bodies?: string;
}

const COMPACT_USAGE = 'db compact-journal [--apply [--vacuum]] [--bodies <absolute directory>]';

export const SCHEMA_VALIDATION_EXIT_CODE = 4;

interface CliOutput {
  write(message: string): unknown;
}

export function parseCliArguments(args: readonly string[]): ParsedCliCommand {
  if (args[0] === 'admin' && (args[1] === 'bootstrap' || args[1] === 'reset-password')) {
    if (args.some((arg) => arg === '--password' || arg.startsWith('--password='))) {
      throw new Error('Passwords must never be provided as command-line arguments');
    }
    const usernameIndex = args.indexOf('--username');
    const username = usernameIndex >= 0 ? args[usernameIndex + 1] : undefined;
    if (
      username === undefined ||
      username.length === 0 ||
      args.length !== 4 ||
      usernameIndex !== 2
    ) {
      throw new Error(`Usage: craftingtable admin ${args[1]} --username <name>`);
    }
    return { command: args[1], username };
  }
  if (args.length === 2 && args[0] === 'db' && args[1] === 'migrate') {
    return { command: 'db-migrate' };
  }
  if (args.length === 2 && args[0] === 'db' && args[1] === 'status') {
    return { command: 'db-status' };
  }
  if (args[0] === 'db' && args[1] === 'compact-journal') {
    const rest = args.slice(2);
    const bodiesAt = rest.indexOf('--bodies');
    const bodies = bodiesAt >= 0 ? rest[bodiesAt + 1] : undefined;
    const flags =
      bodiesAt < 0 ? rest : rest.filter((_, index) => index !== bodiesAt && index !== bodiesAt + 1);
    if (
      flags.some((flag) => flag !== '--apply' && flag !== '--vacuum') ||
      (flags.includes('--vacuum') && !flags.includes('--apply')) ||
      (bodiesAt >= 0 && (bodies === undefined || !bodies.startsWith('/')))
    )
      throw new Error(`Usage: craftingtable ${COMPACT_USAGE}`);
    return {
      command: 'compact-journal',
      apply: flags.includes('--apply'),
      vacuum: flags.includes('--vacuum'),
      ...(bodies === undefined ? {} : { bodies }),
    };
  }
  throw new Error(
    `Usage: craftingtable admin <bootstrap|reset-password> --username <name> | db migrate | db status | ${COMPACT_USAGE}`,
  );
}

export async function readHiddenPassword(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || input.setRawMode === undefined) {
    throw new Error('Password entry requires an interactive terminal');
  }
  output.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const decoder = new StringDecoder('utf8');
    const restore = (): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write('\n');
    };
    const onError = (): void => {
      restore();
      reject(new Error('Password input interrupted'));
    };
    const onEnd = (): void => {
      restore();
      reject(new Error('Password input ended before confirmation'));
    };
    const onData = (chunk: Buffer): void => {
      for (const character of decoder.write(chunk)) {
        if (character === '\x03' || character === '\x04') {
          restore();
          reject(new Error('Canceled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          restore();
          resolve(password);
          return;
        }
        if (character === '\x7f' || character === '\b') {
          password = Array.from(password).slice(0, -1).join('');
          continue;
        }
        if (character === '\x15') {
          password = '';
          continue;
        }
        // Escape sequences (arrow keys, bracketed paste) are not password input.
        if (character < ' ') {
          restore();
          reject(new Error('Unsupported control character; type the password again'));
          return;
        }
        password += character;
        if (Buffer.byteLength(password, 'utf8') > 1024) {
          restore();
          reject(new Error('Password must not exceed 1024 UTF-8 bytes'));
          return;
        }
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
  });
}

function reportSchemaValidationError(error: unknown, stderr: CliOutput): number {
  if (!(error instanceof MigrationValidationError)) {
    throw error;
  }
  stderr.write(`schema invalid (${error.failure}): ${error.message}\n`);
  return SCHEMA_VALIDATION_EXIT_CODE;
}

export function runDatabaseCommand(
  command: 'db-status' | 'db-migrate',
  databasePath: string,
  output: { readonly stdout: CliOutput; readonly stderr: CliOutput } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  if (command === 'db-status') {
    try {
      const status = inspectMigrationStatus(databasePath);
      output.stdout.write(
        `schema ${status.currentVersion}/${status.supportedVersion}; pending: ${status.pendingVersions.join(', ') || 'none'}\n`,
      );
      return status.pendingVersions.length === 0 ? 0 : 2;
    } catch (error) {
      return reportSchemaValidationError(error, output.stderr);
    }
  }

  try {
    const storage = openDaemonStorage(databasePath);
    try {
      output.stdout.write(`schema migrated to version ${storage.migrationStatus.currentVersion}\n`);
      return 0;
    } finally {
      storage.close();
    }
  } catch (error) {
    return reportSchemaValidationError(error, output.stderr);
  }
}

/**
 * Journal compaction (R-H2), an operator maintenance command run with the daemon stopped.
 * Without `--apply` it reports what would change. Bodies go into each run's recorded
 * directory, or under `--bodies` (for a copy of a database whose run directories live
 * elsewhere). `--vacuum` then rebuilds the file to return the freed pages.
 */
export function runJournalCompaction(
  databasePath: string,
  options: { readonly apply: boolean; readonly vacuum: boolean; readonly bodies?: string },
  stdout: CliOutput = process.stdout,
): number {
  // Opening storage migrates it, which a dry run must not do; compaction also assumes the
  // current schema. The daemon's first start after a deploy (or `db migrate`) comes first.
  const status = inspectMigrationStatus(databasePath);
  if (status.pendingVersions.length > 0) {
    stdout.write(
      `The database is at schema ${status.currentVersion}/${status.supportedVersion}. Start the daemon once or run \`craftingtable db migrate\` before compacting; nothing was changed.\n`,
    );
    return 2;
  }
  const storage = openDaemonStorage(databasePath);
  try {
    const fileBytes = () => statSync(databasePath).size;
    const startBytes = fileBytes();
    const result = compactJournal(storage, {
      apply: options.apply,
      now: () => new Date(),
      bodyDirectory: (run) => {
        if (options.bodies !== undefined) return join(options.bodies, run.id);
        const recorded = storage.maintenance.directory(run.id)?.path;
        return recorded !== undefined && existsSync(recorded) ? recorded : undefined;
      },
    });
    const sum = (pick: (run: RunCompaction) => number) =>
      result.runs.reduce((total, run) => total + pick(run), 0);
    const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
    const median = (values: number[]) => {
      const sorted = values.toSorted((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    stdout.write(
      [
        `${result.applied ? 'Compacted' : 'Would compact'} ${result.runs.length} ended runs:`,
        `  raw lines dropped: ${sum((run) => run.rawCleared)}`,
        `  tool-result bodies moved to run directories: ${sum((run) => run.bodiesMoved)}`,
        `  bodies kept in the journal (no run directory): ${sum((run) => run.bodiesKept)}`,
        `  journal bytes of these runs: ${megabytes(sum((run) => run.bytesBefore))} -> ${megabytes(sum((run) => run.bytesAfter))}`,
        `  per run, median: ${megabytes(median(result.runs.map((run) => run.bytesBefore)))} -> ${megabytes(median(result.runs.map((run) => run.bytesAfter)))}`,
        '',
      ].join('\n'),
    );
    if (options.vacuum) {
      storage.vacuum();
      stdout.write(`File: ${megabytes(startBytes)} -> ${megabytes(fileBytes())} after VACUUM\n`);
    }
    return 0;
  } finally {
    storage.close();
  }
}

export async function runCli(args: readonly string[]): Promise<number> {
  const parsed = parseCliArguments(args);
  const config = configFromEnv();
  if (parsed.command === 'db-status') return runDatabaseCommand('db-status', config.databasePath);
  if (parsed.command === 'compact-journal') {
    // Compaction rewrites the journal; the daemon must not be writing it at the same time.
    let lock: Awaited<ReturnType<typeof acquireInstanceLock>>;
    try {
      lock = await acquireInstanceLock(config.dataDir);
    } catch (error) {
      if (!(error instanceof InstanceLockedError)) throw error;
      process.stderr.write(`${error.message} Stop it before compacting the journal.\n`);
      return 1;
    }
    try {
      process.stdout.write(`Journal compaction in ${config.databasePath}\n`);
      return runJournalCompaction(config.databasePath, {
        apply: parsed.apply === true,
        vacuum: parsed.vacuum === true,
        ...(parsed.bodies === undefined ? {} : { bodies: parsed.bodies }),
      });
    } finally {
      await lock.release();
    }
  }
  if (parsed.command === 'db-migrate') {
    // Migrating under a running daemon would change its schema beneath it.
    let lock: Awaited<ReturnType<typeof acquireInstanceLock>>;
    try {
      lock = await acquireInstanceLock(config.dataDir);
    } catch (error) {
      if (!(error instanceof InstanceLockedError)) throw error;
      process.stderr.write(`${error.message} Stop it before migrating.\n`);
      return 1;
    }
    try {
      return runDatabaseCommand('db-migrate', config.databasePath);
    } finally {
      await lock.release();
    }
  }

  if (parsed.command === 'reset-password') {
    if (!existsSync(config.databasePath))
      throw new Error(`Database does not exist: ${config.databasePath}`);
    process.stdout.write(`Resetting password in ${config.databasePath}\n`);
  }
  const firstPassword = await readHiddenPassword(
    parsed.command === 'reset-password' ? 'New password: ' : 'Password: ',
  );
  const secondPassword = await readHiddenPassword('Confirm password: ');
  if (firstPassword !== secondPassword) {
    throw new Error('Passwords do not match');
  }
  const storage = openDaemonStorage(config.databasePath);
  try {
    if (parsed.command === 'reset-password') {
      const result = await new PasswordResetService(storage, new Argon2PasswordHasher()).reset(
        parsed.username as string,
        firstPassword,
      );
      process.stdout.write(
        `Password reset for ${result.username}; revoked ${result.revokedSessionCount} session(s). Sign in with your new password.\n`,
      );
      return 0;
    }
    const service = new BootstrapService(
      storage,
      new Argon2PasswordHasher(),
      new WorkspaceEventNotifier(),
    );
    const result = await service.bootstrap(parsed.username as string, firstPassword);
    process.stdout.write(
      `Created user ${result.user.username} and workspace ${result.workspace.name}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BootstrapRefusedError) {
      process.stderr.write(`${error.message}\n`);
      return 3;
    }
    throw error;
  } finally {
    storage.close();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMain) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
    process.exitCode = 1;
  }
}
