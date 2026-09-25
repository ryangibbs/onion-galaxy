import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { parseHistory, readHistory } from '../src/history.ts'

const RS = '\u001e'
/** Builds `git log --name-status` output, newest commit first */
const log = (...commits: string[][]) => commits.map((lines, i) => `${RS}sha${i}\n\n${lines.join('\n')}\n`).join('')
const counts = (h: { churn: Map<string, number> }) =>
  Object.fromEntries([...h.churn].map(([p, n]) => [path.relative('/repo', p), n]))

test('counts commits per file', () => {
  const h = parseHistory(log(['M\tsrc/a.ts', 'M\tsrc/b.ts'], ['M\tsrc/a.ts'], ['A\tsrc/a.ts']), '/repo')
  assert.deepEqual(counts(h), { 'src/a.ts': 3, 'src/b.ts': 1 })
  assert.equal(h.commits, 3)
})

test('follows renames back to the current name', () => {
  // newest first: b.ts was renamed to c.ts, a.ts was renamed to b.ts before that
  const h = parseHistory(
    log(
      ['M\tsrc/c.ts'],
      ['R100\tsrc/b.ts\tsrc/c.ts'],
      ['M\tsrc/b.ts'],
      ['R095\tsrc/a.ts\tsrc/b.ts'],
      ['M\tsrc/a.ts'],
      ['A\tsrc/a.ts'],
    ),
    '/repo',
  )
  assert.deepEqual(counts(h), { 'src/c.ts': 6 })
})

test('ignores bulk commits, but still follows their renames', () => {
  const bulk = Array.from({ length: 5 }, (_, i) => `M\tsrc/other${i}.ts`)
  const h = parseHistory(
    log(
      ['M\tlib/a.ts'],
      [...bulk, 'R100\tsrc/a.ts\tlib/a.ts'], // a mass move that also touched lots of files
      ['M\tsrc/a.ts'],
    ),
    '/repo',
    4,
  )
  assert.deepEqual(counts(h), { 'lib/a.ts': 2 })
  assert.equal(h.bulkCommits, 1)
})

test('counts a copy as a new file, not a rename', () => {
  const h = parseHistory(log(['C100\tsrc/a.ts\tsrc/copy.ts'], ['M\tsrc/a.ts']), '/repo')
  assert.deepEqual(counts(h), { 'src/copy.ts': 1, 'src/a.ts': 1 })
})

test('handles paths with spaces and no history', () => {
  assert.deepEqual(counts(parseHistory(log(['M\tsrc/my file.ts']), '/repo')), { 'src/my file.ts': 1 })
  assert.equal(parseHistory('', '/repo').commits, 0)
})

// End-to-end against real repositories, since the flags and output format matter
const work = mkdtempSync(path.join(tmpdir(), 'onion-galaxy-history-'))
after(() => rmSync(work, { recursive: true, force: true }))
const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })

test('reads a real repository and follows a git mv', () => {
  const repo = path.join(work, 'repo')
  execFileSync('mkdir', ['-p', path.join(repo, 'src')])
  run(repo, 'init', '-q')
  writeFileSync(path.join(repo, 'src/old.ts'), 'export const a = 1\n'.repeat(20))
  run(repo, 'add', '.')
  run(repo, 'commit', '-qm', 'add')
  writeFileSync(path.join(repo, 'src/old.ts'), 'export const a = 2\n'.repeat(20))
  run(repo, 'commit', '-qam', 'change')
  run(repo, 'mv', 'src/old.ts', 'src/new.ts')
  run(repo, 'commit', '-qm', 'rename')
  const h = readHistory(repo)
  assert.equal(h.status, 'git')
  // the old name's two commits carry over to the new name
  assert.deepEqual(Object.fromEntries([...h.churn].map(([p, n]) => [path.basename(p), n])), { 'new.ts': 3 })
  assert.equal(h.commits, 3)
})

test('refuses to guess from a shallow clone', () => {
  const shallow = path.join(work, 'shallow')
  run(work, 'clone', '-q', '--depth', '1', `file://${path.join(work, 'repo')}`, shallow)
  const h = readHistory(shallow)
  assert.equal(h.status, 'shallow')
  assert.equal(h.churn.size, 0)
})

test('reports when there is no repository or history is off', () => {
  const plain = mkdtempSync(path.join(tmpdir(), 'onion-galaxy-plain-'))
  try {
    assert.equal(readHistory(plain).status, 'unavailable')
    assert.equal(readHistory(plain, { enabled: false }).status, 'disabled')
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})
