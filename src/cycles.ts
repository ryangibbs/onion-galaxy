/**
 * Suggests which imports to remove to break a cycle.
 *
 * Finding the fewest edges whose removal makes a graph acyclic (a minimum feedback arc set) is
 * NP-hard, so this uses the Eades–Lin–Smyth heuristic: order the files so that as many imports as
 * possible point "forward", then cut the ones pointing backward. A second pass puts back every cut
 * that isn't needed, so each suggested cut is necessary: restoring any single one recreates a cycle.
 */

export interface WeightedEdge {
  source: string
  target: string
  /** Cost of cutting this edge, e.g. the number of import statements it stands for */
  weight: number
}

/** Edges to remove so that the graph formed by `edges` has no cycles. */
export function breakCycles<E extends WeightedEdge>(edges: E[]): E[] {
  const order = forwardOrder(edges)
  const cuts = edges.filter(e => order.get(e.source)! >= order.get(e.target)!)
  return minimise(edges, cuts)
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Eades–Lin–Smyth: a vertex order in which few (heavy) edges point backwards. */
function forwardOrder(edges: WeightedEdge[]): Map<string, number> {
  const outW = new Map<string, number>()
  const inW = new Map<string, number>()
  const outs = new Map<string, WeightedEdge[]>()
  const ins = new Map<string, WeightedEdge[]>()
  const remaining = new Set<string>()
  for (const e of edges) {
    remaining.add(e.source).add(e.target)
    if (e.source === e.target) continue // self-loops point backwards in any order
    outW.set(e.source, (outW.get(e.source) ?? 0) + e.weight)
    inW.set(e.target, (inW.get(e.target) ?? 0) + e.weight)
    push(outs, e.source, e)
    push(ins, e.target, e)
  }

  const remove = (v: string) => {
    remaining.delete(v)
    for (const e of outs.get(v) ?? []) inW.set(e.target, inW.get(e.target)! - e.weight)
    for (const e of ins.get(v) ?? []) outW.set(e.source, outW.get(e.source)! - e.weight)
  }

  const head: string[] = [] // grows forwards: sources and "most source-like" vertices
  const tail: string[] = [] // grows backwards: sinks
  while (remaining.size) {
    let changed = true
    while (changed) {
      changed = false
      for (const v of remaining) {
        if (!(outW.get(v) ?? 0)) {
          tail.push(v)
          remove(v)
          changed = true
        } else if (!(inW.get(v) ?? 0)) {
          head.push(v)
          remove(v)
          changed = true
        }
      }
    }
    // Only cycles left: take the vertex whose outgoing weight most exceeds its incoming weight
    let best: string | undefined
    let bestScore = -Infinity
    for (const v of remaining) {
      const score = (outW.get(v) ?? 0) - (inW.get(v) ?? 0)
      if (score > bestScore) [best, bestScore] = [v, score]
    }
    if (best !== undefined) {
      head.push(best)
      remove(best)
    }
  }
  return new Map([...head, ...tail.toReversed()].map((v, i) => [v, i]))
}

/** Put back cuts that aren't needed, most expensive first, keeping the rest acyclic. */
function minimise<E extends WeightedEdge>(edges: E[], cuts: E[]): E[] {
  const cut = new Set(cuts)
  const adjacency = new Map<string, string[]>()
  const addEdge = (e: WeightedEdge) => push(adjacency, e.source, e.target)
  for (const e of edges) if (!cut.has(e)) addEdge(e)

  const reaches = (from: string, to: string) => {
    const stack = [from]
    const seen = new Set(stack)
    while (stack.length) {
      const v = stack.pop()!
      if (v === to) return true
      for (const w of adjacency.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w)
          stack.push(w)
        }
      }
    }
    return false
  }

  // Kept edges only ever grow, so a cut that has to stay now has to stay for good: the result is minimal
  for (const e of cuts.toSorted((a, b) => b.weight - a.weight)) {
    if (!reaches(e.target, e.source)) {
      cut.delete(e)
      addEdge(e)
    }
  }
  return cuts.filter(e => cut.has(e))
}
