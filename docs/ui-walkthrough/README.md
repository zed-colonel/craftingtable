# UI walkthrough captures

Each directory here is one dated capture of every page of the browser app, on a
desktop viewport (1440×900) and a phone viewport (iPhone 13 emulation), produced by:

```sh
WALKTHROUGH_LABEL=<short-label> pnpm ui:walkthrough
```

The label defaults to the short commit hash. Phone images are captured at 1× so a
version stays small; set `WALKTHROUGH_SCALE=2` for crisper phone images. The capture seeds a fresh workspace
on the e2e daemon (plan bundle, repositories, branch settings, a manual run, an
automated cycle up to merge approval, a merge, a sequential roadmap, imported
planning ZIPs and a concurrency map) with the scripted stand-in agents, so every
image shows a real state of the app rather than a mock-up. Each directory's
`README.md` lists the scenes with their URL paths and both images side by side.

Captures are a historical record: take one before and after UI work that changes
page structure, compare, and keep both. Do not edit captured images by hand. The
spec that produces them is `e2e/walkthrough.spec.ts`; extend it when the app grows
a page or a state worth remembering.
