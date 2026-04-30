# CLAUDE.md

All design decisions and specifications are recorded in **SPEC.md**. Always
review it before starting implementation.

## Architecture

```
src/
  git.ts      — fetches git log / ls-files / rev-parse via simple-git
  scorer.ts   — score computation (time decay, author constraint,
                normalization). Provides ScoreMap (de)serialization and
                incremental update.
  cache.ts    — cache read/write, invalidation, and incremental-update
                assembly
  analyzer.ts — public class Analyzer (analyze / getFiles / getRelated)
  index.ts    — public API exports only
```

## Scoring model essentials

- Decay function: `exp(-Δt / τ)`, τ = 8 hours (fixed, not user-configurable)
- Cutoff: 5τ = 40 hours (pairs farther apart than this are skipped)
- Scores are computed only between commits with the same author email
- Normalization: `score(A, B) = raw(A, B) / sqrt(raw(A, A) × raw(B, B))`
  (range 0–1, symmetric)

## Intentionally not done

- No rename/move tracking (only the history of the current path is considered)
- Deleted files are excluded from `getFiles()` (the filter is applied at query
  time; the internal `ScoreMap` retains them)
- No `allPairs()` method (use `getFiles()` + `getRelated()` together)

## Cache

- Disk persistence is enabled by default. See SPEC §9 for details.
- Default path: `<git-dir>/git-cochange/cache.json`
- Incremental updates leverage the additive scoring model (the tail buffer
  retains commits within the last 5τ).
