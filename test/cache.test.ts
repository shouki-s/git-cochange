import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  opts: { email?: string; date?: string; message?: string } = {},
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
  if (opts.email) {
    env.GIT_AUTHOR_EMAIL = opts.email
    env.GIT_COMMITTER_EMAIL = opts.email
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

describe('cache', () => {
  test('default-enabled: writes cache file under .git/git-cochange/cache.json', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1', 'B.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      const a = new Analyzer(dir)
      await a.analyze()

      const cachePath = join(dir, '.git', 'git-cochange', 'cache.json')
      const stat = await readFile(cachePath, 'utf8')
      const parsed = JSON.parse(stat)
      assert.equal(parsed.version, 1)
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

      const cachePath = join(dir, '.git', 'git-cochange', 'cache.json')
      await assert.rejects(() => readFile(cachePath, 'utf8'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('custom path is honored', async () => {
    const { dir, git } = await makeRepo()
    const cacheDir = await mkdtemp(join(tmpdir(), 'git-cochange-cache-custom-'))
    const cachePath = join(cacheDir, 'my-cache.json')
    try {
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      const a = new Analyzer(dir, { cache: { path: cachePath } })
      await a.analyze()

      const raw = await readFile(cachePath, 'utf8')
      const parsed = JSON.parse(raw)
      assert.equal(parsed.version, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test('reusing cached scores yields identical results to a fresh analyze', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1', 'B.ts': '1' }, { date: '2024-01-01T00:00:00Z' })
      await commitFiles(git, dir, { 'A.ts': '2' }, { date: '2024-01-01T01:00:00Z' })

      const first = new Analyzer(dir)
      await first.analyze()
      const expectedRelated = first.getRelated('A.ts')

      // Second analyzer reads the cache written by the first.
      const second = new Analyzer(dir)
      await second.analyze()
      const actualRelated = second.getRelated('A.ts')

      assert.deepEqual(actualRelated, expectedRelated)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('incremental update: adding a commit yields the same scores as full recompute', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1', 'B.ts': '1' }, { date: '2024-01-01T00:00:00Z' })
      await commitFiles(git, dir, { 'A.ts': '2' }, { date: '2024-01-01T01:00:00Z' })

      const seeded = new Analyzer(dir)
      await seeded.analyze()

      // Add a new commit close in time → must trigger incremental update path.
      await commitFiles(git, dir, { 'B.ts': '2', 'C.ts': '1' }, { date: '2024-01-01T02:00:00Z' })

      const incremental = new Analyzer(dir)
      await incremental.analyze()

      // Compare against an analyzer that does NOT use any cache.
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

  test('history rewrite (force-pushed branch) triggers full recompute', async () => {
    const { dir, git } = await makeRepo()
    try {
      // Build initial history.
      await commitFiles(git, dir, { 'A.ts': '1', 'B.ts': '1' }, { date: '2024-01-01T00:00:00Z', message: 'init' })
      await commitFiles(git, dir, { 'A.ts': '2', 'C.ts': '1' }, { date: '2024-01-01T01:00:00Z', message: 'second' })

      const before = new Analyzer(dir)
      await before.analyze()

      // Rewrite history: reset to the first commit and create a divergent one
      // touching different files.
      const log = await git.log()
      const firstSha = log.all[log.all.length - 1].hash
      await git.reset(['--hard', firstSha])
      await commitFiles(git, dir, { 'D.ts': '1', 'E.ts': '1' }, { date: '2024-01-01T01:30:00Z', message: 'rewrite' })

      const after = new Analyzer(dir)
      await after.analyze()

      // Compare against a no-cache analyzer to confirm correctness.
      const fresh = new Analyzer(dir, { cache: false })
      await fresh.analyze()

      assert.deepEqual(after.getFiles().sort(), fresh.getFiles().sort())
      // C should have dropped out (its commit was rewritten away).
      assert.ok(!after.getFiles().includes('C.ts'))
      assert.ok(after.getFiles().includes('D.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('options change invalidates cache', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      const a = new Analyzer(dir)
      await a.analyze()

      // Different options → cache must be regenerated; should not throw and should still work.
      const b = new Analyzer(dir, { includeMergeCommits: true })
      await b.analyze()
      assert.ok(b.getFiles().includes('A.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('corrupt cache file is treated as empty cache', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'A.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      const cachePath = join(dir, '.git', 'git-cochange', 'cache.json')
      await mkdir(join(dir, '.git', 'git-cochange'), { recursive: true })
      await writeFile(cachePath, '{ this is not valid json')

      const a = new Analyzer(dir)
      await a.analyze()
      assert.ok(a.getFiles().includes('A.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('deleted files are filtered out at query time even when cached', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(git, dir, { 'keep.ts': '1', 'gone.ts': '1' }, { date: '2024-01-01T00:00:00Z' })

      // First analyze: both files are tracked.
      const first = new Analyzer(dir)
      await first.analyze()
      assert.ok(first.getFiles().includes('gone.ts'))

      // Delete gone.ts and commit. Cache should still reflect the score data
      // for gone.ts internally, but the query layer must hide it.
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
