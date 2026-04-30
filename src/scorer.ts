import type { CommitInfo } from './git'
import type { ScoreMap } from './score-map'

export const TAU_SECONDS = 8 * 3600
export const CUTOFF_SECONDS = 5 * TAU_SECONDS

/**
 * Incrementally fold `newCommits` into `scoreMap`, given that `oldTail` (commits
 * already accounted for in `scoreMap`, within 5τ of the most recent old commit)
 * is needed to compute cross-terms with the new commits.
 *
 * - `oldTail`: commits already represented in `scoreMap`. Their self / pairwise
 *   contributions are NOT re-added.
 * - `newCommits`: commits to add. Their self contributions are added, plus cross-terms
 *   among themselves and against `oldTail` within the cutoff.
 */
export function applyCommits(scoreMap: ScoreMap, newCommits: CommitInfo[], oldTail: CommitInfo[]): void {
  const newByAuthor = groupByAuthor(newCommits)
  const oldByAuthor = groupByAuthor(oldTail)

  const authors = new Set<string>([...newByAuthor.keys(), ...oldByAuthor.keys()])

  for (const author of authors) {
    const olds = (oldByAuthor.get(author) ?? []).slice().sort((a, b) => a.timestamp - b.timestamp)
    const news = (newByAuthor.get(author) ?? []).slice().sort((a, b) => a.timestamp - b.timestamp)
    if (news.length === 0) continue

    // Merge into a single timestamp-sorted list with an `isNew` tag.
    const merged: Array<{ commit: CommitInfo; isNew: boolean }> = []
    let i = 0
    let j = 0
    while (i < olds.length && j < news.length) {
      if (olds[i].timestamp <= news[j].timestamp) {
        merged.push({ commit: olds[i], isNew: false })
        i++
      } else {
        merged.push({ commit: news[j], isNew: true })
        j++
      }
    }
    while (i < olds.length) merged.push({ commit: olds[i++], isNew: false })
    while (j < news.length) merged.push({ commit: news[j++], isNew: true })

    for (let p = 0; p < merged.length; p++) {
      const a = merged[p]
      if (a.isNew) accumulateSameCommit(scoreMap, a.commit)

      for (let q = p + 1; q < merged.length; q++) {
        const b = merged[q]
        const delta = b.commit.timestamp - a.commit.timestamp
        if (delta >= CUTOFF_SECONDS) break
        // Skip pairs where both are old; they are already in scoreMap.
        if (!a.isNew && !b.isNew) continue
        accumulateCrossCommit(scoreMap, a.commit, b.commit, delta)
      }
    }
  }
}

function groupByAuthor(commits: CommitInfo[]): Map<string, CommitInfo[]> {
  const byAuthor = new Map<string, CommitInfo[]>()
  for (const commit of commits) {
    const list = byAuthor.get(commit.authorEmail)
    if (list) list.push(commit)
    else byAuthor.set(commit.authorEmail, [commit])
  }
  return byAuthor
}

function accumulateSameCommit(scoreMap: ScoreMap, commit: CommitInfo): void {
  // Diagonal: decay(0) = 1 per file per commit
  for (const fi of commit.files) {
    scoreMap.addSelf(fi, 1)
  }

  // Same-commit cross terms: decay(0) = 1 for all file pairs in the same commit
  for (let p = 0; p < commit.files.length; p++) {
    for (let q = 0; q < commit.files.length; q++) {
      if (p !== q) scoreMap.add(commit.files[p], commit.files[q], 1)
    }
  }
}

function accumulateCrossCommit(scoreMap: ScoreMap, ci: CommitInfo, cj: CommitInfo, delta: number): void {
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
