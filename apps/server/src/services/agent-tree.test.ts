import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { AGENT_TREE_MAX_DEPTH, removeAgentTree } from './agent-tree.js';

/** apps/server's tsx, which runs this module in a child process. */
const serverTsx = resolve(fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url)));
const treeModule = resolve(fileURLToPath(new URL('.', import.meta.url)), 'agent-tree.ts');
/** Runs `removeAgentTree(path)` in a child: under a descriptor limit, or in a namespace. */
function removeInChild(launcher: readonly string[], path: string): string {
  const [command, ...args] = launcher;
  const output = execFileSync(
    command!,
    [
      ...args,
      serverTsx,
      '-e',
      `import(${JSON.stringify(treeModule)}).then(async (m) => console.log(JSON.stringify((await m.removeAgentTree(${JSON.stringify(path)})) ?? 'removed')))`,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  return JSON.parse(output.trim().split('\n').at(-1)!);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // coreutils walks by descriptor, so it also clears what a failed test left at any depth.
    execFileSync('chmod', ['-R', 'u+rwx', root]);
    execFileSync('rm', ['-rf', root]);
  }
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ct-agent-tree-'));
  roots.push(root);
  return root;
}

it('removes what an agent left whatever its modes: read-only directories, mode-000 entries (LIVE-31 review)', async () => {
  const root = scratch();
  const own = join(root, 'own');
  mkdirSync(join(own, 'claude-1000', 'locked', 'deeper'), { recursive: true });
  writeFileSync(join(own, 'claude-1000', 'locked', 'file'), 'x');
  writeFileSync(join(own, 'claude-1000', 'unreadable'), 'x');
  chmodSync(join(own, 'claude-1000', 'unreadable'), 0o000);
  chmodSync(join(own, 'claude-1000', 'locked', 'deeper'), 0o000);
  chmodSync(join(own, 'claude-1000', 'locked'), 0o500);
  await expect(removeAgentTree(own)).resolves.toBeUndefined();
  expect(existsSync(own)).toBe(false);
  // Already gone is done.
  await expect(removeAgentTree(own)).resolves.toBeUndefined();
});

it('never follows a link out of the tree: the target keeps its contents and modes (LIVE-31 verification)', async () => {
  const root = scratch();
  const outside = join(root, 'operator');
  mkdirSync(join(outside, 'kept'), { recursive: true });
  writeFileSync(join(outside, 'kept', 'file'), 'x');
  chmodSync(outside, 0o755);
  const own = join(root, 'own');
  mkdirSync(join(own, 'locked'), { recursive: true });
  // Beside and inside a directory the removal must reopen.
  symlinkSync(outside, join(own, 'locked', 'link'));
  symlinkSync(join(outside, 'kept', 'file'), join(own, 'file-link'));
  chmodSync(join(own, 'locked'), 0o500);
  await expect(removeAgentTree(own)).resolves.toBeUndefined();
  expect(existsSync(own)).toBe(false);
  expect(statSync(outside).mode & 0o777).toBe(0o755);
  expect(readdirSync(join(outside, 'kept'))).toEqual(['file']);
  // A tree that is itself a link: only the link goes.
  const link = join(root, 'own-link');
  symlinkSync(outside, link);
  await expect(removeAgentTree(link)).resolves.toBeUndefined();
  expect(existsSync(link)).toBe(false);
  expect(readdirSync(outside)).toEqual(['kept']);
});

it('removes a tree deeper than a path can name, with a read-only directory at its bottom (LIVE-31 verification)', async () => {
  const root = scratch();
  const own = join(root, 'own');
  mkdirSync(own);
  // What a command can make with relative mkdir and cd: 1100 levels, 5500 bytes, past PATH_MAX.
  execFileSync(
    'sh',
    [
      '-c',
      'for i in $(seq 1 1100); do mkdir aaaa && cd aaaa || exit 1; done; touch f; chmod 500 .',
    ],
    { cwd: own },
  );
  await expect(removeAgentTree(own)).resolves.toBeUndefined();
  expect(existsSync(own)).toBe(false);
});

it('reports a tree it cannot remove instead of throwing', async () => {
  const root = scratch();
  const own = join(root, 'own');
  mkdirSync(join(own, 'inside'), { recursive: true });
  // Its parent cannot be written, so the tree's own entry cannot go.
  chmodSync(root, 0o500);
  try {
    await expect(removeAgentTree(own)).resolves.toMatch(/EACCES/);
  } finally {
    chmodSync(root, 0o700);
  }
  rmSync(own, { recursive: true });
});

it('removes names that are not UTF-8, which a command can make (LIVE-31 verification)', async () => {
  const root = scratch();
  const own = join(root, 'own');
  mkdirSync(join(own, 'claude-1000'), { recursive: true });
  const name = Buffer.from([0xff, 0x66]);
  writeFileSync(Buffer.concat([Buffer.from(`${join(own, 'claude-1000')}/`), name]), 'x');
  mkdirSync(Buffer.concat([Buffer.from(`${own}/`), name]));
  await expect(removeAgentTree(own)).resolves.toBeUndefined();
  expect(existsSync(own)).toBe(false);
});

it('holds a bounded number of descriptors whatever the depth (LIVE-31 verification)', () => {
  const root = scratch();
  const own = join(root, 'own');
  mkdirSync(own);
  const levels = AGENT_TREE_MAX_DEPTH * 4 + 76;
  execFileSync(
    'sh',
    [
      '-c',
      `for i in $(seq 1 ${levels}); do mkdir aaaa && cd aaaa || exit 1; done; touch f; chmod 500 .`,
    ],
    { cwd: own },
  );
  // A process allowed fewer descriptors than the tree has levels, and that cannot raise it.
  const limit = AGENT_TREE_MAX_DEPTH + 100;
  expect(removeInChild(['prlimit', `--nofile=${limit}:${limit}`], own)).toBe('removed');
  expect(existsSync(own)).toBe(false);
});

it('removes a tree a stopped removal left with its subtrees moved up, past the bound again (LIVE-31 verification)', async () => {
  const root = scratch();
  const own = join(root, 'own');
  mkdirSync(own);
  // What an interrupted removal leaves: a moved-up subtree named as the next pass would name
  // its own move, itself deeper than the bound.
  const levels = AGENT_TREE_MAX_DEPTH + 44;
  mkdirSync(join(own, '.removing-0'));
  execFileSync(
    'sh',
    ['-c', `for i in $(seq 1 ${levels}); do mkdir a && cd a || exit 1; done; touch f`],
    { cwd: join(own, '.removing-0') },
  );
  await expect(removeAgentTree(own)).resolves.toBeUndefined();
  expect(existsSync(own)).toBe(false);
});

const userNamespaces = (() => {
  try {
    execFileSync('unshare', ['-rm', 'true']);
    return true;
  } catch {
    return false;
  }
})();

it.skipIf(!userNamespaces)(
  'removes the rest when one entry cannot go, and reports it (LIVE-31 verification)',
  () => {
    const root = scratch();
    const own = join(root, 'own');
    for (const name of ['a-first', 'm-mounted', 'z-last'])
      mkdirSync(join(own, name, 'inside'), { recursive: true });
    writeFileSync(join(own, 'z-last', 'inside', 'file'), 'x');
    // In a mount namespace of its own, a mount point cannot be removed: the one failing entry.
    const result = execFileSync(
      'unshare',
      [
        '-rm',
        'sh',
        '-c',
        `mount -t tmpfs none ${JSON.stringify(join(own, 'm-mounted'))} && "$@"`,
        'sh',
        serverTsx,
        '-e',
        `import(${JSON.stringify(treeModule)}).then(async (m) => console.log(JSON.stringify((await m.removeAgentTree(${JSON.stringify(own)})) ?? 'removed')))`,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    expect(JSON.parse(result.trim().split('\n').at(-1)!)).toMatch(/EBUSY/);
    // Its siblings, before and after it, are gone; only the mount point and the top remain.
    expect(readdirSync(own)).toEqual(['m-mounted']);
  },
);
