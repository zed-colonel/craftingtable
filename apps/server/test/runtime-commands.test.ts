import { expect, it } from 'vitest';
import { runtimeCommands } from '../src/routes/runtime-evidence.js';
import type { RuntimeEvidenceService } from '../src/services/runtime-evidence-service.js';

/**
 * The runtime's commands are one table (R-H5): each route runs its own service method, with its
 * own tag. A table row that ran another command's method would post one decision as another.
 */
const EXPECTED: Readonly<Record<string, readonly [method: string, tag: 'decision' | 'config']>> = {
  'audit-native': ['auditNative', 'decision'],
  'authorize-native': ['approveNative', 'decision'],
  'declare-transitions': ['declareUpstreamTransitions', 'decision'],
  configure: ['configure', 'config'],
  'preview-refresh': ['previewRefresh', 'decision'],
  refresh: ['refresh', 'decision'],
  inspect: ['inspect', 'config'],
  discover: ['discover', 'config'],
  'propose-decision': ['proposeArchitectureDecision', 'decision'],
  'generate-plan': ['generatePlanEvidence', 'decision'],
  'prepare-checkpoint': ['prepareCheckpoint', 'decision'],
  submit: ['submit', 'decision'],
  decide: ['decide', 'decision'],
};

it('runs each runtime command through its own service method, with its own tag (R-H5)', async () => {
  const called: string[] = [];
  const service = new Proxy({} as RuntimeEvidenceService, {
    get: (_target, method) => async () => {
      called.push(String(method));
      throw new Error('reached');
    },
  });
  const commands = runtimeCommands(service);
  expect(commands.map((c) => c.action).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
  for (const command of commands) {
    called.length = 0;
    await expect(
      command.run({} as never, 'ws' as never, 'map', {}),
      command.action,
    ).rejects.toThrow('reached');
    expect(called, command.action).toEqual([EXPECTED[command.action]![0]]);
    expect(command.tag, command.action).toBe(EXPECTED[command.action]![1]);
  }
});
