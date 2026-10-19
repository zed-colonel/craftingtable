import { expect, it } from 'vitest';
import { roadmapAttention } from '../src/attention.js';
import { holdStop, roadmapStop } from '../src/roadmap-stop.js';

/** The stored stops a roadmap and its entry holds stand at (R-B4b increment 3; its review LOW-1). */

it("reads a roadmap's stored stop while it needs attention, and none otherwise", () => {
  const attention = roadmapAttention('restart-resume');
  expect(roadmapStop({ status: 'needs-attention', attention })).toEqual(attention);
  // A paused roadmap can keep the stop it was paused at (`runtime-refresh.ts`): it is not a stop.
  expect(roadmapStop({ status: 'paused', attention })).toBeUndefined();
  expect(roadmapStop({ status: 'running' })).toBeUndefined();
});

it("reads an entry hold's stored stop while it needs attention, and none for a pause", () => {
  const attention = roadmapAttention('entry-preparation-failed');
  expect(holdStop({ status: 'needs-attention', reason: 'Failed.', attention })).toEqual(attention);
  expect(holdStop({ status: 'paused', reason: 'Paused.', attention })).toBeUndefined();
  expect(holdStop({ status: 'paused', reason: 'Paused.' })).toBeUndefined();
});
