# ADR-027: Persistent attention notifications

Status: accepted. Date: 2026-09-10.

## Context

Work-item cycles can finish without an open browser. The operator needs phone alerts
and continuing reminders until the work receives attention, including after restarts.

## Decision

Use Pushover normal-priority messages behind a server transport interface. Per-workspace
owner settings and an outbox live in the private SQLite database. Credentials are
write-only and excluded from public contracts, audit/events, logs, and agent context.
This retains the existing OS-user trust boundary rather than adding a key-management
system. Background sends recheck the configuring owner's current authority.

Reconcile automated attention stops and manual review/design/failure states into stable
occurrences. Resolution stops reminders; a new occurrence starts a fresh schedule.
Anchor reminders to first acceptance: +30 minutes, +1 through +6 hours, then daily at a
configured local time, initially 21:00 America/Los_Angeles. Skip missed stages on recovery.
Delivery failure backoff and provider cooldowns are independent of reminder stages.

One daemon worker claims sends with durable one-minute leases. Workflow and delivery
state changes journal atomically. Requests time out in ten seconds; shutdown aborts an
in-flight request and preserves its lease for recovery. No browser or agent gains merge
authority. Private links use the daemon's configured public origin.

## Consequences

Delivery is at least once while enabled and authorized; an ambiguous response or crash
after provider acceptance may duplicate a message. Acceptance is not a read receipt.
An in-flight message can race resolution; later sends recheck current state. Timezone
rules follow the host's Intl timezone data; nonexistent custom times skip a day and
repeated local times send once. Credentials require private database backups.

## Alternatives considered

SMS adds a paid gateway and phone-number setup. Browser push adds service-worker and
subscription management. Pushover emergency-priority repeats do not match this schedule
or provide the daemon's workflow-aware resolution. A generic queue framework is not
needed for this single-daemon outbox.
