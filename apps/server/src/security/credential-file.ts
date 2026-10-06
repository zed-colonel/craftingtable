import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PushoverCredentials {
  readonly applicationToken: string;
  readonly userKey: string;
}

interface CredentialFileContents {
  readonly version: 1;
  readonly pushover: Readonly<Record<string, PushoverCredentials>>;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file's contents, or undefined when they are not a credentials file of this version. */
function parseContents(value: unknown): CredentialFileContents | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.pushover)) return undefined;
  const pushover: Record<string, PushoverCredentials> = {};
  for (const [workspaceId, entry] of Object.entries(value.pushover)) {
    if (!isRecord(entry) || !isText(entry.applicationToken) || !isText(entry.userKey))
      return undefined;
    pushover[workspaceId] = { applicationToken: entry.applicationToken, userKey: entry.userKey };
  }
  return { version: 1, pushover };
}

/** Where a workspace's Pushover credentials are kept. */
export interface PushoverCredentialStore {
  pushover(workspaceId: string): PushoverCredentials | undefined;
  setPushover(workspaceId: string, credentials: PushoverCredentials | undefined): void;
}

/**
 * The daemon's credentials, in `credentials.json` under the operator's settings directory, mode
 * 0600 in a 0700 directory (R-G9; operator decision 2026-10-05): outside the database, so no
 * backup or copy of it carries them, and denied to every sandboxed agent command. Written whole
 * and renamed into place, so a reader never sees half a file.
 */
export class CredentialFile implements PushoverCredentialStore {
  constructor(private readonly directory: string) {}

  private get path(): string {
    return join(this.directory, 'credentials.json');
  }

  pushover(workspaceId: string): PushoverCredentials | undefined {
    return this.read().pushover[workspaceId];
  }

  setPushover(workspaceId: string, credentials: PushoverCredentials | undefined): void {
    const contents = this.read();
    const { [workspaceId]: _previous, ...others } = contents.pushover;
    this.write({
      ...contents,
      pushover: credentials === undefined ? others : { ...others, [workspaceId]: credentials },
    });
  }

  private read(): CredentialFileContents {
    if (!existsSync(this.path)) return { version: 1, pushover: {} };
    // A file someone made readable is made private again before it is read.
    chmodSync(this.path, 0o600);
    let contents: CredentialFileContents | undefined;
    try {
      contents = parseContents(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      contents = undefined;
    }
    if (contents === undefined)
      throw new Error(`${this.path} is not a credentials file this daemon can read`);
    return contents;
  }

  private write(contents: CredentialFileContents): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const next = `${this.path}.${process.pid}.tmp`;
    writeFileSync(next, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    chmodSync(next, 0o600);
    renameSync(next, this.path);
  }
}

/** Credentials held in memory, for a daemon built without a settings directory (tests). */
export class MemoryCredentials implements PushoverCredentialStore {
  private readonly held = new Map<string, PushoverCredentials>();
  pushover(workspaceId: string): PushoverCredentials | undefined {
    return this.held.get(workspaceId);
  }
  setPushover(workspaceId: string, credentials: PushoverCredentials | undefined): void {
    if (credentials === undefined) this.held.delete(workspaceId);
    else this.held.set(workspaceId, credentials);
  }
}
