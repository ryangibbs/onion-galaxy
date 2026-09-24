/** The data contract between the analyzer (Node) and the viewer (browser). */

export interface GalaxyNode {
  /** Path relative to the project root */
  id: string
  name: string
  dir: string
  /** Directory prefix that defines the node's star system */
  cluster: string
  bytes: number
  /** Top-level statements, from dependency-cruiser's experimentalStats */
  statements: number
  loc: number
  /** dependencies / (dependents + dependencies): 0 = stable, 1 = unstable; null for orphans */
  instability: number | null
  orphan: boolean
  /** Commits touching the file in the last year */
  churn: number
  /** Unique local files importing this one */
  dependents: number
  /** Unique local files this one imports */
  dependencies: number
  /** Index into `GalaxyData.cycles`, or null when not in a cycle */
  cycle: number | null
  unresolved: string[]
  violations: string[]
}

export interface GalaxyLink {
  source: string
  target: string
  /** Specifier as written in the source, e.g. `./foo` */
  specifier: string
  types: string[]
  dynamic: boolean
  typeOnly: boolean
  preCompilationOnly: boolean
  circular: boolean
  /** Number of import statements collapsed into this edge */
  count: number
}

export interface GalaxyCluster {
  id: string
  files: number
  loc: number
  cycleFiles: number
}

/** A strongly connected component: every member can reach every other member. */
export interface GalaxyCycle {
  id: number
  size: number
  members: string[]
}

export interface GalaxyMeta {
  root: string
  project: string
  generatedAt: string
  clusterDepth: number
  files: number
  imports: number
  cycles: number
  filesInCycles: number
  orphans: number
  unresolved: number
  hasChurn: boolean
  typeCycles: boolean
}

export interface GalaxyData {
  meta: GalaxyMeta
  clusters: GalaxyCluster[]
  nodes: GalaxyNode[]
  links: GalaxyLink[]
  cycles: GalaxyCycle[]
}
