import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { CommitInfo } from '../src/git'
import { ScoreMap } from '../src/score-map'
import { applyCommits } from '../src/scorer'

const TAU = 8 * 3600

describe('applyCommits / normalizeScore', () => {
  test('same-commit pair has normalized score 1', () => {
    const m = new ScoreMap()
    applyCommits(m, [{ timestamp: 0, authorEmail: 'a@x', files: ['A', 'B'] }], [])
    assert.equal(m.normalize('A', 'B'), 1)
    assert.equal(m.normalize('B', 'A'), 1)
  })

  test('is symmetric', () => {
    const commits: CommitInfo[] = [
      { timestamp: 0, authorEmail: 'a@x', files: ['A', 'B'] },
      { timestamp: TAU, authorEmail: 'a@x', files: ['B', 'C'] },
    ]
    const m = new ScoreMap()
    applyCommits(m, commits, [])
    assert.equal(m.normalize('A', 'C'), m.normalize('C', 'A'))
    assert.equal(m.normalize('A', 'B'), m.normalize('B', 'A'))
  })

  test('score is within [0, 1]', () => {
    const commits: CommitInfo[] = [
      { timestamp: 0, authorEmail: 'a@x', files: ['A', 'B'] },
      { timestamp: 3600, authorEmail: 'a@x', files: ['A'] },
      { timestamp: 7200, authorEmail: 'a@x', files: ['B'] },
      { timestamp: 10000, authorEmail: 'a@x', files: ['A', 'B', 'C'] },
    ]
    const m = new ScoreMap()
    applyCommits(m, commits, [])
    for (const f1 of ['A', 'B', 'C']) {
      for (const f2 of ['A', 'B', 'C']) {
        if (f1 === f2) continue
        const s = m.normalize(f1, f2)
        assert.ok(s >= 0 && s <= 1, `score(${f1},${f2}) = ${s} out of range`)
      }
    }
  })

  test('different authors do not contribute', () => {
    const commits: CommitInfo[] = [
      { timestamp: 0, authorEmail: 'a@x', files: ['A'] },
      { timestamp: 100, authorEmail: 'b@x', files: ['B'] },
    ]
    const m = new ScoreMap()
    applyCommits(m, commits, [])
    assert.equal(m.normalize('A', 'B'), 0)
  })

  test('commits beyond 5τ cutoff do not contribute', () => {
    const beyond = 5 * TAU
    const commits: CommitInfo[] = [
      { timestamp: 0, authorEmail: 'a@x', files: ['A'] },
      { timestamp: beyond, authorEmail: 'a@x', files: ['B'] },
    ]
    const m = new ScoreMap()
    applyCommits(m, commits, [])
    assert.equal(m.normalize('A', 'B'), 0)
  })

  test('decay at Δt = τ matches exp(-1) relative weight', () => {
    const commits: CommitInfo[] = [
      { timestamp: 0, authorEmail: 'a@x', files: ['A'] },
      { timestamp: TAU, authorEmail: 'a@x', files: ['B'] },
    ]
    const m = new ScoreMap()
    applyCommits(m, commits, [])
    // raw(A,B) = e^-1 (both orderings: A→B adds e^-1)
    // self(A) = 1, self(B) = 1
    // score = e^-1 / sqrt(1*1) = e^-1
    const expected = Math.exp(-1)
    const actual = m.normalize('A', 'B')
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ≈ ${expected}, got ${actual}`)
  })

  test('closer pairs score higher than distant pairs', () => {
    const commits: CommitInfo[] = [
      { timestamp: 0, authorEmail: 'a@x', files: ['A'] },
      { timestamp: 60, authorEmail: 'a@x', files: ['B'] },
      { timestamp: 3 * TAU, authorEmail: 'a@x', files: ['C'] },
    ]
    const m = new ScoreMap()
    applyCommits(m, commits, [])
    const ab = m.normalize('A', 'B')
    const ac = m.normalize('A', 'C')
    assert.ok(ab > ac, `expected score(A,B)=${ab} > score(A,C)=${ac}`)
  })

  test('repeated edits to the same file accumulate self-score', () => {
    const commits: CommitInfo[] = [
      { timestamp: 0, authorEmail: 'a@x', files: ['A'] },
      { timestamp: 3600, authorEmail: 'a@x', files: ['A'] },
    ]
    const m = new ScoreMap()
    applyCommits(m, commits, [])
    // self(A) = 1 (commit 0) + 1 (commit 1) + 2*exp(-3600/τ) (cross-commit same file)
    const expected = 2 + 2 * Math.exp(-3600 / TAU)
    assert.ok(Math.abs(m.selfScore('A') - expected) < 1e-9)
  })

  test('commits separated by more than 5τ produce score 0', () => {
    const commits: CommitInfo[] = [
      { timestamp: 0, authorEmail: 'a@x', files: ['A'] },
      { timestamp: 6 * TAU, authorEmail: 'a@x', files: ['B'] },
    ]
    const m = new ScoreMap()
    applyCommits(m, commits, [])
    assert.equal(m.normalize('A', 'B'), 0)
  })

  test('missing file returns score 0 without throwing', () => {
    const m = new ScoreMap()
    applyCommits(m, [{ timestamp: 0, authorEmail: 'a@x', files: ['A'] }], [])
    assert.equal(m.normalize('A', 'Z'), 0)
    assert.equal(m.normalize('Z', 'Z'), 0)
  })

  test('empty commit list yields empty score map', () => {
    const m = new ScoreMap()
    applyCommits(m, [], [])
    assert.deepEqual(Array.from(m.files()), [])
  })
})
