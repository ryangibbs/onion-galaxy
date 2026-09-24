import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reachable, shortestPath } from '../src/graph.ts'

// a → b → c → d, a → c, e is disconnected, c → b closes a loop
const edges: Record<string, string[]> = { a: ['b', 'c'], b: ['c'], c: ['d', 'b'], d: [], e: [] }
const next = (id: string) => edges[id] ?? []

test('reachable reports every file within reach and its distance', () => {
  assert.deepEqual(Object.fromEntries(reachable('a', next)), { a: 0, b: 1, c: 1, d: 2 })
  assert.deepEqual(Object.fromEntries(reachable('e', next)), { e: 0 })
})

test('reachable terminates on cycles', () => {
  assert.deepEqual(Object.fromEntries(reachable('b', next)), { b: 0, c: 1, d: 2 })
})

test('shortestPath finds the fewest hops', () => {
  assert.deepEqual(shortestPath('a', 'd', next), ['a', 'c', 'd'])
  assert.deepEqual(shortestPath('b', 'd', next), ['b', 'c', 'd'])
})

test('shortestPath returns null when there is no path', () => {
  assert.equal(shortestPath('d', 'a', next), null)
  assert.equal(shortestPath('a', 'e', next), null)
})

test('shortestPath from a file to itself finds the shortest cycle through it', () => {
  assert.deepEqual(shortestPath('b', 'b', next), ['b', 'c', 'b'])
  assert.equal(shortestPath('a', 'a', next), null)
})
