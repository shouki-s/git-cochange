import type { CommitInfo } from './git'

const TAU_SECONDS = 8 * 3600
const CUTOFF_SECONDS = 5 * TAU_SECONDS

export interface ScoreMap {
  raw: Map<string, Map<string, number>>
  self: Map<string, number>
}

export function computeScores(commits: CommitInfo[]): ScoreMap {
  const raw = new Map<string, Map<string, number>>()
  const self = new Map<string, number>()

  const addRaw = (a: string, b: string, w: number) => {
    let inner = raw.get(a)
    if (!inner) { inner = new Map(); raw.set(a, inner) }
    inner.set(b, (inner.get(b) ?? 0) + w)
  }

  const addSelf = (f: string, w: number) => {
    self.set(f, (self.get(f) ?? 0) + w)
  }

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
        addSelf(fi, 1)
      }

      // Same-commit cross terms: decay(0) = 1 for all file pairs in the same commit
      for (let p = 0; p < ci.files.length; p++) {
        for (let q = 0; q < ci.files.length; q++) {
          if (p !== q) addRaw(ci.files[p], ci.files[q], 1)
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
              addSelf(fi, 2 * w)
            } else {
              // Cross terms: both orderings
              addRaw(fi, fj, w)
              addRaw(fj, fi, w)
            }
          }
        }
      }
    }
  }

  return { raw, self }
}

export function normalizeScore(scoreMap: ScoreMap, a: string, b: string): number {
  const selfA = scoreMap.self.get(a) ?? 0
  const selfB = scoreMap.self.get(b) ?? 0
  if (selfA === 0 || selfB === 0) return 0

  const rawAB = scoreMap.raw.get(a)?.get(b) ?? 0
  return rawAB / Math.sqrt(selfA * selfB)
}
