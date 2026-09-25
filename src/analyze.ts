import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { cruise, type ICruiseOptions, type ICruiseResult, type IModule } from 'dependency-cruiser'
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config'
import { breakCycles } from './cycles.ts'
import { rankHotspots, topHotspotCount } from './hotspots.ts'
import { stronglyConnectedComponents } from './scc.ts'
import type { GalaxyCluster, GalaxyCycle, GalaxyData, GalaxyLink, GalaxyNode, GalaxyView } from './types.ts'

const DEFAULT_EXCLUDE = '(^|/)(dist|build|coverage|tmp|\\.git)/|\\.d\\.ts$'
/**
 * Always excluded, on top of `exclude`. dependency-cruiser drops any import that resolves to an
 * excluded path, so this removes npm packages from the graph entirely: only the project's own files
 * and the imports between them remain, and instability counts local dependencies only.
 */
const NODE_MODULES = '(^|/)node_modules/'

export interface AnalyzeOptions {
  /** Project root; paths and tsconfig are resolved relative to it */
  root: string
  /** Files/dirs to cruise, relative to root */
  paths: string[]
  tsConfig?: string
  /** Regex of paths to skip */
  exclude?: string
  /** Count `import type` edges when detecting cycles */
  typeCycles?: boolean
  /** Read git history for churn */
  git?: boolean
  /** Directory depth that defines a star system; auto when omitted */
  clusterDepth?: number
  view?: Partial<GalaxyView>
  log?: (msg: string) => void
}

interface BuildOptions {
  root: string
  typeCycles: boolean
  churn: Map<string, number>
  clusterDepth?: number
}

/**
 * Runs dependency-cruiser over `paths` (relative to `root`) and turns the result
 * into a galaxy: nodes (files), links (imports), clusters (star systems) and cycles.
 */
export async function analyze({
  root,
  paths,
  tsConfig,
  exclude = DEFAULT_EXCLUDE,
  typeCycles = false,
  git = true,
  clusterDepth,
  view,
  log = () => {},
}: AnalyzeOptions): Promise<GalaxyData> {
  const cwd = process.cwd()
  process.chdir(root)
  try {
    tsConfig ??= existsSync('tsconfig.json') ? 'tsconfig.json' : undefined
    log(`Cruising ${paths.join(', ')}${tsConfig ? ` with ${tsConfig}` : ''}…`)

    const cruiseOptions: ICruiseOptions = {
      exclude: { path: [exclude, NODE_MODULES] },
      tsPreCompilationDeps: true, // keeps `import type` edges, flagged type-only
      experimentalStats: true, // size + top-level statement count
      combinedDependencies: true,
      ...(tsConfig && { tsConfig: { fileName: tsConfig } }),
    }
    const { output } = await cruise(
      paths,
      cruiseOptions,
      {
        extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
        // Resolve package imports properly (incl. "exports" subpaths like `@scope/lib/datetime`) so they
        // land in node_modules and get excluded, rather than being reported as unresolved
        exportsFields: ['exports'],
        conditionNames: ['import', 'require', 'node', 'default', 'types'],
        mainFields: ['module', 'main', 'types', 'typings'],
      },
      { tsConfig: tsConfig ? extractTSConfig(tsConfig) : undefined },
    )
    const result: ICruiseResult = typeof output === 'string' ? JSON.parse(output) : output
    log(`Found ${result.summary.totalCruised} modules, ${result.summary.totalDependenciesCruised} dependencies`)

    const galaxy = buildGalaxy(result, { root, typeCycles, churn: git ? gitChurn(log) : new Map(), clusterDepth })
    return { ...galaxy, view: { layout: 'spiral', editor: 'vscode', ...view } }
  } finally {
    process.chdir(cwd)
  }
}

// What's left besides project files: Node built-ins (`node:fs`) and unresolvable specifiers
const isProjectFile = (m: IModule) => !m.coreModule && !m.couldNotResolve && !m.dependencyTypes?.includes('core')

const newNode = (id: string, fields: Partial<GalaxyNode>): GalaxyNode => ({
  id,
  name: path.basename(id),
  dir: path.dirname(id),
  cluster: '',
  bytes: 0,
  statements: 0,
  loc: 0,
  instability: null,
  orphan: false,
  churn: 0,
  dependents: 0,
  dependencies: 0,
  cycle: null,
  unresolved: [],
  violations: [],
  hotspot: 0,
  hotspotRank: null,
  ...fields,
})

function addTo(map: Map<string, Set<string>>, key: string, value: string) {
  const set = map.get(key) ?? new Set()
  set.add(value)
  map.set(key, set)
}

function buildGalaxy(
  result: ICruiseResult,
  { root, typeCycles, churn, clusterDepth }: BuildOptions,
): Omit<GalaxyData, 'view'> {
  const localModules = result.modules.filter(isProjectFile)
  const localIds = new Set(localModules.map(m => m.source))

  const nodes = new Map<string, GalaxyNode>()
  for (const m of localModules) {
    nodes.set(
      m.source,
      newNode(m.source, {
        bytes: m.experimentalStats?.size ?? 0,
        statements: m.experimentalStats?.topLevelStatementCount ?? 0,
        loc: countLines(m.source),
        orphan: !!m.orphan,
        churn: churn.get(path.resolve(m.source)) ?? 0,
        violations: (m.rules ?? []).map(r => r.name),
      }),
    )
  }

  const links: GalaxyLink[] = []
  for (const m of localModules) {
    const node = nodes.get(m.source)!
    for (const d of m.dependencies) {
      const edge = {
        source: m.source,
        specifier: d.module,
        types: d.dependencyTypes,
        dynamic: !!d.dynamic || d.dependencyTypes.includes('dynamic-import'),
        typeOnly: !!d.typeOnly || d.dependencyTypes.includes('type-only'),
        preCompilationOnly: !!d.preCompilationOnly,
        circular: false,
        cut: false,
        count: 1,
      }
      if (d.couldNotResolve) {
        node.unresolved.push(d.module)
      } else if (localIds.has(d.resolved)) {
        links.push({ ...edge, target: d.resolved })
      }
    }
  }

  // Cycles: every edge inside a non-trivial strongly connected component is part of a cycle.
  // `import type` edges are erased at compile time, so by default they can't form a (runtime) cycle.
  const countsForCycles = (l: GalaxyLink) => typeCycles || !l.typeOnly
  const adjacency = new Map<string, string[]>([...nodes.keys()].map(id => [id, []]))
  for (const l of links) if (countsForCycles(l)) adjacency.get(l.source)!.push(l.target)
  const cycles: GalaxyCycle[] = stronglyConnectedComponents(adjacency)
    .filter(c => c.length > 1 || adjacency.get(c[0]!)!.includes(c[0]!))
    .toSorted((a, b) => b.length - a.length)
    .map((members, i) => ({ id: i, size: members.length, members, cuts: [] }))
  const cycleOf = new Map<string, number>()
  for (const c of cycles) for (const id of c.members) cycleOf.set(id, c.id)

  for (const l of links) {
    const c = cycleOf.get(l.source)
    l.circular = countsForCycles(l) && c !== undefined && c === cycleOf.get(l.target)
  }

  // Degree counts (unique neighbours, ignoring duplicate imports of the same file)
  const dependents = new Map<string, Set<string>>()
  const dependencies = new Map<string, Set<string>>()
  for (const l of links) {
    addTo(dependencies, l.source, l.target)
    addTo(dependents, l.target, l.source)
  }

  // Hotspots: big files that change often (only meaningful with git history)
  const hotspots = rankHotspots([...nodes.values()])
  for (const [id, h] of hotspots) Object.assign(nodes.get(id)!, { hotspot: h.score, hotspotRank: h.rank })

  // Star systems: group files by directory prefix
  const fileNodes = [...nodes.values()]
  const depth = clusterDepth ?? pickClusterDepth(fileNodes.map(n => n.dir))
  const clusters = new Map<string, GalaxyCluster>()
  for (const n of nodes.values()) {
    n.cluster = clusterKey(n.dir, depth)
    n.dependents = dependents.get(n.id)?.size ?? 0
    n.dependencies = dependencies.get(n.id)?.size ?? 0
    // Robert C. Martin's instability, Ce / (Ca + Ce), over project files only
    const degree = n.dependents + n.dependencies
    n.instability = degree ? n.dependencies / degree : null
    n.cycle = cycleOf.get(n.id) ?? null
    const c = clusters.get(n.cluster) ?? { id: n.cluster, files: 0, loc: 0, cycleFiles: 0 }
    c.files++
    c.loc += n.loc
    if (n.cycle !== null) c.cycleFiles++
    clusters.set(n.cluster, c)
  }

  // Collapse links between the same pair of files (e.g. a type import + a value import)
  const linkMap = new Map<string, GalaxyLink>()
  for (const l of links) {
    const key = `${l.source}\0${l.target}`
    const prev = linkMap.get(key)
    if (!prev) linkMap.set(key, { ...l })
    else {
      prev.count++
      prev.typeOnly &&= l.typeOnly
      prev.dynamic &&= l.dynamic
      prev.circular ||= l.circular
    }
  }

  // Suggest a minimal set of imports to remove per cycle; heavier edges (more import statements) cost more to cut
  const circularByCycle = new Map<number, GalaxyLink[]>()
  for (const l of linkMap.values()) {
    if (!l.circular) continue
    const c = cycleOf.get(l.source)!
    const list = circularByCycle.get(c)
    if (list) list.push(l)
    else circularByCycle.set(c, [l])
  }
  for (const cycle of cycles) {
    const edges = (circularByCycle.get(cycle.id) ?? []).map(l => ({
      source: l.source,
      target: l.target,
      weight: l.count,
      link: l,
    }))
    for (const e of breakCycles(edges)) {
      e.link.cut = true
      cycle.cuts.push({ source: e.source, target: e.target })
    }
  }

  return {
    meta: {
      root: path.resolve(root),
      project: path.basename(path.resolve(root)),
      generatedAt: new Date().toISOString(),
      clusterDepth: depth,
      files: fileNodes.length,
      imports: linkMap.size,
      cycles: cycles.length,
      filesInCycles: cycleOf.size,
      orphans: fileNodes.filter(n => n.orphan).length,
      unresolved: fileNodes.reduce((a, n) => a + n.unresolved.length, 0),
      hasChurn: churn.size > 0,
      rankedHotspots: hotspots.size,
      topHotspots: topHotspotCount(hotspots.size),
      typeCycles,
      cuts: cycles.reduce((a, c) => a + c.cuts.length, 0),
    },
    clusters: [...clusters.values()].toSorted((a, b) => b.files - a.files),
    nodes: [...nodes.values()],
    links: [...linkMap.values()],
    cycles,
  }
}

function clusterKey(dir: string, depth: number): string {
  const parts = dir === '.' ? [] : dir.split('/')
  return parts.slice(0, depth).join('/') || '(root)'
}

/** Choose the shallowest directory depth that yields a reasonable number of star systems. */
function pickClusterDepth(dirs: string[]): number {
  let best = 1
  let bestCount = 0
  for (let d = 1; d <= 5; d++) {
    const count = new Set(dirs.map(dir => clusterKey(dir, d))).size
    if (count >= 6) return d
    if (count > bestCount) [best, bestCount] = [d, count]
  }
  return best
}

function countLines(file: string): number {
  try {
    const text = readFileSync(file, 'utf8')
    let n = text.length && !text.endsWith('\n') ? 1 : 0
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
    return n
  } catch {
    return 0
  }
}

const git = (args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })

/** Number of commits touching each file in the last year, keyed by absolute path. */
function gitChurn(log: (msg: string) => void): Map<string, number> {
  const churn = new Map<string, number>()
  try {
    const top = git(['rev-parse', '--show-toplevel']).trim()
    for (const line of git(['log', '--since=1.year', '--name-only', '--format=']).split('\n')) {
      if (!line) continue
      const abs = path.join(top, line)
      churn.set(abs, (churn.get(abs) ?? 0) + 1)
    }
    log(`Read git history (${churn.size} files touched in the last year)`)
  } catch {
    // not a git repo — churn stays empty
  }
  return churn
}
