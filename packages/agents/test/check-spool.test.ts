import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CheckReply, claimCheckRequest, pendingCheckRequests } from '../src/check-spool.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function spool() {
  const root = mkdtempSync(join(tmpdir(), 'ct-check-spool-'));
  roots.push(root);
  const directory = join(root, 'requests');
  const replies = join(root, 'replies');
  mkdirSync(directory);
  mkdirSync(replies);
  return { root, directory, replies };
}
const request = (directory: string, id: string, body: string) =>
  writeFileSync(join(directory, `${id}.request`), body);
const ID = '00000000-0000-4000-8000-000000000001';

it('relays the daemon output and exit code to the launcher (R-G4)', async () => {
  const s = spool();
  const module = new URL('../src/check-spool.ts', import.meta.url).href;
  const launcher = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(module)}).then(m=>m.submitCheck(${JSON.stringify(s.directory)},${JSON.stringify(s.replies)},'ct-check',['--','true'],60000,30000,20))`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  launcher.stdout.on('data', (d) => (stdout += d));
  launcher.stderr.on('data', (d) => (stderr += d));
  let id: string | undefined;
  for (let i = 0; i < 200 && !id; i++) {
    id = pendingCheckRequests(s.directory)[0];
    if (!id) await new Promise((r) => setTimeout(r, 20));
  }
  expect(id, stderr).toBeDefined();
  const claimed = claimCheckRequest(s.directory, id!);
  expect(claimed).toEqual({ request: { version: 1, tool: 'ct-check', args: ['--', 'true'] } });
  expect(claimCheckRequest(s.directory, id!)).toBeUndefined();
  const reply = new CheckReply(s.directory, s.replies, id!);
  reply.write('first line\n');
  reply.write('second line\n');
  reply.finish(3, 'Check exited 3.');
  const code = await new Promise((resolve) => launcher.once('close', resolve));
  expect(code).toBe(3);
  expect(stdout).toBe('first line\nsecond line\n');
  expect(stderr).toContain('Check exited 3.');
});

it('never follows a link the agent plants in the spool, and never blocks on a FIFO (R-G4)', () => {
  const s = spool();
  const outside = join(s.root, 'operator-file');
  writeFileSync(outside, 'unchanged');
  request(s.directory, ID, JSON.stringify({ version: 1, tool: 'ct-check', args: [] }));
  expect(claimCheckRequest(s.directory, ID)).toHaveProperty('request');
  symlinkSync(outside, join(s.replies, `${ID}.out`));
  const reply = new CheckReply(s.directory, s.replies, ID);
  reply.write('check output');
  reply.finish(0);
  expect(readFileSync(outside, 'utf8')).toBe('unchanged');
  expect(JSON.parse(readFileSync(join(s.replies, `${ID}.exit`), 'utf8'))).toEqual({
    exitCode: 0,
  });

  // A request that is a link to a daemon-readable file, or a FIFO, is refused unread.
  const linked = '00000000-0000-4000-8000-000000000002';
  writeFileSync(
    join(s.root, 'secret.json'),
    JSON.stringify({ version: 1, tool: 'ct-check', args: [] }),
  );
  symlinkSync(join(s.root, 'secret.json'), join(s.directory, `${linked}.request`));
  expect(claimCheckRequest(s.directory, linked)).toEqual({ refused: 'Invalid check request.' });
  const fifo = '00000000-0000-4000-8000-000000000003';
  expect(spawnSync('mkfifo', [join(s.directory, `${fifo}.request`)]).status).toBe(0);
  expect(claimCheckRequest(s.directory, fifo)).toEqual({ refused: 'Invalid check request.' });
});

it('refuses malformed requests and names outside the protocol (R-G4)', () => {
  const s = spool();
  request(s.directory, ID, JSON.stringify({ version: 1, tool: 'bash', args: [] }));
  expect(claimCheckRequest(s.directory, ID)).toEqual({ refused: 'Invalid check request.' });
  const bad = '00000000-0000-4000-8000-000000000004';
  request(s.directory, bad, JSON.stringify({ version: 1, tool: 'ct-check', args: [1] }));
  expect(claimCheckRequest(s.directory, bad)).toEqual({ refused: 'Invalid check request.' });
  writeFileSync(join(s.directory, '../escape.request'), '{}');
  writeFileSync(join(s.directory, 'x.request'), '{}');
  expect(pendingCheckRequests(s.directory)).toEqual([]);
  expect(existsSync(join(s.directory, `${ID}.claimed`))).toBe(true);
});
