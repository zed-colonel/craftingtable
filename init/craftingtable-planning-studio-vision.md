# Planning Studio: vision

- **Status:** draft 1, 2026-10-18, reviewed by the operator. Background on intent, like the
  rest of `init/`, not authority: the decisions it implies are made in ADRs and register
  items when they become relevant (see Open questions).
- **Source:** the operator's voice notes (Dev Cycles, Planning Interface, User Interaction,
  Self-Modification) and a design conversation on 2026-10-18.
- **Builds on:** ADR-028 (roadmaps and Planning Studio boundaries), the planning and
  implementation feedback-loop addendum, ADR-030 (parallel roadmaps), ADR-059 (shared design
  decisions), ADR-075 (an accelerator, not a guardian), `docs/ui/` target UI.
- **Meant to steer:** R-F5 (P4, format additions before the Studio), R-F6 (P5, the Studio
  format family), R-G8 and R-G12 (P5, backends and runs that outlive the daemon).

## Thesis

CraftingTable automates the machinery of the software lifecycle and keeps a person at the top
of it. Whoever drives a plan, whether the operator in chat or an agent acting for them, works
within authority the operator granted. Every decision is recorded, and every record is
truthful.

The Planning Studio is how that person drives it. It becomes the primary control plane: a
chat window with file and screenshot inclusion, from first idea through plan, roadmap,
execution and change. Every surface built so far stays available for power users.

## Who it is for

CraftingTable is built for one operator, and that shapes every default. It is also a public
repository, so nothing hard-codes that one operator: not the user, the agent backend, the
model, or the stack. Flexibility is a goal in itself. The same tool should adapt to a team
with real infrastructure without being rebuilt (see Future directions).

## Principles

1. **The conversation is the view; the plan is the state.** Every choice made in chat becomes
   a typed decision record: the question, the alternatives, the choice, the rationale, and what
   depends on it. That record is what makes impact analysis, branching and audit possible.
2. **What the application does is never assumed.** Its core jobs are always shown to the
   operator and confirmed. Every other decision rests on them, so a wrong assumption there
   does the most damage.
3. **Assumptions are visible.** Vibe-coding tools make the same decisions silently. The Studio
   makes them too, when the operator wants it to, but shows each one as a decision that can
   be changed.
4. **Branches are draft revisions.** Branching from a turn starts a candidate plan revision.
5. **Autonomy is policy.** It is a set of revocable grants, by class of decision, with
   defaults and per-plan overrides.
6. **Everything is mutable; every record is truthful.** Cycles, policies, topics and settings
   can all change, including dropping review. The record always says what actually happened:
   an unreviewed merge is marked unreviewed, and a skipped check shows as skipped, never as
   passed. This is ADR-075 applied to process.
7. **The engine is a service; the chat is one client.** Planning state, decision cards and
   policy live in an engine with a typed interface. The chat window is one client, and an
   agent can be another.

## The conversation

It should feel like any AI chat or coding agent. What differs is that it has one purpose,
which gives it guardrails, defined patterns, and an end.

### Flow

1. **Intake.** The operator gives a prompt, plus any files, screenshots or pasted text.
2. **Playback.** The agent sums up what it understood, including what it assumed and which
   inherited settings apply.
3. **Questions in batches,** two to four at a time, in dependency order.
4. **Alternatives** for architecture and stack, once their dependencies are settled.
5. **Draft plan:** work items, operator steps, and a roadmap whose shape follows from the plan.
6. **Adopt.** Execution begins. Questions and roadblocks from running work come back into the
   same conversation, on the same cards.

The operator can leave the script at any point:

- **"You decide the rest."** Open topics become assumptions, shown on one summary card.
- **"Ask me everything."** Assumptions are asked as questions instead.

### The script

The script is a checklist of planning topics (below), not a fixed sequence. A detailed prompt
settles most topics, and a short one settles few. The same script therefore produces very
different conversations for different users.

Each topic is in one of five states:

- **Answered:** by the operator, or by their prompt or files.
- **Assumed:** the agent used its default and showed it.
- **Derived:** computed from other answers, then confirmed.
- **Skipped:** with a one-line reason, shown so the operator can overrule it.
- **Open:** still needs an answer.

Rules:

- **Order.** Each batch takes the open topics whose dependencies are settled, roughly in tier
  order.
- **"Not sure" is always an answer.** The agent takes its recommendation and marks the topic
  Assumed, or offers research.
- **Done** means no topic is Open. Then the draft plan follows.
- **Changing an answer reopens its dependents,** and the Studio shows which ones.
- **The checklist is data.** Others can extend it, for example with a company's own review
  topics.

### Decision cards

The cards follow the pattern familiar from Claude Code and Codex: options, one marked
recommended, a free-text answer, and "let's discuss this". Planning adds a few things:

- **Each option shows its trade-off** and what it would decide downstream.
- **A preview where it helps,** such as a small architecture diagram per option.
- **"Let's discuss this" is scoped to that decision.** When the discussion ends, it returns to
  the card with the answer filled in.
- **"Decide later"** for decisions that don't block the draft. The items that depend on it are
  marked as waiting.
- **Answered cards stay in the conversation** as the record, collapsed, showing the choice and
  the alternatives.

The card is the same component (R-A6, one decision component per kind) whether the question
comes from planning, from running work, or from an agent client.

### Research

The operator can ask for research, and the agent offers it when a decision depends on facts
it doesn't have. Research runs in the background while the conversation continues. It returns
as a card with sources, and those sources become evidence on the decision record. Expensive
research falls under the autonomy policy.

### Branching

There is one conversation per plan, with branching from any turn as a later goal.

- **A branch is a draft revision.** It forks from that point in the plan's revision lineage
  (ADR-012, ADR-028). Adopting a branch makes it the plan, and the others remain as explored
  alternatives.
- **Execution follows the adopted line only.**
- **Branching can't rewind merged work.** After execution starts, a branch from an early turn
  becomes an amendment proposed from that point. The Studio shows its impact against what's
  already built.

## Topic checklist (draft 1)

**How to read an entry:**
- **Needs:** topics that must be settled first.
- **Default:** what the agent assumes if nothing settles the topic.
- **Skips:** questions the answer rules out.

### A. What it is and who it's for

**T1. Purpose and core jobs**
- Settles: the problem, and the three to six things a user must be able to do.
- Needs: nothing.
- Default: never assumed (principle 2). From a short prompt, the agent proposes core jobs on a
  multi-select card.

**T2. Who uses it**
- Options: just me · me and a few people I know · a team or organisation · the public.
- Default: just me.
- Skips at "just me": sign-in, roles, separate data per customer.

**T3. Stakes**
- Settles: how bad failure is. That covers data sensitivity (money, health, other people's
  data) and whether others depend on the app.
- Needs: T1, T2.
- Default: personal and low, raised automatically for sensitive data.
- Feeds: the quality bar, security, backups and each item's cycle. Team or enterprise stakes
  add the extended topics.

**T4. Starting point**
- Settles: new or existing code, languages and tools the operator knows or wants, and anything
  to avoid.
- Default: a new repo, with no preferences.
- With an existing repo, the agent reads the code, and most of tier D becomes Answered.

### B. Where it runs and how it's used

**T5. Where it runs**
- Options: this computer · a home server or tailnet · a cloud provider · users' own devices.
- Needs: T2, T3.
- Default: this computer if it's just for the operator; the cloud if it's public.

**T6. How people use it** (multi-select)
- Options: web page · desktop app · phone app · command line · API · chat bot · scheduled job.
- Needs: T1, T2, T5.
- Default: a web page served locally.

**T7. Sign-in and access**
- Options: none · a local lock · accounts · organisation sign-in (SSO).
- Needs: T2, T5.
- Skipped for a single user on their own machine or tailnet.

**T8. Devices and offline use**
- Settles: whether it's used from several devices, whether it must work offline, and sync.
- Needs: T5, T6.
- Skipped for one device, or for a web app that's always online.

### C. Data and the outside world

**T9. Data**
- Settles: what it stores, how much, for how long, import and export formats, and history or
  undo.
- Needs: T1, T3, T5.
- Default: a local database with CSV export.

**T10. Outside services**
- Examples: bank feeds, payments, email, maps, AI models.
- Each one produces a provider card, an account (T11) and a secret.
- Needs: T1, T9. This is where the agent usually offers research.

**T11. Accounts and running costs** (derived)
- Built from T5 and T10: every account needed and every recurring cost, on one confirmation
  card.
- Each account becomes an operator step.

### D. How it's built

**T12. Stack**
- Settles: language, framework, storage engine and UI toolkit.
- Needs: T4, T5, T6, T9.
- Always presented as alternatives with a recommendation, unless T4 settles it.

**T13. Architecture and repo layout**
- Settles: single app, app plus worker, or several services; the main modules and their
  boundaries; how the code divides into repos (see Roadmap shape and repo layout).
- Needs: T6, T10, T12.

**T14. Roadmap shape** (derived)
- Derived from the item dependency graph and T13 (see below), then confirmed.

### E. Quality and delivery

**T15. Quality bar**
- Settles: unit and end-to-end tests, checks, accessibility and performance targets.
- Needs: T3, T12.
- Default: set by the stakes. Also sets each item's development cycle.

**T16. Install and updates**
- Options: run by hand · background service · container · CI/CD pipeline · app store.
- Needs: T5, T12.
- Becomes deploy items and operator steps.

**T17. Keeping it running**
- Settles: backups, logs, monitoring and alerts.
- Needs: T3, T5, T9.
- Minimal for a personal tool, fuller at higher stakes.

### F. Shape of the plan

**T18. First version**
- Settles: what's in the first usable release and what waits for later milestones.
- The agent proposes the split, and the operator adjusts it.

**T19. How this plan runs** (inherited, with triggers)
- Settles: the autonomy policy, walkthrough level, cycle defaults and limits.
- Inherited from the operator's settings and listed in one line of the playback. Asked only
  when the operator raises it, or when the plan's scale makes a setting matter:
  - **A plan that touches production, money or other people's data** → merge and deploy
    authority for this plan.
  - **A wide plan** → in-flight limits and the merge policy.
  - **A long or expensive plan** → a budget, and when to check in.
  - **Team or enterprise stakes** → team workflow (X5) can override personal defaults.

### Extended topics (team or enterprise stakes only)

- **X1. Environments:** development, staging and production.
- **X2. Compliance and audit:** where data must live, retention, an audit log.
- **X3. Availability and recovery targets.**
- **X4. Cost ceiling.**
- **X5. Team workflow:** who reviews, code owners, release approvals.
- **X6. Security review:** a threat model and a dependency policy.

The granularity is a starting point. Expect topics to merge, split and appear once the Studio
is in daily use.

### Worked example: "Make me a bookkeeping app for my own budget"

- **Playback:**
  - Answered: T2, just me.
  - Assumed: T3, personal but careful with financial data; T4, a new repo.
  - Everything else is Open.
- **Batch 1:** T1, the core-jobs card, and T5, where it runs. The operator answers: on the
  tailnet.
- **Batch 2:**
  - T6: web page, phone-friendly.
  - T9: "Will you import bank exports?" The agent offers to research bank-feed options, which
    feeds T10.
- **Batch 3:**
  - The T12 stack card, with a recommendation.
  - T13 shown as Assumed: a single app in one repo.
- **Confirmation cards:**
  - T11: accounts and costs, if a bank feed was chosen.
  - T14: sequential, or parallel if the items are independent.
- **Skipped, with reasons:**
  - T7: the tailnet controls access.
  - T8: one web app.
  - T17 is reduced to a nightly backup.
- **Then** the T18 first-version split, and the draft plan.

That comes to three batches and two confirmation cards. A user who pastes a full spec gets
the playback and one confirmation card.

## Roadmap shape and repo layout

These decisions must rest on what each option costs, not on what the tooling can do.

### Roadmap shape

CraftingTable has three shapes, and the Studio derives the choice from the plan:

- **One repo, items in a chain** → sequential.
- **One repo, independent items** → parallel (ADR-030). Exclusion groups come from the module
  boundaries in T13: items that change the same module share a group.
- **Several repos** → cross-project, with declared dependency edges (R-F7). It can also run in
  parallel within each repo.

The Studio always states its reason, for example "sequential: each item changes the store's
write path" or "parallel: three independent lanes, grouped by module". A stated reason can be
challenged. An unstated default leads to plans that run sequentially for no recorded reason.

The derivation weighs parallelism's costs:

- **Rework.** When one item merges, its siblings in flight in the same repo must update and be
  reviewed again. Parallel only pays off when items change different parts of the code.
- **Capacity.** The machine's capacity bounds every roadmap together, and the real limit can be
  the disk rather than the CPU. The Studio reads the capacity settings and doesn't propose more
  width than the machine can run.

### Repo layout

**For separate repos:**
- Each component changes, gets checked and gets released on its own.
- Interfaces are explicit.
- Parallel work in different repos doesn't trigger the update-and-re-review cycle.
- A component can be reused, as ActionQueue is as a published crate.

**Against separate repos:**
- Every change to a shared interface becomes multi-step: a release, a pin, then the
  consumer's update.
- They bring release work, dependency edges to maintain, and integration testing across repos.
  WorldInterface waiting on an ActionQueue release is the cost in practice.
- Splitting a personal app too early gives the overhead of separate services with none of the
  independence.

**What the Studio does:**

1. **Repo layout is a decision within T13,** with a recommendation based on stated criteria. A
   component gets its own repo when at least one of these holds:
   - it has, or will have, consumers other than this app;
   - it has its own release cadence or versioning;
   - it runs on a different platform, such as a phone app beside a server;
   - it's deployed separately, by different people or on a different schedule.
2. **Otherwise, one repo divided into modules,** with boundaries clean enough that pulling one
   out later is cheap. Parallel roadmaps with exclusion groups per module give most of the
   benefit of independent change.
3. **Splitting later is an amendment through the feedback loop.** For example: "a second app
   now uses the parser; extract it?" The layout is a decision with a record, so it can be
   revised when the evidence changes.

## Operator steps

Plans include steps only the operator can do: creating accounts, choosing providers, granting
access, entering keys. They are work items like any other, owned by the operator, and the
operator never has to leave the Studio to follow them.

- **Walkthroughs are on by default.** This is one of the few explicit settings, with three
  levels:
  - **Full walkthrough** (default): numbered steps, what to click, what you should see.
  - **Checklist:** the steps without the detail.
  - **Just what's needed:** "Needs: a Stripe test key."
- **Saying it in chat changes the setting.** "Stop walking me through these" switches the
  level, and the settings page shows the current value.
- **Walkthroughs are written when needed,** from current documentation, with links. A walkthrough
  written months earlier would be stale, because providers change their interfaces.
- **A step is done when the server confirms it,** not when the operator clicks Done. For
  example: the key works, the DNS record resolves, the webhook answers.

## Secrets

Secrets go through a centred, masked overlay. **A secret never enters the conversation, the
transcript, the logs or the model's context.** The model sees only a reference, such as
"secret `stripe_test_key`, set 2026-10-18, verified". It can ask for the secret to be used,
never to read it.

The overlay shows:
- what the secret is for, and which plan step asked for it;
- where it will be stored;
- what can use it, for example "provided to this plan's check and agent runs as `STRIPE_KEY`";
- optionally, a verify button. The server runs the test, not the model, and only the result
  returns to the conversation.

Further rules:

- **Pasted secrets.** The client spots key-shaped text in a message before sending it. It
  offers to move the key into storage and replaces it with the reference, so the key never
  reaches the model.
- **Secrets have a scope:** which plan, which items, and whether they are for development or
  production. A test key can't end up in a deploy step.
- **Agents get service credentials, never personal passwords.** CraftingTable stores what agents
  need, such as API keys. It never stores or relays the operator's system or account
  passwords. Steps that need system rights stay operator steps, with a walkthrough. Operating
  the computer itself (computer use) is out of scope; if it's ever needed, it can be added later
  as a backend capability.

## Autonomy policy

Autonomy is a set of grants, one per class of decision, with defaults and per-plan overrides:

| Class | Example | Default |
|---|---|---|
| Mechanical, no scope change | re-verify, retry, refresh a dependency | act automatically |
| A design choice inside one item | a library, a schema detail | decide, record, tell the operator |
| A change across items or to scope | splitting an item, changing a shared interface | propose and wait |
| Outward or hard to reverse | merge to the main branch, deploy, publish, spend money, create accounts | ask |

- **The mechanism already exists.** R-C10's re-verification grant is revocable, granted by an
  active editor, revoked by any amendment, and recorded. The policy is a set of grants like
  that.
- **Each autonomous action records the grant that allowed it,** so trust can be audited,
  tightened and loosened.
- **Policy can vary by plan,** for example "on this plan, ask me everything".
- **The policy follows the requester, not the interface.** An agent driving a plan is a
  delegate with its own grants. Anything outside them goes to its human owner.
- **Anything that needs the operator's credentials waits for the operator,** by necessity.

## Development cycles

The cycle (design, implement, review, remediate) is configurable and composable. It can be as
simple as implement-then-merge, or as elaborate as a design review before implementation.

- **Cycles are declared data,** composed from steps.
- **The Studio proposes a cycle per item** from its stakes and risk (T3, T15). Explicit cycle
  configuration lives in the power-user view.
- **Mutability has no hard floor,** including dropping review, but principle 6 holds: the record
  shows which steps ran.

## The feedback loop

Once a plan runs, everything it discovers flows back into the Studio. A change is not a patch
to one item. It can mean rethinking the plan, and the Studio does that reconciliation for the
operator.

1. **A run hits something.** It's blocked (missing information, or an operator step), the
   design turns out wrong (a scope change), or it finds an opportunity, such as a component
   with a second consumer.
2. **It sends typed feedback, not free text.** The addendum says "workers propose; planning
   authority decides". R-F6 carries feedback as amendment patches.
3. **The feedback arrives in the plan's conversation as a card, with its impact:** which items
   it affects, what's merged, what's running. No decision made late in a plan should silently
   break items merged early.
4. **The planning authority decides.** That's the operator, or an agent within its grants.
5. **The decision produces a new plan revision.** Affected items are re-planned or re-verified,
   using the existing re-review and re-verification machinery (R-C10).
6. **Unaffected items keep running.** Pausing one item, as parallel roadmaps already allow, is
   the model. Pausing the whole roadmap for one decision is the problem the 2026-09 system
   review recorded.

## Self-modification

CraftingTable may improve and extend itself through the same Studio, gated so that new features
fit its philosophy.

- **A design review against the charter comes first:** `AGENTS.md`, the ADRs, and ADR-075's
  posture. A proposal that conflicts with the charter becomes a decision for the operator, never
  a quiet change.
- **CraftingTable builds itself in a separate clone,** never in its deploy checkout or a
  repository its own runs are using.
- **Deploying stays the operator's action.**

## Power-user surfaces

The Studio takes over Home, as `docs/ui/` already plans. The inbox, board, roadmaps, settings
and every existing surface remain, for operators who want direct control. Anything the Studio
does through conversation must also be visible, and where sensible editable, on those surfaces.

## Future directions, not commitments

These are not planned for building. They are recorded so that current design choices don't
rule them out.

### Scaling out: a control machine and remote workers

A team with substantial compute could run CraftingTable on its own machine and dispatch runs
elsewhere:

- **Control machine:** the daemon, the database, the primary checkouts, the declared checks,
  merges and all authority.
- **Workers:** each gets a worktree and scratch space, runs an agent, and returns commits and
  events.

R-G8 (separating transport from backend) and R-G12 (a per-run supervisor with a durable event
log that the daemon reconnects to) already point that way. Choices that keep the door open:

1. **R-G12's design ADR states that the supervisor may run on another machine.**
2. **Results return as commits and events, not as files the daemon reads.** Code that reads a
   worktree's files directly ties execution to the local disk. Note it when touching such
   code; it is not a remediation item.
3. **Capacity is a pool, not "the workstation".** Today's slots are one local pool. Named pools
   would fit the same model later.
4. **Trusted checks stay with the control machine,** or run in a check pool it trusts. Merges
   depend on receipts the daemon records (R-G13). Worker results would otherwise need a way to
   prove themselves. A team deployment is also where ADR-075's stance would be revisited.

### CraftingTable as a tool for agents

Long-running agents (Hermes, later Exoskeleton) could use a central CraftingTable for
coordinated development. They would not need SDLC skill of their own, because CraftingTable
has it built in. This is why principle 7 holds even for a single operator:

- **Decision cards are typed data** with options a machine can read. An agent answers "option 2"
  through an API or MCP tool, just as the operator taps it.
- **Agents have their own identity,** never the operator's session, with limited grants under
  the autonomy policy.
- **Merge authority stays the operator's** unless the policy explicitly delegates it.

## Open questions

Each question is decided when the first item that depends on it is designed, not before.
Deciding earlier would mean deciding without what those items will show, for example R-F1's
compiled map model.

1. **Where do decision records, topic states and operator steps live in the formats?**
   - Decide at: R-F5's format ADR for decision points, R-F6's format ADR for the rest.
   - R-F5's operator decision points ({id, question, options, authority, blocks,
     evidence_contract, default}) are the first shape of the Studio's decision card. Its ADR
     should settle whether options are machine-readable with a recommended option, so that
     the Studio and agent clients can use the same record.
2. **Which record holds the autonomy grants:** R-C10's grant generalised, or a new policy
   record?
   - Decide at: R-F5, only whether a decision point's `authority` names a class of decision
     that a policy can attach to later. The grant record itself is decided at Studio design
     (P5).
3. **Where do secrets live** (OS keyring, or a daemon-encrypted store), and how are they given
   to checks and agent runs without being readable from locations agents can write to (R-G9)?
   - Decide at: the first Studio increment with operator steps. Nothing before it needs
     secrets beyond what R-G9 already covers.
4. **What is the smallest first increment of the Studio?** For example, the conversation and
   decision cards over today's plan import, before the topic checklist and the feedback loop.
   - Decide at: P5 planning, after R-F6's format ADR, which its done-when requires before
     Studio UI work begins.
