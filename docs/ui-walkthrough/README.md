# UI walkthrough captures

A capture is a dated set of full-page screenshots of every page of the browser app, on a
desktop viewport (1440×900) and a phone viewport (iPhone 13 emulation), produced by:

```sh
WALKTHROUGH_LABEL=<short-label> pnpm ui:walkthrough
```

The label defaults to the short commit hash. Phone images are captured at 1×; set
`WALKTHROUGH_SCALE=2` for crisper phone images. The capture seeds a fresh workspace on the
e2e daemon (plan bundle, repositories, branch settings, a manual run, an automated cycle up
to merge approval, a merge, a sequential roadmap, imported planning ZIPs and a concurrency
map) with the scripted stand-in agents, so every image shows a real state of the app rather
than a mock-up.

**Images never enter the repository.** Each capture is written to
`$CRAFTINGTABLE_WALKTHROUGH_DIR/<date>-<label>/` (default
`$XDG_DATA_HOME/craftingtable-walkthrough/`, i.e. `~/.local/share/craftingtable-walkthrough/`),
with its own `README.md` that lists the scenes and shows both viewports side by side. The
harness appends one row to [INDEX.md](INDEX.md), which is committed with the UI change so the
history records which capture belongs to which commit. Back up the capture store with the rest
of the workstation if the images matter to you; Git does not.

Captures are a historical record: take one before and after UI work that changes page
structure, compare, and keep both. Do not edit captured images by hand. The spec that produces
them is `e2e/walkthrough.spec.ts`; extend it when the app grows a page or a state worth
remembering.

`pnpm test:e2e` (and so `pnpm check`) rehearses the same walk without screenshots, images or
an INDEX row, so a change that breaks its seeding fails the gate instead of the next capture.
