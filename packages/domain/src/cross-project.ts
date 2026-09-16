import type { CompletionPolicy, CycleProfiles } from './work-cycle.js';
import type { RoadmapAutomation } from './roadmap.js';
import type { UserId, WorkspaceId } from './ids.js';
export interface MapAdoption {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly definitionId: string;
  readonly bindingRevision: number;
  readonly decisionIds: readonly string[];
  readonly rationale: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
export type MapActivity = 'development' | 'verification' | 'acceptance';
export interface MapActivitySettings {
  readonly reviewerRoles?: readonly string[];
  readonly profiles: CycleProfiles;
  readonly policy: CompletionPolicy;
  readonly instructions: string;
  readonly automation: RoadmapAutomation;
}
export interface CrossProjectConfiguration {
  readonly definitionId: string;
  readonly bindingRevision: number;
  readonly targetId: string;
  readonly selection: 'target-only' | 'prioritize-full';
  readonly parentAcceptance: 'manual' | 'automatic';
  readonly defaults: MapActivitySettings;
  readonly overrides: readonly {
    readonly level: 'project' | 'activity' | 'individual';
    readonly key: string;
    readonly settings: MapActivitySettings;
  }[];
}
