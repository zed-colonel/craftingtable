import { expect, it } from 'vitest';
import { codexThreadParams, codexTurnParams } from './arguments.js';

it.each(['auto', 'edit-only', 'unrestricted'] as const)(
  'applies %s permissions to new/resumed threads and every turn',
  (permissionMode) => {
    const request = {
      cwd: '/work/x',
      prompt: 'private brief',
      permissionMode,
      additionalDirectories: ['/work/y'],
      appendSystemPrompt: 'instructions',
      model: 'custom',
    };
    const thread = codexThreadParams(request);
    const turn = codexTurnParams(request);
    expect(thread).toMatchObject({
      cwd: '/work/x',
      model: 'custom',
      developerInstructions: 'instructions',
      approvalPolicy: permissionMode === 'auto' ? 'on-request' : 'never',
      approvalsReviewer: permissionMode === 'auto' ? 'auto_review' : 'user',
    });
    expect(turn.approvalPolicy).toEqual(thread.approvalPolicy);
    expect(turn.approvalsReviewer).toEqual(thread.approvalsReviewer);
    expect(turn.sandboxPolicy).toEqual(
      permissionMode === 'unrestricted'
        ? { type: 'dangerFullAccess' }
        : {
            type: 'workspaceWrite',
            writableRoots: ['/work/x', '/work/y'],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
    );
    expect(JSON.stringify(thread)).not.toContain('private brief');
  },
);
