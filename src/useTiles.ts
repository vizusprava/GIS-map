/**
 * Výběr dlaždic (čtverce v mřížce S-JTSK) — klikem, tahem, oblastí nebo celým územím — jejich
 * zvýraznění v mapě a mřížka s názvy přes viditelnou oblast.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { AREA_TILES_CONFIRM, AREA_TILES_MAX } from './config'
import { toolTheme } from './toolColors'
import { TILE_SIZES, type TileSize, type Tile, tileKey, tileAt, tileRingLL, wgsOf, sjtskOf } from './tiles'
import { tilesInShape } from './export/mapTiles'
import { pickTerrain } from './sceneUtils'
import type { MapClickOwner } from './types'
import type { ScenePersist } from './lib/scenePersist'
import type { RegionTool } from './useRegionTool'

/** barva dlaždic v mapě — nastavuje se v toolColors.ts */
const TILE_COLOR = Cesium.Color.fromCssColorString(toolTheme('tiles').map)

export type TilesTool = ReturnType<typeof useTiles>

export function useTiles(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  viewerReady: boolean
  sceneRef: React.RefObject<ScenePersist>
  tileMode: boolean
  claimMapClick: (owner: MapClickOwner) => void
  setClickOwner: React.Dispatch<React.SetStateAction<MapClickOwner>>
  /** jen jeden zdroj výběru naráz (parcely × dlaždice × území) */
  exclusiveSelect: (keep: 'parcel' | 'tile' | 'region') => void
  /** obrys nakreslené oblasti (výběr parcel ho kreslí) */
  areaPolyLL: () => number[][] | null
  region: Pick<RegionTool, 'regionActiveRef'>
}) {
  const { viewerRef, viewerReady, sceneRef, tileMode, claimMapClick, setClickOwner, exclusiveSelect, areaPolyLL, region } = deps
  const scene = sceneRef.current // jen uložený výběr při otevření

  const [tileSize, setTileSize] = useState<TileSize>(1000)
  const [tileCount, setTileCount] = useState(0)
  // Dlaždice drží jen data. Vykreslují se dávkově do dvou primitivů (viz rebuildTileGfx) — dřív
  // to byly dvě Cesium entity NA DLAŽDICI, což při výběru celého okresu znamená tisíce entit
  // a appka se zadrhne. Primitiva zvládnou tentýž počet v jednom vykreslovacím volání.
  const tilesRef = useRef<Map<string, Tile>>(new Map())
  const tileFillRef = useRef<Cesium.GroundPrimitive | null>(null)
  const tileEdgeRef = useRef<Cesium.GroundPolylinePrimitive | null>(null)
  const tileGfxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // mřížka dlaždic přes viditelnou oblast (jako kladení listů na ČÚZK) — zap/vyp overlay s názvy
  const [gridOn, setGridOn] = useState(false)
  const [gridNote, setGridNote] = useState('')
  const gridEntsRef = useRef<Cesium.Entity[]>([])
  const gridLabelsRef = useRef<Cesium.LabelCollection | null>(null)
  const gridKeyRef = useRef('') // co je teď nakreslené (velikost + rozsah buněk) — viz redrawGrid

  /**
   * Dlaždice uvnitř nakreslené oblasti — druhé využití téhož obrysu, kterým se berou parcely.
   *
   * Celý test běží v S-JTSK, ne ve WGS84: mřížka dlaždic je na Křovák zarovnaná, takže tam jsou
   * dlaždice skutečné čtverce a stačí spočítat rozsah indexů. Reprojektuje se jen obrys oblasti
   * (pár bodů) místo každé dlaždice zvlášť — u stovek dlaždic je to znát.
   *
   * Bere se dlaždice, jejíž STŘED padne dovnitř. Okrajové, ze kterých oblast ukrajuje jen roh,
   * tak vypadnou — jinak by výběr přetekl přes nakreslenou hranici na všechny strany.
   */
  /**
   * Dlaždice, jejichž STŘED padne do některého z prstenců (S-JTSK). Sdílené jádro pro obrys
   * nakreslený rukou i pro hranici správního území.
   *
   * Okrajové dlaždice, ze kterých tvar ukrajuje jen roh, vypadnou — jinak by výběr přetekl přes
   * hranici na všechny strany a člověk by dostal víc, než ukázal.
   */
  const tilesInRings = (rings: number[][][], size: number) =>
    tilesInShape(rings, size, 'center', AREA_TILES_MAX)

  /** Společné dokončení hromadného výběru — ptaní se u velkých počtů, zapnutí režimu, hláška. */
  function applyBulkTiles(res: Tile[] | 'too-many', what: string, keepExisting: boolean): void {
    if (res === 'too-many') {
      toast.error(`${what} pokrývá přes ${AREA_TILES_MAX} dlaždic. Přepni na větší dlaždici.`)
      return
    }
    if (!res.length) { toast.info(`Uvnitř (${what.toLowerCase()}) nepadl střed žádné dlaždice — zkus větší tvar nebo menší dlaždici.`); return }
    if (res.length > AREA_TILES_CONFIRM && !confirm(`${what} pokrývá ${res.length} dlaždic. Přidat je všechny?`)) return

    claimMapClick('tile')
    if (!keepExisting) exclusiveSelect('tile') // nový zdroj výběru → parcely pryč
    for (const t of res) setTileSelected(t, true)
    setClickOwner('tile')
    toast.success(`Přidáno ${res.length} dlaždic (celkem ${tilesRef.current.size})`)
  }

  function finalizeAreaTiles() {
    const ll = areaPolyLL()
    if (!ll) return
    // pozor na pořadí: `claimMapClick` uvnitř applyBulkTiles obrys zahodí, tady už ho máme spočítaný
    const poly = ll.map(([lon, lat]) => sjtskOf(lon, lat) as number[])
    applyBulkTiles(tilesInRings([poly], tileSize), 'Oblast', false)
  }

  /**
   * Vyplní dlaždicemi právě zvýrazněné správní území. Víc území se SČÍTÁ — proto `keepExisting`
   * a proto `exclusiveSelect('region')` níž dlaždice neruší: kraj se do nich zrovna převádí.
   */
  function addRegionTiles() {
    const a = region.regionActiveRef.current
    if (!a) { toast.info('Nejdřív vyber území ve vyhledávání nahoře'); return }
    applyBulkTiles(tilesInRings(a.sjtskRings, tileSize), `Území ${a.name}`, true)
  }

  // ── výběr dlaždic: klik přepne jednu, tažení „maluje" přes víc ──
  // Směr celého tahu určí první dlaždice (na vybranou = odebírám, na prázdnou = přidávám),
  // takže stejným gestem jde i mazat. Kamera se při tahu vypne, jinak by mapa ujížděla.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !tileMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    let painting = false
    let adding = true
    const stroke = new Set<string>()  // co už tenhle tah řešil — ať to netluče sem a tam
    let lastPx: Cesium.Cartesian2 | null = null

    // Levé tlačítko si bere malování, jenže tím Cesiu bereme otáčení mapy — bez tohohle by
    // v režimu dlaždic nešlo popojet. Posun tedy na pravé, zoom zůstává kolečku (obsluhuje
    // ho naše plynulé přiblížení, Cesiu tu zůstává jen pinch).
    const cam = v.scene.screenSpaceCameraController
    const prevRotate = cam.rotateEventTypes
    const prevZoom = cam.zoomEventTypes
    cam.rotateEventTypes = [Cesium.CameraEventType.RIGHT_DRAG]
    cam.zoomEventTypes = [Cesium.CameraEventType.PINCH]

    const paintAt = (screen: Cesium.Cartesian2) => {
      // pickTerrain (ray na globus) je proti pickGround levnější — nedělá readback hloubky,
      // což se při desítkách MOUSE_MOVE za sekundu pozná
      const g = pickTerrain(v, screen)
      if (!g) return
      const tile = tileAt(g.lon, g.lat, tileSize)
      const key = tileKey(tile)
      if (stroke.has(key)) return
      stroke.add(key)
      setTileSelected(tile, adding)
    }

    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickTerrain(v, evt.position)
      if (!g) return
      adding = !tilesRef.current.has(tileKey(tileAt(g.lon, g.lat, tileSize)))
      painting = true
      stroke.clear()
      lastPx = evt.position.clone()
      v.scene.screenSpaceCameraController.enableInputs = false
      paintAt(evt.position)
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!painting) return
      // pick až po pár pixelech pohybu; jinak zbytečně pickujeme několikrát v téže dlaždici
      if (lastPx && Cesium.Cartesian2.distance(lastPx, evt.endPosition) < 4) return
      lastPx = evt.endPosition.clone()
      paintAt(evt.endPosition)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    const end = () => {
      if (!painting) return
      painting = false
      stroke.clear()
      lastPx = null
      cam.enableInputs = true
    }
    handler.setInputAction(end, Cesium.ScreenSpaceEventType.LEFT_UP)
    // Pojistka: když pustíš tlačítko mimo canvas, Cesium LEFT_UP nedostane a zůstalo by
    // zapnuté malování i vypnutá kamera. end() je idempotentní, takže to nic nerozbije.
    window.addEventListener('pointerup', end)

    return () => {
      handler.destroy()
      window.removeEventListener('pointerup', end)
      if (v.isDestroyed()) return
      cam.enableInputs = true
      cam.rotateEventTypes = prevRotate
      cam.zoomEventTypes = prevZoom
    }
  }, [tileMode, tileSize])

  /**
   * Překreslí VŠECHNY vybrané dlaždice jako dvě dávková primitiva (výplň + obrys).
   *
   * Odloženě: malování tahem sype změny po jedné a překreslovat na každou z nich by bylo trhané.
   * U velkých výběrů se navíc hrany nezhušťují (`per`) — zakřivení Křováku ve WGS84 je na dlaždici
   * setinový pixel, ale těch bodů jsou při tisících dlaždic statisíce.
   */
  function scheduleTileGfx() {
    clearTimeout(tileGfxTimer.current)
    tileGfxTimer.current = setTimeout(() => rebuildTileGfx(), 80)
  }

  function rebuildTileGfx() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (tileFillRef.current) { v.scene.primitives.remove(tileFillRef.current); tileFillRef.current = null }
    if (tileEdgeRef.current) { v.scene.primitives.remove(tileEdgeRef.current); tileEdgeRef.current = null }

    const tiles = [...tilesRef.current.values()]
    if (!tiles.length) { v.scene.requestRender(); return } // zvýraznění zmizelo — ukázat to
    const per = tiles.length > 400 ? 2 : 8
    const fill = TILE_COLOR.withAlpha(0.12)
    const fills: Cesium.GeometryInstance[] = []
    const edges: Cesium.GeometryInstance[] = []
    for (const t of tiles) {
      const ring = Cesium.Cartesian3.fromDegreesArray(tileRingLL(t, per))
      fills.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(ring) }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(fill) },
      }))
      edges.push(new Cesium.GeometryInstance({
        geometry: new Cesium.GroundPolylineGeometry({ positions: [...ring, ring[0]], width: 2 }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(TILE_COLOR) },
      }))
    }
    tileFillRef.current = v.scene.primitives.add(new Cesium.GroundPrimitive({
      geometryInstances: fills,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true }),
    })) as Cesium.GroundPrimitive
    tileEdgeRef.current = v.scene.primitives.add(new Cesium.GroundPolylinePrimitive({
      geometryInstances: edges,
      appearance: new Cesium.PolylineColorAppearance(),
    })) as Cesium.GroundPolylinePrimitive
    // Staví se odloženě (časovač), tedy mimo render Reactu — a geometrie primitiva se začne
    // počítat až v prvním vykresleném snímku, takže si ho musí vyžádat sám.
    v.scene.requestRender()
  }

  /**
   * Výběr dlaždic patří ke scéně, ne k jednomu sezení.
   *
   * Výkres se mění, území ne — po jeho opravě je potřeba vyjet PŘESNĚ tytéž dlaždice.
   * Skládat je pokaždé ručně by znamenalo, že se výřez o kousek liší a výstupy na sebe
   * nesednou. Ukládání je odložené (viz `saveSceneState`), takže i malování tahem, které
   * sem chodí desetkrát za vteřinu, skončí jedním zápisem.
   */
  function persistTiles(size: TileSize = tileSize) {
    sceneRef.current.patchState({
      tiles: { size, cells: [...tilesRef.current.values()].map(t => [t.ix, t.iy] as [number, number]) },
    })
  }

  /** Zapne/vypne dlaždici. Idempotentní — malování tahem po ní jezdí opakovaně. */
  function setTileSelected(tile: Tile, on: boolean) {
    const key = tileKey(tile)
    if (on === tilesRef.current.has(key)) return
    if (on) tilesRef.current.set(key, tile); else tilesRef.current.delete(key)
    setTileCount(tilesRef.current.size)
    persistTiles()
    scheduleTileGfx()
  }

  function clearTiles() {
    tilesRef.current.clear()
    setTileCount(0)
    persistTiles()
    scheduleTileGfx()
  }

  function toggleTileMode() {
    if (tileMode) { setClickOwner('none'); return }
    claimMapClick('tile')
    exclusiveSelect('tile') // zruš parcely/oblast/území — jen jeden zdroj výběru naráz
    setClickOwner('tile')
  }

  // jiná velikost = jiná mřížka; míchat čtverce dvou velikostí by dělalo překryvy
  function changeTileSize(s: TileSize) {
    if (s === tileSize) return
    clearTiles()
    setTileSize(s)
    persistTiles(s) // `tileSize` se ve stavu změní až po překreslení, tak se nová velikost podá rovnou
  }

  /**
   * Obnova výběru dlaždic z uložené scény.
   *
   * Čeká se na viewer, protože se spolu s výběrem hned překresluje i jeho zvýraznění v mapě.
   * Běží jen při otevření scény — dál už si výběr žije po svém a ukládá se přes `persistTiles`.
   */
  useEffect(() => {
    if (!viewerReady) return
    const saved = scene.initial.tiles
    if (!saved?.cells?.length) return
    const size = ((TILE_SIZES as readonly number[]).includes(saved.size) ? saved.size : 1000) as TileSize
    setTileSize(size)
    tilesRef.current.clear()
    for (const [ix, iy] of saved.cells) tilesRef.current.set(tileKey({ ix, iy, size }), { ix, iy, size })
    setTileCount(tilesRef.current.size)
    scheduleTileGfx()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady])

  // ── Overlay mřížky dlaždic s názvy (jako kladení listů na ČÚZK) ──────────────────
  // Přepočítává se podle pohledu kamery. Aby to nezahltilo scénu, čáry i názvy mají strop:
  // moc dlaždic ve výřezu → napíšeme „přibliž" místo tisíců entit.
  const GRID_MAX_LINES = 4000  // nad tolik dlaždic nekreslíme ani čáry
  const GRID_MAX_LABELS = 400  // nad tolik jen čáry, názvy až po přiblížení

  function clearGrid() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) {
      // hromadně: bez pozastavení by se dávka čar přestavovala po každé odebrané entitě
      v.entities.suspendEvents()
      for (const e of gridEntsRef.current) v.entities.remove(e)
      v.entities.resumeEvents()
      if (gridLabelsRef.current) v.scene.primitives.remove(gridLabelsRef.current) // zároveň ji zničí
      v.scene.requestRender()
    }
    gridEntsRef.current = []
    gridLabelsRef.current = null
    gridKeyRef.current = ''
  }

  function redrawGrid() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (!gridOn) { clearGrid(); setGridNote(''); return }

    // co je vidět (obdélník lon/lat); při pohledu k horizontu je undefined
    const rect = v.camera.computeViewRectangle(v.scene.globe.ellipsoid)
    if (!rect) { clearGrid(); setGridNote('Naklop kameru na mapu'); return }
    const wLon = Cesium.Math.toDegrees(rect.west), eLon = Cesium.Math.toDegrees(rect.east)
    const sLat = Cesium.Math.toDegrees(rect.south), nLat = Cesium.Math.toDegrees(rect.north)

    // rohy výřezu do S-JTSK → obálka v Křováku (mřížka je zarovnaná na S-JTSK)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [lo, la] of [[wLon, sLat], [eLon, sLat], [eLon, nLat], [wLon, nLat]] as [number, number][]) {
      const [x, y] = sjtskOf(lo, la)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const size = tileSize
    const ix0 = Math.floor(minX / size), ix1 = Math.floor(maxX / size)
    const iy0 = Math.floor(minY / size), iy1 = Math.floor(maxY / size)
    const nx = ix1 - ix0 + 1, ny = iy1 - iy0 + 1
    const count = nx * ny
    if (count <= 0 || count > GRID_MAX_LINES) { clearGrid(); setGridNote(count > GRID_MAX_LINES ? 'Přibliž pro zobrazení mřížky' : ''); return }
    const withLabels = count <= GRID_MAX_LABELS
    // Kamera se zastaví po každém otočení nebo kousku posunu a výřez přitom většinou pokrývá
    // pořád tytéž buňky — pak není co překreslovat.
    const key = `${size}|${ix0}|${ix1}|${iy0}|${iy1}|${withLabels}`
    if (key === gridKeyRef.current) return
    clearGrid()
    gridKeyRef.current = key
    v.entities.suspendEvents()

    // přímka v S-JTSK je ve WGS84 mírně zakřivená → zhustit body na hranách buněk
    const linePts = (x0: number, y0: number, x1: number, y1: number, seg: number) => {
      const out: Cesium.Cartesian3[] = []
      for (let k = 0; k <= seg; k++) { const t = k / seg; const [lo, la] = wgsOf(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t); out.push(Cesium.Cartesian3.fromDegrees(lo, la)) }
      return out
    }
    const gridColor = TILE_COLOR.withAlpha(0.55)
    // svislé čáry mřížky (na každé hranici ix)
    for (let ix = ix0; ix <= ix1 + 1; ix++) {
      gridEntsRef.current.push(v.entities.add({
        polyline: { positions: linePts(ix * size, iy0 * size, ix * size, (iy1 + 1) * size, ny + 1), width: 1, material: gridColor, clampToGround: true },
      }))
    }
    // vodorovné čáry mřížky (na každé hranici iy)
    for (let iy = iy0; iy <= iy1 + 1; iy++) {
      gridEntsRef.current.push(v.entities.add({
        polyline: { positions: linePts(ix0 * size, iy * size, (ix1 + 1) * size, iy * size, nx + 1), width: 1, material: gridColor, clampToGround: true },
      }))
    }
    v.entities.resumeEvents()

    // názvy do středů buněk — jen když jich není moc, jinak by se překrývaly a brzdily
    if (!withLabels) { setGridNote(`${count} dlaždic — přibliž pro názvy`); return }
    setGridNote('')
    // Názvy jsou jedna LabelCollection a výšku terénu dostanou jednou, při kreslení. Dřív to byly
    // entity s CLAMP_TO_GROUND: každá si přihlásila hlídání terénu a přepočítávala se s každou
    // nově načtenou dlaždicí — u stovek názvů znát hlavně na slabších počítačích. Hloubkový test
    // je vypnutý, takže pár metrů rozdílu proti nejdetailnějšímu terénu na obrazovce nepoznáš.
    const globe = v.scene.globe
    const heightAt = (lo: number, la: number) => globe.getHeight(Cesium.Cartographic.fromDegrees(lo, la))
    const [clo, cla] = wgsOf((minX + maxX) / 2, (minY + maxY) / 2)
    const fallback = heightAt(clo, cla) ?? 0 // tam, kde ještě není načtená žádná dlaždice terénu
    const lc = new Cesium.LabelCollection({ scene: v.scene })
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const [lo, la] = wgsOf((ix + 0.5) * size, (iy + 0.5) * size)
        lc.add({
          position: Cesium.Cartesian3.fromDegrees(lo, la, heightAt(lo, la) ?? fallback),
          text: `${ix}, ${iy}`,
          font: 'bold 12px monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2000, 1.0, 30000, 0.5),
        })
      }
    }
    gridLabelsRef.current = v.scene.primitives.add(lc)
    v.scene.requestRender()
  }

  // překresli mřížku při zapnutí, změně velikosti dlaždice a po každém pohybu kamery
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    redrawGrid()
    if (!gridOn) return
    const off = () => redrawGrid()
    // Událost si držíme z registrace: cleanup běží i po zničení vieweru (zánik komponenty)
    // a getter `v.camera` by pak sáhl do zahozeného widgetu.
    const moveEnd = v.camera.moveEnd
    moveEnd.addEventListener(off)
    return () => { moveEnd.removeEventListener(off); clearGrid() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOn, tileSize])

  return {
    addRegionTiles,
    changeTileSize,
    clearTiles,
    finalizeAreaTiles,
    gridNote,
    gridOn,
    setGridOn,
    tileCount,
    tileSize,
    tilesRef,
    toggleTileMode,
  }
}
