import simpleGit from 'simple-git'

export interface CommitInfo {
  timestamp: number
  authorEmail: string
  files: string[]
}

export async function fetchCommits(
  repoPath: string,
  options: { ref: string; includeMergeCommits: boolean }
): Promise<CommitInfo[]> {
  const git = simpleGit(repoPath)

  const args: string[] = [
    'log',
    '--format=COMMIT%n%ae%n%at',
    '--name-only',
  ]
  if (!options.includeMergeCommits) args.push('--no-merges')
  args.push(options.ref)

  const output = await git.raw(args)
  return parseLogOutput(output)
}

export async function getTrackedFiles(repoPath: string): Promise<Set<string>> {
  const git = simpleGit(repoPath)
  const output = await git.raw(['ls-files'])
  return new Set(output.split('\n').filter(Boolean))
}

export function parseLogOutput(output: string): CommitInfo[] {
  const commits: CommitInfo[] = []
  const lines = output.split('\n')
  let i = 0

  while (i < lines.length) {
    if (lines[i] === 'COMMIT') {
      const authorEmail = lines[i + 1]?.trim() ?? ''
      const timestamp = parseInt(lines[i + 2]?.trim() ?? '', 10)
      i += 3

      if (!authorEmail || isNaN(timestamp)) continue

      const files: string[] = []
      while (i < lines.length && lines[i] !== 'COMMIT') {
        const line = lines[i].trim()
        if (line) files.push(line)
        i++
      }

      if (files.length > 0) {
        commits.push({ timestamp, authorEmail, files })
      }
    } else {
      i++
    }
  }

  return commits
}
