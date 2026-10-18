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

/** Launchers the tests start: each is killed when its test ends, whatever it asserted. */
const launchers: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const launcher of launchers.splice(0))
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
});

/** A launcher with short limits, which the test answers as the daemon would. */
async function launch(
  limitMs: number,
  { claimMs = 30_000, queuedMs = 86_400_000, claim = true } = {},
) {
  const s = spool();
  const module = new URL('../src/check-spool.ts', import.meta.url).href;
  const launcher = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(module)}).then(m=>m.submitCheck(${JSON.stringify(s.directory)},${JSON.stringify(s.replies)},'ct-check',['--declared','b'],${limitMs},${claimMs},20,${queuedMs}))`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  launchers.push(launcher);
  let stderr = '';
  launcher.stderr.on('data', (d) => (stderr += d));
  const closed = new Promise<number | null>((resolve) => launcher.once('close', resolve));
  let id: string | undefined;
  for (let i = 0; i < 200 && !id; i++) {
    id = pendingCheckRequests(s.directory)[0];
    if (!id) await new Promise((r) => setTimeout(r, 20));
  }
  expect(id, stderr).toBeDefined();
  if (claim) expect(claimCheckRequest(s.directory, id!)).toHaveProperty('request');
  return { s, id: id!, closed, stderr: () => stderr, exited: () => launcher.exitCode !== null };
}

it("counts a launcher's limit from the daemon's start of its check, not from its request: a check queued past the limit is not cancelled while it waits (R-C17 LOW-4)", async () => {
  const { s, id, closed, stderr, exited } = await launch(1000);
  // Claimed and queued behind another check of the run for well past the launcher's limit.
  await new Promise((r) => setTimeout(r, 2500));
  expect(exited(), stderr()).toBe(false);
  expect(existsSync(join(s.directory, `${id}.cancel`))).toBe(false);
  const reply = new CheckReply(s.directory, s.replies, id);
  reply.start();
  expect(existsSync(join(s.replies, `${id}.started`))).toBe(true);
  await new Promise((r) => setTimeout(r, 100));
  reply.write('ran\n');
  reply.finish(0);
  expect(await closed).toBe(0);
  expect(stderr()).not.toContain('within its time limit');
  expect(existsSync(join(s.directory, `${id}.cancel`))).toBe(false);
});

it('once the daemon has started its check, a launcher still gives up at its limit and asks for cancellation (R-C17 LOW-4)', async () => {
  const { s, id, closed, stderr } = await launch(300);
  const reply = new CheckReply(s.directory, s.replies, id);
  reply.start();
  // Started once only: a second start leaves the first marker.
  reply.start();
  expect(await closed).toBe(1);
  expect(stderr()).toContain('CraftingTable did not report this check within its time limit.');
  expect(existsSync(join(s.directory, `${id}.cancel`))).toBe(true);
});

it('the day a launcher waits for its check to start no longer counts once it has started (R-C17 LOW-4 re-check)', async () => {
  const { s, id, closed, stderr } = await launch(5000, { queuedMs: 500 });
  const reply = new CheckReply(s.directory, s.replies, id);
  reply.start();
  // Running past the bound on the wait to start, within its own limit.
  await new Promise((r) => setTimeout(r, 1000));
  reply.finish(0);
  expect(await closed).toBe(0);
  expect(stderr()).not.toContain('within a day');
  expect(existsSync(join(s.directory, `${id}.cancel`))).toBe(false);
});

it('a launcher whose request nobody claims gives up at its pickup limit, whatever its time limit (R-C17 LOW-4 review)', async () => {
  const { closed, stderr } = await launch(600_000, { claimMs: 300, claim: false });
  expect(await closed).toBe(1);
  expect(stderr()).toContain(
    'CraftingTable did not pick up this check; the daemon may be stopped.',
  );
});

it('a queued launcher gives up once its spool is gone, and after a day unstarted it asks for cancellation (R-C17 LOW-4 review)', async () => {
  const gone = await launch(600_000);
  rmSync(gone.s.root, { recursive: true, force: true });
  expect(await gone.closed).toBe(1);
  expect(gone.stderr()).toContain(
    'CraftingTable no longer holds this check request; its run may have ended.',
  );
  // The day's bound, shortened.
  const late = await launch(600_000, { queuedMs: 500 });
  expect(await late.closed).toBe(1);
  expect(late.stderr()).toContain(
    'CraftingTable did not start this check within a day; it was cancelled.',
  );
  expect(existsSync(join(late.s.directory, `${late.id}.cancel`))).toBe(true);
});

it("never follows a link the agent plants for the daemon's start marker (R-C17 LOW-4)", () => {
  const s = spool();
  const outside = join(s.root, 'operator-file');
  writeFileSync(outside, 'unchanged');
  request(s.directory, ID, JSON.stringify({ version: 1, tool: 'ct-check', args: [] }));
  expect(claimCheckRequest(s.directory, ID)).toHaveProperty('request');
  symlinkSync(outside, join(s.replies, `${ID}.started`));
  new CheckReply(s.directory, s.replies, ID).start();
  expect(readFileSync(outside, 'utf8')).toBe('unchanged');
});
