# CT-04A2b1 initial implementation-review disposition

**Status:** Operator disposition recorded; remediation authorized
**Review:** `review-findings/CT-04/CT-04A2b1-initial-review.md`
**Review SHA-256:**
`b8a70cb1793775d93b72b8923d01242e55751eb25d1621b1213a3eb07e1d2f66`
**Reviewed report head:** `ea102b77f944dcd6951b2cb1bf1fc7b4dd301012`
**Review-record commit:** `7c8bcd34c0c4822e1b37cf2f2ea05acc7d9c4056`
**Date:** 2026-07-29

## Operator disposition

The independent review verdict is accepted as **changes required**.

| Finding | Disposition |
|---|---|
| `B1-R-01` | Required. Repair the shared import pattern so multi-line variants are detected and add adversarial multi-line fixtures. |
| `B1-R-02` | Required. Make the protected inventory deterministic in the presence of the existing root CT-04A Git-test scratch directory. |
| `B1-A-01` | Close now. Amend the accepted plan's exact tree to include the necessary schema-version CLI regression test. |
| `B1-A-02` | Close now. Add exact composite-FK catalog guards to migration 0004 while the in-place amendment window remains open. |
| `B1-A-03` | Close now. Narrow the 256-character description criterion to the five new repository kinds and align tests. |
| `B1-A-04` | No change. |
| `B1-A-05` | No change. |
| `B1-A-06` | Close now. Admit the independent initial and remediation review artifacts required by the CT-04 process protocol. |

## Remediation boundary

All directed changes land in one remediation turn. Migration 0004 may be amended
because B1 is not accepted and no operator database is at schema 4. The
remediation must record the new migration checksum, rerun the deterministic
gates, create a new immutable report, and receive a fresh independent review at
the new exact head.

Protected specifications, A2a state primitives, A1 source, and B2 lifecycle
behavior remain unchanged.
