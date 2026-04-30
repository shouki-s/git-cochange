# git-cochange

A library that analyzes git commit logs to compute relevance scores between files.

## Installation

```bash
npm install git-cochange
```

## Usage

```ts
import { Analyzer } from 'git-cochange'

const analyzer = new Analyzer('/path/to/repo')
await analyzer.analyze()

const files = analyzer.getFiles()
const related = analyzer.getRelated('src/api.ts')
// → [{ file: 'src/types.ts', score: 0.91 }, ...]
```

## Examples

`examples/visualize/` contains a demo that generates an HTML page visualizing
the relevance scores as a D3 force-directed graph.

```bash
npx tsx examples/visualize <owner/name>
# → graph.html is generated. Open it in a browser to filter dynamically with
#   the min-score / top-K sliders.
```

## API

### `new Analyzer(repoPath, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `ref` | `string` | `'HEAD'` | The git ref to analyze |
| `includeMergeCommits` | `boolean` | `false` | Whether to include merge commits |
| `cache` | `boolean \| { dir?: string; maxEntries?: number }` | `true` | Disk cache. `false` disables it; `{ dir }` overrides the directory; `{ maxEntries }` overrides the LRU cap (default 16). The default path is `<git-dir>/git-cochange/`. |

### Cache

On the second and subsequent calls to `analyze()`, entries stored as one file
per HEAD are reused.

- Same HEAD: direct hit (no recomputation)
- An ancestor HEAD's entry exists: only the diff commits are computed
  incrementally (forward incremental)
- Otherwise: full recomputation

Switching branches does not delete entries from other branches. When the number
of entries exceeds `maxEntries`, the oldest are evicted by mtime-based LRU.

### `analyzer.analyze(): Promise<void>`

Fetches the git log and computes scores. Must be called before any other
method.

### `analyzer.getFiles(): string[]`

Returns the paths (relative to the repository root) of all scored files.

### `analyzer.getRelated(file: string): RelatedFile[]`

Returns related files for the given file in descending order of score.

```ts
interface RelatedFile {
  file: string   // path relative to the repository root
  score: number  // 0–1
}
```

## Development

```bash
npm run build      # TypeScript compile (output to dist/)
npm test           # run tests (node:test + tsx)
npx tsc --noEmit   # type-check only
npm run lint       # format and static analysis
npm run lint:fix   # auto-fix format and static analysis
```

CI runs the build and tests against Node 20 / 22 on GitHub Actions.
