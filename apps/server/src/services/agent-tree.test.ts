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
  const module = resolve(fileURLToPath(new URL('.', import.meta.url)), 'agent-tree.ts');
  const tsx = resolve(fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url)));
  const result = execFileSync(
    'prlimit',
    [
      `--nofile=${AGENT_TREE_MAX_DEPTH + 100}:${AGENT_TREE_MAX_DEPTH + 100}`,
      tsx,
      '-e',
      `import(${JSON.stringify(module)}).then(async (m) => console.log(JSON.stringify(await m.removeAgentTree(${JSON.stringify(own)}) ?? 'removed')))`,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  expect(result.trim().split('\n').at(-1)).toBe('"removed"');
  expect(existsSync(own)).toBe(false);
});
