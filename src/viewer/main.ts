import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { reachable, shortestPath } from '../graph.ts'
import {
  LAYOUTS,
  type GalaxyCluster,
  type GalaxyData,
  type GalaxyLink,
  type GalaxyNode,
  type LayoutName,
} from '../types.ts'
import { computeLayout, type Layout } from './layouts.ts'
import { createNyan } from './nyan.ts'

// ---------------------------------------------------------------------------
// View model: the analyzer's data plus layout, rendering and simulation state
// ---------------------------------------------------------------------------
interface ViewNode extends GalaxyNode {
  color: string
  radius: number
  isStar: boolean
  seed: [number, number]
  /** Where the current layout pulls this file */
  target: THREE.Vector3
  // position + velocity, owned by the d3 simulation
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  // pinned position (set for stars)
  fx?: number
  fy?: number
  fz?: number
  mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  halo?: THREE.Sprite
  /** Set by 3d-force-graph: the object it renders for this node */
  __threeObj?: THREE.Object3D
}

/** d3 swaps link endpoints from ids to node objects once the simulation starts. */
type ViewLink = Omit<GalaxyLink, 'source' | 'target'> & {
  source: string | ViewNode
  target: string | ViewNode
  // Set by 3d-force-graph: the objects it renders for this link
  __lineObj?: THREE.Object3D
  __photonsObj?: THREE.Object3D
}

interface ViewCluster extends GalaxyCluster {
  hue: number
  color: string
  /** Rough radius the system's planets settle within */
  radius: number
  anchor: THREE.Vector3
  nodes: ViewNode[]
  star: ViewNode
  nebula: THREE.Sprite
  label: HTMLButtonElement
  labelPos: THREE.Vector3
}

/** A bundle of all the imports between two systems, drawn when either system is collapsed */
interface Route {
  a: ViewCluster
  b: ViewCluster
  count: number
  circular: boolean
  mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>
}

/** What the view is focused on; everything else dims */
type Focus =
  | { kind: 'node'; id: string }
  | { kind: 'cluster'; id: string }
  | { kind: 'cycle'; id: number }
  | { kind: 'blast'; id: string; direction: BlastDirection; depth: Map<string, number>; started: number }
  | { kind: 'path'; path: string[]; edges: Set<string> }
type BlastDirection = 'dependents' | 'dependencies'

// Minimal shapes of the d3-force-3d forces we configure
interface LinkForce {
  distance(fn: (l: ViewLink) => number): LinkForce
  strength(fn: (l: ViewLink) => number): LinkForce
}
interface ChargeForce {
  strength(n: number): ChargeForce
  distanceMax(n: number): ChargeForce
}

declare global {
  interface Window {
    galaxy?: unknown
  }
}

/**
 * Glow tuning. Bloom is what merges neighbouring stars in dense views: `strength` is how bright the
 * glow is, `radius` how far it spreads, and `threshold` how bright a pixel must be before it glows at all.
 */
const GLOW = {
  bloom: { strength: 0.6, radius: 0.3, threshold: 0.32 },
  /** Weakest bloom when a big hub is selected and hundreds of neighbours light up at once */
  minBloom: 0.25,
  starHalo: { opacity: 0.28, scale: 3.5 },
  /** Also used for files in cycles, which can pile up by the dozen in one system */
  hubHalo: { opacity: 0.14, scale: 2.5 },
  nebula: { opacity: 0.04, dimmed: 0.015 },
}

/**
 * Zoom-dependent detail: a system collapses into a single star once the camera is further than
 * `radius * perRadius + base` from it. Collapsing and expanding use slightly different distances
 * (`hysteresis`) so a system doesn't flicker while the camera hovers at the boundary.
 */
const DETAIL = { perRadius: 11, base: 380, hysteresis: 0.1 }

const RED = '#ff3b4a'
const IMPORTS = '#5ee7ff'
const IMPORTED_BY = '#ffb347'
const CUT = '#ffd166'
const PATH = '#7dffcf'
const COLD = '#3a4466'
/** Hotspot heat scale: cold blue through yellow and orange to pink (red stays reserved for cycles) */
const HEAT_STOPS: [number, string][] = [
  [0, '#2f4f9a'],
  [0.5, '#f3c24f'],
  [0.78, '#ff8a2b'],
  [1, '#ff3d8b'],
]
const HIDDEN_LAYER = 31
/** Opacity of files outside the current focus */
const DIMMED = 0.045

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`Missing element ${sel}`)
  return el
}
const esc = (s: string | number) =>
  String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString())
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '0%')
const idOf = (end: string | ViewNode) => (typeof end === 'object' ? end.id : end)
const edgeKey = (source: string, target: string) => `${source}\0${target}`
/** Closest ancestor of an event target matching `sel`. */
const closest = (e: Event, sel: string) => (e.target as HTMLElement).closest<HTMLElement>(sel)

const data: GalaxyData = JSON.parse($('#galaxy-data').textContent ?? '')
const { meta, cycles } = data

// ---------------------------------------------------------------------------
// Nodes, links and star systems
// ---------------------------------------------------------------------------
const hueFor = (i: number) => (40 + ((i * 137.508) % 290)) % 360 // golden-angle hues, skipping the reds reserved for cycles
const radiusOf = (c: GalaxyCluster) => 10 + 7 * Math.sqrt(c.files)
const systemColor = new Map(data.clusters.map((c, i) => [c.id, `hsl(${hueFor(i)}, 85%, 66%)`]))

const nodes: ViewNode[] = data.nodes.map(n => ({
  ...n,
  color: n.cycle !== null ? RED : systemColor.get(n.cluster)!,
  radius: 1.2 + 2 * Math.log2(1 + n.dependents),
  isStar: false,
  seed: [Math.random(), Math.random()],
  target: new THREE.Vector3(),
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
}))
const links: ViewLink[] = data.links.map(l => ({ ...l }))
const nodeById = new Map(nodes.map(n => [n.id, n]))
const node = (id: string) => nodeById.get(id)!
const outLinks = new Map<string, ViewLink[]>(nodes.map(n => [n.id, []]))
const inLinks = new Map<string, ViewLink[]>(nodes.map(n => [n.id, []]))
for (const l of links) {
  outLinks.get(idOf(l.source))!.push(l)
  inLinks.get(idOf(l.target))!.push(l)
}

const glowTexture = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.15, 'rgba(255,255,255,0.6)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.12)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
})()

const clusters: ViewCluster[] = data.clusters.map((c, i) => {
  const members = nodes.filter(n => n.cluster === c.id)
  // The system's star is its most-depended-on file, pinned in place so planets orbit it
  const star = members.reduce((a, b) => (b.dependents > a.dependents ? b : a))
  star.isStar = true
  const color = systemColor.get(c.id)!
  const nebula = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color,
      transparent: true,
      opacity: GLOW.nebula.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  nebula.scale.setScalar(radiusOf(c) * 5)

  const label = document.createElement('button')
  label.className = 'sys-label'
  label.textContent = c.id.split('/').pop() ?? c.id
  label.style.color = color
  label.dataset.cluster = c.id
  label.dataset.major = String(i < 30)
  $('#labels').append(label)

  return {
    ...c,
    hue: hueFor(i),
    color,
    radius: radiusOf(c),
    anchor: new THREE.Vector3(),
    nodes: members,
    star,
    nebula,
    label,
    labelPos: new THREE.Vector3(),
  }
})
const clusterById = new Map(clusters.map(c => [c.id, c]))
const clusterOf = (n: ViewNode) => clusterById.get(n.cluster)!
const hubThreshold =
  nodes.toSorted((a, b) => b.dependents - a.dependents)[Math.floor(nodes.length * 0.03)]?.dependents ?? Infinity

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------
const state = {
  focus: null as Focus | null,
  /** The file the details panel is showing */
  selected: null as ViewNode | null,
  /** Start of a path search, waiting for the user to pick the destination */
  pathFrom: null as ViewNode | null,
  hover: null as ViewNode | null,
  cyclesOnly: false,
  hideTypeOnly: false,
  alwaysDetail: false,
  colorBy: 'system' as 'system' | 'hotspots',
}

let focused = null as Set<string> | null
let focusLinkCount = 0

/** The set of node ids in focus, or null when nothing is focused. */
function focusSet(f: Focus | null): Set<string> | null {
  if (!f) return null
  switch (f.kind) {
    case 'node': {
      const s = new Set([f.id])
      for (const l of outLinks.get(f.id)!) s.add(idOf(l.target))
      for (const l of inLinks.get(f.id)!) s.add(idOf(l.source))
      return s
    }
    case 'cluster':
      return new Set(clusterById.get(f.id)!.nodes.map(n => n.id))
    case 'cycle':
      return new Set(cycles[f.id]!.members)
    case 'blast':
      return new Set(f.depth.keys())
    case 'path':
      return new Set(f.path)
  }
}

// Import direction helpers, honouring the "hide type-only imports" toggle
const counts = (l: ViewLink) => !state.hideTypeOnly || !l.typeOnly
const dependentsOf = (id: string) =>
  inLinks
    .get(id)!
    .filter(counts)
    .map(l => idOf(l.source))
const dependenciesOf = (id: string) =>
  outLinks
    .get(id)!
    .filter(counts)
    .map(l => idOf(l.target))

// ---------------------------------------------------------------------------
// Node + link styling
// ---------------------------------------------------------------------------
const sphereGeo = new THREE.SphereGeometry(1, 20, 14)
const haloScale = (n: ViewNode) => (n.isStar ? GLOW.starHalo.scale : GLOW.hubHalo.scale)

function makeNodeObject(n: ViewNode): THREE.Object3D {
  const group = new THREE.Group()
  const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(
    sphereGeo,
    new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 1 }),
  )
  mesh.scale.setScalar(n.radius)
  group.add(mesh)
  n.mesh = mesh
  if (n.isStar || n.cycle !== null || n.dependents >= hubThreshold) {
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: n.color,
        transparent: true,
        opacity: n.isStar ? GLOW.starHalo.opacity : GLOW.hubHalo.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    halo.scale.setScalar(n.radius * haloScale(n))
    halo.userData.baseOpacity = halo.material.opacity
    group.add(halo)
    n.halo = halo
  }
  lod.dirty = true // a new object starts on the visible layer
  return group
}

const sameCluster = (l: ViewLink) => node(idOf(l.source)).cluster === node(idOf(l.target)).cluster

function linkInFocus(l: ViewLink): boolean {
  const f = state.focus
  if (!f || !focused) return true
  const s = idOf(l.source)
  const t = idOf(l.target)
  switch (f.kind) {
    case 'node':
      return s === f.id || t === f.id
    case 'cycle':
      return l.circular && focused.has(s) && focused.has(t)
    case 'blast': {
      // only the edges that carry the ripple outward, one hop at a time
      const ds = f.depth.get(s)
      const dt = f.depth.get(t)
      if (ds === undefined || dt === undefined || !counts(l)) return false
      return f.direction === 'dependents' ? ds === dt + 1 : dt === ds + 1
    }
    case 'path':
      return f.edges.has(edgeKey(s, t))
    case 'cluster':
      return focused.has(s) && focused.has(t)
  }
}

const linkIsVisible = (l: ViewLink) =>
  (!state.hideTypeOnly || !l.typeOnly) && (!state.cyclesOnly || l.circular) && linkInFocus(l)

/**
 * Heat follows hotspot rank rather than the raw score: the log-scaled score puts many ordinary files
 * mid-range, so ranks make the few real hotspots stand out. `(share of files ranked below)^8` runs the
 * top 2% hot, about the top 10% warm, and the rest cool.
 */
function heat(n: ViewNode): number {
  if (n.hotspotRank === null || !meta.rankedHotspots) return 0
  return (1 - (n.hotspotRank - 1) / meta.rankedHotspots) ** 8
}

function heatColor(t: number): string {
  if (t <= 0) return COLD
  const i = HEAT_STOPS.findIndex(([at]) => at >= t)
  const [a0, c0] = HEAT_STOPS[Math.max(0, i - 1)]!
  const [a1, c1] = HEAT_STOPS[i]!
  return `#${new THREE.Color(c0).lerp(new THREE.Color(c1), a1 === a0 ? 0 : (t - a0) / (a1 - a0)).getHexString()}`
}

/** A collapsed system glows with the heat of its hottest file */
const systemHeat = new Map<string, number>()
for (const n of nodes) systemHeat.set(n.cluster, Math.max(systemHeat.get(n.cluster) ?? 0, heat(n)))

function baseColor(n: ViewNode): string {
  if (state.colorBy !== 'hotspots') return n.color
  if (n.isStar && lod.collapsed.has(n.cluster)) return heatColor(systemHeat.get(n.cluster) ?? 0)
  return heatColor(heat(n))
}

/** Warm near the origin of a blast, cooling to violet at the far edge */
function blastColor(depth: number, maxDepth: number): string {
  if (depth === 0) return '#ffffff'
  const t = maxDepth > 1 ? (depth - 1) / (maxDepth - 1) : 0
  return `hsl(${45 - t * 105}, 100%, ${68 - t * 8}%)`
}

function linkColor(l: ViewLink): string {
  const f = state.focus
  if (f && focused) {
    if (f.kind === 'cycle') return l.cut ? CUT : RED
    if (f.kind === 'path') return PATH
    if (l.circular && f.kind !== 'blast') return RED
    // many edges converging on one hub would bloom into a white-out, so thin them as they multiply
    const a = Math.min(0.6, 5 / Math.sqrt(focusLinkCount + 1))
    if (f.kind === 'node') {
      return idOf(l.source) === f.id ? `rgba(94,231,255,${a})` : `rgba(255,179,71,${a * 0.8})`
    }
    if (f.kind === 'blast') {
      const max = Math.max(...f.depth.values())
      const c = new THREE.Color(blastColor(f.depth.get(idOf(l.source))!, max))
      return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`
    }
    return `rgba(190,210,255,${a * 0.7})`
  }
  if (l.circular) return 'rgba(255,59,74,0.85)'
  if (l.typeOnly) return 'rgba(150,160,210,0.02)'
  if (sameCluster(l)) return `hsla(${clusterOf(node(idOf(l.source))).hue}, 80%, 70%, 0.09)`
  return 'rgba(130,160,255,0.025)'
}

function linkWidth(l: ViewLink): number {
  const f = state.focus
  if (!f) return l.circular ? 0.45 : 0
  if (f.kind === 'cycle') return l.cut ? 5 : 2.5
  if (f.kind === 'path') return 3
  return focusLinkCount > 60 ? 0 : 0.6
}

const circularCount = links.filter(l => l.circular).length
function linkParticles(l: ViewLink): number {
  const f = state.focus
  if (!f) return l.circular && circularCount < 1500 ? 1 : 0
  if (f.kind === 'cycle') return l.cut ? 3 : 1
  if (f.kind === 'path') return 3
  return focusLinkCount < 150 ? 2 : 0
}

function particleColor(l: ViewLink): string {
  const f = state.focus
  if (f?.kind === 'path') return PATH
  if (f?.kind === 'cycle' && l.cut) return CUT
  if (l.circular) return RED
  return f?.kind === 'node' && idOf(l.source) === f.id ? IMPORTS : IMPORTED_BY
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------
const lod = { collapsed: new Set<string>(), dirty: true, frame: 0 }

const Graph = new ForceGraph3D($('#graph'), { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<
  ViewNode,
  ViewLink
>
const initialLayout = (LAYOUTS as readonly string[]).includes(data.view?.layout) ? data.view.layout : 'spiral'
let layout: Layout = placeLayout(initialLayout)
for (const n of nodes) {
  // start everyone near home so the layout settles quickly
  const spread = clusterOf(n).radius
  n.x = n.fx ?? n.target.x + (Math.random() - 0.5) * spread
  n.y = n.fy ?? n.target.y + (Math.random() - 0.5) * spread
  n.z = n.fz ?? n.target.z + (Math.random() - 0.5) * spread
}

Graph.width(innerWidth)
  .height(innerHeight)
  .backgroundColor('#03040a')
  .showNavInfo(false)
  .graphData({ nodes, links })
  .nodeId('id')
  .nodeThreeObject(makeNodeObject)
  .nodeLabel(tooltip)
  .nodeVisibility(n => !state.cyclesOnly || n.cycle !== null)
  .linkVisibility(linkIsVisible)
  .linkColor(linkColor)
  .linkWidth(linkWidth)
  .linkOpacity(1)
  .linkDirectionalParticles(linkParticles)
  .linkDirectionalParticleWidth(l => (l.circular ? 1.4 : 1.1))
  .linkDirectionalParticleSpeed(0.006)
  .linkDirectionalParticleColor(particleColor)
  .d3AlphaDecay(0.025)
  .d3VelocityDecay(0.35)
  .warmupTicks(40)
  .cooldownTime(12000)
  .onNodeHover(n => {
    state.hover = n
    $('#graph').style.cursor = n ? 'pointer' : ''
  })
  .onNodeClick(n => {
    if (n.isStar && lod.collapsed.has(n.cluster)) focusCluster(n.cluster)
    else selectNode(n)
  })
  .onBackgroundClick(() => clearFocus())

// Forces: strong pull toward each file's layout target, weak pull across systems
;(Graph.d3Force('charge') as unknown as ChargeForce).strength(-22).distanceMax(220)
Graph.d3Force('cluster', (alpha: number) => {
  const k = (layout.compact ? 0.12 : 0.2) * alpha
  const flatten = layout.compact ? 1.6 : 1 // squash systems a little, like a disc
  for (const n of nodes) {
    if (n.fx !== undefined) continue
    n.vx += (n.target.x - n.x) * k
    n.vy += (n.target.y - n.y) * k * flatten
    n.vz += (n.target.z - n.z) * k
  }
})

function configureLinkForce() {
  ;(Graph.d3Force('link') as unknown as LinkForce)
    .distance(l => (sameCluster(l) ? 14 + clusterOf(node(idOf(l.source))).radius * 0.35 : 90))
    // In the stability layout a file's position *is* its metric, so imports barely pull
    .strength(l => (!layout.compact ? 0.002 : sameCluster(l) ? 0.25 : 0.004))
}
configureLinkForce()

// Scene dressing: starfield, a nebula behind each system, trade routes and stability guides
const scene = Graph.scene()
{
  const count = 7000
  const pos = new Float32Array(count * 3)
  const col = new Float32Array(count * 3)
  const color = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(3000 + Math.random() * 5000)
    pos.set([v.x, v.y, v.z], i * 3)
    color.setHSL(Math.random() < 0.5 ? 0.6 : 0.08, 0.5, 0.6 + Math.random() * 0.4)
    col.set([color.r, color.g, color.b], i * 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  scene.add(
    new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 1.3,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
      }),
    ),
  )
}
for (const c of clusters) scene.add(c.nebula)

const routes: Route[] = (() => {
  const totals = new Map<string, { a: ViewCluster; b: ViewCluster; count: number; circular: boolean }>()
  for (const l of links) {
    if (sameCluster(l)) continue
    const [a, b] = [clusterOf(node(idOf(l.source))), clusterOf(node(idOf(l.target)))].toSorted((x, y) =>
      x.id < y.id ? -1 : 1,
    ) as [ViewCluster, ViewCluster]
    const key = edgeKey(a.id, b.id)
    const route = totals.get(key) ?? { a, b, count: 0, circular: false }
    route.count += l.count
    route.circular ||= l.circular
    totals.set(key, route)
  }
  const max = Math.max(1, ...[...totals.values()].map(r => r.count))
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true)
  return [...totals.values()].map(r => {
    const strength = Math.sqrt(r.count / max)
    const color = r.circular ? new THREE.Color(RED) : new THREE.Color(r.a.color).lerp(new THREE.Color(r.b.color), 0.5)
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: r.circular ? 0.5 : 0.08 + 0.3 * strength,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    mesh.userData.strength = strength
    mesh.visible = false
    scene.add(mesh)
    return { ...r, mesh }
  })
})()

const guides = new THREE.Group()
scene.add(guides)
const guideLabels: { el: HTMLElement; pos: THREE.Vector3 }[] = []

// Bloom gives everything that No Man's Sky glow
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  GLOW.bloom.strength,
  GLOW.bloom.radius,
  GLOW.bloom.threshold,
)
Graph.postProcessingComposer().addPass(bloom)

let R = 1000
const controls = Graph.controls() as OrbitControls
controls.autoRotateSpeed = 0.35
const layoutSelect = $<HTMLSelectElement>('#layout')
layoutSelect.value = layout.name
dressLayout()
flyHome(0)
setTimeout(() => ($('#loading').style.opacity = '0'), 300)

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------
/** Computes a layout and points systems, stars and file targets at it. */
function placeLayout(name: LayoutName): Layout {
  const next = computeLayout(name, clusters, nodes)
  for (const c of clusters) c.anchor = next.anchors.get(c.id)!
  for (const n of nodes) n.target = next.target(n)
  for (const c of clusters) {
    const t = c.star.target
    Object.assign(c.star, { fx: t.x, fy: t.y, fz: t.z })
  }
  return next
}

/** Moves the scene furniture (nebulae, labels, routes, guides) to match the current layout. */
function dressLayout() {
  R = layout.extent * 1.15
  for (const c of clusters) {
    c.nebula.position.copy(c.anchor)
    c.nebula.visible = layout.compact
    c.labelPos = c.anchor.clone().add(new THREE.Vector3(0, layout.compact ? c.radius * 1.15 + 8 : 0, 0))
  }
  const width = clusters.reduce((a, c) => a + c.radius, 0) / Math.max(1, clusters.length)
  for (const r of routes) {
    const from = r.a.anchor
    const to = r.b.anchor
    const length = from.distanceTo(to)
    const thickness = width * 0.09 * (0.25 + 0.75 * (r.mesh.userData.strength as number))
    r.mesh.position.copy(from).add(to).multiplyScalar(0.5)
    r.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize())
    r.mesh.scale.set(thickness, length, thickness)
  }

  guides.clear()
  for (const g of guideLabels) g.el.remove()
  guideLabels.length = 0
  for (const g of layout.guides) {
    const points = new THREE.EllipseCurve(0, 0, g.radius, g.radius).getSpacedPoints(128)
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p.x, 0, p.y))),
      new THREE.LineBasicMaterial({ color: '#8aa0ff', transparent: true, opacity: 0.16 }),
    )
    guides.add(ring)
    const el = document.createElement('span')
    el.className = 'guide-label'
    el.textContent = g.label
    $('#labels').append(el)
    guideLabels.push({ el, pos: new THREE.Vector3(0, 0, -g.radius) })
  }
  $('#layout-hint').hidden = layout.name !== 'stability'
  lod.collapsed.clear()
  lod.dirty = true
}

function switchLayout(name: LayoutName) {
  layout = placeLayout(name)
  configureLinkForce()
  dressLayout()
  Graph.d3ReheatSimulation()
  flyHome()
}

function flyHome(ms = 1400) {
  Graph.cameraPosition({ x: 0, y: R * 0.75, z: R * 1.35 }, { x: 0, y: 0, z: 0 }, ms)
}

// ---------------------------------------------------------------------------
// Zoom-dependent detail
// ---------------------------------------------------------------------------
/** Moving an object to an unused layer hides it from both the camera and mouse picking */
function setShown(obj: THREE.Object3D | undefined, shown: boolean) {
  obj?.traverse(o => o.layers.set(shown ? 0 : HIDDEN_LAYER))
}

const systemStarRadius = (c: ViewCluster) => 3 + 1.8 * Math.sqrt(c.files)
const displayRadius = (n: ViewNode) =>
  n.isStar && lod.collapsed.has(n.cluster) ? systemStarRadius(clusterOf(n)) : n.radius

function updateDetail() {
  const enabled = layout.compact && !state.alwaysDetail && !state.cyclesOnly
  const cam = Graph.camera().position
  // Systems holding anything in focus always stay open, so the focus is never hidden
  const pinned = new Set(focused ? [...focused].map(id => node(id).cluster) : [])
  let changed = lod.dirty
  for (const c of clusters) {
    const was = lod.collapsed.has(c.id)
    const threshold = c.radius * DETAIL.perRadius + DETAIL.base
    const far = cam.distanceTo(c.anchor) > threshold * (1 + (was ? -DETAIL.hysteresis : DETAIL.hysteresis))
    const collapse = enabled && !pinned.has(c.id) && far
    if (collapse !== was) {
      changed = true
      if (collapse) lod.collapsed.add(c.id)
      else lod.collapsed.delete(c.id)
    }
  }
  // 3d-force-graph rebuilds objects after data or style changes, so re-apply every so often too
  if (!changed && ++lod.frame % 20) return
  lod.dirty = false
  for (const n of nodes) setShown(n.__threeObj, n.isStar || !lod.collapsed.has(n.cluster))
  if (state.colorBy === 'hotspots' && !focused) {
    // collapsing swaps a star between its own heat and its system's hottest file
    for (const c of clusters) {
      c.star.mesh?.material.color.set(baseColor(c.star))
      c.star.halo?.material.color.set(baseColor(c.star))
    }
  }
  for (const l of links) {
    const open = !lod.collapsed.has(node(idOf(l.source)).cluster) && !lod.collapsed.has(node(idOf(l.target)).cluster)
    setShown(l.__lineObj, open)
    setShown(l.__photonsObj, open)
  }
  const f = state.focus
  for (const r of routes) {
    const relevant = !f || (f.kind === 'cluster' && (r.a.id === f.id || r.b.id === f.id))
    r.mesh.visible = enabled && relevant && (lod.collapsed.has(r.a.id) || lod.collapsed.has(r.b.id))
  }
}

// ---------------------------------------------------------------------------
// Animation: pulses, blast ripples, labels, detail and… cats
// ---------------------------------------------------------------------------
const labelsToggle = $<HTMLInputElement>('#t-labels')
const nyan = createNyan(scene, Graph.camera() as THREE.PerspectiveCamera)
let lastFrame = performance.now()

;(function animate() {
  const now = performance.now()
  const t = now / 1000
  nyan.update(Math.min(0.1, (now - lastFrame) / 1000)) // cap dt so a backgrounded tab doesn't teleport cats
  lastFrame = now
  updateDetail()
  const f = state.focus
  for (const n of nodes) {
    if (!n.mesh) continue
    const pulse = n === state.hover ? 1.5 : n === state.selected ? 1.15 + Math.sin(t * 4) * 0.08 : 1
    let scale = displayRadius(n) * pulse
    if (f?.kind === 'blast') {
      // the blast ripples outward one hop at a time
      const depth = f.depth.get(n.id)
      if (depth !== undefined) {
        const appear = Math.min(1, Math.max(0, ((now - f.started) / 1000 - depth * 0.18) / 0.35))
        n.mesh.material.opacity = DIMMED + (1 - DIMMED) * appear
        scale *= appear < 1 ? 0.5 + 0.5 * appear + 0.6 * Math.sin(appear * Math.PI) : 1
      }
    }
    n.mesh.scale.setScalar(scale)
    if (n.halo) {
      n.halo.scale.setScalar(scale * haloScale(n) * (f?.kind === 'cycle' && focused?.has(n.id) ? 4 : 1))
      if (n.cycle !== null && !focused) {
        n.halo.material.opacity = n.halo.userData.baseOpacity * (0.75 + 0.25 * Math.sin(t * 2.2 + n.cycle))
      }
    }
  }
  positionLabels()
  requestAnimationFrame(animate)
})()

/** Labels are HTML (crisp, and immune to bloom), projected onto the canvas each frame. */
function positionLabels() {
  const cam = Graph.camera()
  const v = new THREE.Vector3()
  const place = (el: HTMLElement, pos: THREE.Vector3) => {
    v.copy(pos).project(cam)
    const behind = v.z > 1
    el.style.display = behind ? 'none' : ''
    if (!behind) {
      el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px)`
    }
    return !behind
  }
  for (const g of guideLabels) place(g.el, g.pos)
  if (!labelsToggle.checked) return
  for (const c of clusters) {
    if (c.label.hidden || !place(c.label, c.labelPos)) continue
    const dist = cam.position.distanceTo(c.anchor)
    const dimmed = state.focus && !(state.focus.kind === 'cluster' && state.focus.id === c.id)
    c.label.style.opacity = String(dimmed ? 0.25 : Math.min(1, Math.max(0.35, 2200 / dist)))
  }
}

function updateLabels() {
  const f = state.focus
  for (const c of clusters) {
    const focusedHere = f?.kind === 'cluster' && f.id === c.id
    c.label.hidden = !(labelsToggle.checked && (c.label.dataset.major === 'true' || focusedHere))
  }
}
updateLabels()

// ---------------------------------------------------------------------------
// Styling refresh
// ---------------------------------------------------------------------------
/** Neighbours of a selected file are coloured by direction: files it imports vs files importing it */
const neighbourColor = (n: ViewNode, id: string) =>
  outLinks.get(id)!.some(l => idOf(l.target) === n.id) ? IMPORTS : IMPORTED_BY

function refresh() {
  const f = state.focus
  focused = focusSet(f)
  focusLinkCount = focused ? links.filter(linkInFocus).length : 0
  const maxDepth = f?.kind === 'blast' ? Math.max(...f.depth.values()) : 0
  for (const n of nodes) {
    if (!n.mesh) continue
    const inFocus = !focused || focused.has(n.id)
    let color = baseColor(n)
    if (f && inFocus) {
      if (f.kind === 'node' && n.id !== f.id && n.cycle === null) color = neighbourColor(n, f.id)
      else if (f.kind === 'blast') color = blastColor(f.depth.get(n.id)!, maxDepth)
      else if (f.kind === 'path') color = n.id === f.path[0] || n.id === f.path.at(-1) ? '#c8fff0' : PATH
    }
    n.mesh.material.color.set(color)
    n.mesh.material.opacity = inFocus ? 1 : DIMMED
    if (n.halo) {
      n.halo.material.color.set(baseColor(n))
      const lit = inFocus && (!f || f.kind === 'cluster' || f.kind === 'cycle' || n.id === state.selected?.id)
      n.halo.material.opacity = lit ? n.halo.userData.baseOpacity * (f?.kind === 'cycle' ? 1.6 : 1) : 0
    }
  }
  for (const c of clusters) {
    const lit = !f || (f.kind === 'cluster' && f.id === c.id)
    c.nebula.material.opacity = lit ? GLOW.nebula.opacity : GLOW.nebula.dimmed
  }
  updateLabels()
  // Dense neighbourhoods of a big hub would bloom into a white-out
  if (!focused) bloom.strength = GLOW.bloom.strength
  // a path is a handful of bright files, usually seen up close
  else if (f?.kind === 'path') bloom.strength = GLOW.minBloom + 0.1
  else bloom.strength = Math.max(GLOW.minBloom, GLOW.bloom.strength - focused.size / 600)
  Graph.nodeVisibility(Graph.nodeVisibility())
    .linkVisibility(linkIsVisible)
    .linkColor(linkColor)
    .linkWidth(linkWidth)
    .linkDirectionalParticles(linkParticles)
  lod.dirty = true
  renderSidebarActive()
}

// ---------------------------------------------------------------------------
// Focus + camera
// ---------------------------------------------------------------------------
const toVec = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z)

function flyTo(point: { x: number; y: number; z: number }, distance: number) {
  const p = toVec(point)
  const dir = p.length() > 1 ? p.clone().normalize() : new THREE.Vector3(0, 0.5, 1).normalize()
  dir.y += 0.45
  dir.normalize()
  const cam = p.clone().add(dir.multiplyScalar(distance))
  Graph.cameraPosition({ x: cam.x, y: cam.y, z: cam.z }, { x: p.x, y: p.y, z: p.z }, 1400)
}

/** Frames a set of files: close enough to see them, never further out than the overview */
function flyToFit(ids: string[]) {
  const center = new THREE.Vector3()
  for (const id of ids) center.add(toVec(node(id)))
  center.divideScalar(ids.length)
  const spread = Math.max(0, ...ids.map(id => center.distanceTo(toVec(node(id)))))
  // leave room for the planets themselves, which matters when they're all close together
  const biggest = Math.max(0, ...ids.map(id => node(id).radius))
  flyTo(center, Math.min(R * 1.3, Math.max(220, spread * 3.4 + biggest * 14)))
}

function setFocus(focus: Focus | null, selected: ViewNode | null = null) {
  state.focus = focus
  state.selected = selected
  refresh()
}

function selectNode(n: ViewNode) {
  if (state.pathFrom) return completePath(n)
  setFocus({ kind: 'node', id: n.id }, n)
  renderDetails(n)
  flyTo(n, 180 + n.radius * 14)
}

function focusCluster(id: string) {
  if (state.focus?.kind === 'cluster' && state.focus.id === id) return clearFocus()
  setFocus({ kind: 'cluster', id })
  closeDetails()
  const c = clusterById.get(id)!
  flyTo(c.anchor, layout.compact ? c.radius * 4 + 120 : R * 0.6)
}

function focusCycle(id: number) {
  if (state.focus?.kind === 'cycle' && state.focus.id === id) return clearFocus()
  setFocus({ kind: 'cycle', id })
  renderCycle(id)
  flyToFit(cycles[id]!.members)
}

function showBlast(n: ViewNode, direction: BlastDirection) {
  const f = state.focus
  if (f?.kind === 'blast' && f.id === n.id && f.direction === direction) {
    // pressing the active button again goes back to the plain file view
    setFocus({ kind: 'node', id: n.id }, n)
  } else {
    const depth = reachable(n.id, direction === 'dependents' ? dependentsOf : dependenciesOf)
    setFocus({ kind: 'blast', id: n.id, direction, depth, started: performance.now() }, n)
    flyToFit([...depth.keys()])
  }
  renderDetails(n)
}

function startPath(n: ViewNode) {
  state.pathFrom = n
  toast(`Pick the destination for ${n.name}: click a planet or search (Esc cancels)`, 6000)
}

function completePath(to: ViewNode) {
  const from = state.pathFrom!
  state.pathFrom = null
  hideToast()
  // Prefer "from imports … to"; fall back to the other direction before giving up
  const forward = shortestPath(from.id, to.id, dependenciesOf)
  const backward = forward ? null : shortestPath(to.id, from.id, dependenciesOf)
  const path = forward ?? backward
  if (path) {
    const edges = new Set(path.slice(1).map((id, i) => edgeKey(path[i]!, id)))
    setFocus({ kind: 'path', path, edges }, to)
    flyToFit(path)
  } else {
    setFocus(null, to)
  }
  renderPath(from, to, path, !!backward)
}

function clearFocus() {
  state.pathFrom = null
  setFocus(null)
  closeDetails()
}

// ---------------------------------------------------------------------------
// Editor links
// ---------------------------------------------------------------------------
const EDITOR_NAMES = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  zed: 'Zed',
  webstorm: 'WebStorm',
  idea: 'IntelliJ',
  none: '',
} as const

function editorUrl(n: ViewNode): string | null {
  const file = `${meta.root.replace(/\/$/, '')}/${n.id}`
  const encoded = encodeURI(file)
  switch (data.view?.editor ?? 'vscode') {
    case 'vscode':
      return `vscode://file${encoded.startsWith('/') ? '' : '/'}${encoded}`
    case 'cursor':
      return `cursor://file${encoded.startsWith('/') ? '' : '/'}${encoded}`
    case 'zed':
      return `zed://file${encoded.startsWith('/') ? '' : '/'}${encoded}`
    case 'webstorm':
      return `webstorm://open?file=${encodeURIComponent(file)}`
    case 'idea':
      return `idea://open?file=${encodeURIComponent(file)}`
    case 'none':
      return null
  }
}

function openInEditor(n: ViewNode) {
  const url = editorUrl(n)
  if (url) location.href = url
}

// ---------------------------------------------------------------------------
// UI: header, sidebar, details, search, tooltip
// ---------------------------------------------------------------------------
$('#project').textContent = meta.project
$('#stats').innerHTML = (
  [
    ['Files', fmt(meta.files)],
    ['Imports', fmt(meta.imports)],
    ['Star systems', fmt(clusters.length)],
    ['Orphans', fmt(meta.orphans)],
    ['Circular clusters', fmt(meta.cycles), meta.cycles ? 'red' : ''],
    ['Files in cycles', fmt(meta.filesInCycles), meta.filesInCycles ? 'red' : ''],
    ['Imports to cut', fmt(meta.cuts ?? 0), meta.cuts ? 'cut' : ''],
    ['Unresolved', fmt(meta.unresolved)],
  ] as const
)
  .map(([k, v, cls = '']) => `<div class="stat ${cls}"><b>${v}</b><span>${k}</span></div>`)
  .join('')
$('#cycle-count').textContent = cycles.length ? `(${cycles.length})` : ''

$('#tab-systems').innerHTML = clusters
  .map(
    c => `<button class="row" data-cluster="${esc(c.id)}">
      <span class="dot" style="color:${c.color}"></span>
      <span class="label" title="${esc(c.id)}">${esc(c.id)}</span>
      <span class="count">${c.files}${c.cycleFiles ? ` · <span class="r">${c.cycleFiles}⟳</span>` : ''}</span>
    </button>`,
  )
  .join('')

$('#tab-cycles').innerHTML = cycles.length
  ? cycles
      .map(c => {
        const sample = c.members
          .slice(0, 2)
          .map(m => node(m).name)
          .join(', ')
        return `<button class="row" data-cycle="${c.id}">
          <span class="dot" style="color:${RED}"></span>
          <span class="label" title="${esc(c.members.join('\n'))}">${esc(sample)}${c.size > 2 ? ` +${c.size - 2}` : ''}</span>
          <span class="count">${c.size} · <span class="c">${c.cuts?.length ?? 0}✂</span></span>
        </button>`
      })
      .join('')
  : `<div class="empty">No circular dependencies. Clean galaxy ✦</div>`

const isTopHotspot = (n: ViewNode) => n.hotspotRank !== null && n.hotspotRank <= (meta.topHotspots ?? 0)
const hotspotEffort = (n: ViewNode) => `${n.churn} commits in the last year × ${fmt(n.loc)} lines`

const NO_HISTORY: Record<string, string> = {
  shallow:
    'This map was made from a shallow git clone, which lacks the history hotspots need. Fetch full history (<code>git fetch --unshallow</code>, or <code>fetch-depth: 0</code> with actions/checkout) and map it again.',
  unavailable: 'Hotspots need git history, and this project isn’t a git repository.',
  disabled: 'Hotspots need git history, which <code>--no-git</code> turned off.',
}

$('#tab-hotspots').innerHTML = !meta.hasChurn
  ? `<div class="empty">${NO_HISTORY[meta.history ?? 'unavailable'] ?? NO_HISTORY.unavailable}</div>`
  : !meta.rankedHotspots
    ? `<div class="empty">No files changed in the last year.</div>`
    : `<p class="tab-note" title="${esc(`Tests, data and generated files are left out. ${meta.bulkCommits ? `${meta.bulkCommits} bulk commits (100+ files each, like dependency upgrades) aren’t counted as changes. ` : ''}Renamed files keep their history.`)}">Big files that change often (commits in the last year × lines): usually the best place to start refactoring.</p>` +
      nodes
        .filter(n => n.hotspotRank !== null)
        .toSorted((a, b) => a.hotspotRank! - b.hotspotRank!)
        .slice(0, 30)
        .map(
          n => `<button class="row" data-node="${esc(n.id)}" title="${esc(`${n.id}\n${hotspotEffort(n)}`)}">
            <span class="dot" style="color:${heatColor(heat(n))}"></span>
            <span class="label">${esc(n.name)}</span>
            <span class="count">${n.churn}× · ${fmt(n.loc)}</span>
          </button>`,
        )
        .join('')

$('#tab-hubs').innerHTML = nodes
  .toSorted((a, b) => b.dependents - a.dependents)
  .slice(0, 50)
  .map(
    n => `<button class="row" data-node="${esc(n.id)}">
      <span class="dot" style="color:${n.color}"></span>
      <span class="label" title="${esc(n.id)}">${esc(n.name)}</span>
      <span class="count">${n.dependents}↓</span>
    </button>`,
  )
  .join('')

$('#sidebar').addEventListener('click', e => {
  const tab = closest(e, '[data-tab]')
  if (tab) {
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b === tab))
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === `tab-${tab.dataset.tab}`)
    return
  }
  const row = closest(e, '.row')
  if (!row) return
  if (row.dataset.cluster) focusCluster(row.dataset.cluster)
  else if (row.dataset.cycle) focusCycle(Number(row.dataset.cycle))
  else if (row.dataset.node) selectNode(node(row.dataset.node))
})

function renderSidebarActive() {
  const f = state.focus
  for (const r of document.querySelectorAll<HTMLElement>('#sidebar .row')) {
    const { cluster, cycle, node: id } = r.dataset
    r.classList.toggle(
      'active',
      (!!cluster && f?.kind === 'cluster' && f.id === cluster) ||
        (cycle !== undefined && f?.kind === 'cycle' && f.id === Number(cycle)) ||
        (!!id && id === state.selected?.id),
    )
  }
}

$<HTMLInputElement>('#t-cycles').addEventListener('change', e => {
  state.cyclesOnly = (e.target as HTMLInputElement).checked
  refresh()
})
$<HTMLInputElement>('#t-types').addEventListener('change', e => {
  state.hideTypeOnly = (e.target as HTMLInputElement).checked
  refresh()
  if (state.selected) renderDetails(state.selected)
})
$<HTMLInputElement>('#t-detail').addEventListener('change', e => {
  state.alwaysDetail = (e.target as HTMLInputElement).checked
  lod.dirty = true
})
labelsToggle.addEventListener('change', updateLabels)
$<HTMLInputElement>('#t-rotate').addEventListener(
  'change',
  e => (controls.autoRotate = (e.target as HTMLInputElement).checked),
)
layoutSelect.addEventListener('change', () => switchLayout(layoutSelect.value as LayoutName))
const colorBySelect = $<HTMLSelectElement>('#color-by')
colorBySelect.disabled = !meta.rankedHotspots
colorBySelect.title = meta.rankedHotspots ? '' : 'Needs git history'
colorBySelect.addEventListener('change', () => {
  state.colorBy = colorBySelect.value as typeof state.colorBy
  $('#heat-legend').hidden = state.colorBy !== 'hotspots'
  refresh()
})
$('#labels').addEventListener('click', e => {
  const id = closest(e, '[data-cluster]')?.dataset.cluster
  if (id) focusCluster(id)
})

function tooltip(n: ViewNode): string {
  if (n.isStar && lod.collapsed.has(n.cluster)) {
    const c = clusterOf(n)
    return `<div class="tip-name">${esc(c.id)}</div>
      <div class="tip-stats">${fmt(c.files)} files · ${fmt(c.loc)} lines</div>
      ${c.cycleFiles ? `<div class="tip-cycle">⟳ ${c.cycleFiles} files in cycles</div>` : ''}
      <div class="tip-path">Click to fly in</div>`
  }
  return `<div class="tip-name">${esc(n.name)}</div>
    <div class="tip-path">${esc(n.dir)}</div>
    <div class="tip-stats"><span class="i">${n.dependents} dependents</span> · <span class="o">${n.dependencies} imports</span> · ${fmt(n.loc)} loc</div>
    ${n.cycle !== null ? `<div class="tip-cycle">⟳ in circular cluster #${n.cycle + 1} (${cycles[n.cycle]!.size} files)</div>` : ''}
    ${isTopHotspot(n) ? `<div class="tip-hot">🔥 hotspot #${n.hotspotRank} · ${n.churn} commits × ${fmt(n.loc)} lines</div>` : ''}`
}

const tags = (l: ViewLink) =>
  (l.typeOnly ? '<span class="tag">type</span>' : '') +
  (l.dynamic ? '<span class="tag">lazy</span>' : '') +
  (l.cut ? '<span class="tag cut" title="Suggested import to remove to break the cycle">✂ cut</span>' : '') +
  (l.circular && !l.cut ? '<span class="tag" style="color:var(--red)">cycle</span>' : '')

function listItems(ls: ViewLink[], end: 'source' | 'target'): string {
  return ls
    .map(l => ({ n: node(idOf(l[end])), l }))
    .toSorted(
      (a, b) =>
        Number(b.l.cut) - Number(a.l.cut) ||
        Number(b.l.circular) - Number(a.l.circular) ||
        b.n.dependents - a.n.dependents,
    )
    .map(
      ({ n, l }) => `<li class="${l.circular ? 'circ' : ''}"><button data-node="${esc(n.id)}" title="${esc(n.id)}">
        <span>${esc(n.name)}</span>${tags(l)}
        <span class="dir">${esc(n.dir)}</span>
      </button></li>`,
    )
    .join('')
}

const chipList = (items: string[]) => items.map(p => `<span class="chip">${esc(p)}</span>`).join('')
const nodeButton = (id: string) => `<button data-node="${esc(id)}" title="${esc(id)}">${esc(node(id).name)}</button>`

function blastSummary(n: ViewNode, direction: BlastDirection, depth: Map<string, number>): string {
  const reached = depth.size - 1
  const hops = Math.max(0, ...depth.values())
  const perHop = Array.from({ length: hops }, (_, i) => [...depth.values()].filter(d => d === i + 1).length)
  const verb = direction === 'dependents' ? 'depend on' : 'are pulled in by'
  return `<div class="blast">
    <div class="eyebrow">${direction === 'dependents' ? 'Blast radius' : 'Pulls in'}</div>
    <p><b>${fmt(reached)}</b> files (${pct(reached, nodes.length)} of the codebase) ${verb} <b>${esc(n.name)}</b>, directly or indirectly, within ${hops} hop${hops === 1 ? '' : 's'}.</p>
    <div class="hops">${perHop.map((c, i) => `<span style="--c:${blastColor(i + 1, hops)}" title="${c} files at ${i + 1} hop${i ? 's' : ''}"><i style="height:${Math.max(6, (c / Math.max(...perHop)) * 100)}%"></i>${i + 1}</span>`).join('')}</div>
  </div>`
}

function renderDetails(n: ViewNode) {
  const c = clusterOf(n)
  const ins = inLinks.get(n.id)!
  const outs = outLinks.get(n.id)!
  const cyclePath =
    n.cycle === null ? null : shortestPath(n.id, n.id, id => dependenciesOf(id).filter(t => node(t).cycle === n.cycle))
  const inst = n.instability ?? 0
  const f = state.focus
  const blast = f?.kind === 'blast' && f.id === n.id ? f : null
  const dependentsReach = reachable(n.id, dependentsOf).size - 1
  const dependenciesReach = reachable(n.id, dependenciesOf).size - 1
  const url = editorUrl(n)
  const myCuts = outs.filter(l => l.cut)
  const el = $('#details')
  el.innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <div class="eyebrow">${n.isStar ? 'Star · system hub' : 'Planet'}</div>
    <h2>${esc(n.name)}</h2>
    <div class="fullpath">${esc(n.id)}</div>
    <div class="chips">
      <button class="chip cluster" data-cluster="${esc(c.id)}"><span class="dot" style="color:${c.color};display:inline-block;width:7px;height:7px;margin-right:5px"></span>${esc(c.id)}</button>
      ${n.cycle !== null ? `<button class="chip red" data-cycle="${n.cycle}">⟳ circular cluster #${n.cycle + 1} · ${cycles[n.cycle]!.size} files</button>` : ''}
      ${isTopHotspot(n) ? `<span class="chip hot" title="${esc(hotspotEffort(n))}">🔥 top hotspot #${n.hotspotRank}</span>` : ''}
      ${n.orphan ? '<span class="chip">orphan</span>' : ''}
      ${n.dependents === 0 && !n.orphan ? '<span class="chip">entry point?</span>' : ''}
      ${n.violations.map(v => `<span class="chip red">rule: ${esc(v)}</span>`).join('')}
    </div>
    <div class="actions">
      ${url ? `<a class="action" href="${esc(url)}" title="Shortcut: o">Open in ${EDITOR_NAMES[data.view?.editor ?? 'vscode']}</a>` : ''}
      <button class="action ${blast?.direction === 'dependents' ? 'on' : ''}" data-action="dependents" title="Everything that imports this file, directly or indirectly">Blast radius <b>${fmt(dependentsReach)}</b></button>
      <button class="action ${blast?.direction === 'dependencies' ? 'on' : ''}" data-action="dependencies" title="Everything this file imports, directly or indirectly">Pulls in <b>${fmt(dependenciesReach)}</b></button>
      <button class="action" data-action="path" title="Shortest import chain to another file">Path to…</button>
    </div>
    ${blast ? blastSummary(n, blast.direction, blast.depth) : ''}
    <div class="grid">
      <div class="in"><b>${n.dependents}</b><span>Dependents</span></div>
      <div class="out"><b>${n.dependencies}</b><span>Imports</span></div>
      <div><b>${inst.toFixed(2)}</b><span>Instability</span><div class="bar"><i style="width:${inst * 100}%"></i></div></div>
      <div><b>${fmt(n.loc)}</b><span>Lines</span></div>
      <div title="${n.hotspotRank ? esc(`${hotspotEffort(n)}. Ranked #${n.hotspotRank} of ${fmt(meta.rankedHotspots)} files.`) : 'Not ranked: tests, data, generated files and files unchanged in the last year are left out'}"><b>${n.hotspotRank ? `#${n.hotspotRank}` : '–'}</b><span>Hotspot</span><div class="bar"><i style="width:${heat(n) * 100}%;background:${heatColor(heat(n))}"></i></div></div>
      <div><b>${meta.hasChurn ? n.churn : '–'}</b><span>Commits/yr</span></div>
    </div>
    ${
      cyclePath
        ? `<div class="cycle-path"><div class="eyebrow" style="color:var(--red);margin-bottom:4px">Shortest cycle through this file</div>${cyclePath
            .map(nodeButton)
            .join('<span class="arrow">→</span>')}${
            myCuts.length
              ? `<div class="cut-note">✂ Suggested fix: remove the import of ${myCuts.map(l => nodeButton(idOf(l.target))).join(', ')}</div>`
              : ''
          }</div>`
        : ''
    }
    <section class="list"><h3><span><span class="swatch" style="background:${IMPORTED_BY}"></span>Imported by</span><span>${ins.length}</span></h3><ul>${listItems(ins, 'source') || '<li class="muted">Nothing imports this file</li>'}</ul></section>
    <section class="list"><h3><span><span class="swatch" style="background:${IMPORTS}"></span>Imports</span><span>${outs.length}</span></h3><ul>${listItems(outs, 'target') || '<li class="muted">No local imports</li>'}</ul></section>
    ${n.unresolved.length ? `<section class="list"><h3><span style="color:var(--importedBy)">Unresolved imports</span><span>${n.unresolved.length}</span></h3><div class="chips">${chipList(n.unresolved)}</div></section>` : ''}
  `
  openDetails()
}

function renderCycle(id: number) {
  const cycle = cycles[id]!
  const cuts = (cycle.cuts ?? []).map(c => outLinks.get(c.source)!.find(l => idOf(l.target) === c.target)!)
  const members = cycle.members.map(node).toSorted((a, b) => b.dependents - a.dependents)
  $('#details').innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <div class="eyebrow" style="color:var(--red)">Circular cluster #${id + 1}</div>
    <h2>${cycle.size} files</h2>
    <p class="muted">Every file here can reach every other through imports.${
      cuts.length
        ? ` Removing the <b class="cut-text">${cuts.length} import${cuts.length === 1 ? '' : 's'}</b> below breaks every cycle between them. Each one is needed; there may be other equally small fixes.`
        : ''
    }</p>
    ${
      cuts.length
        ? `<section class="list"><h3><span><span class="swatch" style="background:${CUT}"></span>Imports to cut</span><span>${cuts.length}</span></h3><ul>${cuts
            .map(
              l => `<li class="cut-row"><button data-node="${esc(idOf(l.source))}" title="${esc(`${idOf(l.source)} imports ${idOf(l.target)}`)}">
                <span>${esc(node(idOf(l.source)).name)}</span><span class="arrow">→</span><span>${esc(node(idOf(l.target)).name)}</span>
                ${l.typeOnly ? '<span class="tag">type</span>' : ''}${l.dynamic ? '<span class="tag">lazy</span>' : ''}${l.count > 1 ? `<span class="tag">×${l.count}</span>` : ''}
              </button></li>`,
            )
            .join('')}</ul></section>`
        : ''
    }
    <section class="list"><h3><span>Files</span><span>${cycle.size}</span></h3><ul>${members
      .map(
        n =>
          `<li class="circ"><button data-node="${esc(n.id)}" title="${esc(n.id)}"><span>${esc(n.name)}</span><span class="dir">${esc(n.dir)}</span></button></li>`,
      )
      .join('')}</ul></section>
  `
  openDetails()
}

function renderPath(from: ViewNode, to: ViewNode, path: string[] | null, reversed: boolean) {
  $('#details').innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <div class="eyebrow" style="color:${PATH}">Import path</div>
    <h2>${esc(from.name)} ↔ ${esc(to.name)}</h2>
    ${
      path
        ? `<p class="muted">${reversed ? `${esc(from.name)} doesn't reach ${esc(to.name)}, but the reverse does: ` : ''}${path.length - 1} hop${path.length === 2 ? '' : 's'}, following imports.</p>
           <div class="path-chain">${path.map(nodeButton).join('<span class="arrow">→</span>')}</div>`
        : `<p class="muted">No chain of imports connects these files in either direction${state.hideTypeOnly ? ' (type-only imports are hidden)' : ''}.</p>`
    }
    <div class="actions"><button class="action" data-node="${esc(from.id)}">Back to ${esc(from.name)}</button><button class="action" data-node="${esc(to.id)}">Go to ${esc(to.name)}</button></div>
  `
  openDetails()
}

function openDetails() {
  const el = $('#details')
  el.classList.add('open')
  el.scrollTop = 0
}

function closeDetails() {
  $('#details').classList.remove('open')
}

$('#details').addEventListener('click', e => {
  if (closest(e, '.close')) return clearFocus()
  const action = closest(e, '[data-action]')?.dataset.action
  if (action && state.selected) {
    if (action === 'path') startPath(state.selected)
    else showBlast(state.selected, action as BlastDirection)
    return
  }
  const t = closest(e, '[data-node],[data-cluster],[data-cycle]')
  if (!t) return
  if (t.dataset.node) selectNode(node(t.dataset.node))
  else if (t.dataset.cluster) focusCluster(t.dataset.cluster)
  else focusCycle(Number(t.dataset.cycle))
})

function hideToast() {
  $('#toast').classList.remove('show')
}

function toast(message: string, ms = 2600) {
  const el = $('#toast')
  el.textContent = message
  el.classList.add('show')
  clearTimeout(Number(el.dataset.timer))
  el.dataset.timer = String(setTimeout(() => el.classList.remove('show'), ms))
}

// Search
const q = $<HTMLInputElement>('#q')
const results = $('#results')
let matches: ViewNode[] = []
let active = 0

function renderResults() {
  results.innerHTML = matches
    .map(
      (n, i) =>
        `<li class="${i === active ? 'active' : ''}" data-i="${i}"><span class="dot" style="color:${n.color}"></span><span>${esc(n.name)}</span><span class="path">${esc(n.dir)}</span></li>`,
    )
    .join('')
}

q.addEventListener('input', () => {
  const term = q.value.trim().toLowerCase()
  if (term === SECRET) {
    q.value = ''
    matches = []
    renderResults()
    q.blur()
    toggleNyan()
    return
  }
  const startsWith = (n: ViewNode) => Number(n.name.toLowerCase().startsWith(term))
  active = 0
  matches = term
    ? nodes
        .filter(n => n.id.toLowerCase().includes(term))
        .toSorted((a, b) => startsWith(b) - startsWith(a) || b.dependents - a.dependents)
        .slice(0, 12)
    : []
  renderResults()
})

q.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length)
    renderResults()
  } else if (e.key === 'Enter') {
    const match = matches[active]
    if (match) pick(match)
  } else if (e.key === 'Escape') {
    q.value = ''
    matches = []
    renderResults()
    q.blur()
  }
})

results.addEventListener('mousedown', e => {
  const li = closest(e, 'li')
  const match = li && matches[Number(li.dataset.i)]
  if (match) pick(match)
})

function pick(n: ViewNode) {
  q.value = ''
  matches = []
  renderResults()
  q.blur()
  selectNode(n)
}

// Easter egg: type the secret anywhere (or into search) for a visit from some friends
const SECRET = 'nyancat'
let typed = ''

function toggleNyan() {
  toast(nyan.toggle() ? '🌈 Nyan mode engaged. Type nyancat again to land.' : 'Nyan mode off')
}

addEventListener('keydown', e => {
  if (e.target === q || e.target instanceof HTMLSelectElement) return
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    typed = (typed + e.key.toLowerCase()).slice(-SECRET.length)
    if (typed === SECRET) {
      typed = ''
      toggleNyan()
      return
    }
  }
  if (e.key === '/') {
    e.preventDefault()
    q.focus()
  } else if (e.key === 'o' && state.selected) {
    openInEditor(state.selected)
  } else if (e.key === 'Escape') {
    if (state.pathFrom) {
      state.pathFrom = null
      toast('Path search cancelled')
    } else clearFocus()
  }
})

addEventListener('resize', () => {
  Graph.width(innerWidth).height(innerHeight)
  bloom.setSize(innerWidth, innerHeight)
})

// Handy for poking at the graph from devtools
window.galaxy = { Graph, data, state, lod, layout: () => layout }
