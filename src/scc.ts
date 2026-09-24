/**
 * Tarjan's strongly connected components, iterative so deep import chains
 * can't blow the call stack.
 */
export function stronglyConnectedComponents<T>(graph: Map<T, T[]>): T[][] {
  let index = 0
  const indices = new Map<T, number>()
  const lowlink = new Map<T, number>()
  const onStack = new Set<T>()
  const stack: T[] = []
  const components: T[][] = []

  for (const start of graph.keys()) {
    if (indices.has(start)) continue
    // Each frame is [vertex, index of the next edge to visit]
    const work: [T, number][] = [[start, 0]]
    while (work.length) {
      const frame = work[work.length - 1]!
      const [v, i] = frame
      if (i === 0) {
        indices.set(v, index)
        lowlink.set(v, index)
        index++
        stack.push(v)
        onStack.add(v)
      }
      const edges = graph.get(v) ?? []
      if (i < edges.length) {
        frame[1]++
        const w = edges[i]!
        if (!indices.has(w)) work.push([w, 0])
        else if (onStack.has(w)) lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1]![0]
        lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(v)!))
      }
      if (lowlink.get(v) === indices.get(v)) {
        const component: T[] = []
        let w: T
        do {
          w = stack.pop()!
          onStack.delete(w)
          component.push(w)
        } while (w !== v)
        components.push(component)
      }
    }
  }
  return components
}
