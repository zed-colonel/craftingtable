import { expect, it } from 'vitest';
import {
  checkpointOfSubject,
  checkpointSubjectKey,
} from '../../src/services/checkpoint-subject.js';

it("reads back only a roadmap's own checkpoint subject (R-A6 rest, review L4)", () => {
  expect(checkpointOfSubject(checkpointSubjectKey('r', 'WI-ADR-012'), 'r')).toBe('WI-ADR-012');
  // Another roadmap's checkpoint, another subject of the roadmap, an empty id, no roadmap.
  for (const [key, roadmap] of [
    ['roadmap:other:checkpoint:WI-ADR-012', 'r'],
    ['roadmap:r:entry:e', 'r'],
    ['roadmap:r:amendment', 'r'],
    ['roadmap:r:refresh', 'r'],
    ['roadmap:r:checkpoint:', 'r'],
    ['cycle:c', 'r'],
    ['roadmap:r:checkpoint:WI-ADR-012', undefined],
  ] as const)
    expect(checkpointOfSubject(key, roadmap), key).toBeUndefined();
});
