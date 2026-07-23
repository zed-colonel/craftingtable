import { readFile } from 'node:fs/promises';
import {
  agentRunIdSchema,
  projectIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import { AGENT_EVENT_KINDS } from '@craftingtable/domain';
import { z } from 'zod';

/**
 * Shape of `fixtures/agent-events/demo-run.json`: envelope templates without
 * `id`, `sequence`, or `occurredAt`, which the fake backend stamps at emit
 * time. The run-started `branch` is injected from the GitService.
 */
export const demoRunScriptSchema = z.object({
  workspaceId: workspaceIdSchema,
  projectId: projectIdSchema,
  workItemId: workItemIdSchema,
  runId: agentRunIdSchema,
  steps: z
    .array(
      z.object({
        kind: z.enum(AGENT_EVENT_KINDS),
        delayMs: z.number().int().min(0),
        payload: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
});

export type DemoRunScript = z.infer<typeof demoRunScriptSchema>;

export const DEMO_RUN_FIXTURE_URL = new URL(
  '../../../fixtures/agent-events/demo-run.json',
  import.meta.url,
);

export async function loadDemoRunScript(): Promise<DemoRunScript> {
  const raw = await readFile(DEMO_RUN_FIXTURE_URL, 'utf8');
  return demoRunScriptSchema.parse(JSON.parse(raw));
}
