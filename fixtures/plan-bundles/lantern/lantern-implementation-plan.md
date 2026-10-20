# Lantern 0.1 Implementation Plan

*A small, fast search tool for local log files*

**Status:** Development planning baseline
**Target repository:** `example/lantern`
**Integration branch:** `develop`

## 1. Purpose

Lantern indexes the log files on one machine and answers field-aware searches over them
(`level:error service:api "timed out"`) in milliseconds, without a server. Version 0.1 covers
parsing, indexing, background compaction, querying and a command-line interface.

## 2. Shape of the work

The work splits into nine pull requests against `develop`:

- **LN-01 to LN-05** are independent: the record model, the segment format, the tokenizer,
  the query grammar and the command-line interface can proceed in parallel.
- **LN-06** writes segments to disk; **LN-07** (compaction) and **LN-08** (querying) build on it,
  and **LN-09** (ranking) needs both.

## 3. Rules for every pull request

- Keep `cargo test` and `cargo clippy -- -D warnings` green at every commit.
- A change to the segment format comes with a round-trip test and a note in `docs/format.md`.
- No `unsafe` outside `src/segment/mmap.rs`.
