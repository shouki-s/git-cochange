import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import simpleGit, { type SimpleGit } from 'simple-git'
import { Analyzer } from '../src/analyzer'

async function makeRepo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await mkdtemp(join(tmpdir(), 'git-cochange-cache-test-'))
  const git = simpleGit(dir)
  await git.init()
  await git.addConfig('user.email', 'alice@example.com')
  await git.addConfig('user.name', 'Alice')
  await git.addConfig('commit.gpgsign', 'false')
  return { dir, git }
}

async function commitFiles(
  git: SimpleGit,
  dir: string,
  files: Record<string, string>,
  opts: { date?: string; message?: string } = {},
): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path)
    const parent = full.slice(0, full.lastIndexOf('/'))
    if (parent && parent !== dir) await mkdir(parent, { recursive: true })
    await writeFile(full, contents)
    await git.add(path)
  }
  const env: Record<string, string> = {}
  if (opts.date) {
    env.GIT_AUTHOR_DATE = opts.date
    env.GIT_COMMITTER_DATE = opts.date
  }
  const prev = { ...process.env }
  Object.assign(process.env, env)
  try {
    await git.commit(opts.message ?? 'c')
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

async function listSlotFiles(cacheDir: string): Promise<string[]> {
  try {
    return (await readdir(cacheDir)).filter((f) => f.endsWith('.json')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

describe('cache (multi-slot)', () => {
  test('default-enabled: writes a slot file under .git/git-cochange/', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1', 'B.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      const a = new Analyzer(dir)
      await a.analyze()

      const cacheDir = join(dir, '.git', 'git-cochange')
      const slots = await listSlotFiles(cacheDir)
      assert.equal(slots.length, 1)
      assert.match(slots[0], /^[a-f0-9]+-nm\.json$/)

      const parsed = JSON.parse(await readFile(join(cacheDir, slots[0]), 'utf8'))
      assert.equal(parsed.version, 1)
      assert.equal(parsed.includeMergeCommits, false)
      assert.equal(typeof parsed.headSha, 'string')
      assert.ok(parsed.scoreMap)
      assert.ok(Array.isArray(parsed.tail))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('cache: false disables persistence', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      const a = new Analyzer(dir, { cache: false })
      await a.analyze()

      const cacheDir = join(dir, '.git', 'git-cochange')
      assert.deepEqual(await listSlotFiles(cacheDir), [])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('custom dir is honored', async () => {
    const { dir, git } = await makeRepo()
    const cacheDir = await mkdtemp(join(tmpdir(), 'git-cochange-custom-'))
    try {
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      const a = new Analyzer(dir, { cache: { dir: cacheDir } })
      await a.analyze()

      const slots = await listSlotFiles(cacheDir)
      assert.equal(slots.length, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test('direct hit: rerunning analyze with the same HEAD reuses the entry without rewriting it', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1', 'B.ts': '1' }, { date: '2024-01-01T00:00:00Z' })
      await commitFiles(git, dir, { 'A.ts': '2' }, { date: '2024-01-01T01:00:00Z' })

      const cacheDir = join(dir, '.git', 'git-cochange')

      const first = new Analyzer(dir)
      await first.analyze()
      const slots1 = await listSlotFiles(cacheDir)
      assert.equal(slots1.length, 1)
      const before = await readFile(join(cacheDir, slots1[0]), 'utf8')

      const second = new Analyzer(dir)
      await second.analyze()
      const slots2 = await listSlotFiles(cacheDir)
      assert.deepEqual(slots2, slots1)
      const after = await readFile(join(cacheDir, slots2[0]), 'utf8')
      // Direct hit must not rewrite the body (mtime is bumped via utimes only).
      assert.equal(after, before)

      // Result is consistent with a no-cache run.
      const fresh = new Analyzer(dir, { cache: false })
      await fresh.analyze()
      assert.deepEqual(second.getRelated('A.ts'), fresh.getRelated('A.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("branch switch keeps both branches' entries (no eviction below maxEntries)", async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'shared.ts': '1' }, { date: '2024-01-01T00:00:00Z', message: 'init' })
      const main = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()

      // main: add A
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T01:00:00Z', message: 'main-A' })
      const mainAnalyzer = new Analyzer(dir)
      await mainAnalyzer.analyze()

      // feature: from init, add B
      await git.checkout(['-b', 'feature', 'HEAD~1'])
      await commitFiles(git, dir, { 'B.ts': '1' }, { date: '2024-01-01T02:00:00Z', message: 'feat-B' })
      const featureAnalyzer = new Analyzer(dir)
      await featureAnalyzer.analyze()

      // After switching, two entries should coexist.
      const cacheDir = join(dir, '.git', 'git-cochange')
      const slots = await listSlotFiles(cacheDir)
      assert.equal(slots.length, 2, `expected 2 slot files, got ${slots.length}: ${slots.join(', ')}`)

      // Going back to main: direct hit on the original main entry. Result is
      // identical to a no-cache analysis at main.
      await git.checkout(main)
      const mainAgain = new Analyzer(dir)
      await mainAgain.analyze()
      const fresh = new Analyzer(dir, { cache: false })
      await fresh.analyze()
      assert.deepEqual(mainAgain.getFiles().sort(), fresh.getFiles().sort())
      assert.ok(mainAgain.getFiles().includes('A.ts'))
      assert.ok(!mainAgain.getFiles().includes('B.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('forward incremental: new commit on branch reuses the prior HEAD entry', async () => {
    const { dir, git } = await makeRepo()
    const cacheDir = join(dir, '.git', 'git-cochange')
    try {
      await commitFiles(git, dir, { 'A.ts': '1', 'B.ts': '1' }, { date: '2024-01-01T00:00:00Z' })
      await commitFiles(git, dir, { 'A.ts': '2' }, { date: '2024-01-01T01:00:00Z' })

      const seeded = new Analyzer(dir)
      await seeded.analyze()
      const seededSlots = await listSlotFiles(cacheDir)
      assert.equal(seededSlots.length, 1)

      // Add a new commit that should trigger forward incremental from the seeded entry.
      await commitFiles(git, dir, { 'B.ts': '2', 'C.ts': '1' }, { date: '2024-01-01T02:00:00Z' })

      const incremental = new Analyzer(dir)
      await incremental.analyze()

      // A new slot is created for the new HEAD; the old slot is preserved (LRU not yet at limit).
      const allSlots = await listSlotFiles(cacheDir)
      assert.equal(allSlots.length, 2, `expected 2 slots after incremental, got ${allSlots.join(', ')}`)
      assert.ok(allSlots.includes(seededSlots[0]), 'seeded ancestor entry must still exist')

      // Result must match a no-cache run.
      const fresh = new Analyzer(dir, { cache: false })
      await fresh.analyze()
      const incFiles = incremental.getFiles().sort()
      const freshFiles = fresh.getFiles().sort()
      assert.deepEqual(incFiles, freshFiles)
      for (const f of freshFiles) {
        const a = incremental.getRelated(f)
        const b = fresh.getRelated(f)
        assert.equal(a.length, b.length, `length differs for ${f}`)
        for (let i = 0; i < a.length; i++) {
          assert.equal(a[i].file, b[i].file, `file differs for ${f} at ${i}`)
          assert.ok(Math.abs(a[i].score - b[i].score) < 1e-9, `score differs for ${f}→${a[i].file}`)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('forward incremental picks the nearer ancestor when multiple ancestors exist', async () => {
    const { dir, git } = await makeRepo()
    const cacheDir = join(dir, '.git', 'git-cochange')
    try {
      // Build linear history A -> B -> C, analyzing at each step so all three get cached.
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z', message: 'A' })
      await new Analyzer(dir).analyze()
      await commitFiles(git, dir, { 'B.ts': '1' }, { date: '2024-01-01T01:00:00Z', message: 'B' })
      await new Analyzer(dir).analyze()
      // Two ancestor entries exist now (after-A and after-B). The next commit
      // should reuse the nearest (after-B). We can't directly observe this
      // choice, but the resulting scores must match a no-cache run.
      await commitFiles(git, dir, { 'C.ts': '1' }, { date: '2024-01-01T02:00:00Z', message: 'C' })
      const cached = new Analyzer(dir)
      await cached.analyze()

      const slots = await listSlotFiles(cacheDir)
      assert.equal(slots.length, 3)

      const fresh = new Analyzer(dir, { cache: false })
      await fresh.analyze()
      assert.deepEqual(cached.getFiles().sort(), fresh.getFiles().sort())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('LRU evicts the least-recently-used entry when maxEntries is exceeded', async () => {
    const { dir, git } = await makeRepo()
    const cacheDir = join(dir, '.git', 'git-cochange')
    try {
      // Seed maxEntries=2 with two entries via two commits.
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z', message: 'A' })
      await new Analyzer(dir, { cache: { maxEntries: 2 } }).analyze()
      const slotsAfterA = await listSlotFiles(cacheDir)
      assert.equal(slotsAfterA.length, 1)
      const oldestSlot = slotsAfterA[0]

      await commitFiles(git, dir, { 'B.ts': '1' }, { date: '2024-01-01T01:00:00Z', message: 'B' })
      await new Analyzer(dir, { cache: { maxEntries: 2 } }).analyze()
      assert.equal((await listSlotFiles(cacheDir)).length, 2)

      // Force the oldest entry's mtime to be definitively older so eviction order is deterministic.
      const past = new Date(Date.now() - 60_000)
      await utimes(join(cacheDir, oldestSlot), past, past)

      // Third commit pushes us past maxEntries; the oldest must be evicted.
      await commitFiles(git, dir, { 'C.ts': '1' }, { date: '2024-01-01T02:00:00Z', message: 'C' })
      await new Analyzer(dir, { cache: { maxEntries: 2 } }).analyze()

      const after = await listSlotFiles(cacheDir)
      assert.equal(after.length, 2)
      assert.ok(!after.includes(oldestSlot), `expected ${oldestSlot} to have been evicted; got ${after.join(', ')}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('direct hit updates mtime so the entry survives eviction', async () => {
    const { dir, git } = await makeRepo()
    const cacheDir = join(dir, '.git', 'git-cochange')
    try {
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z' })
      await new Analyzer(dir).analyze()
      const [slot] = await listSlotFiles(cacheDir)

      // Push the entry's mtime far into the past.
      const past = new Date(Date.now() - 60_000)
      await utimes(join(cacheDir, slot), past, past)
      const before = (await stat(join(cacheDir, slot))).mtimeMs

      // Direct hit should bump the mtime.
      await new Analyzer(dir).analyze()
      const after = (await stat(join(cacheDir, slot))).mtimeMs
      assert.ok(after > before, `expected mtime to advance on direct hit (before=${before}, after=${after})`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('includeMergeCommits change creates a separate slot', async () => {
    const { dir, git } = await makeRepo()
    const cacheDir = join(dir, '.git', 'git-cochange')
    try {
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      await new Analyzer(dir).analyze()
      await new Analyzer(dir, { includeMergeCommits: true }).analyze()

      const slots = await listSlotFiles(cacheDir)
      assert.equal(slots.length, 2)
      assert.ok(slots.some((s) => s.endsWith('-nm.json')))
      assert.ok(slots.some((s) => s.endsWith('-m.json')))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('history rewrite produces a fresh slot; old slots remain but are unused', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1', 'B.ts': '1' }, { date: '2024-01-01T00:00:00Z', message: 'init' })
      await commitFiles(git, dir, { 'A.ts': '2', 'C.ts': '1' }, { date: '2024-01-01T01:00:00Z', message: 'second' })

      await new Analyzer(dir).analyze()

      // Rewrite to a divergent history.
      const log = await git.log()
      const firstSha = log.all[log.all.length - 1].hash
      await git.reset(['--hard', firstSha])
      await commitFiles(git, dir, { 'D.ts': '1', 'E.ts': '1' }, { date: '2024-01-01T01:30:00Z', message: 'rewrite' })

      const after = new Analyzer(dir)
      await after.analyze()

      // Result must match a no-cache analysis (i.e., the rewritten slot wasn't reused incorrectly).
      const fresh = new Analyzer(dir, { cache: false })
      await fresh.analyze()
      assert.deepEqual(after.getFiles().sort(), fresh.getFiles().sort())
      assert.ok(!after.getFiles().includes('C.ts'))
      assert.ok(after.getFiles().includes('D.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('corrupt slot file is treated as a miss', async () => {
    const { dir, git } = await makeRepo()
    const cacheDir = join(dir, '.git', 'git-cochange')
    try {
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      // Pre-seed a corrupt entry at the SHA we're about to compute.
      const headSha = (await git.revparse(['HEAD'])).trim()
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, `${headSha}-nm.json`), '{ this is not valid json')

      const a = new Analyzer(dir)
      await a.analyze()
      assert.ok(a.getFiles().includes('A.ts'))

      // The corrupt file is overwritten by a fresh entry at the same slot id.
      const slots = await listSlotFiles(cacheDir)
      assert.equal(slots.length, 1)
      const parsed = JSON.parse(await readFile(join(cacheDir, slots[0]), 'utf8'))
      assert.equal(parsed.version, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('deleted files are filtered out at query time even when cached', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'keep.ts': '1', 'gone.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      const first = new Analyzer(dir)
      await first.analyze()
      assert.ok(first.getFiles().includes('gone.ts'))

      await git.rm('gone.ts')
      await commitFiles(git, dir, { 'keep.ts': '2' }, { date: '2024-01-01T01:00:00Z', message: 'rm' })

      const second = new Analyzer(dir)
      await second.analyze()
      assert.ok(!second.getFiles().includes('gone.ts'))
      assert.ok(!second.getRelated('keep.ts').some((r) => r.file === 'gone.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
