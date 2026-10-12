import { ArchitectureDecisions } from '../../decisions/architecture/ArchitectureDecisions.js';
import { EvidenceReview } from '../../decisions/evidence/EvidenceReview.js';
import { SubmitEvidence } from '../../decisions/evidence/SubmitEvidence.js';
import { PlanAcceptance } from '../../decisions/plan-acceptance/PlanAcceptance.js';
import { SetupStepPart } from './setup-steps.js';
import { MapCapabilities } from './MapCapabilities.js';
import { EnvironmentApproval } from '../../decisions/environment/EnvironmentApproval.js';
import { UpstreamTransitions } from '../../decisions/upstream/UpstreamTransitions.js';
import { DependencyRefresh } from '../../decisions/refresh/DependencyRefresh.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionBar } from '../../components/ActionBar.js';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import {
  configureRuntimeSchema,
  type RequestInput,
  type RuntimeEvidenceView,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { revealElement } from '../../lib/reveal-element.js';
import {
  buildRecordAddress,
  configureRuntime,
  discoverRuntime,
  inspectDependency,
  readRuntime,
  runtimeAddress,
} from '../../lib/runtime-evidence-api.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';

/** The dependency environment's setup as this form drafts and sends it. */
type RuntimeConfiguration = RequestInput<typeof configureRuntimeSchema>;
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';
import type { AgentRunId } from '@craftingtable/domain';
export function RuntimeEvidencePanel({
  workspaceId,
  definitionId,
  bindingRevision,
  roadmapId,
  roadmapRevision,
  csrfToken,
  canMutate,
  roadmapSettingsDirty = false,
  onViewChange,
  onDraftChange,
  panelId = `runtime-evidence-${definitionId}`,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  bindingRevision: number;
  roadmapId?: string;
  roadmapRevision?: number;
  csrfToken: string;
  canMutate: boolean;
  panelId?: string;
  roadmapSettingsDirty?: boolean;
  onViewChange?: (roadmapId: string, view: RuntimeEvidenceView) => void;
  onDraftChange?: (roadmapId: string, dirty: boolean) => void;
}) {
  const base = runtimeAddress(workspaceId, definitionId);
  /** A download from the API, not a page: a plain anchor (R-E1). */
  const buildRecordDownload = (runId: string) => buildRecordAddress(base, runId);
  // The map's environment, shared with the setup-time decisions and re-read on its events (R-D4).
  const store = useQueryStore();
  const key = queryKeys.runtime(workspaceId, definitionId);
  const runtime = useQuery(key, () => readRuntime(workspaceId, definitionId));
  const view = runtime.data;
  const [config, setConfig] = useState<RuntimeConfiguration>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [savedConfig, setSavedConfig] = useState('');
  /** Whether the setup form holds unsaved edits; set on every render below. */
  const setupDirty = useRef(false);
  const [refs, setRefs] = useState<Record<string, string>>({});
  /** The setup form follows a view: its pins, consumers and environments. */
  const adoptDraft = useCallback((v: RuntimeEvidenceView) => {
    setRefs(Object.fromEntries(v.current?.pins.map((p) => [p.alias, p.ref]) ?? []));
    const nextConfig: RuntimeConfiguration = {
      bindingRevision: v.bindingRevision,
      expectedGeneration: v.current?.generation ?? 0,
      pins:
        v.current?.pins.map((p) => ({
          alias: p.alias,
          ref: p.ref,
          expectedCommitSha: p.commitSha,
          conformanceRevision: p.conformanceRevision,
          packages: p.packages,
        })) ?? [],
      consumers:
        v.current?.consumers ??
        v.repositories
          .filter((r) => r.role === 'planned_application')
          .map((r) => ({ alias: r.alias, upstreams: [] })),
      environments: v.current?.environments ?? [],
    };
    setConfig(nextConfig);
    setSavedConfig(JSON.stringify(nextConfig));
  }, []);
  /** A command's response is the view, and the form follows it. */
  const adopt = useCallback(
    (v: RuntimeEvidenceView) => {
      store.set(queryKeys.runtime(workspaceId, definitionId), v);
      adoptDraft(v);
    },
    [store, workspaceId, definitionId, adoptDraft],
  );
  useEffect(() => {
    if (roadmapId && view) onViewChange?.(roadmapId, view);
  }, [roadmapId, view, onViewChange]);
  // A view read in the background keeps an unsaved setup draft: only the view under it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft follows each new view.
  useEffect(() => {
    if (view && (config === undefined || !setupDirty.current)) adoptDraft(view);
  }, [view]);
  // A saved binding or roadmap revision changes what this view shows: read it again at once.
  const revisions = useRef(`${bindingRevision}:${roadmapRevision}`);
  useEffect(() => {
    const next = `${bindingRevision}:${roadmapRevision}`;
    if (revisions.current === next) return;
    revisions.current = next;
    store.refreshNow([queryKeys.runtime(workspaceId, definitionId)]);
  }, [store, workspaceId, definitionId, bindingRevision, roadmapRevision]);
  /** The map's supervision previews show what was saved here: read again at once. */
  const runtimeSaved = () => store.refreshNow([['cross-project', workspaceId, definitionId]]);
  const loadError =
    runtime.error === undefined
      ? ''
      : runtime.error instanceof Error
        ? runtime.error.message
        : 'Could not load runtime evidence.';
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  /** Saving the dependency environment: configuration, not a decision (R-A6). */
  const configure = (body: RuntimeConfiguration) => configureRuntime(base, body, csrfToken);
  const dependencyDirty =
    !!config &&
    (JSON.stringify(config) !== savedConfig ||
      config.pins.some((pin) => refs[pin.alias] !== undefined && refs[pin.alias] !== pin.ref));
  useEffect(() => {
    if (roadmapId) onDraftChange?.(roadmapId, dependencyDirty);
  }, [roadmapId, dependencyDirty, onDraftChange]);
  // Evidence recorded by automation shows without navigation (PERF-03, UI-13).
  // An unsaved setup draft is kept: only the view is replaced under it.
  setupDirty.current = dependencyDirty;
  if (!view || !config)
    return (
      <p role={error || loadError ? 'alert' : undefined}>
        {error || loadError || 'Loading dependency environments…'}
      </p>
    );
  const changedRefs = config.pins.some(
    (pin) => refs[pin.alias] !== undefined && refs[pin.alias] !== pin.ref,
  );
  const configDirty = JSON.stringify(config) !== savedConfig;
  const unsavedSetup = roadmapSettingsDirty || configDirty || changedRefs;
  // Decisions bind to the map and its binding, not to queued roadmap settings: an unsaved
  // settings field beside them does not hold an approval (UI-17). Unsaved dependency edits do.
  const unsavedDependencies = configDirty || changedRefs;
  return (
    <Section
      id={panelId}
      className="runtime-evidence"
      title="Dependency environments and evidence"
      summary={
        view.current
          ? `Generation ${view.current.generation} · binding ${view.bindingRevision}`
          : 'No dependency environment configured.'
      }
    >
      <SetupStepPart step="verification">
        <EnvironmentApproval
          panelId={`${panelId}-native`}
          base={base}
          view={view}
          csrfToken={csrfToken}
          canMutate={canMutate}
          onSaved={adopt}
        />
      </SetupStepPart>
      <SetupStepPart step="dependency" id={`${panelId}-dependency-step`}>
        <UpstreamTransitions
          base={base}
          view={view}
          csrfToken={csrfToken}
          canMutate={canMutate}
          onSaved={adopt}
        />
      </SetupStepPart>
      <About label="About dependency environments">
        <p>
          Pin exact source commits for builds. Review qualification evidence separately. Saving here
          does not start work or adopt scheduling proposals.
        </p>
      </About>
      {view.capabilities && (
        <SetupStepPart
          step={['dependency', 'verification', 'plan-acceptance', 'decisions', 'evidence']}
        >
          <MapCapabilities capabilities={view.capabilities} />
        </SetupStepPart>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {/* Outside every setup step: the draft holds decisions shown on other steps (R-A6 review). */}
      {unsavedDependencies && (
        <p role="status" className="warning-state">
          Dependency changes are not saved. Shared decisions and evidence acceptance wait until you
          save or discard them under Dependency environment.
        </p>
      )}
      {view.issues.length > 0 && (
        <ul>
          {distinct(view.issues).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <SetupStepPart step="dependency">
        <DependencyRefresh
          base={base}
          view={view}
          csrfToken={csrfToken}
          disabled={!canMutate || busy || unsavedSetup}
          onSaved={(next) => {
            adopt(next);
            runtimeSaved();
          }}
        />
      </SetupStepPart>
      <SetupStepPart step={[]}>
        <ActionBar label="Dependency setup and evidence">
          <button
            type="button"
            className="secondary-button"
            onClick={() => revealElement(`${panelId}-setup`)}
          >
            Set up dependencies
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => revealElement(`${panelId}-evidence`)}
          >
            Review checkpoint evidence
          </button>
        </ActionBar>
      </SetupStepPart>
      <SetupStepPart step="plan-acceptance">
        <PlanAcceptance
          workspaceId={workspaceId}
          definitionId={definitionId}
          base={base}
          view={view}
          roadmapId={roadmapId}
          csrfToken={csrfToken}
          disabled={busy || !canMutate}
          unsaved={unsavedSetup}
          panelId={panelId}
          onChanged={(next) => {
            adopt(next);
            runtimeSaved();
          }}
        />
      </SetupStepPart>
      <SetupStepPart step="decisions" id={`${panelId}-decisions-step`}>
        <div id={`${panelId}-decisions`}>
          <ArchitectureDecisions
            workspaceId={workspaceId}
            definitionId={definitionId}
            view={view}
            roadmapId={roadmapId}
            csrfToken={csrfToken}
            disabled={busy || !canMutate || unsavedDependencies}
            onChanged={(next) => {
              adopt(next);
              setNotice('Shared decision updated. Design continuation remains a separate action.');
            }}
          />
        </div>
      </SetupStepPart>
      <SetupStepPart step="dependency">
        <details id={`${panelId}-setup`}>
          <summary>Configure pinned dependencies and environments</summary>
          <fieldset disabled={busy || !canMutate || !bindingRevision}>
            <h4>Local development setup</h4>
            <About label="About local setup">
              <p>
                Inspect the selected branches, discover required dependencies, and capture this
                workstation’s environment and installed Rust toolchains. Review the draft before
                saving.
              </p>
            </About>
            <ul>
              {view.repositories
                .filter((r) => r.role === 'planned_application')
                .map((r) => (
                  <li key={r.alias}>
                    {r.alias.toUpperCase()} needs{' '}
                    {r.requiredUpstreams.map((a) => a.toUpperCase()).join(' and ') ||
                      'no upstream pins'}
                    .
                  </li>
                ))}
            </ul>
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                void act(async () => {
                  const result = await discoverRuntime(
                    base,
                    {
                      bindingRevision,
                      refs: view.repositories.flatMap((r) => {
                        const ref = refs[r.alias] ?? r.integrationBranch;
                        return ref ? [{ alias: r.alias, ref }] : [];
                      }),
                    },
                    csrfToken,
                  );
                  setConfig(result.configuration);
                  setNotice(result.notes.join(' '));
                })
              }
            >
              {busy ? 'Working…' : 'Discover local setup'}
            </button>
            <p>
              Discovery replaces the draft below. Nothing is saved until you choose Save dependency
              environment.
            </p>
            <About label="About pins">
              <p>
                Inspect a ref in a bound repository to discover its Cargo package mappings. The
                saved pin is an exact commit. Use Preview dependency refresh after integration
                advances to see which evidence remains applicable and which reviews must run again.
                External native/Kata qualification is configured separately when its gates need
                evidence.
              </p>
              <p>
                After a save, changed environment inputs require native approval and changed
                dependencies require affected reviews. Historical evidence is retained.
              </p>
            </About>
            {view.repositories.map((repo) => (
              <div key={repo.alias}>
                <label className="field">
                  {repo.alias} · branch or commit
                  <input
                    value={refs[repo.alias] ?? repo.integrationBranch ?? ''}
                    onChange={(e) => setRefs({ ...refs, [repo.alias]: e.target.value })}
                  />
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!repo.configured}
                  onClick={() =>
                    void act(async () => {
                      const pin = await inspectDependency(
                        base,
                        {
                          bindingRevision,
                          alias: repo.alias,
                          ref: refs[repo.alias] ?? repo.integrationBranch ?? '',
                        },
                        csrfToken,
                      );
                      setConfig({
                        ...config,
                        pins: [
                          ...config.pins.filter((p) => p.alias !== repo.alias),
                          {
                            alias: repo.alias,
                            ref: refs[repo.alias] ?? repo.integrationBranch ?? '',
                            expectedCommitSha: pin.commitSha,
                            packages: pin.packages,
                            conformanceRevision:
                              config.pins.find((p) => p.alias === repo.alias)
                                ?.conformanceRevision ??
                              repo.conformanceRevision ??
                              '',
                          },
                        ],
                      });
                      setNotice(
                        `Inspected ${repo.alias} at ${pin.commitSha}. Record its conformance revision; all discovered publishable crates will be supplied.`,
                      );
                    })
                  }
                >
                  Inspect {repo.alias}
                </button>
              </div>
            ))}
            {config.pins.map((pin, index) => (
              <div key={pin.alias}>
                <h4>{pin.alias}</h4>
                <p>
                  Ref {pin.ref}
                  <br />
                  <code className="import-digest">{pin.expectedCommitSha}</code>
                </p>
                <label className="field">
                  Conformance revision
                  <input
                    value={pin.conformanceRevision}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        pins: config.pins.map((p, i) =>
                          i === index ? { ...p, conformanceRevision: e.target.value } : p,
                        ),
                      })
                    }
                  />
                </label>
                <p>Supplied crates: {pin.packages.map((p) => p.name).join(', ')}</p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    setConfig({
                      ...config,
                      pins: config.pins.filter((p) => p.alias !== pin.alias),
                      consumers: config.consumers.map((c) => ({
                        ...c,
                        upstreams: c.upstreams.filter((u) => u !== pin.alias),
                      })),
                    })
                  }
                >
                  Remove {pin.alias} pin
                </button>
              </div>
            ))}
            {config.consumers.map((consumer, index) => (
              <fieldset key={consumer.alias}>
                <legend>Dependencies supplied to {consumer.alias}</legend>
                {config.pins
                  .filter((p) => p.alias !== consumer.alias)
                  .map((pin) => (
                    <label className="checkbox-row" key={pin.alias}>
                      <input
                        type="checkbox"
                        checked={consumer.upstreams.includes(pin.alias)}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            consumers: config.consumers.map((c, i) =>
                              i === index
                                ? {
                                    ...c,
                                    upstreams: e.target.checked
                                      ? [...c.upstreams, pin.alias]
                                      : c.upstreams.filter((u) => u !== pin.alias),
                                  }
                                : c,
                            ),
                          })
                        }
                      />
                      {pin.alias}
                    </label>
                  ))}
              </fieldset>
            ))}
            <h4>Qualification environments</h4>
            <About label="About qualification environments">
              <p>
                Record SHA-256 identities for the host/environment, fixtures and toolchain. External
                native and Kata checks are submitted as reviewed evidence; this does not provision a
                host, grant credentials or launch remote checks.
              </p>
            </About>
            {config.environments.map((env, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Controlled inputs; editable names are not stable keys.
              <fieldset key={index}>
                <legend>Environment {index + 1}</legend>
                {env.discovery && (
                  <details>
                    <summary>Captured local fingerprint inputs</summary>
                    <p>
                      Observed configuration only. These fingerprints do not establish passing tests
                      or native/Kata qualification.
                    </p>
                    <h5>Workstation</h5>
                    <pre>{env.discovery.environment}</pre>
                    <h5>Imported fixture sources</h5>
                    <pre>{env.discovery.fixtures}</pre>
                    <h5>Installed toolchains</h5>
                    <pre>{env.discovery.toolchains}</pre>
                  </details>
                )}
                <label className="field">
                  Environment name
                  <input
                    value={env.id}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        environments: config.environments.map((v, i) =>
                          i === index ? { ...v, id: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </label>
                <label className="field">
                  Kind
                  <select
                    disabled={!!env.discovery}
                    value={env.kind}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        environments: config.environments.map((v, i) =>
                          i === index ? { ...v, kind: e.target.value as typeof env.kind } : v,
                        ),
                      })
                    }
                  >
                    <option value="local-development">Local development</option>
                    <option value="external-native">External native qualification</option>
                    <option value="external-kata">Actual Kata qualification</option>
                  </select>
                </label>
                {(
                  ['identityDigest', 'fixtureDigest', 'toolchainDigest', 'authorization'] as const
                ).map((field) => (
                  <label className="field" key={field}>
                    {
                      {
                        identityDigest: 'Environment SHA-256',
                        fixtureDigest: 'Fixture SHA-256',
                        toolchainDigest: 'Toolchain SHA-256',
                        authorization: 'Authorization and scope',
                      }[field]
                    }
                    <input
                      readOnly={!!env.discovery && field !== 'authorization'}
                      value={env[field]}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          environments: config.environments.map((v, i) =>
                            i === index ? { ...v, [field]: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    setConfig({
                      ...config,
                      environments: config.environments.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove environment
                </button>
              </fieldset>
            ))}
            <button
              className="secondary-button"
              type="button"
              onClick={() =>
                setConfig({
                  ...config,
                  environments: [
                    ...config.environments,
                    {
                      id: '',
                      kind: 'local-development',
                      identityDigest: '',
                      fixtureDigest: '',
                      toolchainDigest: '',
                      authorization: '',
                    },
                  ],
                })
              }
            >
              Add environment
            </button>

            <p>
              {configDirty || changedRefs
                ? 'Unsaved dependency changes. Saving creates a new generation and requires plan acceptance.'
                : view.current
                  ? `Dependency settings saved · generation ${view.current.generation}. No dependency save needed.`
                  : 'Discover or enter the dependency environment before saving.'}
            </p>
            {changedRefs && (
              <p role="status">Inspect or rediscover the changed refs before saving.</p>
            )}
            <button
              className="secondary-button"
              type="button"
              disabled={changedRefs || (!configDirty && !!view.current)}
              onClick={() =>
                void act(async () => {
                  const input = configureRuntimeSchema.parse(config);
                  adopt(await configure(input));
                  runtimeSaved();
                  setNotice(
                    'New dependency environment recorded. Unchanged inputs retain their evidence; affected roadmap reviews are queued for Resume. Review plan acceptance.',
                  );
                })
              }
            >
              Save dependency environment
            </button>
          </fieldset>
        </details>
      </SetupStepPart>
      <SetupStepPart step="evidence" id={`${panelId}-evidence-step`}>
        <SubmitEvidence
          id={`${panelId}-evidence`}
          base={base}
          view={view}
          csrfToken={csrfToken}
          disabled={busy || !canMutate}
          onSubmitted={adopt}
        />
        {view.upstreamHistory.length > 0 && (
          <details>
            <summary>Existing upstream review history</summary>
            <p>
              These are candidate records for explicit reuse. A prior AQ finalization does not
              automatically accept its baseline or publication checkpoint.
            </p>
            <ul>
              {view.upstreamHistory.map((r) => (
                <li key={r.runId}>
                  {r.alias} · {r.label}
                  <br />
                  Run <code>{r.runId}</code>
                  <br />
                  <code className="import-digest">{r.headSha}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
        <details>
          <summary>Pinned build records ({view.builds.length} recent runs)</summary>
          <p className="hint">
            Records freeze when a run ends and survive cache cleanup. A passing build is development
            evidence; qualification and publication still need independent review.
          </p>
          {view.builds.map((b) => (
            <p key={b.runId}>
              Run{' '}
              <Link
                route={{
                  name: 'run',
                  workspaceId: workspaceId as WorkspaceId,
                  runId: b.runId as AgentRunId,
                }}
              >
                {b.runId}
              </Link>{' '}
              · {b.successfulBuilds} successful clean builds
              {b.receiptAuthority === 'agent' && (
                <span title="Recorded before CraftingTable ran checks itself: the agent wrote these receipts.">
                  {' '}
                  · agent-reported
                </span>
              )}{' '}
              {b.error && `· ${b.error}`}
              <br />
              <a href={buildRecordDownload(b.runId)}>Download frozen build record</a>
            </p>
          ))}
        </details>
        <h4>Evidence review</h4>
        {!view.submissions.length && <p>No submissions yet.</p>}
        {view.submissions.map((entry) => (
          <EvidenceReview
            key={entry.submission.id}
            id={`${panelId}-submission-${entry.submission.id}`}
            workspaceId={workspaceId}
            definitionId={definitionId}
            base={base}
            view={view}
            entry={entry}
            csrfToken={csrfToken}
            disabled={busy || !canMutate}
            unsavedSetup={unsavedSetup}
            onDecided={(next, message) => {
              adopt(next);
              setNotice(message);
              runtimeSaved();
            }}
          />
        ))}
      </SetupStepPart>
      <SetupStepPart step="dependency">
        {view.history.length > 1 && (
          <details>
            <summary>Environment history ({view.history.length} generations)</summary>
            {view.history.map((g) => (
              <p key={g.id}>
                Generation {g.generation} · {g.createdAt}
                <br />
                <code className="import-digest">{g.digest}</code>
              </p>
            ))}
          </details>
        )}
      </SetupStepPart>
      <button
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={() => void act(async () => adopt(await readRuntime(workspaceId, definitionId)))}
      >
        Refresh evidence
      </button>
    </Section>
  );
}
