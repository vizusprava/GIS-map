/**
 * Česká republika v Google 3D: dlaždice pokrývají celý svět, takže okolí se ztmaví a hranice se
 * protáhne svítící čarou — je hned vidět, kde končí území, se kterým appka pracuje (podklady,
 * katastr i terén ČÚZK jsou jen pro ČR). V podkladech ČÚZK to netřeba: mimo ČR není nic.
 *
 * Ztmavení je polygon s dírou ve tvaru republiky, přilepený na 3D dlaždice (klasifikace), čára
 * hranice taky — obojí jde po dlaždicích, ne v rovině nad nimi.
 */
import { useEffect } from 'react'
import * as Cesium from 'cesium'
import { CR_BORDER } from './crBorder'

/** jak moc ztmavit okolí republiky (0 = vůbec, 1 = černé) */
const DIM_ALPHA = 0.55
/** okolí, které se ztmaví — tak velké, aby ho kamera z největší povolené výšky nepřesáhla */
const OUTER = [4, 43, 28, 57] as const

export function useCrHighlight(deps: { viewerRef: React.RefObject<Cesium.Viewer | null>; viewerReady: boolean; on: boolean }) {
  const { viewerRef, viewerReady, on } = deps
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !viewerReady || !on) return
    const border = Cesium.Cartesian3.fromDegreesArray([...CR_BORDER])
    const [w, s, e, n] = OUTER
    const outer = Cesium.Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n])
    const dim = v.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outer, [new Cesium.PolygonHierarchy(border)]),
        material: Cesium.Color.BLACK.withAlpha(DIM_ALPHA),
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      },
    })
    const line = v.entities.add({
      polyline: {
        positions: [...border, border[0]],
        clampToGround: true,
        width: 6,
        material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.3, color: Cesium.Color.fromCssColorString('#38bdf8') }),
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      },
    })
    return () => {
      if (v.isDestroyed()) return
      v.entities.remove(dim)
      v.entities.remove(line)
    }
  }, [viewerReady, on]) // eslint-disable-line react-hooks/exhaustive-deps
}
