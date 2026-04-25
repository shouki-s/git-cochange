#!/usr/bin/env -S npx tsx
// git-cochange demo: clone a GitHub repo, analyze it, and emit a
// self-contained HTML force graph. Run with --help for usage.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import simpleGit from 'simple-git'
import { Analyzer } from '../../src/index'

const TEMPLATE_PATH = join(__dirname, 'template.html')

// Cap related-files-per-file at the embedding stage so the JSON payload
// stays roughly O(N) instead of O(N^2) on large repos. Must match the
// HTML slider's top-K max (any value beyond this would be unrepresentable
// anyway because the cap drops those pairs from the embedding).
const TOP_K_CAP = 20

interface Args {
  repo: string
  out: string
}

interface Pair {
  a: string
  b: string
  score: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repo: '', out: 'graph.html' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') printHelpAndExit(0)
    else if (a === '--out') args.out = argv[++i] ?? printHelpAndExit(1)
    else if (!a.startsWith('--') && !args.repo) args.repo = a
    else printHelpAndExit(1)
  }
  if (!args.repo) printHelpAndExit(1)
  return args
}

function printHelpAndExit(code: number): never {
  const msg = `Usage: visualize.ts <repo> [options]

Arguments:
  <repo>                GitHub repo (owner/name or URL)

Options:
  --out <file>          Output HTML path (default: graph.html)
  -h, --help            Show this help
`
  process.stdout.write(msg)
  process.exit(code)
}

function normalizeRepoUrl(input: string): string {
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('git@')) {
    return input
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) {
    return `https://github.com/${input}.git`
  }
  throw new Error(`Cannot interpret as a GitHub repo: ${input}`)
}

async function tempDir(prefix: string): Promise<{ path: string } & AsyncDisposable> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  return { path, [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }) }
}

function buildPairs(analyzer: Analyzer): Pair[] {
  const pairs: Pair[] = []
  const seen = new Set<string>()

  for (const file of analyzer.getFiles()) {
    for (const r of analyzer.getRelated(file).slice(0, TOP_K_CAP)) {
      const [a, b] = file < r.file ? [file, r.file] : [r.file, file]
      const key = `${a}\t${b}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ a, b, score: r.score })
    }
  }

  pairs.sort((x, y) => y.score - x.score)
  return pairs
}

function renderHtml(pairs: Pair[], title: string): string {
  // Escape `<` so the JSON cannot prematurely close the embedding <script>.
  const dataJson = JSON.stringify({ pairs }).replace(/</g, '\\u003c')
  const template = readFileSync(TEMPLATE_PATH, 'utf-8')
  // The data placeholder is quoted in the template so it parses as a valid JSON
  // string for biome; we replace including the quotes.
  // split/join avoids both ES2021 dependency and `$` substitution in replacement strings.
  return template.split('"__GRAPH_DATA__"').join(dataJson).split('__TITLE__').join(escapeHtml(title))
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await using repo = await tempDir('git-cochange-')

  const url = normalizeRepoUrl(args.repo)
  console.log(`Cloning ${url} → ${repo.path}`)
  await simpleGit().clone(url, repo.path)

  console.log(`Analyzing ${repo.path} ...`)
  const analyzer = new Analyzer(repo.path)
  await analyzer.analyze()

  const pairs = buildPairs(analyzer)
  console.log(`Embedded ${pairs.length} pairs (filtering happens in the browser)`)

  const html = renderHtml(pairs, args.repo)
  const outPath = resolve(args.out)
  await writeFile(outPath, html, 'utf-8')
  console.log(`Wrote ${outPath}`)
}

main()
