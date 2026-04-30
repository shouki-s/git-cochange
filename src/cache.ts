import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CommitInfo } from './git'
import { getGitDir } from './git'
import { CUTOFF_SECONDS, ScoreMap, type ScoreMapJSON } from './scorer'

const ENTRY_VERSION = 1
const ENTRY_EXT = '.json'
const DEFAULT_MAX_ENTRIES = 16

export interface CacheEntry {
  version: number
  headSha: string
  includeMergeCommits: boolean
  cacheTimestamp: number
  scoreMap: ScoreMap
  tail: CommitInfo[]
}

interface EntryFileFormat {
  version: number
  headSha: string
  includeMergeCommits: boolean
  cacheTimestamp: number
  scoreMap: ScoreMapJSON
  tail: CommitInfo[]
}

export interface CacheConfig {
  enabled: boolean
  dir: string | null
  maxEntries: number
}

export type CacheOption = boolean | { dir?: string; maxEntries?: number } | undefined

export async function resolveCacheConfig(repoPath: string, option: CacheOption): Promise<CacheConfig> {
  if (option === false) return { enabled: false, dir: null, maxEntries: DEFAULT_MAX_ENTRIES }
  const overrides = typeof option === 'object' && option !== null ? option : {}
  const dir = overrides.dir ?? join(await getGitDir(repoPath), 'git-cochange')
  const maxEntries = overrides.maxEntries ?? DEFAULT_MAX_ENTRIES
  return { enabled: true, dir, maxEntries }
}

export function slotId(headSha: string, includeMergeCommits: boolean): string {
  return `${headSha}-${includeMergeCommits ? 'm' : 'nm'}`
}

export function parseSlotId(id: string): { headSha: string; includeMergeCommits: boolean } | null {
  const idx = id.lastIndexOf('-')
  if (idx === -1) return null
  const headSha = id.slice(0, idx)
  const tag = id.slice(idx + 1)
  if (tag !== 'nm' && tag !== 'm') return null
  if (!/^[a-f0-9]{4,}$/.test(headSha)) return null
  return { headSha, includeMergeCommits: tag === 'm' }
}

function entryPath(dir: string, id: string): string {
  return join(dir, `${id}${ENTRY_EXT}`)
}

export async function loadEntry(dir: string, id: string): Promise<CacheEntry | null> {
  let raw: string
  try {
    raw = await readFile(entryPath(dir, id), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }

  let parsed: EntryFileFormat
  try {
    parsed = JSON.parse(raw) as EntryFileFormat
  } catch {
    return null
  }

  if (!parsed || parsed.version !== ENTRY_VERSION) return null
  if (typeof parsed.headSha !== 'string') return null
  if (typeof parsed.includeMergeCommits !== 'boolean') return null
  if (!parsed.scoreMap || !Array.isArray(parsed.tail)) return null

  return {
    version: parsed.version,
    headSha: parsed.headSha,
    includeMergeCommits: parsed.includeMergeCommits,
    cacheTimestamp: parsed.cacheTimestamp,
    scoreMap: ScoreMap.fromJSON(parsed.scoreMap),
    tail: parsed.tail,
  }
}

export async function saveEntry(dir: string, id: string, entry: CacheEntry): Promise<void> {
  const file: EntryFileFormat = {
    version: ENTRY_VERSION,
    headSha: entry.headSha,
    includeMergeCommits: entry.includeMergeCommits,
    cacheTimestamp: entry.cacheTimestamp,
    scoreMap: entry.scoreMap.toJSON(),
    tail: entry.tail,
  }
  await mkdir(dirname(entryPath(dir, id)), { recursive: true })
  await writeFile(entryPath(dir, id), JSON.stringify(file))
}

interface EntryMeta {
  id: string
  headSha: string
  includeMergeCommits: boolean
  mtimeMs: number
}

export async function listEntries(dir: string): Promise<EntryMeta[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const entries: EntryMeta[] = []
  for (const name of names) {
    if (!name.endsWith(ENTRY_EXT)) continue
    const id = name.slice(0, -ENTRY_EXT.length)
    const parsed = parseSlotId(id)
    if (!parsed) continue
    let mtimeMs: number
    try {
      const s = await stat(join(dir, name))
      mtimeMs = s.mtimeMs
    } catch {
      continue
    }
    entries.push({ id, headSha: parsed.headSha, includeMergeCommits: parsed.includeMergeCommits, mtimeMs })
  }
  return entries
}

export async function evictLRU(dir: string, maxEntries: number): Promise<void> {
  if (maxEntries <= 0) return
  const entries = await listEntries(dir)
  if (entries.length <= maxEntries) return
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const e of entries.slice(maxEntries)) {
    try {
      await rm(entryPath(dir, e.id))
    } catch {
      // Best-effort: ignore failures so a single stuck entry can't block the rest.
    }
  }
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
