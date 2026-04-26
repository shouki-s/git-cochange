import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CommitInfo } from './git'
import { getGitDir } from './git'
import { CUTOFF_SECONDS, ScoreMap, type ScoreMapJSON } from './scorer'

const CACHE_VERSION = 1

export interface CacheData {
  version: number
  optionsHash: string
  headSha: string
  cacheTimestamp: number
  scoreMap: ScoreMap
  tail: CommitInfo[]
}

interface CacheFileFormat {
  version: number
  optionsHash: string
  headSha: string
  cacheTimestamp: number
  scoreMap: ScoreMapJSON
  tail: CommitInfo[]
}

export interface CacheConfig {
  enabled: boolean
  path: string | null
}

export function optionsHash(opts: { ref: string; includeMergeCommits: boolean }): string {
  return JSON.stringify({ ref: opts.ref, m: opts.includeMergeCommits })
}

export async function resolveCachePath(
  repoPath: string,
  cacheOption: boolean | { path?: string } | undefined,
): Promise<CacheConfig> {
  if (cacheOption === false) return { enabled: false, path: null }
  if (typeof cacheOption === 'object' && cacheOption?.path) {
    return { enabled: true, path: cacheOption.path }
  }
  // Default-enabled: place cache under <git-dir>/git-cochange/cache.json.
  const gitDir = await getGitDir(repoPath)
  return { enabled: true, path: join(gitDir, 'git-cochange', 'cache.json') }
}

export async function loadCache(path: string): Promise<CacheData | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }

  let parsed: CacheFileFormat
  try {
    parsed = JSON.parse(raw) as CacheFileFormat
  } catch {
    return null
  }

  if (!parsed || parsed.version !== CACHE_VERSION) return null
  if (typeof parsed.headSha !== 'string' || typeof parsed.optionsHash !== 'string') return null
  if (!parsed.scoreMap || !Array.isArray(parsed.tail)) return null

  return {
    version: parsed.version,
    optionsHash: parsed.optionsHash,
    headSha: parsed.headSha,
    cacheTimestamp: parsed.cacheTimestamp,
    scoreMap: ScoreMap.fromJSON(parsed.scoreMap),
    tail: parsed.tail,
  }
}

export async function saveCache(path: string, data: CacheData): Promise<void> {
  const file: CacheFileFormat = {
    version: CACHE_VERSION,
    optionsHash: data.optionsHash,
    headSha: data.headSha,
    cacheTimestamp: data.cacheTimestamp,
    scoreMap: data.scoreMap.toJSON(),
    tail: data.tail,
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(file))
}

/**
 * Build a tail buffer of commits within `CUTOFF_SECONDS` of the most recent
 * commit timestamp. These commits are kept so future incremental updates can
 * compute cross-terms with new commits.
 */
export function buildTail(commits: CommitInfo[]): { tail: CommitInfo[]; maxTimestamp: number } {
  if (commits.length === 0) return { tail: [], maxTimestamp: 0 }
  let maxTs = commits[0].timestamp
  for (const c of commits) if (c.timestamp > maxTs) maxTs = c.timestamp
  const cutoff = maxTs - CUTOFF_SECONDS
  const tail = commits.filter((c) => c.timestamp > cutoff)
  return { tail, maxTimestamp: maxTs }
}
