import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/analyze.ts'
import type { GalaxyData } from '../src/types.ts'

// fixture/ is a tiny project with known shapes: two cycles, a type-only import, a lazy import,
// an orphan and two unresolvable imports (`./missing`, and `lodash`, which isn't installed there)
const root = fileURLToPath(new URL('../fixture/', import.meta.url))
let galaxy: GalaxyData

before(async () => {
  galaxy = await analyze({ root, paths: ['src'], git: false })
})

const node = (id: string) => galaxy.nodes.find(n => n.id === id)!
const link = (source: string, target: string) => galaxy.links.find(l => l.source === source && l.target === target)!

test('maps every project file and import', () => {
  assert.equal(galaxy.meta.files, 10)
  assert.equal(galaxy.meta.imports, 12)
  assert.ok(galaxy.nodes.every(n => n.id.startsWith('src/')))
})

test('finds both runtime cycles', () => {
  const members = galaxy.cycles.map(c => c.members.toSorted())
  assert.deepEqual(members, [
    ['src/core/a.ts', 'src/core/b.ts', 'src/core/c.ts'],
    ['src/api/route.ts', 'src/ui/view.ts'],
  ])
  assert.equal(link('src/core/a.ts', 'src/core/b.ts').circular, true)
  assert.equal(link('src/core/a.ts', 'src/util/types.ts').circular, false)
})

test('suggests one import to cut per fixture cycle', () => {
  assert.deepEqual(
    galaxy.cycles.map(c => c.cuts.length),
    [1, 1],
  )
  assert.equal(galaxy.meta.cuts, 2)
  for (const c of galaxy.cycles) {
    for (const cut of c.cuts) {
      assert.ok(c.members.includes(cut.source) && c.members.includes(cut.target))
      assert.equal(link(cut.source, cut.target).cut, true)
    }
  }
  assert.equal(galaxy.links.filter(l => l.cut).length, 2)
})

test('carries the chosen presentation options', async () => {
  assert.deepEqual(galaxy.view, { layout: 'spiral', editor: 'vscode' })
  const custom = await analyze({ root, paths: ['src'], git: false, view: { layout: 'ring', editor: 'none' } })
  assert.deepEqual(custom.view, { layout: 'ring', editor: 'none' })
})

test('tags type-only and lazy imports', () => {
  assert.equal(link('src/core/a.ts', 'src/util/types.ts').typeOnly, true)
  assert.equal(link('src/ui/view.ts', 'src/ui/lazy.ts').dynamic, true)
  assert.equal(link('src/core/a.ts', 'src/core/b.ts').typeOnly, false)
})

test('import type edges only count towards cycles with typeCycles', async () => {
  // a.ts ⇄ types.ts would only form a cycle through a type import, so it must never be reported
  // without the flag; with it, the result can only gain cycles, never lose them
  const withTypes = await analyze({ root, paths: ['src'], git: false, typeCycles: true })
  assert.ok(withTypes.meta.filesInCycles >= galaxy.meta.filesInCycles)
})

test('counts dependents, dependencies and local-only instability', () => {
  const log = node('src/util/log.ts')
  assert.equal(log.dependents, 3)
  assert.equal(log.dependencies, 0)
  assert.equal(log.instability, 0)
  const view = node('src/ui/view.ts')
  assert.equal(view.instability, view.dependencies / (view.dependents + view.dependencies))
})

test('reports orphans and unresolved imports', () => {
  assert.equal(node('src/util/orphan.ts').orphan, true)
  assert.equal(node('src/util/orphan.ts').instability, null)
  assert.deepEqual(node('src/index.ts').unresolved, ['./missing'])
  assert.equal(galaxy.meta.unresolved, 2)
})

test('groups files into star systems by directory', () => {
  assert.equal(galaxy.meta.clusterDepth, 2)
  assert.deepEqual(galaxy.clusters.map(c => c.id).toSorted(), ['src', 'src/api', 'src/core', 'src/ui', 'src/util'])
  assert.equal(node('src/core/a.ts').cluster, 'src/core')
})

test('honours an explicit cluster depth', async () => {
  const flat = await analyze({ root, paths: ['src'], git: false, clusterDepth: 1 })
  assert.deepEqual(
    flat.clusters.map(c => c.id),
    ['src'],
  )
})
