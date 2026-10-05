# Model catalog fixtures (R-G15)

Hand-written in the shapes the CLIs used on 2026-10-05; no account data. Tests read only these,
never an operator's `~/.claude` or `~/.codex`.

- `claude-cc-v2.json`: Claude Code's per-account catalog, format version 2, as the CLI caches it
  under `<config>/cache/model-catalog/<account>-cc.json`. Only the fields CraftingTable reads are
  meaningful; the rest keep the shape.
- `codex-model-list.json`: the `result` of Codex app-server's `model/list` (0.160.0 protocol),
  with `includeHidden: true`.
