import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLaunchRequest, PinnedCargoManifest } from '@craftingtable/agents';
import { afterEach, expect } from 'vitest';
import {
  cleanupExecutionFixtures,
  commitFile,
  git,
  HOST_GIT,
  itNeedsCargo,
  runLauncher,
  runToFinish,
  scopeReport,
  scopeTree,
  slicedFixture,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** An independent implementation slice with a pinned environment, so its reviews are scoped. */
async function scopedRuntimeFixture() {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s) => ({ ...s, mode: 'implementation' })),
    work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
  }));
  const svc = f.state.context.services.runtimeEvidenceService;
  await svc.configure(f.auth, f.state.workspaceId, f.parentScope.definitionId, {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [],
    consumers: [{ alias: 'local', upstreams: [] }],
    environments: [
      {
        id: 'local',
        kind: 'local-development' as const,
        identityDigest: '1'.repeat(64),
        fixtureDigest: '2'.repeat(64),
        toolchainDigest: '3'.repeat(64),
        authorization: 'Local development checks',
      },
    ],
  });
  const tree = await scopeTree(f, f.scopes[0]!);
  commitFile(tree.path, 'slice.txt', 'slice implementation');
  return { ...f, svc, tree };
}

/**
 * Appends a receipt line exactly as a check launcher would, with every field a gate compares,
 * from files the run can read. Any agent can do this (SEC-01).
 */
function appendReceipt(request: AgentLaunchRequest, fields: Record<string, unknown>) {
  const raw = readFileSync(
    join(request.buildEnvironment!.binDirectory, '../manifest.json'),
    'utf8',
  );
  const m = JSON.parse(raw) as PinnedCargoManifest;
  const headSha = execFileSync(HOST_GIT, ['rev-parse', 'HEAD'], {
    cwd: request.cwd,
    encoding: 'utf8',
  }).trim();
  appendFileSync(
    m.receiptPath,
    `${JSON.stringify({
      kind: 'scoped-check',
      runtimeId: m.runtimeId,
      runId: m.runId,
      manifestDigest: sha(raw),
      verificationMode: m.verification?.mode,
      policyDigest: m.verification && sha(JSON.stringify(m.verification)),
      headSha,
      clean: true,
      command: 'true',
      args: [],
      success: true,
      exitCode: 0,
      diagnostic: '',
      at: new Date().toISOString(),
      ...fields,
    })}\n`,
  );
}

itNeedsCargo(
  'a scoped review needs a scoped check; a local CI receipt alone does not satisfy it (R-G4)',
  async () => {
    const f = await scopedRuntimeFixture();
    const review = (kind: string) => {
      f.backend.replyForRequest = (request) => {
        appendReceipt(request, { kind });
        return { resultText: scopeReport(f.state, f.tree.executionScope!) };
      };
      return runToFinish(f.state, f.tree.id, { role: 'review' });
    };
    const ciOnly = await review('local-ci');
    const environment = f.state.context.storage.runtimeEvidence.run(f.state.workspaceId, ciOnly);
    expect(
      (JSON.parse(readFileSync(environment!.manifestPath, 'utf8')) as PinnedCargoManifest)
        .verification?.mode,
    ).toBe('scoped-checks');
    expect(() => f.svc.assertRun(f.tree, ciOnly)).toThrow('successful scoped check');
  },
);

itNeedsCargo(
  'a receipt an agent writes to the launcher file satisfies no gate; the daemon runs and records the check (R-G4, SEC-01)',
  async () => {
    const f = await scopedRuntimeFixture();
    const storage = f.state.context.storage;
    f.backend.replyForRequest = (request) => {
      appendReceipt(request, { kind: 'scoped-check' });
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const forged = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(storage.runtimeEvidence.run(f.state.workspaceId, forged)?.receiptAuthority).toBe(
      'daemon',
    );
    expect(storage.runtimeEvidence.build(f.state.workspaceId, forged)?.receipts).toBe('');
    expect(() => f.svc.assertRun(f.tree, forged)).toThrow('successful scoped check');

    let output = '';
    f.backend.replyForRequest = async (request) => {
      // The check reports where it ran; the launcher only relays the daemon's output.
      output = (
        await runLauncher(request, 'ct-check', [
          '--',
          process.execPath,
          '-e',
          'console.log("checked in", process.cwd(), "agent", process.env.CT_AGENT_ONLY ?? "absent")',
        ])
      ).stdout;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    process.env.CT_AGENT_ONLY = 'inherited';
    let checked: string;
    try {
      checked = await runToFinish(f.state, f.tree.id, { role: 'review' });
    } finally {
      delete process.env.CT_AGENT_ONLY;
    }
    expect(output).toContain(`checked in ${f.tree.path} agent absent`);
    const [recorded] = storage.runtimeEvidence.checkReceipts(f.state.workspaceId, checked);
    expect(JSON.parse(recorded!.receipt)).toMatchObject({
      kind: 'scoped-check',
      recordedBy: 'daemon',
      success: true,
      clean: true,
      headSha: git(['rev-parse', 'HEAD'], f.tree.path).trim(),
    });
    expect(() => f.svc.assertRun(f.tree, checked)).not.toThrow();
  },
);

itNeedsCargo(
  'a check still running when its run ends is stopped and records nothing (R-G4)',
  async () => {
    const f = await scopedRuntimeFixture();
    const storage = f.state.context.storage;
    let pending: Promise<unknown> | undefined;
    f.backend.replyForRequest = (request) => {
      // Not awaited: the agent ends its turn while its check is still running.
      pending = runLauncher(request, 'ct-check', [
        '--',
        process.execPath,
        '-e',
        'setTimeout(() => console.log("finished late"), 60000)',
      ]).then(
        () => 0,
        (error: { code?: number }) => error.code,
      );
      const checks = f.state.context.services.checkRequestService;
      const runId = request.buildEnvironment!.namespace!;
      // The turn ends once the daemon is running the check.
      const release = (async () => {
        while (checks.inFlight(runId).length === 0) await new Promise((r) => setTimeout(r, 20));
      })();
      return { resultText: scopeReport(f.state, f.tree.executionScope!), release };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(await pending).not.toBe(0);
    expect(storage.runtimeEvidence.checkReceipts(f.state.workspaceId, run)).toEqual([]);
    expect(storage.runtimeEvidence.build(f.state.workspaceId, run)?.receipts).toBe('');
  },
);

/** An operator local CI configuration whose act prints and then sleeps for `seconds`. */
function fakeLocalCi(root: string, seconds: number) {
  const tool = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const config = join(root, 'act.json');
  writeFileSync(
    config,
    JSON.stringify({
      actExecutable: tool('act', `echo "act ran"; sleep ${seconds}`),
      dockerExecutable: tool('docker', 'exit 0'),
      dockerHost: 'unix:///run/user/1000/docker.sock',
      image: `image@sha256:${'a'.repeat(64)}`,
      cacheRoot: join(root, 'cache'),
    }),
  );
  return config;
}

itNeedsCargo(
  'ct-act runs in the daemon; a local CI line an agent writes is dropped, and CI still running at the end invalidates the record (R-G4, LIVE-03)',
  async () => {
    const f = await scopedRuntimeFixture();
    const storage = f.state.context.storage;
    const root = mkdtempSync(join(tmpdir(), 'ct-receipt-gates-ci-'));
    mkdirSync(join(f.tree.path, '.github/workflows'), { recursive: true });
    writeFileSync(join(f.tree.path, '.github/workflows/ci.yml'), 'name: CI\non: push\n');
    git(['add', '.'], f.tree.path);
    git(['commit', '-m', 'workflow'], f.tree.path);
    const previous = process.env.CRAFTINGTABLE_ACT_CONFIG;
    process.env.CRAFTINGTABLE_ACT_CONFIG = fakeLocalCi(root, 0);
    try {
      let output = '';
      f.backend.replyForRequest = async (request) => {
        appendReceipt(request, { kind: 'local-ci' });
        output = (await runLauncher(request, 'ct-act', ['-W', '.github/workflows/ci.yml'])).stdout;
        return { resultText: scopeReport(f.state, f.tree.executionScope!) };
      };
      const ran = await runToFinish(f.state, f.tree.id, { role: 'review' });
      expect(output).toContain('act ran');
      const frozen = storage.runtimeEvidence.build(f.state.workspaceId, ran)!.receipts;
      // Only the daemon's own receipt: the appended line is gone.
      expect(
        frozen
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      ).toEqual([
        expect.objectContaining({ kind: 'local-ci', recordedBy: 'daemon', success: true }),
      ]);

      process.env.CRAFTINGTABLE_ACT_CONFIG = fakeLocalCi(root, 60);
      f.backend.replyForRequest = (request) => {
        void runLauncher(request, 'ct-act', ['-W', '.github/workflows/ci.yml']).catch(() => {});
        const checks = f.state.context.services.checkRequestService;
        const runId = request.buildEnvironment!.namespace!;
        const release = (async () => {
          while (!checks.inFlight(runId).includes('ct-act'))
            await new Promise((r) => setTimeout(r, 20));
        })();
        return { resultText: scopeReport(f.state, f.tree.executionScope!), release };
      };
      const unfinished = await runToFinish(f.state, f.tree.id, { role: 'review' });
      expect(storage.runtimeEvidence.build(f.state.workspaceId, unfinished)?.error).toContain(
        'Local CI did not finish collection',
      );
    } finally {
      if (previous === undefined) delete process.env.CRAFTINGTABLE_ACT_CONFIG;
      else process.env.CRAFTINGTABLE_ACT_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
