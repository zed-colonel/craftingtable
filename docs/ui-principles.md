# CraftingTable UI principles

CraftingTable should feel calm, deliberate, warm, and highly legible. The visual direction may take inspiration from the restrained editorial quality of Claude's interfaces, but it must not copy Anthropic branding, logos, exact layouts, or trade dress.

## Desired qualities

- Warm-neutral surfaces rather than cold enterprise gray.
- Clear editorial hierarchy with generous but not wasteful spacing.
- Low visual noise; status should be obvious without appearing frantic.
- Subtle borders and depth rather than heavy cards or glass effects.
- Restrained accent color used primarily for focus and important state.
- Dense operational detail only where the user is inspecting work.
- Strong typography, readable line lengths, and accessible contrast.
- Motion only when it communicates a state transition; no decorative animation.
- Desktop-first, responsive enough for a MacBook browser.

## Initial shell

The CT-01 shell should communicate the eventual product shape without pretending to implement it. A useful layout is:

- a narrow left navigation rail;
- a concise project/workspace header;
- summary regions for `Needs attention`, `Active`, `Ready`, and `Blocked`;
- an activity panel showing one fake normalized agent event;
- an explicit badge or label that the backend and data are simulated.

## Design tokens

Create reusable CSS custom properties for at least:

- canvas and raised surfaces;
- primary, secondary, and muted text;
- borders and focus rings;
- accent and semantic states;
- spacing scale;
- radius scale;
- typography scale;
- shadow/elevation levels.

Do not introduce a large component library merely to render the first shell. Prefer small local primitives and plain CSS unless a dependency materially reduces complexity.

## Accessibility

- Full keyboard navigation for controls introduced in CT-01.
- Visible focus states.
- Semantic landmarks and headings.
- Color is never the sole carrier of status.
- Respect reduced-motion preferences.
