import { buildTail, type CacheData, loadCache, optionsHash, resolveCachePath, saveCache } from './cache'
import { type CommitInfo, fetchCommits, getTrackedFiles, isAncestor, resolveSha } from './git'
import { applyCommits, CUTOFF_SECONDS, computeScores, type ScoreMap } from './scorer'

export interface AnalyzerOptions {
  ref?: string
  includeMergeCommits?: boolean
  /** Disk cache. Default: true (uses `<git-dir>/git-cochange/cache.json`). */
  cache?: boolean | { path?: string }
}

export interface RelatedFile {
  file: string
  score: number
}

interface AnalyzedState {
  scoreMap: ScoreMap
  trackedFiles: Set<string>
}

export class Analyzer {
  private readonly repoPath: string
  private readonly ref: string
  private readonly includeMergeCommits: boolean
  private readonly cacheOption: boolean | { path?: string } | undefined
  private state: AnalyzedState | null = null

  constructor(repoPath: string, options?: AnalyzerOptions) {
    this.repoPath = repoPath
    this.ref = options?.ref ?? 'HEAD'
    this.includeMergeCommits = options?.includeMergeCommits ?? false
    this.cacheOption = options?.cache
  }

  async analyze(): Promise<void> {
    const cacheConfig = await resolveCachePath(this.repoPath, this.cacheOption)
    const headSha = await resolveSha(this.repoPath, this.ref)
    const optsHash = optionsHash({ ref: this.ref, includeMergeCommits: this.includeMergeCommits })

    const existing = cacheConfig.enabled && cacheConfig.path ? await loadCache(cacheConfig.path) : null
    const result = await this.computeWithCache(existing, headSha, optsHash)

    const trackedFiles = await getTrackedFiles(this.repoPath)
    this.state = { scoreMap: result.scoreMap, trackedFiles }

    if (cacheConfig.enabled && cacheConfig.path) {
      await saveCache(cacheConfig.path, {
        version: 1,
        optionsHash: optsHash,
        headSha,
        cacheTimestamp: result.maxTimestamp,
        scoreMap: result.scoreMap,
        tail: result.tail,
      })
    }
  }

  getFiles(): string[] {
    const state = this.ensureAnalyzed()
    const result: string[] = []
    for (const f of state.scoreMap.files()) {
      if (state.trackedFiles.has(f)) result.push(f)
    }
    return result
  }

  getRelated(file: string): RelatedFile[] {
    const state = this.ensureAnalyzed()
    if (!state.trackedFiles.has(file)) return []

    const results: RelatedFile[] = []
    for (const otherFile of state.scoreMap.related(file)) {
      if (!state.trackedFiles.has(otherFile)) continue
      const score = state.scoreMap.normalize(file, otherFile)
      if (score > 0) results.push({ file: otherFile, score })
    }

    return results.sort((a, b) => b.score - a.score)
  }

  private async computeWithCache(
    cache: CacheData | null,
    headSha: string,
    optsHash: string,
  ): Promise<{ scoreMap: ScoreMap; tail: CommitInfo[]; maxTimestamp: number }> {
    if (cache && cache.optionsHash === optsHash) {
      if (cache.headSha === headSha) {
        // Cache is exactly up to date with HEAD: reuse as-is.
        return { scoreMap: cache.scoreMap, tail: cache.tail, maxTimestamp: cache.cacheTimestamp }
      }
      const incremental = await this.tryIncrementalUpdate(cache, headSha)
      if (incremental) return incremental
    }
    return this.fullCompute()
  }

  private async tryIncrementalUpdate(
    cache: CacheData,
    headSha: string,
  ): Promise<{ scoreMap: ScoreMap; tail: CommitInfo[]; maxTimestamp: number } | null> {
    if (!(await isAncestor(this.repoPath, cache.headSha, headSha))) return null

    const newCommits = await fetchCommits(this.repoPath, {
      ref: this.ref,
      includeMergeCommits: this.includeMergeCommits,
      since: cache.headSha,
    })
    if (newCommits.length === 0) {
      return { scoreMap: cache.scoreMap, tail: cache.tail, maxTimestamp: cache.cacheTimestamp }
    }

    // If any new commit predates the cached tail's window by more than the cutoff,
    // the tail buffer is insufficient — fall back to full recompute.
    const minNewTs = newCommits.reduce((m, c) => Math.min(m, c.timestamp), Number.POSITIVE_INFINITY)
    if (minNewTs < cache.cacheTimestamp - CUTOFF_SECONDS) return null

    applyCommits(cache.scoreMap, newCommits, cache.tail)

    const all = cache.tail.concat(newCommits)
    const { tail, maxTimestamp } = buildTail(all)
    return {
      scoreMap: cache.scoreMap,
      tail,
      maxTimestamp: Math.max(maxTimestamp, cache.cacheTimestamp),
    }
  }

  private async fullCompute(): Promise<{ scoreMap: ScoreMap; tail: CommitInfo[]; maxTimestamp: number }> {
    const commits = await fetchCommits(this.repoPath, {
      ref: this.ref,
      includeMergeCommits: this.includeMergeCommits,
    })
    const scoreMap = computeScores(commits)
    const { tail, maxTimestamp } = buildTail(commits)
    return { scoreMap, tail, maxTimestamp }
  }

  private ensureAnalyzed(): AnalyzedState {
    if (!this.state) {
      throw new Error('analyze() must be called before getFiles() / getRelated()')
    }
    return this.state
  }
}
