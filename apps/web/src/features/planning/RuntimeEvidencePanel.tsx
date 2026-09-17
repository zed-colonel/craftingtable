import { NativeVerificationPanel } from './NativeVerificationPanel.js';
import { useCallback, useEffect, useState } from 'react';
import { ActionBar } from '../../components/ActionBar.js';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import {
  configureRuntimeSchema,
  discoverRuntimeResponseSchema,
  evidenceSubmissionRequestSchema,
  inspectDependencyResponseSchema,
  runtimeEvidenceViewSchema,
  type ConfigureRuntime,
  type RuntimeEvidenceView,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { revealElement } from '../../lib/reveal-element.js';
import { request } from '../../lib/api-client.js';
export function RuntimeEvidencePanel({
  workspaceId,
  definitionId,
  bindingRevision,
  roadmapId,
  roadmapRevision,
  csrfToken,
  canMutate,
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
}) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/concurrency-definitions/${encodeURIComponent(definitionId)}/runtime`;
  const [view, setView] = useState<RuntimeEvidenceView>(),
    [config, setConfig] = useState<ConfigureRuntime>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [refs, setRefs] = useState<Record<string, string>>({}),
    [subject, setSubject] = useState(''),
    [evidence, setEvidence] = useState(''),
    [rationale, setRationale] = useState<Record<string, string>>({}),
    [planReviewed, setPlanReviewed] = useState<Record<string, boolean>>({});
  const adopt = useCallback((v: RuntimeEvidenceView) => {
    setView(v);
    setRefs(Object.fromEntries(v.current?.pins.map((p) => [p.alias, p.ref]) ?? []));
    setConfig({
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
    });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Saved revisions invalidate this read even when the endpoint identity stays unchanged.
  useEffect(() => {
    let alive = true;
    const load = () =>
      void request(base, runtimeEvidenceViewSchema)
        .then((v) => {
          if (alive) adopt(v);
        })
        .catch((e) => {
          if (alive) setError(e instanceof Error ? e.message : 'Could not load runtime evidence.');
        });
    load();
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === definitionId) load();
    };
    window.addEventListener('craftingtable:saved-plan-changed', changed);
    return () => {
      alive = false;
      window.removeEventListener('craftingtable:saved-plan-changed', changed);
    };
  }, [base, adopt, bindingRevision, roadmapRevision, definitionId]);
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
  const post = (action: string, body: unknown) =>
    request(`${base}/${action}`, runtimeEvidenceViewSchema, {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(body),
    });
  if (!view || !config)
    return <p role={error ? 'alert' : undefined}>{error || 'Loading dependency environments…'}</p>;
  const changedRefs = config.pins.some(
    (pin) => refs[pin.alias] !== undefined && refs[pin.alias] !== pin.ref,
  );
  const selected = view.subjects.find((s) => `${s.subject.kind}:${s.subject.sourceId}` === subject);
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
      <NativeVerificationPanel
        panelId={`${panelId}-native`}
        base={base}
        view={view}
        csrfToken={csrfToken}
        canMutate={canMutate}
        onSaved={adopt}
      />
      <About label="About dependency environments">
        <p>
          Pin exact source commits for builds. Review qualification evidence separately. Saving here
          does not start work or adopt map decisions.
        </p>
      </About>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {view.issues.length > 0 && (
        <ul>
          {view.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
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
      {view.planAcceptance && (
        <section id={`${panelId}-plan-acceptance`} aria-label="Saved plan acceptance">
          <h4>Saved plan acceptance · STACK-PLAN-ACCEPTED</h4>
          <p>
            Generate evidence from the saved roadmap and dependency setup. Unsaved form edits are
            not included. Generation records facts; your separate review and acceptance approve the
            plan.
          </p>
          {!view.planAcceptance.roadmaps.length && (
            <p>Save a cross-project roadmap first using Create cross-project roadmap above.</p>
          )}
          {view.planAcceptance.roadmaps
            .filter((r) => !roadmapId || r.roadmapId === roadmapId)
            .map((r) => (
              <div key={r.roadmapId}>
                <p>
                  <strong>{r.name}</strong> · Saved revision {r.definitionRevision} · Binding{' '}
                  {view.bindingRevision} · Environment generation{' '}
                  {view.current?.generation ?? 'not saved'}
                </p>
                <p role="status">
                  {r.state === 'accepted'
                    ? 'Plan evidence accepted. Start or Resume remains your action.'
                    : r.state === 'awaiting-review'
                      ? 'Evidence generated — awaiting your plan review.'
                      : r.state === 'ready-to-generate'
                        ? 'Saved configuration is ready to generate plan evidence.'
                        : 'Saved configuration needs attention before evidence can be generated.'}
                </p>
                {r.issues.length > 0 && (
                  <ul>
                    {r.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
                <ActionBar label="Plan acceptance actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || !canMutate || r.state !== 'ready-to-generate'}
                    onClick={() =>
                      void act(async () => {
                        const next = await post('generate-plan', {
                          roadmapId: r.roadmapId,
                          definitionRevision: r.definitionRevision,
                          snapshotDigest: r.snapshotDigest,
                        });
                        adopt(next);
                        const generated = next.planAcceptance?.roadmaps.find(
                          (p) => p.roadmapId === r.roadmapId,
                        );
                        setNotice(
                          'Plan evidence generated. Inspect the saved facts below, then record your independent plan review. No checkpoint has been accepted.',
                        );
                        if (generated?.submissionId)
                          revealElement(`${panelId}-submission-${generated.submissionId}`);
                      })
                    }
                  >
                    Generate plan-acceptance evidence
                  </button>
                  {r.submissionId && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => revealElement(`${panelId}-submission-${r.submissionId}`)}
                    >
                      Review generated plan evidence
                    </button>
                  )}
                </ActionBar>
              </div>
            ))}
        </section>
      )}
      <details id={`${panelId}-setup`}>
        <summary>Configure pinned dependencies and environments</summary>
        <fieldset disabled={busy || !canMutate || !bindingRevision}>
          <h4>Local development setup</h4>
          <p>
            Inspect the selected branches, discover required dependencies, and capture this
            workstation’s environment and installed Rust toolchains. Review the draft before saving.
          </p>
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
                const result = await request(`${base}/discover`, discoverRuntimeResponseSchema, {
                  method: 'POST',
                  headers: { 'x-craftingtable-csrf': csrfToken },
                  body: JSON.stringify({
                    bindingRevision,
                    refs: view.repositories.flatMap((r) => {
                      const ref = refs[r.alias] ?? r.integrationBranch;
                      return ref ? [{ alias: r.alias, ref }] : [];
                    }),
                  }),
                });
                setConfig(result.configuration);
                setNotice(result.notes.join(' '));
              })
            }
          >
            {busy ? 'Working…' : 'Discover local setup'}
          </button>
          <p>
            Discovery replaces the setup draft below. Nothing is saved or approved until you choose
            Save dependency environment. External native/Kata qualification is configured separately
            when its gates need evidence.
          </p>
          <p>
            Inspect a ref in a bound repository to discover its Cargo package mappings. The saved
            pin is an exact commit; later integration changes require a new generation and fresh
            evidence.
          </p>
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
                    const pin = await request(`${base}/inspect`, inspectDependencyResponseSchema, {
                      method: 'POST',
                      headers: { 'x-craftingtable-csrf': csrfToken },
                      body: JSON.stringify({
                        bindingRevision,
                        alias: repo.alias,
                        ref: refs[repo.alias] ?? repo.integrationBranch ?? '',
                      }),
                    });
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
                            config.pins.find((p) => p.alias === repo.alias)?.conformanceRevision ??
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
          <p>
            Record SHA-256 identities for the host/environment, fixtures and toolchain. External
            native and Kata checks are submitted as reviewed evidence; this does not provision a
            host, grant credentials or launch remote checks.
          </p>
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
            Saving a generation invalidates earlier evidence for this binding. Historical
            submissions remain available.
          </p>
          {changedRefs && (
            <p role="status">Inspect or rediscover the changed refs before saving.</p>
          )}
          <button
            className="secondary-button"
            type="button"
            disabled={changedRefs}
            onClick={() =>
              void act(async () => {
                const input = configureRuntimeSchema.parse(config);
                adopt(await post('configure', input));
                window.dispatchEvent(
                  new CustomEvent('craftingtable:runtime-saved', { detail: definitionId }),
                );
                setNotice(
                  'New dependency environment recorded. Prior evidence must be reassessed.',
                );
              })
            }
          >
            Save dependency environment
          </button>
        </fieldset>
      </details>
      <details id={`${panelId}-evidence`}>
        <summary>Submit qualification or checkpoint evidence</summary>
        <fieldset disabled={busy || !canMutate || !view.current}>
          <label className="field">
            Evidence subject
            <select
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setEvidence('');
              }}
            >
              <option value="">Select a slice, parent or checkpoint</option>
              {view.subjects.map((s) => (
                <option
                  key={`${s.subject.kind}:${s.subject.sourceId}`}
                  value={`${s.subject.kind}:${s.subject.sourceId}`}
                >
                  {s.subject.sourceId} · {s.subject.kind}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <>
              <p>
                {selected.title} · profile {selected.profile}
              </p>
              <p>Required independent roles: {selected.reviewerRoles.join(', ')}</p>
              <ul>
                {selected.requirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p>
                Cases:{' '}
                {selected.cases
                  .map((c) => `${c.id}${c.requiresKata ? ' (Kata)' : ''}`)
                  .join(', ') || 'No assigned cases.'}
              </p>
              {selected.issues.map((i) => (
                <p key={i}>{i}</p>
              ))}
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  setEvidence(
                    JSON.stringify(
                      {
                        runtimeId: view.current!.id,
                        subject: selected.subject,
                        testedCode: selected.testedRepositories.map((alias) => ({
                          alias,
                          commitSha: 'REPLACE_WITH_TESTED_COMMIT',
                        })),
                        environmentId: view.current!.environments[0]?.id ?? '',
                        executedBy: '',
                        executedAt: new Date().toISOString(),
                        reviewers: selected.reviewerRoles.map((role) => ({
                          identity: '',
                          roles: [role],
                          artifact: 'independent-review',
                        })),
                        requirements: selected.requirements.map((requirement) => ({
                          requirement,
                          artifact: 'verification-log',
                        })),
                        cases: selected.cases.map((c) => ({
                          id: c.id,
                          sourceRecordDigest: c.sourceRecordDigest,
                          result: 'passed',
                          artifact: 'verification-log',
                        })),
                        artifacts: [
                          { name: 'verification-log', content: '' },
                          { name: 'independent-review', content: '' },
                        ],
                        ...(selected.cases.some((c) => c.requiresKata)
                          ? {
                              kata: {
                                runtime: 'kata',
                                hostIdentity: '',
                                vmIdentity: '',
                                imageDigest: '',
                                configurationDigest: '',
                                observationArtifact: 'verification-log',
                                noNativeFallback: true,
                              },
                            }
                          : {}),
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                Prepare evidence template
              </button>
            </>
          )}
          <p>
            Fill in the template or upload an evidence JSON file. Include actual logs and
            independent review text; case names alone do not pass. Identities are external
            attestations that you review. Use sourceRunId only to explicitly reuse a successful
            historical review of the exact same source tree.
          </p>
          <label className="field">
            Evidence JSON file
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void act(async () => {
                    if (f.size > 5 * 1024 * 1024) throw new Error('Evidence file exceeds 5 MiB.');
                    setEvidence(await f.text());
                  });
              }}
            />
          </label>
          <label className="field">
            Evidence package
            <textarea rows={12} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={!evidence}
            onClick={() =>
              void act(async () => {
                adopt(
                  await post('submit', evidenceSubmissionRequestSchema.parse(JSON.parse(evidence))),
                );
                setEvidence('');
                setNotice(
                  'Evidence recorded for independent operator review. No checkpoint has been accepted yet.',
                );
              })
            }
          >
            Submit evidence for review
          </button>
        </fieldset>
      </details>
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
        <p>
          Records are frozen when a run ends and survive build-cache cleanup. A successful build is
          development evidence; qualification and publication still require their independent
          review.
        </p>
        {view.builds.map((b) => (
          <p key={b.runId}>
            Run{' '}
            <a
              href={`/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(b.runId)}`}
            >
              {b.runId}
            </a>{' '}
            · {b.successfulBuilds} successful clean builds {b.error && `· ${b.error}`}
            <br />
            <a href={`${base}/runs/${encodeURIComponent(b.runId)}/build-record`}>
              Download frozen build record
            </a>
          </p>
        ))}
      </details>
      <h4>Evidence review</h4>
      {!view.submissions.length && <p>No submissions yet.</p>}
      {view.submissions.map(({ submission: s, decision, issues }) => (
        <details key={s.id} id={`${panelId}-submission-${s.id}`}>
          <summary>
            {s.subject.sourceId} · {decision?.outcome ?? 'awaiting review'}
            {issues.length ? ' · blocked or stale' : ''}
          </summary>
          <p>
            Environment {s.environmentId} · tested {s.executedAt} · executor {s.executedBy}
          </p>
          <p>
            {s.generatedPlan ? (
              decision ? (
                `Plan review recorded by ${decision.decidedByUserId} as stack-integration-owner.`
              ) : (
                'Independent plan review pending: accepting below records your authenticated review as stack-integration-owner. The daemon only collected setup facts.'
              )
            ) : (
              <>
                Independent reviewers:{' '}
                {s.reviewers.map((r) => `${r.identity} (${r.roles.join(', ')})`).join('; ')}
              </>
            )}
          </p>
          <p>
            Code:{' '}
            <code className="import-digest">
              {s.subjectCommit ?? 'upstream pins in recorded generation'}
            </code>
          </p>
          {s.testedCode?.map((c) => (
            <p key={c.alias}>
              Tested {c.alias}: <code className="import-digest">{c.commitSha}</code>
            </p>
          ))}
          {issues.length > 0 && (
            <ul>
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          {s.artifacts.map((a) => (
            <details key={a.name}>
              <summary>{a.name}</summary>
              <code className="import-digest">SHA-256 {a.digest}</code>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.content}</pre>
            </details>
          ))}
          {decision ? (
            <p>
              {decision.outcome} · {decision.rationale}
            </p>
          ) : (
            <fieldset disabled={busy || !canMutate}>
              {s.generatedPlan && (
                <label className="field">
                  <span>
                    <input
                      type="checkbox"
                      checked={planReviewed[s.id] ?? false}
                      onChange={(e) =>
                        setPlanReviewed({ ...planReviewed, [s.id]: e.target.checked })
                      }
                    />{' '}
                    I reviewed the saved plan, bindings, decisions, reviewer assignments and
                    resources as stack-integration-owner.
                  </span>
                </label>
              )}
              <label className="field">
                Review decision rationale
                <textarea
                  value={rationale[s.id] ?? ''}
                  onChange={(e) => setRationale({ ...rationale, [s.id]: e.target.value })}
                />
              </label>
              {(['accepted', 'rejected'] as const).map((outcome) => (
                <button
                  className="secondary-button"
                  key={outcome}
                  type="button"
                  disabled={
                    !rationale[s.id]?.trim() ||
                    (outcome === 'accepted' &&
                      (issues.length > 0 || (!!s.generatedPlan && !planReviewed[s.id])))
                  }
                  onClick={() =>
                    void act(async () => {
                      adopt(
                        await post('decide', {
                          submissionId: s.id,
                          outcome,
                          rationale: rationale[s.id],
                        }),
                      );
                      setNotice(
                        s.generatedPlan && outcome === 'accepted'
                          ? 'Plan evidence accepted. Start or Resume the roadmap when ready.'
                          : `Evidence ${outcome}.`,
                      );
                      window.dispatchEvent(
                        new CustomEvent('craftingtable:runtime-saved', { detail: definitionId }),
                      );
                    })
                  }
                >
                  {outcome === 'accepted' ? 'Accept evidence' : 'Reject evidence'}
                </button>
              ))}
            </fieldset>
          )}
        </details>
      ))}
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
      <button
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={() => void act(async () => adopt(await request(base, runtimeEvidenceViewSchema)))}
      >
        Refresh evidence
      </button>
    </Section>
  );
}
