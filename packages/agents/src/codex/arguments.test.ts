import { expect, it } from 'vitest';
import { codexExecArguments, codexResumeArguments } from './arguments.js';

it.each(['auto', 'edit-only'] as const)(
  'uses noninteractive workspace-write for %s, including resume',
  (permissionMode) => {
    const request = { cwd: '/work/x', prompt: 'private brief', permissionMode };
    const flags = [
      '--json',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'approval_policy="never"',
    ];
    expect(codexExecArguments(request)).toEqual(['exec', ...flags, '-']);
    expect(codexResumeArguments('thread-1', request)).toEqual([
      'exec',
      'resume',
      ...flags,
      'thread-1',
      '-',
    ]);
  },
);
it('passes the model and explicit unrestricted posture without putting the prompt in argv', () => {
  const request = {
    cwd: '/work/x',
    prompt: 'private brief',
    permissionMode: 'unrestricted' as const,
    model: 'gpt-5.6-luna',
  };
  expect(codexExecArguments(request)).toEqual([
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--model',
    'gpt-5.6-luna',
    '-',
  ]);
  expect(codexResumeArguments('thread-1', request)).toEqual([
    'exec',
    'resume',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--model',
    'gpt-5.6-luna',
    'thread-1',
    '-',
  ]);
});
