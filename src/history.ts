/**
 * Change frequency from git: how many commits touched each file in the last year.
 *
 * Three things would otherwise skew it:
 * - Bulk commits (dependency upgrades, codemods, mass reformatting) touch hundreds of files at once
 *   and say nothing about how often each one really changes, so they aren't counted. Their renames
 *   still are followed.
 * - Renames: a moved file keeps the commits it had under its old name.
 * - Shallow clones (CI checks out with depth 1 by default) have almost no history, so the numbers
 *   would be silently wrong. History is skipped instead, with a reason.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** Commits touching more files than this are treated as bulk changes */
export const BULK_COMMIT_FILES = 100

export type HistoryStatus = 'git' | 'shallow' | 'unavailable' | 'disabled'

export interface History {
  status: HistoryStatus
  /** Commits per file, keyed by absolute path, under the file's current name */
  churn: Map<string, number>
  /** Commits read from the last year */
  commits: number
  /** Of those, bulk commits whose changes weren't counted */
  bulkCommits: number
}

/** Marks the start of each commit in the log output */
const COMMIT = '\u001e'

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

const empty = (status: HistoryStatus): History => ({ status, churn: new Map(), commits: 0, bulkCommits: 0 })

export function readHistory(cwd: string, { enabled = true } = {}): History {
  if (!enabled) return empty('disabled')
  let top: string
  try {
    top = git(cwd, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return empty('unavailable') // not a git repository, or git isn't installed
  }
  if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true') return empty('shallow')
  const log = git(cwd, [
    // keep non-ASCII paths readable instead of octal-escaped
    '-c',
    'core.quotePath=false',
    'log',
    '--since=1.year',
    '-M', // report renames, so history can follow them
    '--name-status',
    `--format=${COMMIT}%H`,
  ])
  return { status: 'git', ...parseHistory(log, top) }
}

/**
 * Parses `git log --name-status -M --format=<COMMIT>%H`, newest commit first. Walking backwards in
 * time, each rename maps the older name onto the file's current name, so earlier commits count
 * towards the file as it's called today.
 */
export function parseHistory(log: string, root: string, bulkLimit = BULK_COMMIT_FILES) {
  const churn = new Map<string, number>()
  /** older path → path it's known by today */
  const renamedTo = new Map<string, string>()
  const current = (p: string) => renamedTo.get(p) ?? p
  let commits = 0
  let bulkCommits = 0

  for (const block of log.split(COMMIT)) {
    const lines = block.split('\n').filter(l => l.includes('\t'))
    if (!block.trim()) continue
    commits++
    const bulk = lines.length > bulkLimit
    if (bulk) bulkCommits++
    for (const line of lines) {
      const [status = '', ...paths] = line.split('\t')
      // R<score>: renamed from paths[0] to paths[1]; C<score>: copied, which is a new file
      const file = status.startsWith('R') || status.startsWith('C') ? paths[1]! : paths[0]!
      const now = current(file)
      if (!bulk) churn.set(now, (churn.get(now) ?? 0) + 1)
      if (status.startsWith('R')) renamedTo.set(paths[0]!, now)
    }
  }

  return {
    churn: new Map([...churn].map(([p, n]) => [path.join(root, p), n])),
    commits,
    bulkCommits,
  }
}
