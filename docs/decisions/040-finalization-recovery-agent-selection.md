# ADR-040: Change the finalization agent at recovery

Status: accepted. Refines ADR-033 and ADR-038.

An owner/editor at an idle finalization checkpoint may select another backend/model with
Resume, focused remediation, general remediation authorization, or nit deferral. The choice
applies to the recovery and all subsequent assessment, polish, remediation and review runs
in that finalization. Reviews remain independent runs. Conflict resolution retains its
separate explicitly selected profile.

Keep the original finalization profiles immutable. Store an optional backend/model override
on the cycle; absent command input keeps it, and null restores the original per-step settings.
Apply the override when resolving the profile at launch, retaining that step's original
permission mode. Omitting a model selects the new backend's default; never inherit the old
backend's model name. The existing runtime backend catalog and custom model field remain
available. A backend switch creates a new run with the durable parent handoff; it does not
resume a different vendor's session.

Validate the recovery action, current editor authority, versions, idle state, pending
conflicts/promotion and backend availability before persisting the override together with
the next-run reservation and any budget grant. Attribute the selection in the cycle audit.
Existing runs retain their recorded settings; restart retains the override and still requires
explicit resumption. Changing an agent through Resume retries the current step without
adding remediation attempts. No selection alters completion gates or final merge authority.
