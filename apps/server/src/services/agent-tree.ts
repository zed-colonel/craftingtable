import { constants } from 'node:fs';
import { chmod, lstat, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';

/** Linux's O_PATH, which Node does not name: a descriptor for the object, no permission needed. */
const O_PATH = 0o10000000;
/** A directory, never through a link in its last component, whatever its mode. */
const DIRECTORY_FLAGS = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/**
 * Directories held open at once (LIVE-31 verification): deeper subtrees are moved up beside the
 * top and removed from a queue, so a tree of any depth needs at most this many descriptors.
 */
export const AGENT_TREE_MAX_DEPTH = 256;

type Name = string | Buffer;

/**
 * Removes a tree an agent wrote, whatever it left (LIVE-31 review and verification): read-only
 * or mode-000 directories, links, names that are not UTF-8, and any depth. Each directory is
 * opened by an `O_PATH` descriptor without following a link, made the owner's through that
 * descriptor's `/proc/self/fd` link, and its entries, read as bytes, are reached as
 * `/proc/self/fd/<fd>/<name>`, so a link an agent plants or swaps in, even while the removal
 * runs, is only unlinked, never followed, and no path grows with the depth. Past
 * `AGENT_TREE_MAX_DEPTH` a subtree is renamed up into the top directory, which an agent cannot
 * write, and removed in turn. An entry that fails is passed over, the rest still go, and the
 * first failure is returned; an entry already gone is done. Asynchronous, so a large tree does
 * not hold the daemon. Never rejects. Linux only, as the daemon is.
 */
export async function removeAgentTree(path: string): Promise<string | undefined> {
  const failures: unknown[] = [];
  try {
    const top = await lstat(path).catch(gone);
    if (top === undefined) return undefined;
    if (!top.isDirectory()) {
      await unlink(path).catch(gone);
      return undefined;
    }
    const held = await openDirectory(path);
    if (held === undefined) {
      await unlink(path).catch(gone);
      return undefined;
    }
    try {
      const root = `/proc/self/fd/${held.fd}`;
      const walk: Walk = { root, moved: 0, queue: [], failures };
      await removeContents(root, 1, walk);
      // Subtrees moved up past the depth bound, until none is left.
      for (let next = walk.queue.shift(); next !== undefined; next = walk.queue.shift()) {
        try {
          await removeEntry(next, 1, walk);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      await held.close();
    }
    await rmdir(path).catch(gone);
  } catch (error) {
    failures.push(error);
  }
  return failures.length ? String(failures[0]) : undefined;
}

interface Walk {
  /** The top directory's descriptor link: moved subtrees go here. */
  readonly root: string;
  moved: number;
  readonly queue: Name[];
  readonly failures: unknown[];
}

/** An entry that is already gone is done; anything else is a failure. */
function gone(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  throw error;
}

function child(directory: string, name: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${directory}/`), name]);
}

/** Removes everything inside a held directory, passing over what fails. */
async function removeContents(directory: string, depth: number, walk: Walk): Promise<void> {
  await chmod(directory, 0o700);
  for (const name of await readdir(directory, { encoding: 'buffer' })) {
    try {
      await removeEntry(child(directory, name), depth, walk);
    } catch (error) {
      walk.failures.push(error);
    }
  }
}

async function removeEntry(path: Name, depth: number, walk: Walk): Promise<void> {
  const entry = await lstat(path).catch(gone);
  if (entry === undefined) return;
  if (!entry.isDirectory()) {
    await unlink(path).catch(gone);
    return;
  }
  if (depth >= AGENT_TREE_MAX_DEPTH) {
    // Moved up beside the top, where no agent writes; a rename follows no link.
    const moved = `${walk.root}/.removing-${walk.moved++}`;
    await rename(path, moved).catch(gone);
    walk.queue.push(moved);
    return;
  }
  const held = await openDirectory(path);
  if (held === undefined) {
    // Replaced by a link or file since: unlinked, never followed.
    await unlink(path).catch(gone);
    return;
  }
  try {
    await removeContents(`/proc/self/fd/${held.fd}`, depth + 1, walk);
  } finally {
    await held.close();
  }
  await rmdir(path).catch(gone);
}

/** The directory itself, or undefined if a link or file is there now, or nothing. */
async function openDirectory(path: Name) {
  try {
    return await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENOENT') return undefined;
    throw error;
  }
}
