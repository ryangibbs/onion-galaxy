/**
 * Easter egg: type `nyancat` and Nyan Cats fly through the galaxy leaving rainbow trails.
 *
 * Cats fly along the camera's right vector at varying depths, so from the viewer's point of view
 * they cross the screen left to right like the original, whichever way the galaxy is rotated.
 * The trail is a chain of camera-facing sprites with horizontal rainbow stripes that fade out.
 */
import * as THREE from 'three'

const CATS = 5
const TRAIL_LIFE = 2.2 // seconds a trail segment takes to fade out
const PIXEL = 4 // canvas pixels per pixel-art pixel

// ---------------------------------------------------------------------------
// Pixel art
// ---------------------------------------------------------------------------
const RAINBOW = ['#ff0000', '#ff9900', '#ffff00', '#33ff00', '#0099ff', '#6633ff']

/** Draws the cat out of pixel-art rectangles on a 34 × 21 grid. */
function catTexture(): { texture: THREE.CanvasTexture; aspect: number } {
  const W = 34
  const H = 21
  const canvas = document.createElement('canvas')
  canvas.width = W * PIXEL
  canvas.height = H * PIXEL
  const g = canvas.getContext('2d')!
  const px = (x: number, y: number, w: number, h: number, color: string) => {
    g.fillStyle = color
    g.fillRect(x * PIXEL, y * PIXEL, w * PIXEL, h * PIXEL)
  }
  const OUTLINE = '#000000'
  const FUR = '#999999'

  // Tail, sticking out behind the pop-tart
  px(0, 9, 6, 4, OUTLINE)
  px(1, 10, 5, 2, FUR)

  // Legs
  for (const x of [6, 10, 18, 22]) {
    px(x, 16, 4, 4, OUTLINE)
    px(x + 1, 16, 2, 3, FUR)
  }

  // Pop-tart: outline, crust, filling (corners trimmed so it reads as rounded), sprinkles
  px(5, 1, 21, 16, OUTLINE)
  px(4, 2, 23, 14, OUTLINE)
  px(5, 2, 21, 14, '#ffcc99')
  px(6, 3, 19, 12, '#ff99ff')
  px(6, 3, 1, 1, '#ffcc99')
  px(24, 3, 1, 1, '#ffcc99')
  px(6, 14, 1, 1, '#ffcc99')
  px(24, 14, 1, 1, '#ffcc99')
  for (const [x, y] of [
    [9, 4],
    [14, 5],
    [20, 4],
    [8, 8],
    [12, 10],
    [17, 7],
    [10, 13],
    [15, 12],
    [21, 11],
  ] as const) {
    px(x, y, 1, 1, '#ff3399')
  }

  // Head: outline, ears, fur, eyes with glints, cheeks, mouth
  px(18, 7, 15, 10, OUTLINE)
  px(19, 4, 3, 4, OUTLINE)
  px(29, 4, 3, 4, OUTLINE)
  px(20, 5, 1, 3, FUR)
  px(30, 5, 1, 3, FUR)
  px(19, 8, 13, 8, FUR)
  px(21, 6, 1, 2, FUR)
  px(29, 6, 1, 2, FUR)
  px(22, 10, 2, 2, OUTLINE)
  px(28, 10, 2, 2, OUTLINE)
  px(22, 10, 1, 1, '#ffffff')
  px(28, 10, 1, 1, '#ffffff')
  px(20, 12, 2, 2, '#ff9999')
  px(30, 12, 1, 2, '#ff9999')
  px(24, 13, 4, 1, OUTLINE)
  px(25, 12, 1, 1, OUTLINE)

  return { texture: pixelTexture(canvas), aspect: W / H }
}

function rainbowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = PIXEL * 2
  canvas.height = RAINBOW.length * PIXEL * 2
  const g = canvas.getContext('2d')!
  RAINBOW.forEach((color, i) => {
    g.fillStyle = color
    g.fillRect(0, i * PIXEL * 2, canvas.width, PIXEL * 2)
  })
  return pixelTexture(canvas)
}

/** Crisp, unfiltered pixels: this is pixel art, not a photo. */
function pixelTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------
interface Segment {
  sprite: THREE.Sprite
  age: number
}

interface Cat {
  sprite: THREE.Sprite
  /** Direction of flight (the camera's right vector when the cat spawned) */
  dir: THREE.Vector3
  up: THREE.Vector3
  speed: number
  height: number
  /** Distance travelled; the cat respawns once it's flown past the far edge of the view */
  travelled: number
  span: number
  sinceSegment: number
  wave: number
  phase: number
  trail: Segment[]
}

export interface Nyan {
  readonly active: boolean
  toggle(): boolean
  update(dt: number): void
}

export function createNyan(scene: THREE.Scene, camera: THREE.PerspectiveCamera): Nyan {
  const { texture: catTex, aspect } = catTexture()
  const stripeTex = rainbowTexture()
  const group = new THREE.Group()
  group.visible = false
  scene.add(group)

  const cats: Cat[] = []
  let active = false

  function launch(cat: Cat, stagger: boolean) {
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
    const up = new THREE.Vector3().crossVectors(right, forward).normalize()

    // Somewhere between close and far, so cats pass both in front of and behind the systems
    const depth = 150 + Math.random() * 900
    const halfHeight = depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const halfWidth = halfHeight * camera.aspect
    const height = halfHeight * 0.14
    const lift = (Math.random() - 0.5) * halfHeight * 1.5

    const start = camera.position
      .clone()
      .addScaledVector(forward, depth)
      .addScaledVector(up, lift)
      .addScaledVector(right, -halfWidth - height * 3)

    Object.assign(cat, {
      dir: right,
      up,
      height,
      speed: halfWidth * (0.35 + Math.random() * 0.3), // roughly 3–6 seconds to cross the screen
      travelled: stagger ? -Math.random() * halfWidth * 2 : 0, // spread the first wave out
      span: (halfWidth + height * 3) * 2,
      sinceSegment: 0,
      wave: 0,
      phase: Math.random() * Math.PI * 2,
    })
    cat.sprite.position.copy(start).addScaledVector(right, Math.max(0, cat.travelled))
    cat.sprite.scale.set(height * aspect, height, 1)
  }

  for (let i = 0; i < CATS; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: catTex, transparent: true, depthWrite: false }))
    sprite.renderOrder = 20
    group.add(sprite)
    const cat = { sprite, trail: [] } as unknown as Cat
    cats.push(cat)
  }

  function dropSegment(cat: Cat) {
    // Reuse a faded segment when there is one, otherwise make a new sprite
    let seg = cat.trail.find(s => s.age >= TRAIL_LIFE)
    if (!seg) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: stripeTex, transparent: true, depthWrite: false }),
      )
      sprite.renderOrder = 19
      group.add(sprite)
      seg = { sprite, age: 0 }
      cat.trail.push(seg)
    }
    const w = cat.height * 0.5
    const h = cat.height * 0.62
    cat.wave ^= 1
    seg.age = 0
    seg.sprite.visible = true
    seg.sprite.scale.set(w * 1.05, h, 1)
    // Start just behind the pop-tart, bobbing up and down like the original
    seg.sprite.position
      .copy(cat.sprite.position)
      .addScaledVector(cat.dir, -cat.height * aspect * 0.42)
      .addScaledVector(cat.up, (cat.wave ? 1 : -1) * cat.height * 0.05 - cat.height * 0.02)
  }

  return {
    get active() {
      return active
    },

    toggle() {
      active = !active
      group.visible = active
      if (active) for (const cat of cats) launch(cat, true)
      else for (const cat of cats) for (const seg of cat.trail) seg.age = TRAIL_LIFE
      return active
    },

    update(dt) {
      if (!active) return
      const t = performance.now() / 1000
      for (const cat of cats) {
        const step = cat.speed * dt
        cat.travelled += step
        if (cat.travelled < 0) {
          cat.sprite.visible = false // still waiting in the wings
        } else {
          cat.sprite.visible = true
          cat.sprite.position.addScaledVector(cat.dir, step)
          cat.sprite.material.rotation = Math.sin(t * 8 + cat.phase) * 0.05 // a little wobble
          cat.sinceSegment += step
          if (cat.sinceSegment >= cat.height * 0.5) {
            cat.sinceSegment = 0
            dropSegment(cat)
          }
        }
        for (const seg of cat.trail) {
          seg.age += dt
          seg.sprite.material.opacity = Math.max(0, 1 - seg.age / TRAIL_LIFE)
          seg.sprite.visible = seg.age < TRAIL_LIFE
        }
        if (cat.travelled > cat.span) launch(cat, false)
      }
    },
  }
}
