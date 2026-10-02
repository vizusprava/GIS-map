/**
 * Zvýraznění správního území — kraj, okres, obec i katastrální území.
 *
 * Okolí vybraného území se ztmaví plochou s dírou ve tvaru hranice, ne ořezem: díra jde
 * udělat z jednoho polygonu s vnitřními prstenci, kdežto ořez by musel řešit každou vrstvu
 * mapy zvlášť. Ztmavení se navíc dá plynule měnit, což se u ořezu nedá.
 *
 * Dvě věci si bere zvenku, protože nejsou jeho: klik do mapy (o ten se dělí s ostatními
 * nástroji) a rozbalovací nabídka hledání (do ní vypisuje nalezená území).
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { CR_EXTENT } from './config'
import { pickGround } from './sceneUtils'
import { wgsOf } from './tiles'
import { fetchAdminUnits, fetchAdminParts, fetchAdminGeom, type AdminUnit } from './katastr'

export type RegionTool = ReturnType<typeof useRegionTool>

/** viditelnost okolí z posuvníku (0 = černé, 1 = plné) → alfa překryvu */
const dimAlpha = (vis: number) => Math.min(1, Math.max(0, 1 - vis))

export function useRegionTool(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  /** ostatní nástroje pustí klik do mapy; území si ho bere */
  claimMapClick: (who: 'region' | 'none') => void
  /** kdo právě vlastní klik do mapy */
  clickOwner: string
  /** vybrané území vypne ostatní výběry (parcely, dlaždice) */
  exclusiveSelect: (keep: 'parcel' | 'tile' | 'region') => void
  clearPlaceHits: () => void
  setSearchOpen: (open: boolean) => void
}) {
  const { viewerRef, claimMapClick, clickOwner, exclusiveSelect, clearPlaceHits, setSearchOpen } = deps

  // odvozeno z vlastníka kliku, aby nemohlo odporovat ostatním nástrojům
  const regionMode = clickOwner === 'region'
  const setRegionMode = (on: boolean) => claimMapClick(on ? 'region' : 'none')
  const [regionBusy, setRegionBusy] = useState(false)
  const [regionChoices, setRegionChoices] = useState<AdminUnit[]>([])
  const [regionName, setRegionName] = useState<string | null>(null)
  const [regionDim, setRegionDim] = useState(0.2) // viditelnost okolí (0 = černé, 1 = plné)
  const [regionParts, setRegionParts] = useState<AdminUnit[]>([]) // katastrální území vybrané obce
  const regionEntsRef = useRef<Cesium.Entity[]>([])
  const regionDimEntRef = useRef<Cesium.Entity | null>(null)
  // barva překryvu okolí — čte ji CallbackProperty, posuvník mění jen alfu (viz drawRegionDim)
  const dimColorRef = useRef(new Cesium.Color(0, 0, 0, dimAlpha(regionDim)))
  const regionActiveRef = useRef<{ name: string; worldRings: Cesium.Cartesian3[][]; sjtskRings: [number, number][][] } | null>(null)
  const regionPrimsRef = useRef<Cesium.Primitive[]>([]) // hranice jako primitivy (vždy viditelné)

  // ── Zvýraznění správního území (kraj/okres/obec) ──────────────────────────────────────
  // klik na mapu → stáhne vnořené jednotky obsahující bod → nabídne je k výběru
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !regionMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction(async (evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) return
      setRegionBusy(true)
      try {
        const units = await fetchAdminUnits(g.lon, g.lat)
        setRegionParts([]); setRegionChoices(units); clearPlaceHits()
        // výsledky klikem chodí do TÉŽE nabídky jako výsledky hledání — jedno místo, kde se vybírá
        setSearchOpen(units.length > 0)
        if (!units.length) toast.info('Tady jsem žádné území nenašel')
      } catch (e) { console.error('Načtení území selhalo:', e); toast.error('Načtení území selhalo') }
      finally { setRegionBusy(false) }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [regionMode])

  function clearRegionEnts() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) {
      for (const e of regionEntsRef.current) v.entities.remove(e)
      if (regionDimEntRef.current) v.entities.remove(regionDimEntRef.current)
      for (const p of regionPrimsRef.current) v.scene.primitives.remove(p)
    }
    regionEntsRef.current = []; regionDimEntRef.current = null; regionPrimsRef.current = []
  }
  function clearRegion() {
    clearRegionEnts()
    regionActiveRef.current = null
    setRegionName(null); setRegionChoices([]); setRegionParts([])
  }
  /**
   * Tmavý překryv okolí (díra = území). Geometrie se staví jen při výběru území; posuvník mění
   * jen alfu barvy, kterou si plocha čte přes CallbackProperty — dávka pozemních ploch ji v Cesiu
   * přepíše bez nové triangulace. Dřív se překryv při každém posunu posuvníku stavěl znovu, a to
   * s hranicí kraje o desítkách tisíc bodů znamenalo trhaný posuvník a probliknutí mapy.
   */
  function drawRegionDim() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (regionDimEntRef.current) { v.entities.remove(regionDimEntRef.current); regionDimEntRef.current = null }
    const a = regionActiveRef.current
    if (!a) return
    const R = CR_EXTENT
    const outer = [
      Cesium.Cartesian3.fromRadians(R.west, R.south), Cesium.Cartesian3.fromRadians(R.east, R.south),
      Cesium.Cartesian3.fromRadians(R.east, R.north), Cesium.Cartesian3.fromRadians(R.west, R.north),
    ]
    const holes = a.worldRings.map(r => new Cesium.PolygonHierarchy(r))
    const color = new Cesium.CallbackProperty((_t, out) => Cesium.Color.clone(dimColorRef.current, out as Cesium.Color), false)
    regionDimEntRef.current = v.entities.add({
      show: dimColorRef.current.alpha > 0.01,
      polygon: { hierarchy: new Cesium.PolygonHierarchy(outer, holes), material: new Cesium.ColorMaterialProperty(color), classificationType: Cesium.ClassificationType.BOTH },
    })
  }
  useEffect(() => {
    const alpha = dimAlpha(regionDim)
    dimColorRef.current.alpha = alpha
    // úplně průhledné okolí se nekreslí vůbec (plocha přes celou ČR by jinak stála snímek zbytečně)
    if (regionDimEntRef.current) regionDimEntRef.current.show = alpha > 0.01
    const v = viewerRef.current
    if (v && !v.isDestroyed()) v.scene.requestRender()
  }, [regionDim])

  // vybere jednotku: dotáhne geometrii (líně), ztlumí okolí (překryv na globu) a přeletí na ni.
  // Bez viditelné hranice — území je dané tím, že okolí zšedne (uvnitř zůstane plná mapa).
  async function isolateRegion(u: AdminUnit) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    setRegionBusy(true)
    try {
      const rings = u.rings ?? await fetchAdminGeom(u.layer, u.kod)
      if (!rings.length) { toast.error('Území nemá geometrii'); return }
      if (v.isDestroyed()) return
      claimMapClick('region')   // ostatní nástroje pustit klik — území si ho bere
      exclusiveSelect('region') // území aktivní → zruš parcely/oblast/dlaždice (jen jeden zdroj naráz)
      clearRegionEnts()
      const worldRings = rings.map(r => r.map(([x, y]) => { const [lo, la] = wgsOf(x, y) as number[]; return Cesium.Cartesian3.fromDegrees(lo, la) }))
      regionActiveRef.current = { name: u.name, worldRings, sjtskRings: rings }
      drawRegionDim()
      setRegionName(u.name)
      // nabídku NEcháváme otevřenou → jde rovnou vybrat jinou část/jednotku
      const all = worldRings.flat()
      if (all.length) v.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(all), { duration: 1.2 })
    } catch (e) { console.error('Zobrazení území selhalo:', e); toast.error('Zobrazení území selhalo') }
    finally { setRegionBusy(false) }
  }

  // vypíše katastrální území (části) vybrané obce
  async function loadParts(obecKod: number) {
    setRegionBusy(true)
    try {
      const parts = await fetchAdminParts(obecKod)
      setRegionParts(parts)
      if (!parts.length) toast.info('Obec nemá další katastrální území')
    } catch (e) { console.error('Načtení částí selhalo:', e); toast.error('Načtení částí selhalo') }
    finally { setRegionBusy(false) }
  }

  /** Název → správní jednotky z RÚIAN. Katastrální území jdou zvlášť, bývá jich na jeden dotaz moc. */

  return {
    clearRegion,
    isolateRegion,
    loadParts,
    regionActiveRef,
    regionBusy,
    regionChoices,
    regionDim,
    regionMode,
    regionName,
    regionParts,
    setRegionBusy,
    setRegionChoices,
    setRegionDim,
    setRegionMode,
    setRegionParts,
  }
}
