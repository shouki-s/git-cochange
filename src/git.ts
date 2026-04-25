import simpleGit from 'simple-git'

export interface CommitInfo {
  timestamp: number
  authorEmail: string
  files: string[]
}

export async function fetchCommits(
  repoPath: string,
  options: { ref: string; includeMergeCommits: boolean },
): Promise<CommitInfo[]> {
  const git = simpleGit(repoPath)

  const args: string[] = ['log', '--format=COMMIT%n%ae%n%at', '--name-only']
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
  if (!output) return []

  // git log emits one block per commit, each prefixed with a literal "COMMIT"
  // marker line. Strip the leading marker, then split on the between-commit
  // markers to get one block per commit.
  const body = output.startsWith('COMMIT\n') ? output.slice('COMMIT\n'.length) : output
  const blocks = body.split('\nCOMMIT\n')

  const commits: CommitInfo[] = []
  for (const block of blocks) {
    const [emailLine, tsLine, ...fileLines] = block.split('\n')
    const authorEmail = emailLine?.trim() ?? ''
    const timestamp = parseInt(tsLine?.trim() ?? '', 10)
    if (!authorEmail || Number.isNaN(timestamp)) continue

    const files = fileLines.map((l) => l.trim()).filter(Boolean)
    if (files.length > 0) {
      commits.push({ timestamp, authorEmail, files })
    }
  }

  return commits
}
