import { fetchCommits, getTrackedFiles } from './git'
import { computeScores, normalizeScore, ScoreMap } from './scorer'

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
  private trackedFiles: Set<string> | null = null

  constructor(repoPath: string, options?: AnalyzerOptions) {
    this.repoPath = repoPath
    this.ref = options?.ref ?? 'HEAD'
    this.includeMergeCommits = options?.includeMergeCommits ?? false
  }

  async analyze(): Promise<void> {
    const [commits, trackedFiles] = await Promise.all([
      fetchCommits(this.repoPath, { ref: this.ref, includeMergeCommits: this.includeMergeCommits }),
      getTrackedFiles(this.repoPath),
    ])

    const filteredCommits = commits
      .map(c => ({ ...c, files: c.files.filter(f => trackedFiles.has(f)) }))
      .filter(c => c.files.length > 0)

    this.trackedFiles = trackedFiles
    this.scoreMap = computeScores(filteredCommits)
  }

  getFiles(): string[] {
    if (!this.scoreMap || !this.trackedFiles) {
      throw new Error('analyze() must be called before getFiles()')
    }
    return Array.from(this.scoreMap.self.keys()).filter(f => this.trackedFiles!.has(f))
  }

  getRelated(file: string): RelatedFile[] {
    if (!this.scoreMap || !this.trackedFiles) {
      throw new Error('analyze() must be called before getRelated()')
    }

    const inner = this.scoreMap.raw.get(file)
    if (!inner) return []

    const results: RelatedFile[] = []
    for (const otherFile of inner.keys()) {
      if (!this.trackedFiles.has(otherFile)) continue
      const score = normalizeScore(this.scoreMap, file, otherFile)
      if (score > 0) results.push({ file: otherFile, score })
    }

    return results.sort((a, b) => b.score - a.score)
  }
}
