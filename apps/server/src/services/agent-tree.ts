import { constants } from 'node:fs';
import { chmod, lstat, open, readdir, rmdir, unlink } from 'node:fs/promises';

/** Linux's O_PATH, which Node does not name: a descriptor for the object, no permission needed. */
const O_PATH = 0o10000000;
/** A directory, never through a link in its last component, whatever its mode. */
const DIRECTORY_FLAGS = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * Removes a tree an agent wrote, whatever it left (LIVE-31 review and verification): read-only
 * or mode-000 directories, links, and depths past what a path can name. Each directory is
 * opened by an `O_PATH` descriptor without following a link, made the owner's through that
 * descriptor's `/proc/self/fd` link, and its entries are reached as `/proc/self/fd/<fd>/<name>`,
 * so a link an agent plants or swaps in, even while the removal runs, is only unlinked, never
 * followed, and no path grows with the depth. Asynchronous, so a large tree does not hold the daemon. Resolves to why the removal
 * failed, or undefined; never rejects. Linux only, as the daemon is.
 */
export async function removeAgentTree(path: string): Promise<string | undefined> {
  try {
    await removeEntry(path);
    return undefined;
  } catch (error) {
    return String(error);
  }
}

async function removeEntry(path: string): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!entry.isDirectory()) {
    await unlink(path);
    return;
  }
  const directory = await openDirectory(path);
  if (directory === undefined) {
    // Replaced by a link or file since: unlinked, never followed.
    await unlink(path);
    return;
  }
  try {
    // Through the descriptor's own link, which names this object and no other.
    const inside = `/proc/self/fd/${directory.fd}`;
    await chmod(inside, 0o700);
    for (const name of await readdir(inside)) await removeEntry(`${inside}/${name}`);
  } finally {
    await directory.close();
  }
  await rmdir(path);
}

/** The directory itself, or undefined if a link or file is there now. */
async function openDirectory(path: string) {
  try {
    return await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}
