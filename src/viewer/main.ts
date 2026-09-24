import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { GalaxyCluster, GalaxyData, GalaxyLink, GalaxyNode } from '../types.ts'
import { createNyan } from './nyan.ts'

// ---------------------------------------------------------------------------
// View model: the analyzer's data plus layout, rendering and simulation state
// ---------------------------------------------------------------------------
interface ViewNode extends GalaxyNode {
  color: string
  radius: number
  isStar: boolean
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
}

/** d3 swaps link endpoints from ids to node objects once the simulation starts. */
type ViewLink = Omit<GalaxyLink, 'source' | 'target'> & { source: string | ViewNode; target: string | ViewNode }

interface ViewCluster extends GalaxyCluster {
  hue: number
  color: string
  /** Rough radius the system's planets settle within */
  radius: number
  /** Personal space used when placing systems so they don't overlap */
  reach: number
  anchor: THREE.Vector3
  nodes: ViewNode[]
  star: ViewNode
  nebula: THREE.Sprite
  label: HTMLButtonElement
  labelPos: THREE.Vector3
}

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

const RED = '#ff3b4a'
const IMPORTS = '#5ee7ff'
const IMPORTED_BY = '#ffb347'

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`Missing element ${sel}`)
  return el
}
const esc = (s: string | number) =>
  String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString())
const idOf = (end: string | ViewNode) => (typeof end === 'object' ? end.id : end)
/** Closest ancestor of an event target matching `sel`. */
const closest = (e: Event, sel: string) => (e.target as HTMLElement).closest<HTMLElement>(sel)

const data: GalaxyData = JSON.parse($('#galaxy-data').textContent ?? '')
const { meta, cycles } = data

// ---------------------------------------------------------------------------
// Layout: star systems along spiral arms, biggest at the galactic core
// ---------------------------------------------------------------------------
const hueFor = (i: number) => (40 + ((i * 137.508) % 290)) % 360 // golden-angle hues, skipping the reds reserved for cycles
const ARMS = 3
const TWIST = 1.1

const radiusOf = (c: GalaxyCluster) => 10 + 7 * Math.sqrt(c.files)

function placeSystems(input: GalaxyCluster[]) {
  const placed: { anchor: THREE.Vector3; reach: number }[] = []
  const armT = Array.from({ length: ARMS }, () => 0)
  const coreR = (input[0] ? radiusOf(input[0]) : 50) * 1.4

  return input.map((c, i) => {
    const radius = radiusOf(c)
    const reach = radius * 1.35
    let anchor = new THREE.Vector3()
    if (i > 0) {
      // Walk outward along this system's arm until it no longer overlaps anything already placed
      const arm = (i - 1) % ARMS
      const offset = (arm * 2 * Math.PI) / ARMS
      for (let t = armT[arm]!; ; t += 4) {
        const r = coreR + t
        const theta = offset + (r / coreR) * TWIST * 0.35
        const jitter = (Math.random() - 0.5) * reach * 0.6
        const p = new THREE.Vector3(
          Math.cos(theta) * r + jitter,
          (Math.random() - 0.5) * reach * 0.5,
          Math.sin(theta) * r - jitter,
        )
        if (placed.every(q => q.anchor.distanceTo(p) > (q.reach + reach) * 1.05)) {
          anchor = p
          armT[arm] = t
          break
        }
      }
    }
    placed.push({ anchor, reach })
    const hue = hueFor(i)
    const color = `hsl(${hue}, 85%, 66%)`
    return { ...c, hue, color, radius, reach, anchor }
  })
}

const layout = placeSystems(data.clusters)
const layoutById = new Map(layout.map(c => [c.id, c]))

const nodes: ViewNode[] = data.nodes.map(n => {
  const system = layoutById.get(n.cluster)!
  const spread = () => (Math.random() - 0.5) * system.radius
  return {
    ...n,
    color: n.cycle !== null ? RED : system.color,
    radius: 1.2 + 2 * Math.log2(1 + n.dependents),
    isStar: false,
    // start everyone near home so the layout settles quickly
    x: system.anchor.x + spread(),
    y: system.anchor.y + spread(),
    z: system.anchor.z + spread(),
    vx: 0,
    vy: 0,
    vz: 0,
  }
})
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

const clusters: ViewCluster[] = layout.map((c, i) => {
  const members = nodes.filter(n => n.cluster === c.id)
  // The system's star is its most-depended-on file, pinned at the anchor so planets orbit it
  const star = members.reduce((a, b) => (b.dependents > a.dependents ? b : a))
  star.isStar = true
  Object.assign(star, { fx: c.anchor.x, fy: c.anchor.y, fz: c.anchor.z, x: c.anchor.x, y: c.anchor.y, z: c.anchor.z })

  const nebula = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: c.color,
      transparent: true,
      opacity: GLOW.nebula.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  nebula.scale.setScalar(c.radius * 5)
  nebula.position.copy(c.anchor)

  const label = document.createElement('button')
  label.className = 'sys-label'
  label.textContent = c.id.split('/').pop() ?? c.id
  label.style.color = c.color
  label.dataset.cluster = c.id
  label.dataset.major = String(i < 30)
  $('#labels').append(label)

  return {
    ...c,
    nodes: members,
    star,
    nebula,
    label,
    labelPos: c.anchor.clone().add(new THREE.Vector3(0, c.radius * 1.15 + 8, 0)),
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
  selected: null as ViewNode | null,
  focusCluster: null as string | null,
  focusCycle: null as number | null,
  hover: null as ViewNode | null,
  cyclesOnly: false,
  hideTypeOnly: false,
}

/** The set of node ids in focus, or null when nothing is focused. */
function focusSet(): Set<string> | null {
  if (state.selected) {
    const s = new Set([state.selected.id])
    for (const l of outLinks.get(state.selected.id)!) s.add(idOf(l.target))
    for (const l of inLinks.get(state.selected.id)!) s.add(idOf(l.source))
    return s
  }
  if (state.focusCluster) return new Set(clusterById.get(state.focusCluster)!.nodes.map(n => n.id))
  if (state.focusCycle !== null) return new Set(cycles[state.focusCycle]!.members)
  return null
}
let focused: Set<string> | null = null
let focusLinkCount = 0

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
  return group
}

const sameCluster = (l: ViewLink) => node(idOf(l.source)).cluster === node(idOf(l.target)).cluster

function linkInFocus(l: ViewLink): boolean {
  if (!focused) return true
  const s = idOf(l.source)
  const t = idOf(l.target)
  if (state.selected) return s === state.selected.id || t === state.selected.id
  if (state.focusCycle !== null) return l.circular && focused.has(s) && focused.has(t)
  return focused.has(s) && focused.has(t)
}

const linkIsVisible = (l: ViewLink) =>
  (!state.hideTypeOnly || !l.typeOnly) && (!state.cyclesOnly || l.circular) && linkInFocus(l)

function linkColor(l: ViewLink): string {
  if (focused) {
    if (l.circular) return RED
    // many edges converging on one hub would bloom into a white-out, so thin them as they multiply
    const a = Math.min(0.6, 5 / Math.sqrt(focusLinkCount + 1))
    if (state.selected)
      return idOf(l.source) === state.selected.id ? `rgba(94,231,255,${a})` : `rgba(255,179,71,${a * 0.8})`
    return `rgba(190,210,255,${a * 0.7})`
  }
  if (l.circular) return 'rgba(255,59,74,0.85)'
  if (l.typeOnly) return 'rgba(150,160,210,0.02)'
  if (sameCluster(l)) return `hsla(${clusterOf(node(idOf(l.source))).hue}, 80%, 70%, 0.09)`
  return 'rgba(130,160,255,0.025)'
}
const linkWidth = (l: ViewLink) =>
  focused ? (state.focusCycle !== null ? 3 : focusLinkCount > 60 ? 0 : 0.6) : l.circular ? 0.45 : 0
const circularCount = links.filter(l => l.circular).length
const linkParticles = (l: ViewLink) =>
  focused ? (focusLinkCount < 150 ? 2 : 0) : l.circular && circularCount < 1500 ? 1 : 0

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------
const Graph = new ForceGraph3D($('#graph'), { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<
  ViewNode,
  ViewLink
>
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
  .linkDirectionalParticleColor(l =>
    l.circular ? RED : state.selected && idOf(l.source) === state.selected.id ? IMPORTS : IMPORTED_BY,
  )
  .d3AlphaDecay(0.025)
  .d3VelocityDecay(0.35)
  .warmupTicks(40)
  .cooldownTime(12000)
  .onNodeHover(n => {
    state.hover = n
    $('#graph').style.cursor = n ? 'pointer' : ''
  })
  .onNodeClick(n => selectNode(n))
  .onBackgroundClick(() => clearFocus())

// Forces: strong pull toward home system, weak pull across systems
;(Graph.d3Force('charge') as unknown as ChargeForce).strength(-22).distanceMax(220)
;(Graph.d3Force('link') as unknown as LinkForce)
  .distance(l => (sameCluster(l) ? 14 + clusterOf(node(idOf(l.source))).radius * 0.35 : 90))
  .strength(l => (sameCluster(l) ? 0.25 : 0.004))
Graph.d3Force('cluster', (alpha: number) => {
  const k = 0.12 * alpha
  for (const n of nodes) {
    if (n.fx !== undefined) continue
    const a = clusterOf(n).anchor
    n.vx += (a.x - n.x) * k
    n.vy += (a.y - n.y) * k * 1.6 // flatten systems a little, like a disc
    n.vz += (a.z - n.z) * k
  }
})

// Scene dressing: starfield and a nebula behind each system
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

// Bloom gives everything that No Man's Sky glow
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  GLOW.bloom.strength,
  GLOW.bloom.radius,
  GLOW.bloom.threshold,
)
Graph.postProcessingComposer().addPass(bloom)

const R = Math.max(400, ...clusters.map(c => c.anchor.length() + c.radius)) * 1.15
Graph.cameraPosition({ x: 0, y: R * 0.75, z: R * 1.35 }, { x: 0, y: 0, z: 0 })
const controls = Graph.controls() as OrbitControls
controls.autoRotateSpeed = 0.35
setTimeout(() => ($('#loading').style.opacity = '0'), 300)

const labelsToggle = $<HTMLInputElement>('#t-labels')
const nyan = createNyan(scene, Graph.camera() as THREE.PerspectiveCamera)
let lastFrame = performance.now()

// Hover/selection pulse, cycle twinkle, label tracking and… cats
;(function animate() {
  const now = performance.now()
  const t = now / 1000
  nyan.update(Math.min(0.1, (now - lastFrame) / 1000)) // cap dt so a backgrounded tab doesn't teleport cats
  lastFrame = now
  for (const n of nodes) {
    if (!n.mesh) continue
    const pulse = n === state.hover ? 1.5 : n === state.selected ? 1.15 + Math.sin(t * 4) * 0.08 : 1
    n.mesh.scale.setScalar(n.radius * pulse)
    if (n.halo && n.cycle !== null && !focused) {
      n.halo.material.opacity = n.halo.userData.baseOpacity * (0.75 + 0.25 * Math.sin(t * 2.2 + n.cycle))
    }
  }
  positionLabels()
  requestAnimationFrame(animate)
})()

/** System labels are HTML (crisp, and immune to bloom), projected onto the canvas each frame. */
function positionLabels() {
  if (!labelsToggle.checked) return
  const cam = Graph.camera()
  const v = new THREE.Vector3()
  for (const c of clusters) {
    const el = c.label
    if (el.hidden) continue
    v.copy(c.labelPos).project(cam)
    const behind = v.z > 1
    el.style.display = behind ? 'none' : ''
    if (behind) continue
    el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px)`
    const dist = cam.position.distanceTo(c.anchor)
    el.style.opacity = String(focused && state.focusCluster !== c.id ? 0.25 : Math.min(1, Math.max(0.35, 2200 / dist)))
  }
}

function updateLabels() {
  for (const c of clusters) {
    c.label.hidden = !(labelsToggle.checked && (c.label.dataset.major === 'true' || state.focusCluster === c.id))
  }
}
updateLabels()

// ---------------------------------------------------------------------------
// Styling refresh
// ---------------------------------------------------------------------------
function refresh() {
  focused = focusSet()
  focusLinkCount = focused ? links.filter(linkInFocus).length : 0
  const selected = state.selected
  for (const n of nodes) {
    if (!n.mesh) continue
    const inFocus = !focused || focused.has(n.id)
    let color = n.color
    if (selected && inFocus && n !== selected && n.cycle === null) {
      // colour neighbours by direction: things I import vs things that import me
      const imports = outLinks.get(selected.id)!.some(l => idOf(l.target) === n.id)
      color = imports ? IMPORTS : IMPORTED_BY
    }
    n.mesh.material.color.set(color)
    n.mesh.material.opacity = inFocus ? 1 : 0.07
    if (n.halo) {
      const lit = inFocus && (!selected || n === selected || n.cycle !== null)
      n.halo.material.opacity = lit ? n.halo.userData.baseOpacity * (state.focusCycle !== null ? 1.6 : 1) : 0
      n.halo.scale.setScalar(n.radius * haloScale(n) * (focused && inFocus && state.focusCycle !== null ? 4 : 1))
    }
  }
  for (const c of clusters)
    c.nebula.material.opacity = !focused || state.focusCluster === c.id ? GLOW.nebula.opacity : GLOW.nebula.dimmed
  updateLabels()
  // Dense neighbourhoods of a big hub would bloom into a white-out
  bloom.strength =
    selected && focused ? Math.max(GLOW.minBloom, GLOW.bloom.strength - focused.size / 600) : GLOW.bloom.strength
  Graph.linkVisibility(linkIsVisible).linkColor(linkColor).linkWidth(linkWidth).linkDirectionalParticles(linkParticles)
  renderSidebarActive()
}

function refreshVisibility() {
  Graph.nodeVisibility(Graph.nodeVisibility()).linkVisibility(Graph.linkVisibility())
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

function centroid(ids: string[]) {
  const v = new THREE.Vector3()
  for (const id of ids) v.add(toVec(node(id)))
  return v.divideScalar(ids.length)
}

function selectNode(n: ViewNode) {
  Object.assign(state, { selected: n, focusCluster: null, focusCycle: null })
  refresh()
  renderDetails(n)
  flyTo(n, 180 + n.radius * 14)
}

function focusCluster(id: string) {
  if (state.focusCluster === id) return clearFocus()
  Object.assign(state, { selected: null, focusCluster: id, focusCycle: null })
  closeDetails()
  refresh()
  const c = clusterById.get(id)!
  flyTo(c.anchor, c.radius * 4 + 120)
}

function focusCycle(id: number) {
  if (state.focusCycle === id) return clearFocus()
  Object.assign(state, { selected: null, focusCluster: null, focusCycle: id })
  closeDetails()
  refresh()
  const members = cycles[id]!.members
  const center = centroid(members)
  const spread = Math.max(...members.map(m => center.distanceTo(toVec(node(m)))))
  // cycles can span the whole galaxy, so never back out further than the overview
  flyTo(center, Math.min(R * 1.3, Math.max(120, spread * 3.4)))
}

function clearFocus() {
  Object.assign(state, { selected: null, focusCluster: null, focusCycle: null })
  closeDetails()
  refresh()
}

/** Shortest import path from n back to itself, if it's in a cycle. */
function shortestCycle(n: ViewNode): string[] | null {
  if (n.cycle === null) return null
  const prev = new Map<string, string>()
  const queue = [n.id]
  const seen = new Set([n.id])
  while (queue.length) {
    const cur = queue.shift()!
    for (const l of outLinks.get(cur)!) {
      const t = idOf(l.target)
      if (node(t).cycle !== n.cycle) continue
      if (t === n.id) {
        const path = [cur]
        while (path[0] !== n.id) path.unshift(prev.get(path[0]!)!)
        return [...path, n.id]
      }
      if (!seen.has(t)) {
        seen.add(t)
        prev.set(t, cur)
        queue.push(t)
      }
    }
  }
  return null
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
    ['Circular clusters', fmt(meta.cycles), meta.cycles ? 'red' : ''],
    ['Files in cycles', fmt(meta.filesInCycles), meta.filesInCycles ? 'red' : ''],
    ['Orphans', fmt(meta.orphans)],
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
          <span class="count">${c.size} files</span>
        </button>`
      })
      .join('')
  : `<div class="empty">No circular dependencies. Clean galaxy ✦</div>`

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
  for (const r of document.querySelectorAll<HTMLElement>('#sidebar .row')) {
    const { cluster, cycle, node: id } = r.dataset
    r.classList.toggle(
      'active',
      (!!cluster && cluster === state.focusCluster) ||
        (cycle !== undefined && Number(cycle) === state.focusCycle) ||
        (!!id && id === state.selected?.id),
    )
  }
}

$<HTMLInputElement>('#t-cycles').addEventListener('change', e => {
  state.cyclesOnly = (e.target as HTMLInputElement).checked
  refreshVisibility()
})
$<HTMLInputElement>('#t-types').addEventListener('change', e => {
  state.hideTypeOnly = (e.target as HTMLInputElement).checked
  refreshVisibility()
})
labelsToggle.addEventListener('change', updateLabels)
$<HTMLInputElement>('#t-rotate').addEventListener(
  'change',
  e => (controls.autoRotate = (e.target as HTMLInputElement).checked),
)
$('#labels').addEventListener('click', e => {
  const id = closest(e, '[data-cluster]')?.dataset.cluster
  if (id) focusCluster(id)
})

function tooltip(n: ViewNode): string {
  return `<div class="tip-name">${esc(n.name)}</div>
    <div class="tip-path">${esc(n.dir)}</div>
    <div class="tip-stats"><span class="i">${n.dependents} dependents</span> · <span class="o">${n.dependencies} imports</span> · ${fmt(n.loc)} loc</div>
    ${n.cycle !== null ? `<div class="tip-cycle">⟳ in circular cluster #${n.cycle + 1} (${cycles[n.cycle]!.size} files)</div>` : ''}`
}

function listItems(ls: ViewLink[], end: 'source' | 'target'): string {
  return ls
    .map(l => ({ n: node(idOf(l[end])), l }))
    .toSorted((a, b) => Number(b.l.circular) - Number(a.l.circular) || b.n.dependents - a.n.dependents)
    .map(
      ({ n, l }) => `<li class="${l.circular ? 'circ' : ''}"><button data-node="${esc(n.id)}" title="${esc(n.id)}">
        <span>${esc(n.name)}</span>
        ${l.typeOnly ? '<span class="tag">type</span>' : ''}${l.dynamic ? '<span class="tag">lazy</span>' : ''}${l.circular ? '<span class="tag" style="color:var(--red)">cycle</span>' : ''}
        <span class="dir">${esc(n.dir)}</span>
      </button></li>`,
    )
    .join('')
}

const chipList = (items: string[]) => items.map(p => `<span class="chip">${esc(p)}</span>`).join('')

function renderDetails(n: ViewNode) {
  const c = clusterOf(n)
  const ins = inLinks.get(n.id)!
  const outs = outLinks.get(n.id)!
  const cyclePath = shortestCycle(n)
  const inst = n.instability ?? 0
  const el = $('#details')
  el.innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <div class="eyebrow">${n.isStar ? 'Star · system hub' : 'Planet'}</div>
    <h2>${esc(n.name)}</h2>
    <div class="fullpath">${esc(n.id)}</div>
    <div class="chips">
      <button class="chip cluster" data-cluster="${esc(c.id)}"><span class="dot" style="color:${c.color};display:inline-block;width:7px;height:7px;margin-right:5px"></span>${esc(c.id)}</button>
      ${n.cycle !== null ? `<button class="chip red" data-cycle="${n.cycle}">⟳ circular cluster #${n.cycle + 1} · ${cycles[n.cycle]!.size} files</button>` : ''}
      ${n.orphan ? '<span class="chip">orphan</span>' : ''}
      ${n.dependents === 0 && !n.orphan ? '<span class="chip">entry point?</span>' : ''}
      ${n.violations.map(v => `<span class="chip red">rule: ${esc(v)}</span>`).join('')}
    </div>
    <div class="grid">
      <div class="in"><b>${n.dependents}</b><span>Dependents</span></div>
      <div class="out"><b>${n.dependencies}</b><span>Imports</span></div>
      <div><b>${inst.toFixed(2)}</b><span>Instability</span><div class="bar"><i style="width:${inst * 100}%"></i></div></div>
      <div><b>${fmt(n.loc)}</b><span>Lines</span></div>
      <div><b>${n.bytes ? (n.bytes / 1024).toFixed(1) : '–'}</b><span>KB</span></div>
      <div><b>${meta.hasChurn ? n.churn : '–'}</b><span>Commits/yr</span></div>
    </div>
    ${
      cyclePath
        ? `<div class="cycle-path"><div class="eyebrow" style="color:var(--red);margin-bottom:4px">Shortest cycle through this file</div>${cyclePath
            .map(id => `<button data-node="${esc(id)}" title="${esc(id)}">${esc(node(id).name)}</button>`)
            .join('<span class="arrow">→</span>')}</div>`
        : ''
    }
    <section class="list"><h3><span><span class="swatch" style="background:${IMPORTED_BY}"></span>Imported by</span><span>${ins.length}</span></h3><ul>${listItems(ins, 'source') || '<li class="muted">Nothing imports this file</li>'}</ul></section>
    <section class="list"><h3><span><span class="swatch" style="background:${IMPORTS}"></span>Imports</span><span>${outs.length}</span></h3><ul>${listItems(outs, 'target') || '<li class="muted">No local imports</li>'}</ul></section>
    ${n.unresolved.length ? `<section class="list"><h3><span style="color:var(--importedBy)">Unresolved imports</span><span>${n.unresolved.length}</span></h3><div class="chips">${chipList(n.unresolved)}</div></section>` : ''}
  `
  el.classList.add('open')
  el.scrollTop = 0
}

function closeDetails() {
  $('#details').classList.remove('open')
}

$('#details').addEventListener('click', e => {
  if (closest(e, '.close')) return clearFocus()
  const t = closest(e, '[data-node],[data-cluster],[data-cycle]')
  if (!t) return
  if (t.dataset.node) selectNode(node(t.dataset.node))
  else if (t.dataset.cluster) focusCluster(t.dataset.cluster)
  else focusCycle(Number(t.dataset.cycle))
})

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
  const on = nyan.toggle()
  const toast = $('#toast')
  toast.textContent = on ? '🌈 Nyan mode engaged. Type nyancat again to land.' : 'Nyan mode off'
  toast.classList.add('show')
  clearTimeout(Number(toast.dataset.timer))
  toast.dataset.timer = String(setTimeout(() => toast.classList.remove('show'), 2600))
}

addEventListener('keydown', e => {
  if (e.target === q) return
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
  } else if (e.key === 'Escape') clearFocus()
})

addEventListener('resize', () => {
  Graph.width(innerWidth).height(innerHeight)
  bloom.setSize(innerWidth, innerHeight)
})

// Handy for poking at the graph from devtools
window.galaxy = { Graph, data, state }
