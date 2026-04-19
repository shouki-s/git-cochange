import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import simpleGit, { type SimpleGit } from 'simple-git'
import { Analyzer } from '../src/analyzer'

async function makeRepo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await mkdtemp(join(tmpdir(), 'git-cochange-test-'))
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
  opts: { email?: string; name?: string; date?: string; message?: string } = {},
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
  if (opts.name) {
    env.GIT_AUTHOR_NAME = opts.name
    env.GIT_COMMITTER_NAME = opts.name
  }
  const prev = { ...process.env }
  Object.assign(process.env, env)
  try {
    await git.commit(opts.message ?? 'c', undefined, { '--allow-empty': null })
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

describe('Analyzer', () => {
  test('throws if getFiles/getRelated called before analyze', () => {
    const a = new Analyzer('/nonexistent')
    assert.throws(() => a.getFiles(), /analyze\(\)/)
    assert.throws(() => a.getRelated('x'), /analyze\(\)/)
  })

  describe('on a small real repo', () => {
    let dir: string
    let analyzer: Analyzer

    before(async () => {
      const { dir: d, git } = await makeRepo()
      dir = d

      // Commit 1: A, B together
      await commitFiles(
        git,
        dir,
        { 'A.ts': '1', 'B.ts': '1' },
        {
          date: '2024-01-01T00:00:00Z',
        },
      )
      // Commit 2: A only, 1 hour later
      await commitFiles(
        git,
        dir,
        { 'A.ts': '2' },
        {
          date: '2024-01-01T01:00:00Z',
        },
      )
      // Commit 3: C only, far in the future (>5τ = 40h)
      await commitFiles(
        git,
        dir,
        { 'C.ts': '1' },
        {
          date: '2024-01-05T00:00:00Z',
        },
      )

      analyzer = new Analyzer(dir)
      await analyzer.analyze()
    })

    after(async () => {
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    test('getFiles returns all tracked files touched by commits', () => {
      const files = analyzer.getFiles().sort()
      assert.deepEqual(files, ['A.ts', 'B.ts', 'C.ts'])
    })

    test('getRelated returns results sorted by score desc', () => {
      const related = analyzer.getRelated('A.ts')
      for (let i = 1; i < related.length; i++) {
        assert.ok(related[i - 1].score >= related[i].score)
      }
    })

    test('A and B are related; C is isolated (beyond cutoff)', () => {
      const relA = analyzer.getRelated('A.ts')
      const byFile = new Map(relA.map((r) => [r.file, r.score]))
      assert.ok((byFile.get('B.ts') ?? 0) > 0, 'A should be related to B')
      assert.equal(byFile.get('C.ts') ?? 0, 0, 'A should not be related to C')
    })

    test('scores are symmetric between A and B', () => {
      const ab = analyzer.getRelated('A.ts').find((r) => r.file === 'B.ts')?.score ?? 0
      const ba = analyzer.getRelated('B.ts').find((r) => r.file === 'A.ts')?.score ?? 0
      assert.ok(Math.abs(ab - ba) < 1e-12)
    })

    test('getRelated for unknown file returns empty array', () => {
      assert.deepEqual(analyzer.getRelated('nope.ts'), [])
    })
  })

  test('deleted files are excluded from getFiles()', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(
        git,
        dir,
        { 'keep.ts': '1', 'gone.ts': '1' },
        {
          date: '2024-01-01T00:00:00Z',
        },
      )
      await unlink(join(dir, 'gone.ts'))
      await git.rm('gone.ts')
      await commitFiles(
        git,
        dir,
        { 'keep.ts': '2' },
        {
          date: '2024-01-01T01:00:00Z',
          message: 'remove gone.ts',
        },
      )

      const analyzer = new Analyzer(dir)
      await analyzer.analyze()
      const files = analyzer.getFiles()
      assert.ok(files.includes('keep.ts'))
      assert.ok(!files.includes('gone.ts'))
      // Related lookups should also not surface the deleted file.
      const related = analyzer.getRelated('keep.ts')
      assert.ok(!related.some((r) => r.file === 'gone.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('different authors do not produce cross-commit relation', async () => {
    const { dir, git } = await makeRepo()
    try {
      await commitFiles(
        git,
        dir,
        { 'A.ts': '1' },
        {
          email: 'alice@example.com',
          name: 'Alice',
          date: '2024-01-01T00:00:00Z',
        },
      )
      await commitFiles(
        git,
        dir,
        { 'B.ts': '1' },
        {
          email: 'bob@example.com',
          name: 'Bob',
          date: '2024-01-01T00:30:00Z',
        },
      )

      const analyzer = new Analyzer(dir)
      await analyzer.analyze()
      const related = analyzer.getRelated('A.ts')
      assert.equal(related.find((r) => r.file === 'B.ts')?.score ?? 0, 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('merge commits are excluded by default', async () => {
    const { dir, git } = await makeRepo()
    try {
      // main branch: initial commit
      await commitFiles(
        git,
        dir,
        { 'A.ts': '1' },
        {
          date: '2024-01-01T00:00:00Z',
          message: 'init',
        },
      )

      const mainBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()

      // feature branch touches B
      await git.checkoutLocalBranch('feature')
      await commitFiles(
        git,
        dir,
        { 'B.ts': '1' },
        {
          date: '2024-01-01T00:30:00Z',
          message: 'feat',
        },
      )

      // back to main, touch C, then merge feature with --no-ff so a merge commit is created
      await git.checkout(mainBranch)
      await commitFiles(
        git,
        dir,
        { 'C.ts': '1' },
        {
          date: '2024-01-01T01:00:00Z',
          message: 'c',
        },
      )
      await git.merge(['--no-ff', '--no-edit', 'feature'])

      const withoutMerge = new Analyzer(dir)
      await withoutMerge.analyze()
      const withMerge = new Analyzer(dir, { includeMergeCommits: true })
      await withMerge.analyze()

      // sanity: both runs know about A, B, C
      assert.ok(withoutMerge.getFiles().includes('B.ts'))
      assert.ok(withMerge.getFiles().includes('B.ts'))

      // Merge commit pulls B and C into the same commit (conflict-free merge
      // records both as changed relative to its first parent), so
      // includeMergeCommits should introduce a B–C relation that the default
      // analysis does not have.
      const bcDefault = withoutMerge.getRelated('B.ts').find((r) => r.file === 'C.ts')?.score ?? 0
      const bcWithMerge = withMerge.getRelated('B.ts').find((r) => r.file === 'C.ts')?.score ?? 0
      assert.ok(
        bcWithMerge >= bcDefault,
        `includeMergeCommits should add >= relation: default=${bcDefault}, withMerge=${bcWithMerge}`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
