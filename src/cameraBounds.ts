/**
 * Hlídání kamery: nepustí ji z dosahu České republiky a zarazí nečekané skoky.
 *
 * 1. Oddálení jen do výšky, ze které je vidět celá republika (podle zorného úhlu a poměru stran
 *    plátna) — dál už ne. Platí pro tah pravým tlačítkem i pinch (Cesium `maximumZoomDistance`)
 *    i pro naše kolečko (useCameraMotion se ptá na `crMaxHeight`); pojistka níž srovná i zbytek.
 *    Dolů nejníž `MIN_ABOVE_GROUND_M` nad terénem.
 * 2. Posun: místo, na které se kamera dívá, smí být nanejvýš `MARGIN_KM` (crGeometry.ts) za
 *    hranicí ČR. Hlídá se
 *    bod pohledu, ne poloha kamery — šikmý pohled zdálky by jinak narážel, i když míří na ČR.
 * 3. Skoky: při naklánění k obzoru Cesium otáčí kolem bodu stovky kilometrů daleko a kamera
 *    pak o kus myši odletí i s výškou. Náklon je proto omezený (`MAX_TILT_DEG`) a snímek, ve
 *    kterém se kamera během ovládání myší (a chvíli po puštění — setrvačnost) přesune nepřiměřeně
 *    daleko vůči své výšce, se zahodí.
 *
 * Běží v `postUpdate` — po ovladači myši i po našem kolečku a kroužení (`preUpdate`), ale před
 * chvěním kamery (`preRender`), takže opravuje skutečnou polohu kamery, ne rozechvěnou.
 */
import { useEffect } from 'react'
import * as Cesium from 'cesium'
import { CR_H, CR_W, clampToCr } from './crGeometry'

/** největší náklon kamery od svislice — blíž k obzoru se otáčí kolem moc vzdáleného bodu */
const MAX_TILT_DEG = 82
/** nejníž nad terénem (m) — níž by kamera zajela do země */
export const MIN_ABOVE_GROUND_M = 2
/** rezerva nad výškou, ze které je republika vidět celá (okraje, lišta, panel) */
const VIEW_MARGIN = 1.25
/** jak dlouho po puštění myši ještě hlídat skoky (setrvačnost ovladače) */
const INERTIA_MS = 1500

/** Nejvyšší výška kamery (m nad elipsoidem): z ní je vidět celá republika, víc ne. */
export function crMaxHeight(scene: Cesium.Scene): number {
  const f = scene.camera.frustum
  const aspect = scene.canvas.clientWidth / Math.max(1, scene.canvas.clientHeight) || 1.6
  const fovy = f instanceof Cesium.PerspectiveFrustum && f.fovy ? f.fovy : Math.PI / 3
  const fovx = 2 * Math.atan(Math.tan(fovy / 2) * aspect)
  const km = Math.max(CR_W / 2 / Math.tan(fovx / 2), CR_H / 2 / Math.tan(fovy / 2)) * VIEW_MARGIN
  return km * 1000
}

export function useCameraBounds(deps: { viewerRef: React.RefObject<Cesium.Viewer | null>; viewerReady: boolean }) {
  const { viewerRef, viewerReady } = deps
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !viewerReady) return
    const scene = v.scene, cam = scene.camera, ssc = scene.screenSpaceCameraController
    const ellipsoid = scene.globe.ellipsoid
    ssc.maximumTiltAngle = Cesium.Math.toRadians(MAX_TILT_DEG)
    // přiblížení (tah pravým tlačítkem, pinch i naše kolečko) se zastaví 2 m nad zemí
    ssc.minimumZoomDistance = MIN_ABOVE_GROUND_M

    // Ovládá teď uživatel kameru myší (nebo dobíhá setrvačnost)? Jen tehdy se hlídají skoky —
    // přelety, minimapa a uložené pohledy kameru přenášejí daleko schválně.
    let pressed = 0, activeUntil = 0
    const canvas = scene.canvas
    const onDown = () => { pressed++; activeUntil = Infinity }
    const onUp = () => { if (pressed > 0) { pressed = 0; activeUntil = performance.now() + INERTIA_MS } }
    canvas.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    let last: { pos: Cesium.Cartesian3; dir: Cesium.Cartesian3; up: Cesium.Cartesian3; h: number } | null = null
    const ray = new Cesium.Ray(), carto = new Cesium.Cartographic()
    const onPostUpdate = () => {
      // kdo kameru drží přes lookAt (otáčení kolem bodu, snímkování), ten ji řídí sám
      if (!Cesium.Matrix4.equals(cam.transform, Cesium.Matrix4.IDENTITY)) { last = null; return }
      const maxH = crMaxHeight(scene)
      ssc.maximumZoomDistance = maxH
      const flying = !!(cam as unknown as { _currentFlight?: unknown })._currentFlight
      const c = Cesium.Cartographic.fromCartesian(cam.positionWC, ellipsoid, carto)
      if (!c) return

      // 3. skok během ovládání myší: přesun víc než dvojnásobek výšky, nebo výška ×3 / ÷3
      //    za jediný snímek — normální tah, zoom ani setrvačnost tolik nedají
      if (last && !flying && performance.now() < activeUntil) {
        const moved = Cesium.Cartesian3.distance(cam.positionWC, last.pos)
        const ratio = Math.max(c.height, 1) / Math.max(last.h, 1)
        if (moved > Math.max(2 * last.h, 2000) || ratio > 3 || ratio < 1 / 3) {
          cam.setView({ destination: last.pos, orientation: { direction: last.dir, up: last.up } })
          return
        }
      }

      let changed = false
      // 1. strop výšky (v pohledu shora bez perspektivy se oddaluje šířkou záběru, ne výškou)
      const f = cam.frustum
      if (f instanceof Cesium.OrthographicFrustum && (f.width ?? 0) > CR_W * 1000 * VIEW_MARGIN) {
        f.width = CR_W * 1000 * VIEW_MARGIN
        changed = true
      }
      if (c.height > maxH * 1.001) {
        c.height = maxH
        cam.position = Cesium.Cartographic.toCartesian(c, ellipsoid)
        changed = true
      }
      // …a podlaha: nejméně 2 m nad terénem (kde je terén načtený; jinak to pozná až za chvíli)
      const ground = scene.globe.getHeight(c)
      if (ground !== undefined && c.height < ground + MIN_ABOVE_GROUND_M) {
        c.height = ground + MIN_ABOVE_GROUND_M
        cam.position = Cesium.Cartographic.toCartesian(c, ellipsoid)
        changed = true
      }
      // 2. místo pohledu: průsečík osy kamery se zemí, nanejvýš 3× výška daleko (u pohledu
      //    k obzoru by průsečík ležel stovky km daleko a kamera by se kvůli němu vracela)
      if (!flying) {
        const h = Math.max(c.height, 50)
        Cesium.Cartesian3.clone(cam.positionWC, ray.origin)
        Cesium.Cartesian3.clone(cam.directionWC, ray.direction)
        const hit = Cesium.IntersectionTests.rayEllipsoid(ray, ellipsoid)
        const dist = hit ? Math.min(hit.start, 3 * h) : 3 * h
        const look = Cesium.Ray.getPoint(ray, dist, new Cesium.Cartesian3())
        const lc = Cesium.Cartographic.fromCartesian(look, ellipsoid)
        if (lc) {
          const q = clampToCr(Cesium.Math.toDegrees(lc.longitude), Cesium.Math.toDegrees(lc.latitude))
          if (q) {
            const to = Cesium.Cartesian3.fromDegrees(q[0], q[1], lc.height)
            const shift = Cesium.Cartesian3.subtract(to, look, new Cesium.Cartesian3())
            cam.position = Cesium.Cartesian3.add(cam.positionWC, shift, new Cesium.Cartesian3())
            changed = true
          }
        }
      }
      if (changed) scene.requestRender()
      const h = Cesium.Cartographic.fromCartesian(cam.positionWC, ellipsoid)?.height ?? c.height
      last = { pos: Cesium.Cartesian3.clone(cam.positionWC), dir: Cesium.Cartesian3.clone(cam.directionWC), up: Cesium.Cartesian3.clone(cam.upWC), h }
    }
    scene.postUpdate.addEventListener(onPostUpdate)
    return () => {
      scene.postUpdate.removeEventListener(onPostUpdate)
      canvas.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [viewerReady]) // eslint-disable-line react-hooks/exhaustive-deps
}
