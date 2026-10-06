/**
 * Drobní pomocníci nad viewrem a usazením modelu: co je pod kurzorem, kam se kamera dívá
 * a jak z kotvy poskládat transformační matici.
 */
import * as Cesium from 'cesium'
import type { GroundHit, Placement } from './types'

/** Najde 3D bod povrchu (terén/dlaždice) pod daným bodem obrazovky. */
export function pickGround(v: Cesium.Viewer, screen: Cesium.Cartesian2): GroundHit | null {
  const scene = v.scene
  let cart: Cesium.Cartesian3 | undefined
  if (scene.pickPositionSupported) {
    const c = scene.pickPosition(screen)
    if (Cesium.defined(c)) cart = c
  }
  if (!cart) {
    const ray = v.camera.getPickRay(screen)
    if (ray) { const c = scene.globe.pick(ray, scene); if (Cesium.defined(c)) cart = c }
  }
  if (!cart) {
    const c = v.camera.pickEllipsoid(screen, scene.globe.ellipsoid)
    if (Cesium.defined(c)) cart = c
  }
  if (!cart) return null
  const carto = Cesium.Cartographic.fromCartesian(cart)
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: carto.height }
}

/** Bod terénu pod kurzorem nezávisle na modelu (globe.pick ignoruje primitivy modelu). */
export function pickTerrain(v: Cesium.Viewer, screen: Cesium.Cartesian2): GroundHit | null {
  const ray = v.camera.getPickRay(screen)
  let cart = ray ? v.scene.globe.pick(ray, v.scene) : undefined
  if (!Cesium.defined(cart)) cart = v.camera.pickEllipsoid(screen, v.scene.globe.ellipsoid)
  if (!Cesium.defined(cart)) return null
  const carto = Cesium.Cartographic.fromCartesian(cart)
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: carto.height }
}

/** Povrch pod středem obrazovky (kam se zhruba dívá kamera). */
export function viewCenterGround(v: Cesium.Viewer): GroundHit {
  const canvas = v.scene.canvas
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
  const hit = pickGround(v, center)
  if (hit) return hit
  const carto = v.camera.positionCartographic
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: 0 }
}

export function positionOf(p: Placement): Cesium.Cartesian3 {
  return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.groundH + p.heightOffset)
}

export function buildMatrix(p: Placement, centerOffset: Cesium.Cartesian3, yawDeg = 0): Cesium.Matrix4 {
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(p.heading + yawDeg),
    Cesium.Math.toRadians(p.pitch),
    Cesium.Math.toRadians(p.roll),
  )
  const frame = Cesium.Transforms.headingPitchRollToFixedFrame(positionOf(p), hpr)
  const scaled = Cesium.Matrix4.multiplyByUniformScale(frame, p.scale, new Cesium.Matrix4())
  const tneg = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.negate(centerOffset, new Cesium.Cartesian3()))
  return Cesium.Matrix4.multiply(scaled, tneg, new Cesium.Matrix4())
}

/** Další snímek prohlížeče — mezi kusy těžké práce, ať mapa mezitím překreslí a reaguje na myš. */
export const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()))

/**
 * Počká, až se dotáhne podklad pod aktuálním pohledem (dlaždice glóbu i 3D dlaždice) —
 * soubory scény se pak stavějí nad hotovou mapou, ne o překot s ní. Nejdéle `maxMs`:
 * pomalé dlaždice nesmí soubory zdržet donekonečna.
 */
export function waitForMap(v: Cesium.Viewer, maxMs = 6000): Promise<void> {
  return new Promise(resolve => {
    if (v.isDestroyed()) { resolve(); return }
    const scene = v.scene
    // dokud se nic nenakreslilo, je fronta dlaždic prázdná jen proto, že ještě nic nechtěla
    let frames = 0
    const off = scene.postRender.addEventListener(() => { frames++ })
    const t0 = performance.now()
    let calm = 0
    const done = () => { off(); resolve() }
    const tilesets = () => {
      const out: Cesium.Cesium3DTileset[] = []
      for (let i = 0; i < scene.primitives.length; i++) {
        const p = scene.primitives.get(i)
        if (p instanceof Cesium.Cesium3DTileset && p.show) out.push(p)
      }
      return out
    }
    const tick = () => {
      if (v.isDestroyed()) { done(); return }
      const loaded = frames >= 3 && (!scene.globe?.show || scene.globe.tilesLoaded) && tilesets().every(t => t.tilesLoaded)
      calm = loaded ? calm + 1 : 0
      if (calm >= 2 || performance.now() - t0 > maxMs) { done(); return }
      scene.requestRender() // v režimu kreslení na vyžádání by se stav dlaždic jinak neposunul
      setTimeout(tick, 200)
    }
    setTimeout(tick, 200)
  })
}

/**
 * Natočí kameru na místě na azimut `heading` (radiány, od severu po směru hodin) — poloha,
 * výška i sklon zůstanou. Rozdělaný přelet se nejdřív dokončí: kdo klikl do minimapy a hned
 * táhne, chce stát tam, kam klikl, ne někde na půl cesty.
 */
export function faceCamera(v: Cesium.Viewer, heading: number) {
  const cam = v.camera
  cam.completeFlight()
  cam.setView({ orientation: { heading, pitch: cam.pitch, roll: cam.roll } })
}

/** Otočí kameru na místě o `deg` stupňů (kladné doprava) — viz `faceCamera`. */
export function turnCamera(v: Cesium.Viewer, deg: number) {
  v.camera.completeFlight()
  faceCamera(v, v.camera.heading + Cesium.Math.toRadians(deg))
}
