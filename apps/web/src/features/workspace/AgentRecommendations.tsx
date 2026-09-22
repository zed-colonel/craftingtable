import { About } from '../../components/About.js';
export function AgentRecommendations() {
  return (
    <About label="Suggested models and where to set them">
      <p>
        Starting recommendations for scoped development; review results and usage per completed item
        before broad rollout. These suggestions do not change your saved profiles.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>UI field</th>
              <th>Starting choice</th>
              <th>Use an override when…</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                'Design',
                'GPT-6 Astra · High',
                'Architecture and cross-project decisions remain with the operator.',
              ],
              [
                'Implementation',
                'GPT-6 Sol · Medium',
                'Choose Astra · High for difficult concurrency, lifecycle or security work.',
              ],
              [
                'Remediation',
                'GPT-6 Sol · High',
                'Choose Astra · High for systemic defects or repeated unsuccessful repairs.',
              ],
              [
                'Review',
                'GPT-6 Astra · High',
                'Includes ordinary reviews and independent slice verification.',
              ],
              [
                'Specialist overrides → Security review',
                'Inherit Review',
                'Extra high effort can help with the hardest security reviews.',
              ],
              [
                'Specialist overrides → Technical checkpoint review',
                'Inherit Review',
                'Retain Astra for semantic compatibility and contract judgment.',
              ],
              [
                'Specialist overrides → Parent acceptance',
                'Inherit Review',
                'Retain Astra for whole-parent conformance.',
              ],
              [
                'Specialist overrides → Integration conflict resolution',
                'GPT-6 Sol · High',
                'Choose Astra when resolving the conflict requires architectural judgment.',
              ],
              [
                'Specialist overrides → Evidence investigation',
                'GPT-6 Sol · Medium',
                'Read-only fact gathering and bounded reassessment; cannot approve architecture.',
              ],
              [
                'Plan → Finalization → Stage reviewer / Stage implementation agent',
                'Astra · High for correctness, conformance, simplification and final review',
                'Use Sol · Medium for selected polish, documentation and straightforward nits.',
              ],
            ].map(([field, choice, note]) => (
              <tr key={field}>
                <th scope="row">{field}</th>
                <td>{choice}</td>
                <td>{note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        For a harder individual scope, open Roadmap agent profiles below, select that scope and
        apply its override. Finalization keeps its separate stage profiles. Luna is not recommended
        as the initial reviewer for this stack.
      </p>
      <p>
        Model positioning:{' '}
        <a href="https://learn.chatgpt.com/docs/models" target="_blank" rel="noreferrer">
          OpenAI model guidance
        </a>
        . Effort choices are sent to Codex; leaving effort unset preserves local configuration.
      </p>
    </About>
  );
}
