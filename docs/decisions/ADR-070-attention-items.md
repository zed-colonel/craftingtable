# ADR-070: Attention items, a delivery log and push gates

Status: accepted
Date: 2026-09-25

## Context

ADR-067 made every stop declare a typed code and owner, but "what needs the operator" was
still re-derived on every notification tick: the service listed every worktree, cycle and
run, and asked the roadmap scheduler to evaluate the map, inside an immediate write
transaction, up to 2k+1 times per tick with k deliveries (NOTIF-08). Occurrences lived in an
outbox row that a reopened alert overwrote (NOTIF-07), so a false alarm could not be counted.
A 30-second settle period was the only guard against paging for a state the controller was
about to leave (NOTIF-01); nothing held pushes while the operator was at the screen
(NOTIF-04); reminders repeated text frozen at creation and each went out on its own
(NOTIF-12). Several stops still had no code at all: an interrupted merge, a failed merge
cleanup, a blocked finalization cleanup, a roadmap paused for an amendment decision or a
queued dependency refresh, and hand-started runs (register item R-A4).

## Decision

- **Items are rows.** `attention_items` holds one row per occurrence: a subject (`cycle:<id>`,
  `run:<id>`, `roadmap:<id>:entry:<entryId>`, `storage:volumes`, …) stopped at one code for the
  operator. Only operator-owned attention becomes an item; controller-owned stops stay status.
  A resolved row records when and by what (`operator`, `automation`, `superseded`) and can no
  longer change; the database refuses updates to resolved rows and all deletes. A subject that
  stops again gets a new row, which `continues` the previous one and keeps its reminder schedule
  when it reopens within ten minutes.
- **Items follow writes.** The storage reports every record it writes to one observer. The
  `AttentionProjector` marks the affected unit (a worktree, a roadmap, a finalization) and
  re-derives only that unit just before the transaction commits, so an item opens and resolves
  in the transaction that changes its subject. Units read rows only. Sets that need the map or
  the filesystem are synced by the component that evaluates them anyway: the roadmap scheduler
  after each pass (verification setup, checkpoints ready for evidence, held entries, which also
  say when Re-verify applies), and the storage monitor on its own 30-second timer.
- **Delivery reads items only.** `NotificationService` receives storage narrowed to the
  notification, attention, audit, event, workspace, user and installation repositories; it
  cannot read cycles, roadmaps, maps or the filesystem. A push waits until the item is due and
  settled (30 s), no command holds its cycle, every running controller worker has completed a
  pass that began after the item opened (at most two minutes), and, for a first push, the
  operator is not watching (an open event stream or a command in the last five minutes) or the
  item is older than a five-minute grace. Reminders wait while the operator is issuing commands.
- **One digest per wake.** All eligible items of a workspace go out as one push, with text
  rendered from the items at send time. Each attempt, including tests, is appended to
  `notification_deliveries`, which the database keeps append-only.
- **False alarms are a query.** A pushed item that resolved with no operator command recorded in
  the workspace since it opened is a false alarm:
  `resolved_by = 'automation'` and an accepted delivery lists it.

## Consequences

- The notification tick is a few indexed reads; map evaluation happens once per scheduler pass.
- The inbox (R-A5) and the rail count can read the same rows the push log refers to.
- `resolvedBy = operator` means an operator acted in the workspace after the item opened, not
  necessarily on that item. The metric is conservative: it counts only stops nobody touched.
- Outbox rows written before schema 32 are folded into the matching items at the first tick
  (their reminder schedule carries over), then resolved. Test pushes keep using that table.
- A write outside a transaction is projected at the next transaction or delivery tick.
- A reminder never fires while the operator keeps issuing commands; a browser tab left open
  only delays first pushes by the grace period.

## Alternatives considered

- Re-derive once per tick in a read transaction and cache it: removes the cost, not the
  prediction problem or the lost history.
- Write items from each service's own transition code: every writer would have to remember,
  and a forgotten one would silently drop an alert. The write observer covers every writer,
  including tests and future code.
