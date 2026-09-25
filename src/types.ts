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
  /** 0–1: how much of a hotspot this file is (log-scaled commits × lines); 0 when not ranked */
  hotspot: number
  /** 1 = biggest hotspot; null for data, generated files, tests and files unchanged in the last year */
  hotspotRank: number | null
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
  /** Removing this import is part of the suggested way to break its cycle */
  cut: boolean
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
  /** A minimal set of imports whose removal breaks every cycle among the members */
  cuts: { source: string; target: string }[]
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
  /** Where churn came from: git history, or why there isn't any */
  history: 'git' | 'shallow' | 'unavailable' | 'disabled'
  /** Commits read from the last year */
  historyCommits: number
  /** Bulk commits (dependency upgrades, codemods…) whose changes weren't counted */
  bulkCommits: number
  /** Files with a hotspot rank */
  rankedHotspots: number
  /** Ranks 1…topHotspots count as top hotspots (the top 2%) */
  topHotspots: number
  typeCycles: boolean
  /** Imports suggested for removal across all cycles */
  cuts: number
}

export const LAYOUTS = ['spiral', 'stability', 'ring', 'sphere'] as const
export type LayoutName = (typeof LAYOUTS)[number]

export const EDITORS = ['vscode', 'cursor', 'zed', 'webstorm', 'idea', 'none'] as const
export type EditorName = (typeof EDITORS)[number]

/** Presentation options, chosen on the command line */
export interface GalaxyView {
  layout: LayoutName
  editor: EditorName
}

export interface GalaxyData {
  meta: GalaxyMeta
  clusters: GalaxyCluster[]
  nodes: GalaxyNode[]
  links: GalaxyLink[]
  cycles: GalaxyCycle[]
  view: GalaxyView
}
