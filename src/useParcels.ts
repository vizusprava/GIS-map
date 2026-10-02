/**
 * Výběr parcel z katastru — klikem po jedné i obtažením oblasti — jejich zvýraznění v mapě
 * a kóty stran s výměrou.
 *
 * Ořez a ztlumení okolí podle výběru řeší `useMapLayers`; tenhle hook mu jen hlásí, že se
 * výběr změnil (`onSelectionChange`) nebo zmizel (`onCleared`).
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { pickGround } from './sceneUtils'
import { wgsOf } from './tiles'
import { toolTheme } from './toolColors'
import { pointInRing, ringCentroid } from './rings'
import { MEASURE_MAX_EDGES, MEASURE_MIN_EDGE, measureRing, fmtArea, type ParcelMeasure } from './measure'
import { fetchParcelAt, fetchParcelsInBbox, kuNames, parcelIskns, splitParcelId } from './katastr'
import { fetchElevSampler } from './elevation'
import { geoidN } from './geoid'
import type { MapClickOwner, Parcel, ParcelEntry, SceneObj } from './types'
import type { SavedParcel } from './lib/types'
import type { ScenePersist } from './lib/scenePersist'

// barvy nástrojů v mapě — nastavují se v toolColors.ts
const PARCEL_COLOR = Cesium.Color.fromCssColorString(toolTheme('parcel').map)
const AREA_COLOR = Cesium.Color.fromCssColorString(toolTheme('area').map)

export type ParcelsTool = ReturnType<typeof useParcels>

export function useParcels(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  sceneRef: React.RefObject<ScenePersist>
  parcelMode: boolean
  areaMode: boolean
  upsertObj: (o: SceneObj) => void
  removeObj: (id: string) => void
  releaseMapClick: (who: MapClickOwner) => void
  /** výběr se změnil — ořez a ztlumení okolí ho sledují */
  onSelectionChange: () => void
  /** výběr je celý pryč */
  onCleared: () => void
}) {
  const { viewerRef, sceneRef, parcelMode, areaMode, upsertObj, removeObj, releaseMapClick, onSelectionChange, onCleared } = deps

  // multi-parcela: vybrané parcely (klíč = id parcely)
  // `label` = číslo parcely z KN; drží se tady, aby šel výběr uložit do scény a obnovit i s popisem
  const parcelsRef = useRef<Map<string, ParcelEntry>>(new Map())
  // popisky měření (kóty stran + výměra) po parcelách — mimo p.ents, ať jdou zhasnout zvlášť od zvýraznění
  const measureRef = useRef<Map<string, Cesium.Entity[]>>(new Map())
  const [parcelHl, setParcelHl] = useState(true) // zvýraznění (tyrkys výplň+obrys) vybraných parcel
  const [parcelMeasure, setParcelMeasure] = useState(false) // kóty délek u stran + výměra uprostřed parcely
  // area = součet výměr z KN, mapArea = součet spočítaný z geometrie mapy
  const [measureSum, setMeasureSum] = useState<{ area: number; mapArea: number; note: string }>({ area: 0, mapArea: 0, note: '' })
  const [parcelLoading, setParcelLoading] = useState(false)
  const [parcelCount, setParcelCount] = useState(0)
  // výběr oblasti: naklikat body → vybrat všechny parcely uvnitř polygonu
  const [areaPtCount, setAreaPtCount] = useState(0)
  const [areaLoading, setAreaLoading] = useState(false)
  const areaPtsRef = useRef<Cesium.Cartesian3[]>([])
  const areaEntsRef = useRef<Cesium.Entity[]>([])

  // režim výběru parcely: klik → načti obrys z katastru a vykresli polygon
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !parcelMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction(async (evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) return
      setParcelLoading(true)
      try {
        const parcel = await fetchParcelAt(g.lon, g.lat)
        if (parcel) toggleParcelSel(parcel)
        else toast.info('Tady katastr žádnou parcelu nevede')
      } catch (e) {
        console.error('Načtení parcely selhalo:', e)
        toast.error('Katastr ČÚZK neodpověděl — zkus to za chvíli znovu')
      } finally {
        setParcelLoading(false)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [parcelMode])

  // režim výběru oblasti: každý klik přidá vrchol; polygon se dokreslí a po potvrzení vybere parcely uvnitř
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !areaMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) return
      const pos = Cesium.Cartesian3.fromDegrees(g.lon, g.lat)
      areaPtsRef.current.push(pos)
      // bod — přichycený k terénu (jinak by seděl na elipsoidu = výšce 0 a při šikmém pohledu se promítl jinam)
      areaEntsRef.current.push(v.entities.add({
        position: pos,
        point: { pixelSize: 9, color: AREA_COLOR, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }))
      // výplň polygonu (od 3 bodů) — CallbackProperty ať se překresluje
      if (areaPtsRef.current.length === 3) {
        areaEntsRef.current.push(v.entities.add({
          polygon: {
            hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy(areaPtsRef.current), false),
            material: AREA_COLOR.withAlpha(0.15),
            classificationType: Cesium.ClassificationType.BOTH,
          },
          polyline: {
            positions: new Cesium.CallbackProperty(() => [...areaPtsRef.current, areaPtsRef.current[0]], false),
            width: 2, material: AREA_COLOR, clampToGround: true,
          },
        }))
      }
      setAreaPtCount(areaPtsRef.current.length)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [areaMode])

  function clearArea() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) areaEntsRef.current.forEach(e => v.entities.remove(e))
    areaEntsRef.current = []
    areaPtsRef.current = []
    setAreaPtCount(0)
  }

  // potvrdí oblast: stáhne parcely v bboxu a vybere ty, jejichž těžiště leží uvnitř nakresleného polygonu
  /** Obrys nakreslené oblasti jako lon/lat dvojice. */
  function areaPolyLL(): number[][] | null {
    const pts = areaPtsRef.current
    if (pts.length < 3) return null
    return pts.map(c => {
      const cc = Cesium.Cartographic.fromCartesian(c)
      return [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)]
    })
  }

  async function finalizeArea() {
    const pts = areaPtsRef.current
    if (pts.length < 3) return
    const poly = pts.map(c => {
      const cc = Cesium.Cartographic.fromCartesian(c)
      return [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)]
    })
    const lons = poly.map(p => p[0]); const lats = poly.map(p => p[1])
    const minLon = Math.min(...lons), maxLon = Math.max(...lons)
    const minLat = Math.min(...lats), maxLat = Math.max(...lats)
    setAreaLoading(true)
    try {
      const parcels = await fetchParcelsInBbox(minLon, minLat, maxLon, maxLat)
      for (const parcel of parcels) {
        // těžiště počítáme v S-JTSK a reprojektujeme jen ten jeden bod (levné)
        const [cx, cy] = ringCentroid(parcel.ring)
        const [clon, clat] = wgsOf(cx, cy)
        if (!pointInRing(clon, clat, poly)) continue
        // vybraná parcela → teprve teď reprojektuj celou geometrii (vnější prstenec i díry)
        const toCart = (r: number[][]) => r.map(([x, y]) => {
          const [lo, la] = wgsOf(x, y)
          return Cesium.Cartesian3.fromDegrees(lo, la)
        })
        addParcelSel({
          id: parcel.id, label: parcel.label, knArea: parcel.knArea, iskn: parcel.iskn, ku: parcel.ku,
          positions: toCart(parcel.ring), holes: parcel.holes.map(toCart),
        })
      }
    } finally {
      setAreaLoading(false)
      clearArea()
      releaseMapClick('area')
    }
  }

  // klik na parcelu ji přidá do výběru; klik na už vybranou ji odebere (multi)
  function toggleParcelSel(parcel: Parcel) {
    const pid = parcel.id || `p${Math.round(parcel.positions[0].x)}_${Math.round(parcel.positions[0].y)}`
    if (parcelsRef.current.has(pid)) { removeParcel(pid); return }
    addParcelSel(parcel)
  }

  // přidá parcelu do výběru (bez toggle) — sdílené klikem i výběrem oblasti.
  // `save: false` = obnova ze scény: parcely tam už jsou, zapisovat je zpátky nemá cenu.
  function addParcelSel(parcel: Parcel, save = true) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const pid = parcel.id || `p${Math.round(parcel.positions[0].x)}_${Math.round(parcel.positions[0].y)}`
    if (parcelsRef.current.has(pid)) return
    const toRing = (cs: Cesium.Cartesian3[]) => cs.map(c => {
      const cc = Cesium.Cartographic.fromCartesian(c)
      return [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)]
    })
    const ring = toRing(parcel.positions)
    const holeCarts = parcel.holes ?? []
    const holes = holeCarts.map(toRing)
    const fill = v.entities.add({
      show: parcelHl,
      // díry v hierarchii → zvýraznění nepřekryje vykrojené parcely uvnitř (a lícuje s výměrou)
      polygon: { hierarchy: new Cesium.PolygonHierarchy(parcel.positions, holeCarts.map(h => new Cesium.PolygonHierarchy(h))), material: PARCEL_COLOR.withAlpha(0.25), classificationType: Cesium.ClassificationType.BOTH },
    })
    const border = v.entities.add({
      show: parcelHl,
      polyline: { positions: [...parcel.positions, parcel.positions[0]], width: 3, material: PARCEL_COLOR, clampToGround: true },
    })
    // obrys i kolem děr, ať je vidět, co je z parcely vykrojené
    const holeBorders = holeCarts.map(h => v.entities.add({
      show: parcelHl,
      polyline: { positions: [...h, h[0]], width: 2, material: PARCEL_COLOR.withAlpha(0.7), clampToGround: true },
    }))
    parcelsRef.current.set(pid, { positions: parcel.positions, ring, holes, knArea: parcel.knArea ?? 0, label: parcel.label ?? '', iskn: parcel.iskn, ku: parcel.ku, ents: [fill, border, ...holeBorders] })
    upsertObj({ id: `parcel-${pid}`, kind: 'parcel', name: `Parcela ${parcel.label || parcel.id || ''}`.trim(), visible: true })
    setParcelCount(parcelsRef.current.size)
    if (save) saveParcels()
    onSelectionChange() // ořez i ztlumení sledují výběr parcel
  }

  /**
   * Uloží vybrané parcely do scény — prstence v lon/lat, ať se po otevření nemusí znovu ptát
   * katastru (a výběr vydrží i to, že je ČÚZK zrovna nedostupný).
   */
  function saveParcels() {
    const list: SavedParcel[] = [...parcelsRef.current.entries()].map(([pid, p]) => ({
      pid, label: p.label, knArea: p.knArea,
      ...(p.iskn ? { iskn: p.iskn } : {}), ...(p.ku ? { ku: p.ku } : {}),
      ring: p.ring as [number, number][],
      holes: p.holes as [number, number][][],
    }))
    sceneRef.current.patchState({ parcels: list })
  }

  /** Vrátí uložené parcely zpátky do mapy (při otevření scény). */
  function restoreParcels(list: SavedParcel[]) {
    const toCart = (r: [number, number][]) => r.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la))
    for (const p of list) {
      if (!p.ring?.length) continue
      addParcelSel({ id: p.pid, label: p.label, knArea: p.knArea, iskn: p.iskn, ku: p.ku, positions: toCart(p.ring), holes: (p.holes ?? []).map(toCart) }, false)
    }
  }

  /**
   * Parcely uložené dřív, než se k nim ukládal název k.ú. a identifikátor v katastru, si je
   * dohledají v RÚIAN (nové je mají rovnou z WFS). Jen do paměti — ukládat odvoditelný údaj
   * do scény nemá cenu. Každá parcela se zkouší jednou, i kdyby ji RÚIAN neznal.
   */
  const [, setInfoVer] = useState(0)
  const enrichTriedRef = useRef(new Set<string>())
  useEffect(() => {
    const missing = [...parcelsRef.current.entries()].filter(([pid, p]) => (!p.iskn || !p.ku) && !enrichTriedRef.current.has(pid))
    if (!missing.length) return
    for (const [pid] of missing) enrichTriedRef.current.add(pid)
    void (async () => {
      try {
        const codes = missing.flatMap(([pid]) => { const sp = splitParcelId(pid); return sp ? [sp.kuKod] : [] })
        const [names, iskns] = await Promise.all([
          codes.length ? kuNames(codes) : new Map<number, string>(),
          parcelIskns(missing.filter(([, p]) => !p.iskn).map(([pid]) => pid)),
        ])
        let changed = false
        for (const [pid] of missing) {
          const cur = parcelsRef.current.get(pid)
          if (!cur) continue
          const kod = splitParcelId(pid)?.kuKod
          if (!cur.ku && kod != null && names.has(kod)) { cur.ku = names.get(kod); changed = true }
          if (!cur.iskn && iskns.has(pid)) { cur.iskn = iskns.get(pid); changed = true }
        }
        if (changed) setInfoVer(v => v + 1) // překreslit seznam parcel v panelu
      } catch (e) { console.warn('Doplnění údajů parcel z RÚIAN selhalo:', e) }
    })()
  }, [parcelCount])

  /**
   * Přelet kolmo nad parcelu. Její body leží na elipsoidu, takže výška terénu se vezme z načtené
   * dlaždice, a když tam ještě není, z ČÚZK (Bpv + kvazigeoid) — jinak by kamera skončila pod zemí.
   */
  async function flyToParcel(pid: string) {
    const v = viewerRef.current
    const p = parcelsRef.current.get(pid)
    if (!v || v.isDestroyed() || !p?.ring.length) return
    const lons = p.ring.map(r => r[0]), lats = p.ring.map(r => r[1])
    const w = Math.min(...lons), e = Math.max(...lons), s = Math.min(...lats), n = Math.max(...lats)
    const lon = (w + e) / 2, lat = (s + n) / 2
    const diag = Cesium.Cartesian3.distance(Cesium.Cartesian3.fromDegrees(w, s), Cesium.Cartesian3.fromDegrees(e, n))
    let ground = v.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat))
    if (ground == null) {
      try {
        const at = await fetchElevSampler('dmr5g', w, s, e, n, 3)
        const h = at(lon, lat)
        if (h != null) ground = h + geoidN(lon, lat)
      } catch { /* bez výšky se letí výš, viz níž */ }
    }
    if (v.isDestroyed()) return
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, (ground ?? 600) + Math.max(120, diag * 1.8)),
      orientation: { heading: v.camera.heading, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 1.2,
    })
  }

  function removeParcel(pid: string) {
    const v = viewerRef.current
    const p = parcelsRef.current.get(pid)
    if (p && v && !v.isDestroyed()) p.ents.forEach(e => v.entities.remove(e))
    parcelsRef.current.delete(pid)
    removeObj(`parcel-${pid}`)
    setParcelCount(parcelsRef.current.size)
    saveParcels()
    onSelectionChange()
  }

  function clearAllParcels() {
    for (const pid of [...parcelsRef.current.keys()]) removeParcel(pid)
    onCleared() // vypni ořez i ztlumení (effect přepočítá)
  }

  // zap/vyp tyrkysové zvýraznění vybraných parcel (výběr i ořez/ztlumení zůstávají) → koukat „načisto"
  function toggleParcelHighlight() {
    const nv = !parcelHl
    for (const p of parcelsRef.current.values()) for (const e of p.ents) e.show = nv && !p.hidden
    setParcelHl(nv)
  }

  // ── Měření vybraných parcel ─────────────────────────────────────────────────────
  // Kóta (délka v m) u každé strany + výměra uprostřed parcely. Staví se znovu při každé
  // změně výběru — parcel bývají desítky, takže je levnější přepočítat než udržovat diff.
  function clearMeasure() {
    const v = viewerRef.current
    for (const ents of measureRef.current.values()) if (v && !v.isDestroyed()) for (const e of ents) v.entities.remove(e)
    measureRef.current.clear()
  }

  function redrawMeasure() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    clearMeasure()
    if (!parcelMeasure) { setMeasureSum({ area: 0, mapArea: 0, note: '' }); return }

    const measured: Array<{ pid: string; show: boolean; kn: number; m: ParcelMeasure }> = []
    let edgeCount = 0, areaSum = 0, knSum = 0
    for (const [pid, p] of parcelsRef.current) {
      const m = measureRing(p.ring, p.holes)
      if (!m) continue
      measured.push({ pid, show: !p.hidden, kn: p.knArea, m })
      edgeCount += m.edges.filter(e => e.len >= MEASURE_MIN_EDGE).length
      areaSum += m.area
      knSum += p.knArea || m.area // parcela bez údaje z KN (starší cache) → aspoň nezkreslí součet
    }
    // u velkých výběrů se kóty stran stejně slijí → vypustíme je, výměry zůstanou
    const withEdges = edgeCount <= MEASURE_MAX_EDGES
    setMeasureSum({ area: knSum, mapArea: areaSum, note: withEdges ? '' : `${edgeCount} stran — kóty skryté, zůstaly jen výměry` })

    const lbl = (extra: Partial<Cesium.LabelGraphics.ConstructorOptions>): Cesium.LabelGraphics.ConstructorOptions => ({
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      ...extra,
    })

    for (const { pid, show, kn, m } of measured) {
      const ents: Cesium.Entity[] = []
      if (withEdges) {
        for (const e of m.edges) {
          if (e.len < MEASURE_MIN_EDGE) continue
          ents.push(v.entities.add({
            show,
            position: Cesium.Cartesian3.fromDegrees(e.mid[0], e.mid[1]),
            label: lbl({
              text: `${e.len.toFixed(2)} m`,
              font: 'bold 15px monospace',
              outlineWidth: 4,
              // mírné zmenšení s odstupem (dřív 0.55 na 2 km — kóty byly z výšky nečitelné)
              scaleByDistance: new Cesium.NearFarScalar(400, 1.0, 4000, 0.8),
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4000), // z dálky by to byla jen kaše
            }),
          }))
        }
      }
      // Hlavní číslo = výměra ZAPSANÁ v KN (sedne na ikatastr a na list vlastnictví).
      // Pod ním malým z mapy — to lícuje s kótami po obvodu a s DXF exportem. V územích
      // s mapou 1:2880 se ta dvě čísla liší o jednotky procent a je fér vidět obojí.
      const areaPos = Cesium.Cartesian3.fromDegrees(m.label[0], m.label[1])
      ents.push(v.entities.add({
        show,
        position: areaPos,
        label: lbl({
          text: fmtArea(kn || m.area),
          font: 'bold 14px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#7dffb2'),
          outlineWidth: 4,
          scaleByDistance: new Cesium.NearFarScalar(400, 1.0, 12000, 0.5),
        }),
      }))
      // druhý řádek jen když se od KN opravdu liší (jinak by tam stálo dvakrát totéž)
      if (kn > 0 && Math.abs(m.area - kn) >= 1) {
        ents.push(v.entities.add({
          show,
          position: areaPos,
          label: lbl({
            text: `z mapy ${fmtArea(m.area)}`,
            font: '11px sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#cfd8dc'),
            pixelOffset: new Cesium.Cartesian2(0, 15),
            scaleByDistance: new Cesium.NearFarScalar(400, 1.0, 12000, 0.5),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000),
          }),
        }))
      }
      measureRef.current.set(pid, ents)
    }
  }

  // měření sleduje přepínač i každou změnu výběru (parcelCount se mění při add/remove)
  useEffect(() => { redrawMeasure() }, [parcelMeasure, parcelCount])

  /** Zap/vyp jedné parcely z panelu Scéna — zvýraznění i její kóty. */
  function setParcelVisible(pid: string, vis: boolean) {
    const p = parcelsRef.current.get(pid)
    if (p) { p.hidden = !vis; p.ents.forEach(en => { en.show = vis && parcelHl }) }
    measureRef.current.get(pid)?.forEach(en => { en.show = vis })
  }

  return {
    addParcelSel,
    areaLoading,
    areaPolyLL,
    areaPtCount,
    clearAllParcels,
    clearArea,
    finalizeArea,
    flyToParcel,
    measureSum,
    parcelCount,
    parcelHl,
    parcelLoading,
    parcelMeasure,
    parcelsRef,
    removeParcel,
    restoreParcels,
    setParcelMeasure,
    setParcelVisible,
    toggleParcelHighlight,
  }
}
