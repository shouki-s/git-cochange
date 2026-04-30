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
} from './cache'
import { type CommitInfo, countCommitsBetween, fetchCommits, getTrackedFiles, isAncestor, resolveSha } from './git'
import { applyCommits, CUTOFF_SECONDS, ScoreMap } from './scorer'

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
    const dir = config.enabled ? config.dir : null
    if (!dir) return this.computeFromBase(null)

    const ancestor = await this.findNearestAncestor(dir, headSha)
    const base = ancestor ? await loadEntry(dir, ancestor.id) : null
    const result = await this.computeFromBase(base)
    await this.persist(config, headSha, currentId, result)
    return result
  }

  private async computeFromBase(base: CacheEntry | null): Promise<ComputeResult> {
    const newCommits = await fetchCommits(this.repoPath, {
      ref: this.ref,
      includeMergeCommits: this.includeMergeCommits,
      since: base?.headSha,
    })

    if (!base) {
      const scoreMap = new ScoreMap()
      applyCommits(scoreMap, newCommits, [])
      const { tail, maxTimestamp } = buildTail(newCommits)
      return { scoreMap, tail, maxTimestamp }
    }

    if (newCommits.length === 0) {
      return { scoreMap: base.scoreMap, tail: base.tail, maxTimestamp: base.cacheTimestamp }
    }

    // If the ancestor's tail buffer doesn't cover the new commits' lookback
    // window, fall back to recomputing from scratch.
    const minNewTs = newCommits.reduce((m, c) => Math.min(m, c.timestamp), Number.POSITIVE_INFINITY)
    if (minNewTs < base.cacheTimestamp - CUTOFF_SECONDS) return this.computeFromBase(null)

    applyCommits(base.scoreMap, newCommits, base.tail)
    const merged = base.tail.concat(newCommits)
    const { tail, maxTimestamp } = buildTail(merged)
    return {
      scoreMap: base.scoreMap,
      tail,
      maxTimestamp: Math.max(maxTimestamp, base.cacheTimestamp),
    }
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

  private async findNearestAncestor(dir: string, headSha: string): Promise<EntryMeta | null> {
    const entries = await listEntries(dir)
    const candidates = entries.filter((e) => e.includeMergeCommits === this.includeMergeCommits)
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

  private ensureAnalyzed(): AnalyzedState {
    if (!this.state) {
      throw new Error('analyze() must be called before getFiles() / getRelated()')
    }
    return this.state
  }
}
