# git-cochange specification

A library that analyzes git commit logs to compute relevance (co-change /
logical coupling) between files.

This document records **only agreed-upon specifications**. Open items are
tracked separately in `TODO` (the Claude Code task list).

---

## 1. Overview

A **general-purpose library** that takes a git commit log as input and
computes pairwise file relevance and the related files for a given file.

It is independent of any specific consumer (IDE extensions, CI tools,
visualization tools, etc.). Higher-level tools should be built on top of this
library.

## 2. Use cases

The library itself is responsible only for "computing and exposing relevance".
Anticipated downstream uses:

- Editor / IDE extensions (planned as a separate project in the future)
- Review assistance in CI
- Architecture visualization

That said, the API and feature set must not be skewed toward any specific
consumer.

## 3. Terminology

- **co-change**: multiple files modified within the same commit.
- **relevance score**: a numeric value indicating the strength of co-change
  between two files.

## 4. Input

- Repository path (absolute)
- Options (see `AnalyzerOptions`)

## 4.1 Aggregation granularity

- **File-level only.** Directory-level aggregation is not provided.
- If directory-level aggregation is needed, the caller must do it themselves.

## 5. Output

The library exposes results through query methods on the `Analyzer` instance.
There is no file or stream output; the caller decides how to consume the
data.

- **List of analyzed files** — `getFiles(): string[]`
  - Repository-root–relative paths
  - Limited to files currently tracked by `git ls-files` (deleted files are
    excluded at query time; see §7.4)
  - Order is unspecified
- **Related files for a given file** — `getRelated(file): RelatedFile[]`
  - Each element is `{ file: string, score: number }`
  - `file`: a repository-root–relative path of a related file
  - `score`: relevance score in `[0, 1]` (see §6.3)
  - Sorted by `score` in descending order
  - Pairs whose normalized score is `0` are omitted
  - Returns `[]` if the queried file is not tracked
- **Symmetry** — `score(A, B) = score(B, A)` (see §6.3). When iterating all
  pairs via `getFiles()` + `getRelated()`, each unordered pair appears twice;
  the caller should deduplicate as needed (see §8.3).

## 6. Scoring

### 6.1 Model

Each commit is treated as a `(timestamp, author_email)` pair.

- `C(X)`: the set of commits that touched file X. Each element is `(t, a)` =
  (timestamp, author email).

```
raw(A, B) = Σ_{(tᵢ,aᵢ)∈C(A)} Σ_{(tⱼ,aⱼ)∈C(B)}  [aᵢ = aⱼ] · decay(|tᵢ - tⱼ|)

decay(Δt) = exp(-Δt / τ)   if Δt < 5τ
           = 0              otherwise

score(A, B) = raw(A, B) / sqrt(raw(A,A) × raw(B,B))
```

`[aᵢ = aⱼ]` is the Iverson bracket (1 if author emails match, 0 otherwise).

### 6.2 Parameters

| Parameter | Value | Meaning |
|---|---|---|
| τ (decay time constant) | 8 hours (fixed) | Contribution one day later is about 0.05 (weak relation) |
| Cutoff | 5τ = 40 hours | Pairs farther apart than this are skipped (optimization) |

### 6.3 Score properties

- Range: 0–1 (same structure as cosine similarity)
- Symmetric: `score(A, B) = score(B, A)` → can be treated as an undirected
  graph
- Same commit (`Δt=0, aᵢ=aⱼ`): `decay(0) = 1`, the maximum contribution
- Nearby commits with different authors do not contribute

## 7. Filtering

### 7.1 Commits to analyze

- Default: all commits reachable from `HEAD` (including those from
  already-merged branches)
- The analyzed ref is user-configurable
- Merge commits: **excluded by default** (equivalent to `--no-merges`). Can be
  included via an option.

### 7.2 Filtering (future extensions)

The following are out of scope for now. They may be added to
`AnalyzerOptions` in the future:

- **Time-range filter** (`since` / `until`): high priority as a performance
  measure for large repositories
- **File-pattern exclusion** (`excludeFiles`): for noise reduction such as
  `*.lock`

### 7.3 Renames / moves

- **Not tracked.** Only the commit history under the current path is
  considered.
- History prior to a rename is not carried over.

### 7.4 Deleted files

- **Not included.** `getFiles()` returns only currently existing files.
- Scores involving deleted files are neither computed nor retained.

### 7.5 Large commits

- **Currently no special handling.** Left to the scoring model.
- If problems are observed in the future, this will be addressed by a
  preprocessing step (data cleansing) that skips commits touching more than N
  files. The scoring formula will not change.

## 8. API

### 8.1 Classes

```ts
class Analyzer {
  constructor(repoPath: string, options?: AnalyzerOptions)
  analyze(): Promise<void>
  getFiles(): string[]
  getRelated(file: string): RelatedFile[]
}

interface AnalyzerOptions {
  ref?: string               // ref to analyze (default: 'HEAD')
  includeMergeCommits?: boolean  // include merge commits (default: false)
}

interface RelatedFile {
  file: string   // path relative to the repository root
  score: number  // 0–1
}
```

### 8.2 Behavior

- `analyze()`: fetch the git log → compute scores for all pairs and retain
  them in memory. Asynchronous.
- `getFiles()`: returns all scored file paths. Synchronous.
- `getRelated(file)`: returns related files for the given file in descending
  score order. Synchronous.
- Calling `getFiles()` / `getRelated()` before `analyze()` throws.

### 8.3 All-pairs pattern

`allPairs()` is not provided. Callers should combine `getFiles()` and
`getRelated()`:

```ts
const files = analyzer.getFiles()
const allPairs = files.flatMap(f =>
  analyzer.getRelated(f).map(r => ({ fileA: f, fileB: r.file, score: r.score }))
)
// Scores are symmetric, so this contains duplicates. The caller should
// deduplicate as needed.
```

## 9. Cache

### 9.1 Overview

- The result of `analyze()` is persisted to disk so that subsequent calls run
  faster.
- **Enabled by default.** Can be disabled with `cache: false`.
- **Multi-slot layout**: multiple HEADs (i.e. branch switches or multiple
  worktrees) can coexist. Running `analyze()` on one branch does not delete
  the cache from another.

### 9.2 API

```ts
interface AnalyzerOptions {
  // ...
  cache?: boolean | { dir?: string; maxEntries?: number }
}
```

- `true` / unspecified: use the default directory (`<git-dir>/git-cochange/`)
- `false`: cache disabled
- `{ dir }`: override the cache directory
- `{ maxEntries }`: override the LRU cap (default 16)

> The old `{ path }` form (single-file specification) has been removed. With
> the multi-slot layout, the user specifies a *directory*.

### 9.3 Storage layout

```
<cache-dir>/
  index.json                      ← LRU ordering and entry list (optional)
  <slot-id>.json                  ← one file per entry
  <slot-id>.json
  ...
```

- **slot-id**: format `<headSha>-<optionsTag>` (e.g. `a1b2c3...-nm` /
  `a1b2c3...-m`). `optionsTag` encodes `includeMergeCommits` as a single
  character.
- Each entry retains: `headSha`, `includeMergeCommits`, the cumulative
  `ScoreMap`, the tail buffer of the most recent 5τ commits, the
  `cacheTimestamp`, and the library `version`.
- `index.json` holds metadata only (the slot-id list and last-access
  timestamps). It exists to support LRU decisions without reading the
  payloads. If it is corrupted, it can be reconstructed from the entries.

### 9.4 Resolution order (behavior of `analyze()`)

For the current `(headSha, includeMergeCommits)`, the following are tried in
order:

1. **Direct hit**: if an entry with the same slot-id exists, reuse it as is
   (no computation; only the last-access timestamp in `index.json` is
   updated).
2. **Forward incremental from an ancestor**: among existing entries with
   matching `includeMergeCommits`, identify those whose head is an ancestor
   of the current HEAD using `git merge-base --is-ancestor`. If multiple,
   pick the closest (smallest `rev-list --count <ancestor>..HEAD`) and apply
   an incremental update for the diff commits (§9.5). Write the result as a
   new entry (**the ancestor entry is not deleted**).
3. **Full recompute**: if neither applies, compute from an empty state and
   write the result as a new entry.

After writing, if the number of entries exceeds `maxEntries` (default 16),
the entries with the oldest last-access timestamps are evicted (LRU
eviction).

> Backward incremental (descendant → ancestor) is **not provided**. In most
> cases, ancestor entries also remain due to LRU, so forward incremental
> alone covers the practical cases.

### 9.5 Incremental update mechanism

Because the score is additive (`raw(A, B) = Σ contributions`), the current
HEAD's `ScoreMap` can be obtained by adding the contributions of new commits
in `<ancestor>..HEAD` to the ancestor entry's `ScoreMap`.

To compute the cross-terms (within 5τ) between new commits and the
ancestor-side commits, the ancestor entry includes a **tail buffer of the
most recent 5τ commits**. If the oldest timestamp among the new commits
falls outside the cached window, the incremental update is abandoned and a
full recompute is performed.

### 9.6 Triggers for invalidation / full recompute

Reuse of a given entry is abandoned (→ a new entry is created) when any of
the following happens:

- Library `version` mismatch (the old entry is deleted)
- `index.json` or the relevant entry's JSON is corrupted
- The ancestor relationship has been broken (e.g. by force-push) — but
  **entries from other branches are unaffected**

### 9.7 Deleted files (implementation note)

- The internal `ScoreMap` includes "every file that has ever existed".
  Excluding deleted files (§7.4) is applied at query time (`getFiles()` /
  `getRelated()`) by intersecting with the result of `git ls-files`.
- This way the cache is not invalidated every time a file is deleted.

## 10. Non-functional requirements

### 10.1 Language / runtime

- Implemented in **TypeScript**.
- Runs on Node.js.
- The public API ships TypeScript type definitions.

### 10.2 Performance

- **Target scale**: roughly the Linux kernel (~1M commits, ~80k files).
- **Numeric goals**: none for now. Address actual problems as they are
  measured.
- The cache (a future phase) is the main mechanism for handling large
  repositories.

### 10.3 git access

- Use **simple-git**.
- Assume the git binary is available on the host.
- Avoid parsing raw git output as strings.

## 11. Distribution

- Distributed **as an npm library only**.
- Ships TypeScript type definitions.
- A CLI is **out of scope** for now. It may be provided separately in the
  future, but is not addressed in this specification.
