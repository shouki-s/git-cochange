import {
  buildTail,
  type CacheConfig,
  type CacheEntry,
  type CacheOption,
  type EntryMeta,
  evictLRU,
  listEntries,
  loadEntry,
  resolveCacheConfig,
  saveEntry,
  slotId,
  touchEntry,
} from './cache'
import { type CommitInfo, countCommitsBetween, fetchCommits, getTrackedFiles, isAncestor, resolveSha } from './git'
import { applyCommits, CUTOFF_SECONDS, computeScores, type ScoreMap } from './scorer'

export interface AnalyzerOptions {
  ref?: string
  includeMergeCommits?: boolean
  /** Disk cache. Default: true (uses `<git-dir>/git-cochange/`). */
  cache?: CacheOption
}

export interface RelatedFile {
  file: string
  score: number
}

interface AnalyzedState {
  scoreMap: ScoreMap
  trackedFiles: Set<string>
}

interface ComputeResult {
  scoreMap: ScoreMap
  tail: CommitInfo[]
  maxTimestamp: number
}

export class Analyzer {
  private readonly repoPath: string
  private readonly ref: string
  private readonly includeMergeCommits: boolean
  private readonly cacheOption: CacheOption
  private state: AnalyzedState | null = null

  constructor(repoPath: string, options?: AnalyzerOptions) {
    this.repoPath = repoPath
    this.ref = options?.ref ?? 'HEAD'
    this.includeMergeCommits = options?.includeMergeCommits ?? false
    this.cacheOption = options?.cache
  }

  async analyze(): Promise<void> {
    const config = await resolveCacheConfig(this.repoPath, this.cacheOption)
    const headSha = await resolveSha(this.repoPath, this.ref)
    const currentId = slotId(headSha, this.includeMergeCommits)

    const result = await this.resolveResult(config, headSha, currentId)

    const trackedFiles = await getTrackedFiles(this.repoPath)
    this.state = { scoreMap: result.scoreMap, trackedFiles }
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

  private async resolveResult(config: CacheConfig, headSha: string, currentId: string): Promise<ComputeResult> {
    if (!config.enabled || !config.dir) {
      return this.fullCompute()
    }

    // 1. Direct hit
    const direct = await loadEntry(config.dir, currentId)
    if (direct) {
      await touchEntry(config.dir, currentId)
      return { scoreMap: direct.scoreMap, tail: direct.tail, maxTimestamp: direct.cacheTimestamp }
    }

    // 2. Forward incremental from nearest ancestor
    const incremental = await this.tryForwardIncremental(config, headSha)
    if (incremental) {
      await this.persist(config, headSha, currentId, incremental)
      return incremental
    }

    // 3. Full recompute
    const fresh = await this.fullCompute()
    await this.persist(config, headSha, currentId, fresh)
    return fresh
  }

  private async persist(config: CacheConfig, headSha: string, id: string, result: ComputeResult): Promise<void> {
    if (!config.dir) return
    const entry: CacheEntry = {
      version: 1,
      headSha,
      includeMergeCommits: this.includeMergeCommits,
      cacheTimestamp: result.maxTimestamp,
      scoreMap: result.scoreMap,
      tail: result.tail,
    }
    await saveEntry(config.dir, id, entry)
    await evictLRU(config.dir, config.maxEntries)
  }

  private async tryForwardIncremental(config: CacheConfig, headSha: string): Promise<ComputeResult | null> {
    if (!config.dir) return null

    const ancestor = await this.findNearestAncestor(config.dir, headSha)
    if (!ancestor) return null

    const entry = await loadEntry(config.dir, ancestor.id)
    if (!entry) return null

    const newCommits = await fetchCommits(this.repoPath, {
      ref: this.ref,
      includeMergeCommits: this.includeMergeCommits,
      since: ancestor.headSha,
    })

    if (newCommits.length === 0) {
      return { scoreMap: entry.scoreMap, tail: entry.tail, maxTimestamp: entry.cacheTimestamp }
    }

    // Tail buffer must cover all new commits' lookback window. If a new commit
    // is older than the cached window, fall back to a full recompute.
    const minNewTs = newCommits.reduce((m, c) => Math.min(m, c.timestamp), Number.POSITIVE_INFINITY)
    if (minNewTs < entry.cacheTimestamp - CUTOFF_SECONDS) return null

    applyCommits(entry.scoreMap, newCommits, entry.tail)
    const merged = entry.tail.concat(newCommits)
    const { tail, maxTimestamp } = buildTail(merged)
    return {
      scoreMap: entry.scoreMap,
      tail,
      maxTimestamp: Math.max(maxTimestamp, entry.cacheTimestamp),
    }
  }

  private async findNearestAncestor(dir: string, headSha: string): Promise<EntryMeta | null> {
    const entries = await listEntries(dir)
    const candidates = entries.filter(
      (e) => e.includeMergeCommits === this.includeMergeCommits && e.headSha !== headSha,
    )
    if (candidates.length === 0) return null

    const ancestryChecks = await Promise.all(
      candidates.map(async (c) => ({ entry: c, isAnc: await isAncestor(this.repoPath, c.headSha, headSha) })),
    )
    const ancestors = ancestryChecks.filter((x) => x.isAnc).map((x) => x.entry)
    if (ancestors.length === 0) return null

    const distances = await Promise.all(
      ancestors.map(async (a) => ({
        entry: a,
        distance: await countCommitsBetween(this.repoPath, a.headSha, headSha),
      })),
    )
    distances.sort((a, b) => a.distance - b.distance)
    return distances[0].entry
  }

  private async fullCompute(): Promise<ComputeResult> {
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
