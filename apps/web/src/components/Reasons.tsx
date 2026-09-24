/**
 * Why something is waiting, grouped by who can move it.
 *
 * The daemon reports typed reasons (dependency, evidence, review,
 * authorization, resource, capacity, exclusion, attention, automation). The
 * kind alone does not tell the operator whether to act, so reasons are shown
 * under one of three headings: things only the operator can resolve, things
 * automation will resolve on its own, and things waiting on other work.
 */
export type ReasonKind =
  | 'authorization'
  | 'attention'
  | 'review'
  | 'resource'
  | 'capacity'
  | 'automation'
  | 'dependency'
  | 'evidence'
  | 'exclusion';

export interface Reason {
  readonly kind: ReasonKind;
  readonly text: string;
  /**
   * Who resolves it, when the daemon says so (a phase blocker's code). An operator-owned
   * reason is "Needs you" whatever its kind, e.g. plan acceptance evidence (UI-09).
   */
  readonly owner?: 'operator' | 'controller';
}

type Resolver = 'you' | 'automation' | 'other-work';

const RESOLVER: Readonly<Record<ReasonKind, Resolver>> = {
  authorization: 'you',
  attention: 'you',
  review: 'you',
  resource: 'automation',
  capacity: 'automation',
  automation: 'automation',
  dependency: 'other-work',
  evidence: 'other-work',
  exclusion: 'other-work',
};

const RESOLVER_LABELS: Readonly<Record<Resolver, string>> = {
  you: 'Needs you',
  automation: 'Waiting on automation',
  'other-work': 'Waiting on other work',
};

export const REASON_KIND_LABELS: Readonly<Record<ReasonKind, string>> = {
  authorization: 'Authorization',
  attention: 'Attention',
  review: 'Review',
  resource: 'Resource',
  capacity: 'Capacity',
  automation: 'Automation',
  dependency: 'Dependency',
  evidence: 'Evidence',
  exclusion: 'Exclusion',
};

const ORDER: readonly Resolver[] = ['you', 'automation', 'other-work'];

function resolverOf(reason: Reason): Resolver {
  return reason.owner === 'operator' ? 'you' : RESOLVER[reason.kind];
}

export function Reasons({
  reasons,
  satisfied,
}: {
  reasons: readonly Reason[];
  /** Shown when there are no reasons, so "nothing is waiting" is explicit. */
  satisfied?: string;
}) {
  if (reasons.length === 0) {
    return satisfied === undefined ? null : <p className="reasons-satisfied">{satisfied}</p>;
  }
  const unique = reasons.filter(
    (reason, index) =>
      reasons.findIndex((other) => other.kind === reason.kind && other.text === reason.text) ===
      index,
  );
  const groups = ORDER.map((resolver) => ({
    resolver,
    entries: unique.filter((reason) => resolverOf(reason) === resolver),
  })).filter((group) => group.entries.length > 0);
  return (
    <div className="reasons">
      {groups.map((group) => (
        <div key={group.resolver} className={`reason-group reason-group-${group.resolver}`}>
          <h4 className="reason-group-title">{RESOLVER_LABELS[group.resolver]}</h4>
          <ul>
            {group.entries.map((reason) => (
              <li key={`${reason.kind}:${reason.text}`}>
                <span className="reason-kind">{REASON_KIND_LABELS[reason.kind]}</span>
                <span className="reason-text">{reason.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
