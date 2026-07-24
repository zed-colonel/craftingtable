import { describe, expect, it } from 'vitest';
import { WORKSPACE_EVENT_KINDS } from './workspace-events.js';

describe('workspace event vocabulary', () => {
  it('contains only the CT-02 event kind', () => {
    expect(WORKSPACE_EVENT_KINDS).toEqual(['workspace-created']);
  });
});
