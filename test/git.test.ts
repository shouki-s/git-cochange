import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogOutput } from '../src/git'

describe('parseLogOutput', () => {
  test('parses a single commit with multiple files', () => {
    const output = [
      'COMMIT',
      'alice@example.com',
      '1700000000',
      'src/a.ts',
      'src/b.ts',
      '',
    ].join('\n')

    const commits = parseLogOutput(output)
    assert.equal(commits.length, 1)
    assert.deepEqual(commits[0], {
      authorEmail: 'alice@example.com',
      timestamp: 1700000000,
      files: ['src/a.ts', 'src/b.ts'],
    })
  })

  test('parses multiple commits', () => {
    const output = [
      'COMMIT',
      'alice@example.com',
      '1700000000',
      'a.ts',
      '',
      'COMMIT',
      'bob@example.com',
      '1700001000',
      'b.ts',
      'c.ts',
      '',
    ].join('\n')

    const commits = parseLogOutput(output)
    assert.equal(commits.length, 2)
    assert.equal(commits[0].authorEmail, 'alice@example.com')
    assert.deepEqual(commits[0].files, ['a.ts'])
    assert.equal(commits[1].authorEmail, 'bob@example.com')
    assert.deepEqual(commits[1].files, ['b.ts', 'c.ts'])
  })

  test('skips commits with no files (e.g. empty or pure-merge)', () => {
    const output = [
      'COMMIT',
      'alice@example.com',
      '1700000000',
      '',
      'COMMIT',
      'bob@example.com',
      '1700001000',
      'b.ts',
      '',
    ].join('\n')

    const commits = parseLogOutput(output)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].authorEmail, 'bob@example.com')
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(parseLogOutput(''), [])
  })

  test('skips commits with invalid timestamp', () => {
    const output = [
      'COMMIT',
      'alice@example.com',
      'not-a-number',
      'a.ts',
      '',
      'COMMIT',
      'bob@example.com',
      '1700001000',
      'b.ts',
      '',
    ].join('\n')

    const commits = parseLogOutput(output)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].authorEmail, 'bob@example.com')
  })

  test('ignores blank file lines', () => {
    const output = [
      'COMMIT',
      'alice@example.com',
      '1700000000',
      'a.ts',
      '',
      '',
      'b.ts',
      '',
    ].join('\n')

    const commits = parseLogOutput(output)
    assert.equal(commits.length, 1)
    assert.deepEqual(commits[0].files, ['a.ts', 'b.ts'])
  })
})
