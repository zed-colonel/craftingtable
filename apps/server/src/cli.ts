import { openDatabase, migrationStatus, openCraftingTableStorage } from '@craftingtable/storage';
import { configFromEnv } from './config.js';
import { Argon2PasswordHasher } from './security/password-hasher.js';
import { BootstrapService } from './services/bootstrap-service.js';
import { BootstrapRefusedError } from './services/errors.js';
import { WorkspaceEventNotifier } from './services/workspace-event-notifier.js';

export interface ParsedCliCommand {
  readonly command: 'bootstrap' | 'db-migrate' | 'db-status';
  readonly username?: string;
}

export function parseCliArguments(args: readonly string[]): ParsedCliCommand {
  if (args[0] === 'admin' && args[1] === 'bootstrap') {
    if (args.includes('--password')) {
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
      throw new Error('Usage: craftingtable admin bootstrap --username <name>');
    }
    return { command: 'bootstrap', username };
  }
  if (args.length === 2 && args[0] === 'db' && args[1] === 'migrate') {
    return { command: 'db-migrate' };
  }
  if (args.length === 2 && args[0] === 'db' && args[1] === 'status') {
    return { command: 'db-status' };
  }
  throw new Error(
    'Usage: craftingtable admin bootstrap --username <name> | db migrate | db status',
  );
}

export async function readHiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error('Password bootstrap requires an interactive terminal');
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const restore = (): void => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          restore();
          reject(new Error('Canceled'));
          return;
        }
        if (byte === 13 || byte === 10) {
          restore();
          resolve(password);
          return;
        }
        if (byte === 127 || byte === 8) {
          password = password.slice(0, -1);
          continue;
        }
        password += Buffer.from([byte]).toString('utf8');
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function runCli(args: readonly string[]): Promise<number> {
  const parsed = parseCliArguments(args);
  const config = configFromEnv();
  if (parsed.command === 'db-status') {
    const database = openDatabase(config.databasePath);
    try {
      const status = migrationStatus(database);
      process.stdout.write(
        `schema ${status.currentVersion}/${status.supportedVersion}; pending: ${status.pendingVersions.join(', ') || 'none'}\n`,
      );
      return status.pendingVersions.length === 0 ? 0 : 2;
    } finally {
      database.close();
    }
  }

  if (parsed.command === 'db-migrate') {
    const storage = openCraftingTableStorage(config.databasePath);
    try {
      process.stdout.write(
        `schema migrated to version ${storage.migrationStatus.currentVersion}\n`,
      );
      return 0;
    } finally {
      storage.close();
    }
  }

  const firstPassword = await readHiddenPassword('Password: ');
  const secondPassword = await readHiddenPassword('Confirm password: ');
  if (firstPassword !== secondPassword) {
    throw new Error('Passwords do not match');
  }
  const storage = openCraftingTableStorage(config.databasePath);
  try {
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
