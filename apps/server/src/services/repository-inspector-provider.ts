import type { RepositoryFeatureConfig } from '../config.js';
import type {
  RepositoryObservationPortCreationFailure,
  RepositoryObservationPortCreationResult,
} from './repository-observation-adapter.js';
import type {
  RepositoryAdapterFailure,
  RepositoryObservationPort,
} from './repository-observation-port.js';

export interface MonotonicClock {
  now(): number;
}

export const PERFORMANCE_MONOTONIC_CLOCK: MonotonicClock = {
  now: () => performance.now(),
};

export type RepositoryObservationPortFactory = (
  onInvariantFault: (failure: RepositoryAdapterFailure) => void,
) => Promise<RepositoryObservationPortCreationResult>;

export interface RepositoryProviderFailure {
  readonly kind: 'feature-disabled' | 'temporarily-unavailable' | 'permanently-unavailable';
  readonly reason:
    | 'feature-disabled'
    | 'creation-failed'
    | 'adapter-vocabulary-mismatch'
    | 'adapter-invariant-fault';
}

export type RepositoryProviderResult =
  | { readonly ok: true; readonly port: RepositoryObservationPort }
  | { readonly ok: false; readonly failure: RepositoryProviderFailure };

export type RepositoryProviderStatus =
  | 'disabled'
  | 'idle'
  | 'creating'
  | 'available'
  | 'cooldown'
  | 'permanently-unavailable';

type ProviderState =
  | { readonly kind: 'disabled'; readonly result: RepositoryProviderResult }
  | { readonly kind: 'idle' }
  | { readonly kind: 'creating'; readonly promise: Promise<RepositoryProviderResult> }
  | { readonly kind: 'available'; readonly result: RepositoryProviderResult }
  | {
      readonly kind: 'cooldown';
      readonly result: RepositoryProviderResult;
      readonly retryNotBefore: number;
    }
  | { readonly kind: 'permanently-unavailable'; readonly result: RepositoryProviderResult };

function publicFailure(
  failure: RepositoryObservationPortCreationFailure,
  temporary: boolean,
): RepositoryProviderFailure {
  return Object.freeze({
    kind: temporary ? 'temporarily-unavailable' : 'permanently-unavailable',
    reason: failure.reason,
  });
}

export class RepositoryInspectorProvider {
  private state: ProviderState;
  private readonly retryDelayMs: number;

  constructor(
    feature: RepositoryFeatureConfig,
    private readonly factory: RepositoryObservationPortFactory,
    private readonly clock: MonotonicClock = PERFORMANCE_MONOTONIC_CLOCK,
  ) {
    this.retryDelayMs = feature.enabled ? feature.retryDelayMs : 0;
    this.state = feature.enabled
      ? { kind: 'idle' }
      : {
          kind: 'disabled',
          result: Object.freeze({
            ok: false,
            failure: Object.freeze({
              kind: 'feature-disabled',
              reason: 'feature-disabled',
            }),
          }),
        };
  }

  status(): RepositoryProviderStatus {
    return this.state.kind;
  }

  private latchInvariantFault(_failure: RepositoryAdapterFailure): void {
    const result: RepositoryProviderResult = Object.freeze({
      ok: false,
      failure: Object.freeze({
        kind: 'permanently-unavailable',
        reason: 'adapter-invariant-fault',
      }),
    });
    this.state = { kind: 'permanently-unavailable', result };
  }

  private async create(): Promise<RepositoryProviderResult> {
    let created: RepositoryObservationPortCreationResult;
    try {
      created = await this.factory((failure) => this.latchInvariantFault(failure));
    } catch {
      created = {
        ok: false,
        failure: { reason: 'adapter-invariant-fault', retryability: 'not-retryable' },
      };
    }
    if (created.ok) {
      if (this.state.kind === 'permanently-unavailable') {
        return this.state.result;
      }
      const result: RepositoryProviderResult = Object.freeze({
        ok: true,
        port: created.port,
      });
      this.state = { kind: 'available', result };
      return result;
    }
    const temporary = created.failure.retryability === 'retryable';
    const result: RepositoryProviderResult = Object.freeze({
      ok: false,
      failure: publicFailure(created.failure, temporary),
    });
    this.state = temporary
      ? {
          kind: 'cooldown',
          result,
          retryNotBefore: this.clock.now() + this.retryDelayMs,
        }
      : { kind: 'permanently-unavailable', result };
    return result;
  }

  get(): Promise<RepositoryProviderResult> {
    switch (this.state.kind) {
      case 'disabled':
      case 'available':
      case 'permanently-unavailable':
        return Promise.resolve(this.state.result);
      case 'creating':
        return this.state.promise;
      case 'cooldown':
        if (this.clock.now() < this.state.retryNotBefore) {
          return Promise.resolve(this.state.result);
        }
        this.state = { kind: 'idle' };
        return this.get();
      case 'idle': {
        const promise = Promise.resolve().then(async () => await this.create());
        this.state = { kind: 'creating', promise };
        return promise;
      }
    }
  }
}
