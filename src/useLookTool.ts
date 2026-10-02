/**
 * Vzhled kamery — hloubka ostrosti a zorný úhel.
 *
 * Drží se pohromadě, protože jde o tutéž věc: jak scéna VYPADÁ, ne co v ní je. Obojí
 * se navíc mění při přeletu na uložený pohled, a to přes `lookAnimRef` — číslo, kterým si
 * kamera označí probíhající animaci. Kdo sáhne na vzhled ručně, ho zvýší a rozdělaný přechod
 * tím zruší; jinak by doběhl a přepsal, co jsi právě nastavil.
 */
import { useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { createCircleDofStage, type CircleDofUniforms } from './dofCircle'
import { viewCenterGround } from './sceneUtils'

export type LookTool = ReturnType<typeof useLookTool>

export function useLookTool(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
}) {
  const { viewerRef } = deps

  const [dofOn, setDofOn] = useState(false)
  // 'dist' = ostré je vše v dané vzdálenosti (vestavěná DOF), 'circle' = ostrý kruh uprostřed obrazovky
  const [dofMode, setDofMode] = useState<'dist' | 'circle'>('circle')
  const [dofFocal, setDofFocal] = useState(300)
  const [dofBlur, setDofBlur] = useState(2)
  const [dofRadius, setDofRadius] = useState(0.84)
  const [dofFeather, setDofFeather] = useState(0.7)
  const [fov, setFov] = useState(60)

  const dofRef = useRef<Cesium.PostProcessStageComposite | null>(null)
  const dofCircleRef = useRef<Cesium.PostProcessStageComposite | null>(null)

  const lookAnimRef = useRef(0)                        // totéž pro přechod vzhledu (FOV/DOF) při přeletu

  // ── DOF / FOV ──
  type DofCfg = { on: boolean; mode: 'dist' | 'circle'; focal: number; blur: number; radius: number; feather: number }
  /**
   * Přepošle nastavení do post-process stages. Bere jen změněné hodnoty (`applyDof({ radius })`),
   * zbytek se dočte ze současného stavu — setState je asynchronní, takže spoléhat na něj by
   * znamenalo použít o krok starou hodnotu.
   *
   * Stage se zakládají líně a jen ta, která se opravdu používá: každá si drží vlastní framebuffery,
   * takže vyrobit obě dopředu by stálo paměť i výkon zbytečně.
   */
  function applyDofRaw(c: DofCfg) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const wantDist = c.on && c.mode === 'dist'
    const wantCircle = c.on && c.mode === 'circle'

    if (wantDist && !dofRef.current) dofRef.current = v.scene.postProcessStages.add(Cesium.PostProcessStageLibrary.createDepthOfFieldStage()) as Cesium.PostProcessStageComposite
    if (dofRef.current) {
      dofRef.current.enabled = wantDist
      if (wantDist) {
        const u = dofRef.current.uniforms as { focalDistance: number; stepSize: number; sigma: number }
        u.focalDistance = c.focal; u.stepSize = c.blur; u.sigma = Math.max(1, c.blur)
      }
    }

    if (wantCircle && !dofCircleRef.current) dofCircleRef.current = v.scene.postProcessStages.add(createCircleDofStage()) as Cesium.PostProcessStageComposite
    if (dofCircleRef.current) {
      dofCircleRef.current.enabled = wantCircle
      if (wantCircle) {
        const u = dofCircleRef.current.uniforms as CircleDofUniforms
        u.radius = c.radius; u.feather = c.feather; u.stepSize = c.blur; u.sigma = Math.max(1, c.blur)
      }
    }
    v.scene.requestRender()
  }
  function applyFovRaw(deg: number) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const f = v.scene.camera.frustum
    if (f instanceof Cesium.PerspectiveFrustum) f.fov = Cesium.Math.toRadians(deg)
  }

  // Veřejné obálky pro ovládání: ruční sáhnutí na slider ZRUŠÍ běžící přechod vzhledu, jinak by
  // ho příští snímek animace hned přepsal. Animace proto sahá na *Raw, ovládání na tyhle.
  function applyDof(o: Partial<DofCfg>) {
    lookAnimRef.current++
    applyDofRaw({ on: dofOn, mode: dofMode, focal: dofFocal, blur: dofBlur, radius: dofRadius, feather: dofFeather, ...o })
  }
  function applyFov(deg: number) { lookAnimRef.current++; applyFovRaw(deg) }
  function dofFocusCenter() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const g = viewCenterGround(v)
    const dist = Math.round(Cesium.Cartesian3.distance(v.camera.positionWC, Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)))
    setDofFocal(dist); setDofOn(true); applyDof({ on: true, focal: dist })
  }
  return {
    applyDof,
    applyDofRaw,
    applyFov,
    applyFovRaw,
    dofBlur,
    dofFeather,
    dofFocal,
    dofFocusCenter,
    dofMode,
    dofOn,
    dofRadius,
    fov,
    lookAnimRef,
    setDofBlur,
    setDofFeather,
    setDofFocal,
    setDofMode,
    setDofOn,
    setDofRadius,
    setFov,
  }
}
