/**
 * Where star systems (and, for the stability layout, individual files) sit in space. The force
 * simulation then pulls every file towards `target(node)`, so switching layout animates.
 */
import * as THREE from 'three'
import type { LayoutName } from '../types.ts'

export interface LayoutSystem {
  id: string
  files: number
  /** Rough radius the system's planets settle within */
  radius: number
}

export interface LayoutFile {
  id: string
  cluster: string
  instability: number | null
  /** Two stable random numbers in [0, 1), so a file keeps its place across layout switches */
  seed: [number, number]
}

export interface Layout {
  name: LayoutName
  /** Centre of each system: nebulae, labels, trade routes and zoom-dependent detail hang off it */
  anchors: Map<string, THREE.Vector3>
  /** Where the simulation pulls a file */
  target(file: LayoutFile): THREE.Vector3
  /** Systems are compact blobs, so collapsing distant ones into a single star makes sense */
  compact: boolean
  /** Radius of the whole arrangement, for framing the camera */
  extent: number
  /** Concentric reference rings (stability layout) */
  guides: { radius: number; label: string }[]
}

/** Clearance a system needs so its neighbours don't overlap it */
const reachOf = (s: LayoutSystem) => s.radius * 1.35

/** `systems` must be sorted biggest first */
export function computeLayout(name: LayoutName, systems: LayoutSystem[], files: LayoutFile[]): Layout {
  if (name === 'stability') return stability(systems, files)
  const anchors = name === 'ring' ? ring(systems) : name === 'sphere' ? sphere(systems) : spiral(systems)
  return {
    name,
    anchors,
    target: f => anchors.get(f.cluster)!,
    compact: true,
    extent: Math.max(400, ...systems.map(s => anchors.get(s.id)!.length() + s.radius)),
    guides: [],
  }
}

// ---------------------------------------------------------------------------

const SPIRAL_ARMS = 3
const SPIRAL_TWIST = 0.385 // radians of arm rotation per core radius travelled outward
let spiralCache: Map<string, THREE.Vector3> | undefined

/** Biggest system at the core, then each next one walked outward along its arm until it fits. */
function spiral(systems: LayoutSystem[]): Map<string, THREE.Vector3> {
  // The spiral has random jitter: keep it, so switching back to it restores the same galaxy
  if (spiralCache) return spiralCache
  const placed: { anchor: THREE.Vector3; reach: number }[] = []
  const armT = Array.from({ length: SPIRAL_ARMS }, () => 0)
  const coreR = (systems[0]?.radius ?? 50) * 1.4
  const anchors = new Map<string, THREE.Vector3>()
  systems.forEach((s, i) => {
    const reach = reachOf(s)
    let anchor = new THREE.Vector3()
    if (i > 0) {
      const arm = (i - 1) % SPIRAL_ARMS
      const offset = (arm * 2 * Math.PI) / SPIRAL_ARMS
      for (let t = armT[arm]!; ; t += 4) {
        const r = coreR + t
        const theta = offset + (r / coreR) * SPIRAL_TWIST
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
    anchors.set(s.id, anchor)
  })
  spiralCache = anchors
  return anchors
}

/** Systems side by side around one circle, each given an arc as wide as it needs. */
function ring(systems: LayoutSystem[]): Map<string, THREE.Vector3> {
  const widths = systems.map(s => reachOf(s) * 2.3)
  const circumference = widths.reduce((a, w) => a + w, 0)
  const radius = Math.max(150, circumference / (2 * Math.PI))
  const anchors = new Map<string, THREE.Vector3>()
  let arc = 0
  systems.forEach((s, i) => {
    const theta = ((arc + widths[i]! / 2) / circumference) * 2 * Math.PI
    arc += widths[i]!
    anchors.set(s.id, new THREE.Vector3(Math.cos(theta) * radius, 0, Math.sin(theta) * radius))
  })
  return anchors
}

/** Systems spread evenly over a globe (a Fibonacci sphere), sized so they roughly fit. */
function sphere(systems: LayoutSystem[]): Map<string, THREE.Vector3> {
  // Fibonacci points are only roughly even, and big systems need more than their share, so be generous
  const area = systems.reduce((a, s) => a + (reachOf(s) * 2.3) ** 2, 0)
  const radius = Math.max(200, Math.sqrt(area / (4 * Math.PI)) * 2)
  const golden = Math.PI * (3 - Math.sqrt(5))
  const n = systems.length
  const anchors = new Map<string, THREE.Vector3>()
  systems.forEach((s, i) => {
    const y = n === 1 ? 0 : 1 - (2 * i) / (n - 1)
    const r = Math.sqrt(1 - y * y)
    anchors.set(s.id, new THREE.Vector3(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r).multiplyScalar(radius))
  })
  return anchors
}

/**
 * A disc where distance from the centre is instability: files everything depends on sit at the
 * core, files nothing depends on at the rim. Each system gets a wedge sized by its file count, so
 * directories stay together while their files spread out by stability.
 */
function stability(systems: LayoutSystem[], files: LayoutFile[]): Layout {
  const inner = 40
  const outer = Math.max(320, 24 * Math.sqrt(files.length))
  const total = systems.reduce((a, s) => a + s.files, 0) || 1
  const wedges = new Map<string, { start: number; width: number }>()
  let start = 0
  for (const s of systems) {
    const width = (s.files / total) * 2 * Math.PI
    wedges.set(s.id, { start, width })
    start += width
  }
  const anchors = new Map<string, THREE.Vector3>()
  for (const s of systems) {
    const { start: a, width } = wedges.get(s.id)!
    const theta = a + width / 2
    anchors.set(s.id, new THREE.Vector3(Math.cos(theta) * outer * 1.18, 0, Math.sin(theta) * outer * 1.18))
  }
  const radiusFor = (instability: number | null) =>
    instability === null ? outer * 1.08 : inner + instability * (outer - inner)
  return {
    name: 'stability',
    anchors,
    target: f => {
      const { start: a, width } = wedges.get(f.cluster)!
      const theta = a + width * (0.08 + 0.84 * f.seed[0])
      const r = radiusFor(f.instability)
      return new THREE.Vector3(Math.cos(theta) * r, (f.seed[1] - 0.5) * 36, Math.sin(theta) * r)
    },
    compact: false,
    extent: outer * 1.3,
    guides: [
      { radius: radiusFor(0), label: 'stable · 0' },
      { radius: radiusFor(0.5), label: '0.5' },
      { radius: radiusFor(1), label: 'unstable · 1' },
    ],
  }
}
