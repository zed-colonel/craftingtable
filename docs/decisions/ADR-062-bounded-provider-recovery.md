# ADR-062: Bounded recovery from model-service failures

Status: accepted
Date: 2026-09-22

A temporary model-service failure is neither a source finding nor an invalid-report remediation.
Adapters normalize trusted structured failure discriminants into a vendor-neutral optional turn
field. Prose, raw stderr and old raw vendor records never authorize automatic retries. Codex capacity,
server and recognized transport failures and Claude structured server failures are eligible only
with terminal failure and settled tools. Authentication, quotas/rate limits, unknown errors,
interactive requests, ambiguous tools, background timeouts and genuine questions require attention.
Claude's discriminants follow the [official SDK message types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py);
Codex's follow the installed app-server's generated CodexErrorInfo schema.

The controller reserves at most three same-step retries after 1, 5 and 15 minutes. Durable cycle
state records the failed run, backend/model, attempts and due time. Retries share the original step
deadline and retain partial work, guidance and handoff lineage, without debiting remediation rounds.
A normal next step clears the service allowance. Retry now advances the due time only; it cannot
increase allowance, extend the deadline or bypass gates. Explicit ordinary resume after exhaustion
opens a new operator-authorized step window. Pause and stop retain existing workflow meanings.

A retry cannot launch before terminal process-group cleanup and run-storage cleanup, while its
roadmap is paused, after authority/admission changes, or across conflicting worktree lineage.
Launch revalidates phase, dependency and evidence gates and reserves resources normally. Waiting
backoff holds no process resource reservation. Daemon restart holds running cycles for explicit
resumption and preserves the retry budget. Notifications use the existing cycle attention path:
backoff is progress, exhaustion or an unsafe failure needs attention.

Fresh sessions are deliberate. Thread resume can carry stale cwd, sandbox/additional directories,
dependency launchers and run-specific receipt identity. Recompose current context and export the
full prior conversation instead. Pinned review continuations permit existing verification artifacts
only under the established unchanged HEAD/target/index checks; they cannot adopt partial reports.
The new review must finish successfully, produce a valid complete report and satisfy normal gates.
No retry grants new model, merge or protected-branch promotion authority.

## Amendment 2026-09-25: provider-side credential rejections (R-C11)

A provider can reject credentials the host never supplied: on 2026-09-25 Codex's backend
answered ChatGPT-mode sessions with "401 Unauthorized: Incorrect API key provided: sk-svcac…"
for about 21 minutes, and Codex's automatic approval review failed the same way. The Codex
adapter now classifies such a 401 as `credential-rejected` when the session's login is ChatGPT
mode, no API key is in the environment Codex runs with, and the login is still present after
the failure (`account/read`). The evidence is the observed endpoint, the key as masked by the
vendor (a short prefix and the last four characters) and the request id.

Codex gives no structured code for this, so two text reads are an exception to "prose and raw
stderr never authorize retries", and they are the only ones:

- On a failed turn whose CodexErrorInfo is `other` or absent, the backend's status line in the
  error message.
- On stderr, the one log line Codex writes when a command's automatic approval review fails
  ("Automatic approval review failed: " followed by the same status line). The app-server
  stream carries no item for it; the model sees it only as its tool's output.

Both reads match the fixed status line within one line and the first 4 KB, with bounded
quantifiers. The stderr read never changes a turn's outcome: it is reported with the completed
turn as a suspected outage. The controller uses it only when that step would otherwise stop for
the operator, and never when output was clipped: the stop is set aside for a credential retry,
and the retry's reason names it. A step that completed anyway stands. The questions of a failed
turn still keep it with the operator, credential rejection or not.

The controller retries a `credential-rejected` step three times, after 5, 15 and 30 minutes,
and moves the step deadline by each wait. Spent or unsafe retries stop with the code
`provider-credentials-rejected`, naming the suspected outage and the evidence. When an approval
outage cannot be retried, the step's own stop is kept, with the evidence added. A rejected
local login (Codex's `unauthorized`, an API-key login or key, or a login that is gone) still
stops at once and asks the operator to sign in again.

## Amendment 2026-09-25: ending the session on a used-up allowance (R-C9)

A quota failure used to be retried only when nothing was outstanding, but a session with
sub-agents and background shells kept producing failing results against the used-up allowance
(run 736446e8: 31 minutes, nine results, every one unsafe). The Claude adapter now ends the
session, with its process group, at the first quota result that has a known reset, keeping the
latest reset any rejected report named until an `allowed` report. The step's final result is
then a quota failure with that reset, safe to retry unless the agent was waiting on the
operator, and R-C8's wait applies.
