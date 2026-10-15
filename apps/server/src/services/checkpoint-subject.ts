import type { RoadmapId } from '@craftingtable/domain';
/**
 * The subject key of a roadmap's map-checkpoint item (R-A5, R-C3b): one item per checkpoint
 * ready for the operator. The roadmap writes it and the inbox reads the checkpoint back from it
 * (R-A6 rest), so the format lives here alone.
 */
export function checkpointSubjectKey(roadmapId: RoadmapId, checkpointId: string): string {
  return `roadmap:${roadmapId}:checkpoint:${checkpointId}`;
}

/** The checkpoint a roadmap's checkpoint item is about; none for any other subject. */
export function checkpointOfSubject(subjectKey: string, roadmapId: RoadmapId | undefined) {
  if (roadmapId === undefined) return undefined;
  const prefix = checkpointSubjectKey(roadmapId, '');
  return subjectKey.startsWith(prefix) && subjectKey.length > prefix.length
    ? subjectKey.slice(prefix.length)
    : undefined;
}
