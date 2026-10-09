import type { MapCapabilitiesView } from '@craftingtable/contracts';
import { About } from '../../components/About.js';

type Gap = MapCapabilitiesView['gaps'][number];

/** One gap as the operator reads it, chosen by its code, never by prose (R-F2 part 5). */
function gapText(gap: Gap): string {
  switch (gap.code) {
    case 'plan-checkpoint-ambiguous':
      return `Several stack plan approvals (${gap.checkpointIds.join(', ')}): none is the plan checkpoint, so plan acceptance needs reviewed evidence.`;
    case 'plan-owner-unrecognized':
      return `${gap.checkpointId} is a plan approval owned by ${gap.owner}, not the stack: it is not the plan checkpoint.`;
    case 'plan-contract-changed':
      return `${gap.checkpointId}'s contract differs from the attested one (${gap.fields.join(', ')}): plan evidence is submitted and reviewed by hand.`;
    case 'decision-contract-changed':
      return `${gap.checkpointId} is reviewed under ${gap.profileId}, which differs (${gap.fields.join(', ')}): it is not prepared or decided as a shared decision.`;
    case 'security-role-undeclared':
      return 'No evidence profile names a security reviewer, so no roadmap can delegate a security review.';
    case 'recovery-profile-unrecognized':
      return `Contract checkpoints the operator cannot recover without a delegated review: ${gap.checkpointIds.join(', ')}.`;
    case 'resource-adapter-missing':
      return `No daemon adapter runs ${gap.resourceId}: work that needs it waits for evidence submitted by hand.`;
    case 'resource-adapter-unusable':
      return `${gap.resourceId} asks for what its ${gap.adapter} adapter cannot provide (${gap.fields.join(', ')}).`;
  }
}

/**
 * What the controller cannot automate on this map, and each slice's build classification, as
 * the daemon reads them (R-F2 part 5). A reworded contract or a renamed id or role shows here
 * as a typed gap instead of changing behaviour silently.
 */
export function MapCapabilities({ capabilities }: { capabilities: MapCapabilitiesView }) {
  const { gaps, builds } = capabilities;
  const scoped = builds.filter((b) => b.mode === 'scoped-checks');
  const current = builds.filter((b) => b.mode === 'current-upstream-build');
  return (
    <details className="map-capabilities">
      <summary>
        What CraftingTable cannot automate here ({gaps.length}) · build classification
      </summary>
      <About label="About map capabilities">
        <p>
          CraftingTable recognizes a map's plan, decision and resource contracts by their declared
          ids and attested wording. Anything it does not recognize stays manual and is listed here.
        </p>
        <p>
          A slice with scoped checks builds without the current upstream pins (ADR-053); a slice
          whose upstream links have all moved to their pins builds against them anyway.
        </p>
      </About>
      {gaps.length ? (
        <ul aria-label="Capability gaps">
          {gaps.map((gap) => (
            <li key={`${gap.code}:${gapText(gap)}`}>{gapText(gap)}</li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">Every contract, role and resource of this map is recognized.</p>
      )}
      <p>
        Builds: {scoped.length} {scoped.length === 1 ? 'slice' : 'slices'} with scoped checks,{' '}
        {current.length} against the current upstream pins.
      </p>
      <details>
        <summary>Build classification by slice</summary>
        <ul aria-label="Build classification">
          {builds.map((b) => (
            <li key={b.sliceId}>
              <code>{b.sliceId}</code> ·{' '}
              {b.mode === 'scoped-checks' ? 'scoped checks' : 'current upstream build'}
            </li>
          ))}
        </ul>
      </details>
    </details>
  );
}
