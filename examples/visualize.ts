#!/usr/bin/env -S npx tsx
//
// git-cochange demo: clone a GitHub repository (or use a local one),
// run the analyzer, and emit a self-contained HTML visualizing the
// co-change graph as a D3 force-directed layout. Files with stronger
// co-change relations are pulled closer together.
//
// Usage:
//   npx tsx examples/visualize.ts <repo> [--out graph.html]
//                                        [--min-score 0.1]
//                                        [--top-k 5]
//                                        [--cache-dir .cache/repo]
//
// <repo> accepts: owner/name, https://github.com/owner/name(.git),
// git@github.com:owner/name.git, or a path to a local clone.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import simpleGit from 'simple-git'
import { Analyzer } from '../src/index'

const TEMPLATE_PATH = join(__dirname, 'template.html')

interface Args {
  repo: string
  out: string
  minScore: number
  topK: number
  cacheDir: string | null
}

interface GraphNode {
  id: string
  group: string
  degree: number
}

interface GraphLink {
  source: string
  target: string
  score: number
}

interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const opts: Record<string, string> = {}

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') {
      printHelpAndExit(0)
    } else if (a.startsWith('--')) {
      const key = a.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        console.error(`Missing value for --${key}`)
        printHelpAndExit(1)
      }
      opts[key] = value
      i++
    } else {
      positional.push(a)
    }
  }

  if (positional.length !== 1) {
    console.error('Expected exactly one <repo> argument.')
    printHelpAndExit(1)
  }

  return {
    repo: positional[0],
    out: opts.out ?? 'graph.html',
    minScore: opts['min-score'] ? Number(opts['min-score']) : 0.1,
    topK: opts['top-k'] ? Number(opts['top-k']) : 5,
    cacheDir: opts['cache-dir'] ?? null,
  }
}

function printHelpAndExit(code: number): never {
  const msg = `Usage: visualize.ts <repo> [options]

Arguments:
  <repo>                GitHub repo (owner/name, URL) or local path

Options:
  --out <file>          Output HTML path (default: graph.html)
  --min-score <n>       Drop edges with score below n (default: 0.1)
  --top-k <n>           Keep up to top-K related files per file (default: 5)
  --cache-dir <dir>     Reuse this directory for the clone (default: temp)
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

async function resolveRepoPath(
  repo: string,
  cacheDir: string | null,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (existsSync(repo)) {
    return { path: resolve(repo), cleanup: async () => {} }
  }

  const url = normalizeRepoUrl(repo)
  const dir = cacheDir ? resolve(cacheDir) : await mkdtemp(join(tmpdir(), 'git-cochange-'))

  if (cacheDir) await mkdir(dir, { recursive: true })

  if (existsSync(join(dir, '.git'))) {
    console.log(`Using existing clone at ${dir}`)
  } else {
    console.log(`Cloning ${url} → ${dir}`)
    await simpleGit().clone(url, dir)
  }

  const cleanup = cacheDir ? async () => {} : async () => rm(dir, { recursive: true, force: true })
  return { path: dir, cleanup }
}

function buildGraph(analyzer: Analyzer, minScore: number, topK: number): Graph {
  const files = analyzer.getFiles()

  const links: GraphLink[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const related = analyzer.getRelated(file).slice(0, topK)
    for (const r of related) {
      if (r.score < minScore) continue
      const key = file < r.file ? `${file} ${r.file}` : `${r.file} ${file}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ source: file, target: r.file, score: r.score })
    }
  }

  const degree = new Map<string, number>()
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
  }

  const nodes: GraphNode[] = []
  for (const id of degree.keys()) {
    nodes.push({ id, group: topLevelDir(id), degree: degree.get(id) ?? 0 })
  }

  return { nodes, links }
}

function topLevelDir(path: string): string {
  const idx = path.indexOf('/')
  return idx === -1 ? '(root)' : path.slice(0, idx)
}

function renderHtml(graph: Graph, title: string): string {
  // Escape `<` so the JSON cannot prematurely close the embedding <script>.
  const dataJson = JSON.stringify(graph).replace(/</g, '\\u003c')
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

  const { path: repoPath, cleanup } = await resolveRepoPath(args.repo, args.cacheDir)

  try {
    console.log(`Analyzing ${repoPath} …`)
    const analyzer = new Analyzer(repoPath)
    await analyzer.analyze()

    const graph = buildGraph(analyzer, args.minScore, args.topK)
    console.log(`Graph: ${graph.nodes.length} nodes, ${graph.links.length} edges`)

    const html = renderHtml(graph, args.repo)
    const outPath = resolve(args.out)
    await writeFile(outPath, html, 'utf-8')
    console.log(`Wrote ${outPath}`)
  } finally {
    await cleanup()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
