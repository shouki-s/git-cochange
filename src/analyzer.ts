import { fetchCommits, getTrackedFiles } from './git'
import { computeScores, normalizeScore, type ScoreMap } from './scorer'

export interface AnalyzerOptions {
  ref?: string
  includeMergeCommits?: boolean
}

export interface RelatedFile {
  file: string
  score: number
}

export class Analyzer {
  private readonly repoPath: string
  private readonly ref: string
  private readonly includeMergeCommits: boolean
  private scoreMap: ScoreMap | null = null

  constructor(repoPath: string, options?: AnalyzerOptions) {
    this.repoPath = repoPath
    this.ref = options?.ref ?? 'HEAD'
    this.includeMergeCommits = options?.includeMergeCommits ?? false
  }

  async analyze(): Promise<void> {
    const [commits, trackedFiles] = await Promise.all([
      fetchCommits(this.repoPath, {
        ref: this.ref,
        includeMergeCommits: this.includeMergeCommits,
      }),
      getTrackedFiles(this.repoPath),
    ])

    const filteredCommits = commits
      .map((c) => ({ ...c, files: c.files.filter((f) => trackedFiles.has(f)) }))
      .filter((c) => c.files.length > 0)

    this.scoreMap = computeScores(filteredCommits)
  }

  getFiles(): string[] {
    const scoreMap = this.ensureAnalyzed()
    return Array.from(scoreMap.self.keys())
  }

  getRelated(file: string): RelatedFile[] {
    const scoreMap = this.ensureAnalyzed()

    const inner = scoreMap.raw.get(file)
    if (!inner) return []

    const results: RelatedFile[] = []
    for (const otherFile of inner.keys()) {
      const score = normalizeScore(scoreMap, file, otherFile)
      if (score > 0) results.push({ file: otherFile, score })
    }

    return results.sort((a, b) => b.score - a.score)
  }

  private ensureAnalyzed(): ScoreMap {
    if (!this.scoreMap) {
      throw new Error('analyze() must be called before getFiles() / getRelated()')
    }
    return this.scoreMap
  }
}
