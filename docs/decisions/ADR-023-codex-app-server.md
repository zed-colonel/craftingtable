# ADR-023 — Codex app-server integration

- **Status:** accepted
- **Date:** 2026-09-09
- **Supersedes:** ADR-022 transport, permission mapping and telemetry decisions

## Context

CraftingTable is an interactive supervisor. Codex's documented app-server integration
supports persistent threads, steering, interruption and model/usage metadata. The
exec/resume transport in ADR-022 unnecessarily limits these capabilities.

## Decision

Run one supervised `codex app-server --stdio` process per CraftingTable run. Initialize
its RPC connection, read authentication mode, and start or resume a thread. Keep vendor
requests and notifications inside the agent adapter. The browser and daemon keep their
existing run commands and durable event kinds; no network listener or new dependency
is introduced. The registry, migrations and remediation selection in ADR-022 remain.

Follow-ups use `turn/steer` with an expected turn id while active, or `turn/start` while
idle. Only explicit stale-turn rejections can retry input; timeouts fail the run because
delivery is ambiguous. End drains accepted input before closing stdin. Cancel requests
`turn/interrupt`, then terminates and reaps the process group with SIGKILL escalation.
Unexpected exits and protocol failures fail the run even after a successful turn.
Completed items provide bounded replayable messages and tool results; deltas are transient.

Auto maps to workspace-write, on-request approval and Codex's automatic reviewer.
Edit-only maps to workspace-write with escalation denied; unrestricted disables both
sandbox and approval checks. Overrides apply on thread start/resume and every turn.
Unexpected client approval requests are declined, elicitation is declined, and user
input requests receive no invented answer. Developer instructions and session names
use app-server fields. Dollar budget caps remain unsupported and produce a notice.

The thread response supplies the resolved model; reroute notifications update the model
recorded on turn completion and the daemon's run projection. Authentication mode comes
from `account/read`, never environment inference. Account identities and raw RPC responses
are not journaled. Turn token counts are optional neutral fields on existing completion
events. `account/usage/read` may supply a thread dollar estimate; missing, invalid or
unsupported usage leaves cost absent. Subscription estimates are not bills. No local
pricing calculation is substituted for provider data.

## Consequences

Subscription login works without an API key. The installed CLI protocol (0.153.4) and
[live app-server documentation](https://learn.chatgpt.com/docs/app-server) define the
integration; optional usage remains account/version dependent. Interrupted runs remain
interrupted after daemon restart. Interactive human approval UI, automatic restart
recovery and dynamic model discovery remain separate work.

Protocol tests cover handshake, steering races, unexpected requests, optional telemetry,
failed turns and process reaping. Browser tests exercise implementation, review,
remediation, follow-ups and review-gated merge with both backends. A live subscription
smoke test verifies the installed app-server in an isolated temporary worktree, including
file edits, commands, active steering and End. The captured notification fixture excludes
authentication responses and reasoning content and replaces the temporary worktree path.
