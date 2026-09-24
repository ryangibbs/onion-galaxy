import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stronglyConnectedComponents } from '../src/scc.ts'

const sccs = (edges: Record<string, string[]>) =>
  stronglyConnectedComponents(new Map(Object.entries(edges)))
    .map(c => c.toSorted().join(','))
    .toSorted()

test('a graph without cycles has one component per vertex', () => {
  assert.deepEqual(sccs({ a: ['b'], b: ['c'], c: [] }), ['a', 'b', 'c'])
})

test('finds a simple cycle', () => {
  assert.deepEqual(sccs({ a: ['b'], b: ['a'], c: ['a'] }), ['a,b', 'c'])
})

test('finds overlapping cycles as one component', () => {
  // a → b → c → a and b → d → b share b, so all four can reach each other
  assert.deepEqual(sccs({ a: ['b'], b: ['c', 'd'], c: ['a'], d: ['b'] }), ['a,b,c,d'])
})

test('keeps separate cycles separate', () => {
  assert.deepEqual(sccs({ a: ['b'], b: ['a', 'c'], c: ['d'], d: ['c'] }), ['a,b', 'c,d'])
})

test('handles self-loops and edges to vertices missing from the map', () => {
  assert.deepEqual(sccs({ a: ['a', 'ghost'] }), ['a', 'ghost'])
})

test('does not overflow the stack on a very long import chain', () => {
  const n = 50_000
  const graph = new Map(Array.from({ length: n }, (_, i) => [`m${i}`, i < n - 1 ? [`m${i + 1}`] : ['m0']]))
  const components = stronglyConnectedComponents(graph)
  assert.equal(components.length, 1)
  assert.equal(components[0]!.length, n)
})
