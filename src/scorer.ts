import type { CommitInfo } from './git'

const TAU_SECONDS = 8 * 3600
const CUTOFF_SECONDS = 5 * TAU_SECONDS

export class ScoreMap {
  private readonly raw = new Map<string, Map<string, number>>()
  private readonly self = new Map<string, number>()

  add(a: string, b: string, w: number): void {
    let inner = this.raw.get(a)
    if (!inner) {
      inner = new Map()
      this.raw.set(a, inner)
    }
    inner.set(b, (inner.get(b) ?? 0) + w)
  }

  addSelf(f: string, w: number): void {
    this.self.set(f, (this.self.get(f) ?? 0) + w)
  }

  normalize(a: string, b: string): number {
    const selfA = this.self.get(a) ?? 0
    const selfB = this.self.get(b) ?? 0
    if (selfA === 0 || selfB === 0) return 0
    const rawAB = this.raw.get(a)?.get(b) ?? 0
    return rawAB / Math.sqrt(selfA * selfB)
  }

  selfScore(f: string): number {
    return this.self.get(f) ?? 0
  }

  files(): IterableIterator<string> {
    return this.self.keys()
  }

  related(f: string): IterableIterator<string> {
    return (this.raw.get(f) ?? new Map<string, number>()).keys()
  }
}

export function computeScores(commits: CommitInfo[]): ScoreMap {
  const scoreMap = new ScoreMap()

  const byAuthor = new Map<string, CommitInfo[]>()
  for (const commit of commits) {
    const list = byAuthor.get(commit.authorEmail)
    if (list) list.push(commit)
    else byAuthor.set(commit.authorEmail, [commit])
  }

  for (const authorCommits of byAuthor.values()) {
    authorCommits.sort((a, b) => a.timestamp - b.timestamp)
    const n = authorCommits.length

    for (let i = 0; i < n; i++) {
      const ci = authorCommits[i]

      // Diagonal: decay(0) = 1 per file per commit
      for (const fi of ci.files) {
        scoreMap.addSelf(fi, 1)
      }

      // Same-commit cross terms: decay(0) = 1 for all file pairs in the same commit
      for (let p = 0; p < ci.files.length; p++) {
        for (let q = 0; q < ci.files.length; q++) {
          if (p !== q) scoreMap.add(ci.files[p], ci.files[q], 1)
        }
      }

      // Cross-commit terms within cutoff window
      for (let j = i + 1; j < n; j++) {
        const cj = authorCommits[j]
        const delta = cj.timestamp - ci.timestamp
        if (delta >= CUTOFF_SECONDS) break

        const w = Math.exp(-delta / TAU_SECONDS)

        for (const fi of ci.files) {
          for (const fj of cj.files) {
            if (fi === fj) {
              // Same file: contributes to self-score (both orderings: i→j and j→i)
              scoreMap.addSelf(fi, 2 * w)
            } else {
              // Cross terms: both orderings
              scoreMap.add(fi, fj, w)
              scoreMap.add(fj, fi, w)
            }
          }
        }
      }
    }
  }

  return scoreMap
}
