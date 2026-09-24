/** Graph searches shared by the analyzer and the viewer. */

export type Neighbours = (id: string) => Iterable<string>

/**
 * Everything reachable from `start`, with its distance in hops (`start` itself is 0).
 * With a "who imports me" neighbour function this is a file's blast radius.
 */
export function reachable(start: string, next: Neighbours): Map<string, number> {
  const depth = new Map([[start, 0]])
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]!
    for (const w of next(v)) {
      if (depth.has(w)) continue
      depth.set(w, depth.get(v)! + 1)
      queue.push(w)
    }
  }
  return depth
}

/**
 * The shortest chain of hops from `from` to `to`, inclusive, or null when there is none.
 * `from === to` finds the shortest cycle back to the start instead of a zero-length path.
 */
export function shortestPath(from: string, to: string, next: Neighbours): string[] | null {
  const prev = new Map<string, string>()
  const queue = [from]
  const seen = new Set<string>()
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]!
    for (const w of next(v)) {
      if (w === to) {
        const path = [v]
        while (path[0] !== from) path.unshift(prev.get(path[0]!)!)
        return [...path, to]
      }
      if (seen.has(w) || w === from) continue
      seen.add(w)
      prev.set(w, v)
      queue.push(w)
    }
  }
  return null
}
