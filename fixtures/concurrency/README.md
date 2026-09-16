# Cross-project import conformance fixtures

These three operator-provided planning archives are the exact reference inputs for
ADR-043 and the cross-project roadmap. They are test data, never imported at daemon
startup or executed. Embedded scripts/schemas/reports remain inert; CraftingTable's
own validator checks the package. Tests assert source identity, coverage and phase
semantics rather than trusting the supplied validation report.

- Map v0.3 ZIP: `3df30b94de7dad830b67a2f6f67cc9d662023f8f36a307db10e915d2a24da335`
- WI r5 ZIP: `151dd46ca8c295964de5e82da6d6f01797c663a22b50f01df6ff9fb2db1a5e69`
- EXO r6 ZIP: `5e430bea7723785f70374e0aa377f5c0ab6731ab9c1d52a620b7a3cbfa976a5b`

Only these three packages are retained, not the surrounding download directory.
The AQ source ZIP is not present and its declared hash is not runtime proof.
