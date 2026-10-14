import type { ToolObservation, ToolchainSettings } from '@craftingtable/agents';
import { expect, it } from 'vitest';
import { ToolchainService } from '../../src/services/toolchain-service.js';

/**
 * R-G17 decisions 4 and 5 (amended): the daemon probes the configured tools at start, every
 * Python check re-reads them, and Tools shows each tool's identity and what changed and when.
 */

const python = {
  interpreter: '/opt/ct/python/bin/python3.12',
  version: '3.12',
  uv: { path: '/opt/ct/bin/uv', version: '0.12' },
};
const settings: ToolchainSettings = { python, limits: { memoryMax: '8G', tasksMax: 1024 } };

const identity = (tool: 'python' | 'uv', sha256: string, version: string): ToolObservation => ({
  tool,
  path: tool === 'python' ? python.interpreter : python.uv.path,
  configuredVersion: tool === 'python' ? '3.12' : '0.12',
  identity: {
    tool,
    path: tool === 'python' ? python.interpreter : python.uv.path,
    uid: 0,
    mode: '0755',
    size: 10,
    sha256,
    version,
  },
});

it('shows each configured tool after the start probe, with the caps', async () => {
  let probed = 0;
  const service = new ToolchainService(
    settings,
    async () => {
      probed++;
      return [
        identity('python', 'a'.repeat(64), '3.12.15'),
        identity('uv', 'b'.repeat(64), '0.12.22'),
      ];
    },
    () => new Date('2026-10-13T20:00:00Z'),
  );
  expect(service.status().tools).toEqual([]);
  await service.refresh();
  expect(probed).toBe(1);
  expect(service.status()).toMatchObject({
    limits: { memoryMax: '8G', tasksMax: 1024 },
    python,
    tools: [
      {
        tool: 'python',
        path: python.interpreter,
        configuredVersion: '3.12',
        identity: { sha256: 'a'.repeat(64), version: '3.12.15' },
        checkedAt: '2026-10-13T20:00:00.000Z',
        changes: [],
      },
      { tool: 'uv', identity: { version: '0.12.22' }, changes: [] },
    ],
  });
});

it("records what changed and when, as a check's re-read finds it, and a problem it finds", async () => {
  let at = new Date('2026-10-13T20:00:00Z');
  const service = new ToolchainService(
    settings,
    async () => [
      identity('python', 'a'.repeat(64), '3.12.15'),
      identity('uv', 'b'.repeat(64), '0.12.22'),
    ],
    () => at,
  );
  await service.refresh();
  // The operator updates CPython in place: a check's re-read records it, and does not refuse it.
  at = new Date('2026-10-14T09:30:00Z');
  service.record([
    identity('python', 'c'.repeat(64), '3.12.16'),
    identity('uv', 'b'.repeat(64), '0.12.22'),
  ]);
  const [pythonStatus, uvStatus] = service.status().tools;
  expect(pythonStatus?.identity?.version).toBe('3.12.16');
  expect(pythonStatus?.changes).toEqual([
    {
      at: '2026-10-14T09:30:00.000Z',
      from: `version 3.12.15, sha256 ${'a'.repeat(12)}…, owner 0, mode 0755`,
      to: `version 3.12.16, sha256 ${'c'.repeat(12)}…, owner 0, mode 0755`,
    },
  ]);
  expect(uvStatus?.changes).toEqual([]);
  // A problem is shown, and its appearance is a change too.
  at = new Date('2026-10-14T10:00:00Z');
  service.record([
    {
      tool: 'python',
      path: python.interpreter,
      configuredVersion: '3.12',
      problem: { code: 'untrusted-owner', message: `${python.interpreter} is not owned by root` },
    },
  ]);
  const changed = service.status().tools[0];
  expect(changed?.problem?.code).toBe('untrusted-owner');
  expect(changed?.identity).toBeUndefined();
  expect(changed?.changes.at(-1)).toEqual({
    at: '2026-10-14T10:00:00.000Z',
    from: `version 3.12.16, sha256 ${'c'.repeat(12)}…, owner 0, mode 0755`,
    to: `refused: ${python.interpreter} is not owned by root`,
  });
});

it('keeps at most 20 changes per tool, the latest', async () => {
  let n = 0;
  const service = new ToolchainService(
    settings,
    async () => [],
    () => new Date(1_000_000 + n),
  );
  for (n = 0; n < 30; n++)
    service.record([
      identity('python', `${n.toString(16).padStart(12, '0')}${'0'.repeat(52)}`, '3.12.15'),
    ]);
  const changes = service.status().tools[0]?.changes ?? [];
  expect(changes).toHaveLength(20);
  expect(changes.at(-1)?.to).toContain(`sha256 ${(29).toString(16).padStart(12, '0')}`);
});

it('probes nothing and lists no tool without a Python profile', async () => {
  let probed = 0;
  const service = new ToolchainService(
    { limits: { memoryMax: '8G', tasksMax: 1024 } },
    async () => {
      probed++;
      return [];
    },
  );
  await service.refresh();
  expect(probed).toBe(0);
  expect(service.status()).toEqual({ limits: { memoryMax: '8G', tasksMax: 1024 }, tools: [] });
});

it('keeps the start from failing when a probe throws, and logs it', async () => {
  const warnings: string[] = [];
  const service = new ToolchainService(
    settings,
    async () => {
      throw new Error('spawn failed');
    },
    () => new Date(),
    { warn: (message) => warnings.push(message) },
  );
  await service.refresh();
  expect(service.status().tools).toEqual([]);
  expect(warnings).toEqual(['The configured toolchain could not be probed']);
});
