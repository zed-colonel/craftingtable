import { createHash } from 'node:crypto';
import type {
  FailedRepositoryInspection,
  ProjectId,
  ProjectRepositoryBinding,
  ProjectRepositoryBindingId,
  RegisteredRepository,
  RepositoryId,
  RepositoryInspection,
  RepositoryInspectionId,
  RepositoryReduction,
  RepositoryStatus,
  SuccessfulRepositoryInspection,
  UserId,
  WorkspaceId,
} from '@craftingtable/domain';

/** Hash exact UTF-8 bytes. Whitespace and key order are intentionally material. */
export function sha256ExactUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function verifyExactUtf8Sha256(value: string, expectedSha256: string): boolean {
  return sha256ExactUtf8(value) === expectedSha256;
}

/** Serialize once so storage and projections can derive from one immutable value. */
export function serializeRepositoryObservation(value: unknown): {
  readonly observationJson: string;
  readonly observationSha256: string;
} {
  const observationJson = JSON.stringify(value);
  if (observationJson === undefined) {
    throw new TypeError('Repository observation must be JSON serializable');
  }
  return { observationJson, observationSha256: sha256ExactUtf8(observationJson) };
}

export type SuccessfulInspectionWrite = Omit<SuccessfulRepositoryInspection, 'sequence'>;
export type FailedInspectionWrite = Omit<FailedRepositoryInspection, 'sequence'>;
export type InspectionWrite = SuccessfulInspectionWrite | FailedInspectionWrite;

export interface RegisterRepositoryInput {
  readonly id: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly actorUserId: UserId;
  readonly inspection: SuccessfulInspectionWrite & {
    readonly kind: 'registration';
    readonly outcome: 'succeeded';
  };
}

export type RepositoryRegistrationResult =
  | { readonly kind: 'created'; readonly repository: RegisteredRepository }
  | { readonly kind: 'existing'; readonly repository: RegisteredRepository }
  | { readonly kind: 'conflicting-local-state'; readonly status: RepositoryStatus }
  | { readonly kind: 'local-identity-conflict' }
  | { readonly kind: 'identity-reserved-elsewhere' };

export interface ApplyRepositoryTransitionInput {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly expectedVersion: number;
  readonly actorUserId: UserId;
  readonly changedAt: string;
  readonly reduction: Extract<RepositoryReduction, { readonly kind: 'transition' }>;
}

export type RepositoryMutationResult =
  | { readonly kind: 'changed'; readonly repository: RegisteredRepository }
  | { readonly kind: 'unchanged'; readonly repository: RegisteredRepository }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'version-conflict' }
  | { readonly kind: 'state-conflict'; readonly status: RepositoryStatus };

export interface AppendRepositoryVerificationInput {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly expectedVersion: number;
  readonly inspection: InspectionWrite & {
    readonly kind: 'verification';
  };
}

export type InspectionAppendResult =
  | { readonly kind: 'appended'; readonly inspection: RepositoryInspection }
  | { readonly kind: 'duplicate-id' }
  | { readonly kind: 'version-conflict' }
  | { readonly kind: 'repository-not-inspectable'; readonly status: RepositoryStatus };

export interface ReaffirmRepositoryEnvironmentInput {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly expectedVersion: number;
  readonly expectedLatestSuccessfulInspectionId: RepositoryInspectionId;
  readonly actorUserId: UserId;
  readonly changedAt: string;
  readonly inspection: SuccessfulInspectionWrite & {
    readonly kind: 'reaffirmation';
    readonly outcome: 'succeeded';
  };
}

export type RepositoryReaffirmationResult =
  | {
      readonly kind: 'changed';
      readonly repository: RegisteredRepository;
      readonly inspection: SuccessfulRepositoryInspection;
    }
  | { readonly kind: 'duplicate-id' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'version-conflict' }
  | { readonly kind: 'latest-successful-conflict' }
  | { readonly kind: 'repository-not-reaffirmable'; readonly status: RepositoryStatus };

export interface RetireRepositoryWithBindingsInput {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly expectedVersion: number;
  readonly actorUserId: UserId;
  readonly changedAt: string;
}

export type RepositoryRetirementResult =
  | {
      readonly kind: 'changed';
      readonly repository: RegisteredRepository;
      readonly retiredBindingIds: readonly ProjectRepositoryBindingId[];
    }
  | {
      readonly kind: 'unchanged';
      readonly repository: RegisteredRepository;
      readonly retiredBindingIds: readonly [];
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'version-conflict' };

export interface InsertProjectRepositoryBindingInput {
  readonly id: ProjectRepositoryBindingId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly repositoryId: RepositoryId;
  readonly expectedRepositoryVersion: number;
  readonly actorUserId: UserId;
  readonly boundAt: string;
}

export type ProjectRepositoryBindingInsertResult =
  | { readonly kind: 'created'; readonly binding: ProjectRepositoryBinding }
  | { readonly kind: 'existing'; readonly binding: ProjectRepositoryBinding }
  | { readonly kind: 'project-already-bound' }
  | { readonly kind: 'repository-not-found' }
  | { readonly kind: 'repository-not-active'; readonly status: RepositoryStatus }
  | { readonly kind: 'repository-version-conflict' };

export interface RetireProjectRepositoryBindingInput {
  readonly workspaceId: WorkspaceId;
  readonly bindingId: ProjectRepositoryBindingId;
  readonly expectedVersion: number;
  readonly actorUserId: UserId;
  readonly retiredAt: string;
}

export type BindingMutationResult =
  | { readonly kind: 'changed'; readonly binding: ProjectRepositoryBinding }
  | { readonly kind: 'unchanged'; readonly binding: ProjectRepositoryBinding }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'version-conflict' };

export interface RepositorySummaryRow {
  readonly repository: RegisteredRepository;
  readonly latestInspection: RepositoryInspection;
  readonly latestSuccessfulInspection: SuccessfulRepositoryInspection;
}

export interface ProjectRepositoryBindingSummaryRow {
  readonly binding: ProjectRepositoryBinding;
  readonly repositoryStatus: RepositoryStatus;
  readonly repositoryStatusReason: RegisteredRepository['statusReason'];
}

export interface RepositoryInspectionSummaryRow {
  readonly inspection: RepositoryInspection;
  readonly acceptedAsEnvironmentBaseline: boolean;
}

export interface RegisteredRepositoryRepository {
  register(input: RegisterRepositoryInput): RepositoryRegistrationResult;
  find(workspaceId: WorkspaceId, repositoryId: RepositoryId): RegisteredRepository | undefined;
  list(workspaceId: WorkspaceId, limit: number): readonly RegisteredRepository[];
  applyTransition(input: ApplyRepositoryTransitionInput): RepositoryMutationResult;
  reaffirmEnvironment(input: ReaffirmRepositoryEnvironmentInput): RepositoryReaffirmationResult;
  retireWithBindings(input: RetireRepositoryWithBindingsInput): RepositoryRetirementResult;
}

export interface RepositoryInspectionRepository {
  appendVerification(input: AppendRepositoryVerificationInput): InspectionAppendResult;
  find(
    workspaceId: WorkspaceId,
    inspectionId: RepositoryInspectionId,
  ): RepositoryInspection | undefined;
  listForRepository(
    workspaceId: WorkspaceId,
    repositoryId: RepositoryId,
    limit: number,
  ): readonly RepositoryInspection[];
  latestForRepository(workspaceId: WorkspaceId, repositoryId: RepositoryId): RepositoryInspection;
  latestSuccessfulForRepository(
    workspaceId: WorkspaceId,
    repositoryId: RepositoryId,
  ): SuccessfulRepositoryInspection;
}

export interface ProjectRepositoryBindingRepository {
  insert(input: InsertProjectRepositoryBindingInput): ProjectRepositoryBindingInsertResult;
  find(
    workspaceId: WorkspaceId,
    bindingId: ProjectRepositoryBindingId,
  ): ProjectRepositoryBinding | undefined;
  findActiveForProject(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): ProjectRepositoryBinding | undefined;
  listForProject(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): readonly ProjectRepositoryBinding[];
  listForRepository(
    workspaceId: WorkspaceId,
    repositoryId: RepositoryId,
  ): readonly ProjectRepositoryBinding[];
  retire(input: RetireProjectRepositoryBindingInput): BindingMutationResult;
}

export interface RepositoryRegistryQueryRepository {
  repositorySummary(
    workspaceId: WorkspaceId,
    repositoryId: RepositoryId,
  ): RepositorySummaryRow | undefined;
  repositorySummaries(workspaceId: WorkspaceId, limit: number): readonly RepositorySummaryRow[];
  projectBindingSummaries(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): readonly ProjectRepositoryBindingSummaryRow[];
  inspectionSummaries(
    workspaceId: WorkspaceId,
    repositoryId: RepositoryId,
    limit: number,
  ): readonly RepositoryInspectionSummaryRow[];
}

export interface RepositoryRegistryRepositories {
  readonly repositories: RegisteredRepositoryRepository;
  readonly inspections: RepositoryInspectionRepository;
  readonly bindings: ProjectRepositoryBindingRepository;
  readonly queries: RepositoryRegistryQueryRepository;
}
