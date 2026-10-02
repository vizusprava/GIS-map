/**
 * Městské části Liberce (katastrální území) jako „polární záře" stoupající od terénu.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { geoidN } from './geoid'
import { fetchElevSampler } from './elevation'
import { AURORA_HEIGHT_M, AURORA_LABEL_LIFT_M, AURORA_SINK_M, auroraMaterial, smoothClosedRing, fetchLiberecDistricts } from './districts'

export type DistrictsTool = ReturnType<typeof useDistricts>

export function useDistricts(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  /** klik do mapy nemá jiný nástroj (výběr parcel, oblasti, dlaždic, posun modelu) */
  clickFree: boolean
}) {
  const { viewerRef, clickFree } = deps

  // městské části Liberce (katastrální území) se zářícím obrysem
  const [districtsOn, setDistrictsOn] = useState(false)
  const [districtsLoading, setDistrictsLoading] = useState(false)
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null)
  const districtsRef = useRef<Map<string, { name: string; color: Cesium.Color; rings: Cesium.Cartesian3[][]; ents: Cesium.Entity[]; prims: Cesium.Primitive[] }>>(new Map())

  // městské části Liberce (k.ú.) jako „polární záře" stoupající od terénu, každá vlastní barva; zap/vyp
  async function toggleDistricts() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (districtsOn) {
      for (const d of districtsRef.current.values()) {
        d.ents.forEach(e => v.entities.remove(e))
        d.prims.forEach(p => v.scene.primitives.remove(p))
      }
      districtsRef.current.clear()
      setSelectedDistrict(null)
      setDistrictsOn(false)
      return
    }
    setDistrictsLoading(true)
    try {
      const list = await fetchLiberecDistricts()
      if (v.isDestroyed()) return
      // výšky terénu z jednoho DMR snímku přes celý Liberec (1 request pro všechny části)
      let ground: (lon: number, lat: number) => number
      try {
        const sampler = await fetchElevSampler('dmr5g', 14.94, 50.68, 15.15, 50.83, 2048)
        ground = (lon, lat) => { const e = sampler(lon, lat); return (e != null ? e : 350) + geoidN(lon, lat) }
      } catch { ground = (lon, lat) => 350 + geoidN(lon, lat) } // fallback: cca výška Liberce
      if (v.isDestroyed()) return

      const COS = Math.cos(50.77 * Math.PI / 180)
      list.forEach((d, i) => {
        const color = Cesium.Color.fromHsl(i / list.length, 0.85, 0.55) // vlastní barva pro každou část
        const phase = i * 0.9
        const ents: Cesium.Entity[] = []
        const prims: Cesium.Primitive[] = []
        for (const ring of d.rings) {
          const lonlat = ring.map(c => { const cc = Cesium.Cartographic.fromCartesian(c); return [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)] as [number, number] })
          // decimace obrysu na ~70 m, pak Catmull-Rom spline → plynulá „splinová" stěna bez tvrdých rohů
          const dec: [number, number][] = []
          let last: [number, number] | null = null
          for (const p of lonlat) {
            if (!last) { dec.push(p); last = p; continue }
            if (Math.hypot((p[0] - last[0]) * 111320 * COS, (p[1] - last[1]) * 111320) >= 70) { dec.push(p); last = p }
          }
          if (dec.length < 3) continue
          const smooth = smoothClosedRing(dec, 10)
          const closed = [...smooth, smooth[0]]
          const baseH = closed.map(([lo, la]) => ground(lo, la))
          const positions = closed.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la))
          // stěna „polární záře" jako primitiv se shaderovým materiálem (vlnění + fade, GPU)
          const geom = new Cesium.WallGeometry({
            positions,
            minimumHeights: baseH.map(h => h - AURORA_SINK_M), // zapuštěno pod terén, ať nikde nefloatuje
            maximumHeights: baseH.map(h => h + AURORA_HEIGHT_M),
            vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          })
          const prim = new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({ geometry: geom }),
            appearance: new Cesium.MaterialAppearance({ material: auroraMaterial(color, phase), translucent: true, flat: true, faceForward: false }),
            asynchronous: false,
          })
          v.scene.primitives.add(prim)
          prims.push(prim)
          // tenká ostrá linka na terénu pro definici hranice (plná detailní geometrie)
          ents.push(v.entities.add({
            polyline: { positions: [...ring, ring[0]], width: 2.5, clampToGround: true, material: color },
          }))
          // jemná výplň (kvůli kliknutí + lehkému zabarvení plochy)
          ents.push(v.entities.add({
            polygon: { hierarchy: new Cesium.PolygonHierarchy(ring), material: color.withAlpha(0.05), classificationType: Cesium.ClassificationType.BOTH },
          }))
        }
        // popisek letí ve vzduchu nad září (nad terénem, ne na výšce 0)
        const big = d.rings.reduce((a, b) => (b.length > a.length ? b : a))
        const bigLL = big.map(c => Cesium.Cartographic.fromCartesian(c))
        const clon = Cesium.Math.toDegrees(bigLL.reduce((s, c) => s + c.longitude, 0) / bigLL.length)
        const clat = Cesium.Math.toDegrees(bigLL.reduce((s, c) => s + c.latitude, 0) / bigLL.length)
        const labelPos = Cesium.Cartesian3.fromDegrees(clon, clat, ground(clon, clat) + AURORA_HEIGHT_M + AURORA_LABEL_LIFT_M)
        ents.push(v.entities.add({
          position: labelPos,
          label: {
            text: d.name, font: 'bold 13px sans-serif', fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(3000, 1.15, 80000, 0.4),
            translucencyByDistance: new Cesium.NearFarScalar(70000, 1.0, 130000, 0.0),
          },
          point: { pixelSize: 5, color, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        }))
        for (const e of ents) (e as unknown as { __district: string }).__district = d.code
        districtsRef.current.set(d.code, { name: d.name, color, rings: d.rings, ents, prims })
      })
      setDistrictsOn(true)
    } finally { setDistrictsLoading(false) }
  }

  // zvýrazní vybranou městskou část (silnější výplň) + přiletí na ni kamerou
  function selectDistrict(code: string) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    setSelectedDistrict(code)
    for (const [c, d] of districtsRef.current) {
      const alpha = c === code ? 0.22 : 0.05
      for (const e of d.ents) if (e.polygon) e.polygon.material = new Cesium.ColorMaterialProperty(d.color.withAlpha(alpha))
    }
    const d = districtsRef.current.get(code)
    if (d) v.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(d.rings.flat()), { duration: 1.0 })
  }

  // klik na městskou část ji vybere (jen když je vrstva zapnutá a nejsme v jiném klikacím režimu)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !districtsOn || !clickFree) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = v.scene.pick(evt.position) as { id?: { __district?: string } } | undefined
      const code = picked?.id?.__district
      if (code) selectDistrict(code)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [districtsOn, clickFree])

  return {
    districtsLoading,
    districtsOn,
    districtsRef,
    selectDistrict,
    selectedDistrict,
    toggleDistricts,
  }
}
