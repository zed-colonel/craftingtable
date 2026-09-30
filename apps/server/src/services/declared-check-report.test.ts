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
import { declaredCheckReport } from './agent-run-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'declared-report-'));
  roots.push(root);
  const log = join(root, 'check.log');
  writeFileSync(log, 'error: the queue lost an item\n');
  const run = join(root, 'run');
  mkdirSync(run);
  return { root, log, run };
}

it("copies a failed check's output into the run directory and never writes through a link (R-G13 increment 3 review)", () => {
  const { root, log, run } = setup();
  const report = declaredCheckReport(
    [
      { checkId: 'ok', exitCode: 0, diagnostic: '', logPath: log },
      { checkId: 'queue', exitCode: 1, diagnostic: 'failed', logPath: log },
    ],
    run,
  );
  expect(report).toContain('- ok: exited 0.');
  expect(report).toContain(`Output: ${join(run, 'declared-checks', 'queue.log')}`);
  expect(readFileSync(join(run, 'declared-checks', 'queue.log'), 'utf8')).toContain('lost an item');

  // A directory planted as a link elsewhere is not written through.
  const { run: planted } = setup();
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(planted, 'declared-checks'));
  const refused = declaredCheckReport(
    [{ checkId: 'queue', exitCode: 1, diagnostic: 'failed', logPath: log }],
    planted,
  );
  expect(refused).not.toContain('Output:');
  expect(existsSync(join(elsewhere, 'queue.log'))).toBe(false);
});
