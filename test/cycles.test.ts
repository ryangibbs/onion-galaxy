import assert from 'node:assert/strict'
import { test } from 'node:test'
import { breakCycles, type WeightedEdge } from '../src/cycles.ts'
import { stronglyConnectedComponents } from '../src/scc.ts'

const edge = (source: string, target: string, weight = 1): WeightedEdge => ({ source, target, weight })
const key = (e: WeightedEdge) => `${e.source}→${e.target}`

function hasCycle(edges: WeightedEdge[]): boolean {
  const graph = new Map<string, string[]>()
  for (const e of edges) {
    graph.set(e.source, [...(graph.get(e.source) ?? []), e.target])
    if (!graph.has(e.target)) graph.set(e.target, [])
  }
  return (
    edges.some(e => e.source === e.target) || stronglyConnectedComponents(graph).some(component => component.length > 1)
  )
}

/** The two guarantees: cutting breaks every cycle, and no cut can be put back */
function assertMinimalCut(edges: WeightedEdge[], cuts: WeightedEdge[]) {
  const kept = edges.filter(e => !cuts.includes(e))
  assert.equal(hasCycle(kept), false, 'graph is acyclic after the cuts')
  for (const c of cuts) assert.equal(hasCycle([...kept, c]), true, `cut ${key(c)} is necessary`)
}

test('a simple cycle needs exactly one cut', () => {
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
  const cuts = breakCycles(edges)
  assert.equal(cuts.length, 1)
  assertMinimalCut(edges, cuts)
})

test('prefers cutting the lighter edge of a pair', () => {
  // a imports b in five places, b imports a once: cutting b → a is the smaller change
  const edges = [edge('a', 'b', 5), edge('b', 'a', 1)]
  assert.deepEqual(breakCycles(edges).map(key), ['b→a'])
})

test('one well-placed cut can break several cycles', () => {
  // b → c sits on both a → b → c → a and b → c → d → b
  const edges = [edge('a', 'b'), edge('b', 'c', 3), edge('c', 'a'), edge('c', 'd'), edge('d', 'b')]
  const cuts = breakCycles(edges)
  assertMinimalCut(edges, cuts)
  assert.ok(cuts.length <= 2)
})

test('always cuts self-imports', () => {
  const edges = [edge('a', 'a'), edge('a', 'b')]
  assert.deepEqual(breakCycles(edges).map(key), ['a→a'])
})

test('leaves an acyclic graph alone', () => {
  assert.deepEqual(breakCycles([edge('a', 'b'), edge('b', 'c'), edge('a', 'c')]), [])
})

test('random graphs: cuts are always sufficient and minimal', () => {
  // Small deterministic PRNG so failures are reproducible
  let seed = 42
  const random = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32
  for (let round = 0; round < 200; round++) {
    const n = 2 + Math.floor(random() * 12)
    const edges: WeightedEdge[] = []
    for (let i = 0; i < n * 2; i++) {
      edges.push(edge(`v${Math.floor(random() * n)}`, `v${Math.floor(random() * n)}`, 1 + Math.floor(random() * 4)))
    }
    assertMinimalCut(edges, breakCycles(edges))
  }
})
