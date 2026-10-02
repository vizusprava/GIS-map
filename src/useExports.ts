/**
 * Exporty — nastavení výstupů a všech sedmnáct způsobů, jak scénu dostat ven.
 *
 * Řadí se podle DRUHU VÝSTUPU, ne podle toho, čeho se týkají: `exportAllRegions` stojí vedle
 * `exportOneGeoTiff`, protože sdílejí tutéž mašinerii na GeoTIFF, a totéž platí o skládání map
 * a o DXF. Rvát je po jednom k „území", „dlaždicím" a „parcelám" by tuhle osu rozbilo — sdílené
 * kusy by se musely buď zduplikovat, nebo předávat mezi třemi vlastníky.
 *
 * Vlastní práci dělají moduly v `export/`; tady zůstalo posbírání stavu a předání runneru.
 */
import { useEffect, useRef, useState } from 'react'
import polygonClipping from 'polygon-clipping'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { ask } from './dialog'
import type { ExportRunner } from './useExportRunner'
import { exportTilesObj as exportTilesObjCore } from './export/tilesObj'
import { exportMapTiles as exportMapTilesCore } from './export/mapTiles'
import { exportGeoTiff as exportGeoTiffCore } from './export/geotiff'
import { exportCutout as exportCutoutCore } from './export/cutout'
import { exportGoogleMesh as exportGoogleMeshCore } from './export/googleMesh'
import { AREA_TILES_MAX, isAbortError } from './config'
import { LOCAL_TILES, ORTO_MAX_LEVEL, bakedKeys, orthoBakedKey, orthoTileUrl } from './imagery'
import type { CoordPoint, ExportOpts } from './lib/types'
import type { ScenePersist } from './lib/scenePersist'
import type { GoogleTile } from './export/googleMesh'
import { KATASTR_MAX_RES, MESH_STEP_DEFAULT, MESH_STEPS, TEX_SIZES, pool, sjtskOf, tilesBounds, tilesOutline, wgsOf } from './tiles'
import type { Tile } from './tiles'
import type { Base, ParcelEntry } from './types'
import type { MapLayer, MeshStep, TexSize, TileSize } from './tiles'
import { MAP_RES, estimateMapTiles, fmtBytes, tilesInShape } from './export/mapTiles'
import type { MapRes } from './export/mapTiles'
import { planGeoTiff } from './export/geotiff'
import type { OutDir } from './export/geotiff'
/** vybraná parcela tak, jak ji drží mapa — s prstencem v lon/lat pro DXF a výřezy */
import { buildDxf, buildDxfLayers, download } from './exportUtils'
import { fetchElevSamplerSJTSK } from './elevation'
import { bakedGet, bakedPut } from './cache'
import { fetchKatastrPolylines } from './export/katastrDxf'
import { fetchCacheTile } from './orthoTiles'
import { ruianQuery } from './katastr'
import { mapOverlayFor, type DrawOverlay } from './export/drawOverlay'
import { throwIfAborted } from './export/ctx'

export type ExportsApi = ReturnType<typeof useExports>

export function useExports(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  runner: ExportRunner
  tilesRef: React.RefObject<Map<string, Tile>>
  tileSize: TileSize
  parcelsRef: React.RefObject<Map<string, ParcelEntry>>
  regionActiveRef: React.RefObject<{ name: string; worldRings: Cesium.Cartesian3[][]; sjtskRings: [number, number][][] } | null>
  /** označí, že se ukládá; panel podle toho zamkne tlačítka */
  setRegionBusy: (b: boolean) => void
  /** vrstva ortofota — po napečení dlaždic se překreslí, ať se berou z cache */
  ortoRef: React.RefObject<Cesium.ImageryLayer | null>
  /** aktivní podklad — DXF katastru se kreslí jen nad ortofotem */
  base: Base
  /** počítadlo napečených dlaždic pro panel */
  setBakedInfo: (n: number) => void
  coordShift: [number, number, number]
  coordPts: CoordPoint[]
  googleRef: React.RefObject<Cesium.Cesium3DTileset | null>
  refreshOrtoLayer: () => void
  /** výkresy pro dokreslení do rastru mapy — jen viditelné, s aktuální průhledností */
  drawingOverlays: () => DrawOverlay[]
  /** volby exportu se ukládají se scénou (`SceneState.exportOpts`) */
  sceneRef: React.RefObject<ScenePersist>
}) {
  const { viewerRef, runner, tilesRef, tileSize, parcelsRef, regionActiveRef, coordShift, coordPts, googleRef, refreshOrtoLayer, setRegionBusy, ortoRef, setBakedInfo, base, drawingOverlays, sceneRef } = deps

  /** běží DXF export — zamyká jeho tlačítka */
  const [exporting, setExporting] = useState(false)

  // ── volby exportu: počáteční hodnoty z uložené scény, co neprojde kontrolou, je výchozí ──
  const saved = sceneRef.current.initial.exportOpts ?? {}
  const pick = <T,>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt)
  const flag = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt)
  const [texSize, setTexSize] = useState<TexSize>(() => pick(saved.texSize, TEX_SIZES, 2048))
  const [meshStep, setMeshStep] = useState<MeshStep>(() => pick(saved.meshStep, MESH_STEPS, MESH_STEP_DEFAULT))
  // 3D export s ortofotem jako texturou; bez něj jde čistý terén (rychlejší, menší zip)
  const [exportOrtho, setExportOrtho] = useState(() => flag(saved.ortho, true))
  // dlaždicový 2D export: zvolené rozlišení drží bez ohledu na velikost území
  const [mapRes, setMapRes] = useState<MapRes>(() => pick(saved.mapRes, MAP_RES, 0.2))
  // 'both' = ortofoto i topo přes tutéž obálku a rozlišení → vyjdou pixel na pixel a jdou
  // v Photoshopu nebo AE položit přes sebe bez jakéhokoliv dorovnávání
  const [mapLayer, setMapLayer] = useState<MapLayer | 'both'>(() => pick(saved.mapLayer, ['ortofoto', 'topo', 'both'] as const, 'both'))
  // PNG do Photoshopu a AE (menší, georeference vedle jako .pgw), GeoTIFF když ji chceš uvnitř
  const [mapFormat, setMapFormat] = useState<'png' | 'tiff' | 'jpeg'>(() => pick(saved.mapFormat, ['png', 'tiff', 'jpeg'] as const, 'png'))
  // dokreslit do 2D exportu výkresy, které jsou v mapě vidět
  const [mapDrawings, setMapDrawings] = useState(() => flag(saved.drawings, true))
  // dokreslit do 2D exportu katastrální mapu (jako překryv Katastr v mapě)
  const [mapKatastr, setMapKatastr] = useState(() => flag(saved.mapKatastr, false))
  // 3D export: přibalit hranice parcel jako DXF křivky
  const [exportKatastr, setExportKatastr] = useState(() => flag(saved.katastr, false))
  const [exportBuildings, setExportBuildings] = useState(() => flag(saved.buildings, false))

  // Zapisuje se jen skutečná změna — otevření scény samo nic neukládá.
  const opts: ExportOpts = { meshStep, texSize, ortho: exportOrtho, katastr: exportKatastr, buildings: exportBuildings, mapLayer, mapRes, mapFormat, drawings: mapDrawings, mapKatastr }
  const optsJson = JSON.stringify(opts)
  const savedJsonRef = useRef(optsJson)
  useEffect(() => {
    if (optsJson === savedJsonRef.current) return
    savedJsonRef.current = optsJson
    sceneRef.current.patchState({ exportOpts: JSON.parse(optsJson) as ExportOpts })
  }, [optsJson, sceneRef])

  /** jsou v mapě vidět výkresy, které by šlo do 2D exportu dokreslit? */
  const hasDrawings = () => drawingOverlays().length > 0
  /** dokreslení výkresů pro 2D export — `undefined`, když je to vypnuté nebo není co kreslit */
  const overlay = () => (mapDrawings ? mapOverlayFor(drawingOverlays()) : undefined)

  async function exportTilesObj() {
    const tiles = [...tilesRef.current.values()]
    if (!tiles.length) return
    await runner.runExport(runner.tileUi, 'Export dlaždic selhal', ctx =>
      exportTilesObjCore(tiles, { tileSize, meshStep, texSize, ortho: exportOrtho, buildings: exportBuildings, katastr: exportKatastr, shift: coordShift, points: coordPts }, ctx))
  }

  /**
   * 2D mapa vybraných dlaždic ve ZVOLENÉM rozlišení (na rozdíl od „Spojené mapy", která u velkého
   * území tiše zmenší měřítko, protože se musí vejít do jednoho canvasu).
   *
   * Cíl se volí podle odhadu: velký výstup jde rovnou na disk, protože v paměti by ho prohlížeč
   * neunesl. Kdo zápis na disk nemá (Firefox, Safari), dostane aspoň varování před pádem.
   */
  async function exportMapTiles2D() {
    const tiles = [...tilesRef.current.values()]
    if (!tiles.length) { toast.info('Nejsou vybrané žádné dlaždice'); return }
    const est = estimateMapTiles(tiles.length, tileSize, mapRes)
    const hasPicker = 'showSaveFilePicker' in window
    const big = est.bytes > 500e6
    if (big && !hasPicker && !(await ask({
      title: `Exportovat ~${fmtBytes(est.bytes)}?`,
      message: `${tiles.length} dlaždic. Tenhle prohlížeč neumí zapisovat rovnou na disk, takže se zip poskládá ` +
        'v paměti a u téhle velikosti může spadnout. Doporučuju hrubší detail, nebo Chrome či Edge.',
      okLabel: 'Přesto exportovat', danger: true,
    }))) return
    const ov = overlay()
    await runner.runExport(runner.tileUi, 'Export mapy selhal', async ctx => {
      let last = ''
      for (const layer of exportLayers()) {
        last = await exportMapTilesCore(tiles, { tileSize, res: mapRes, layer, toDisk: big && hasPicker, overlay: ov, katastr: withKatastr() }, ctx)
      }
      return last
    })
  }

  /**
   * Jeden spojený GeoTIFF — pro Photoshop a After Effects, kde se s dlaždicemi pracovat nedá.
   *
   * Nepočítá se přes canvas, takže neplatí jeho strop 16 384 px: zapisuje se po pruzích rovnou
   * do souboru. Limitem je až samotný cíl — kompozice v AE končí na 30 000 px, Photoshop na
   * 300 000, klasický TIFF na 4 GB. Co z toho projde, ukazuje odhad v panelu.
   */
  async function exportOneGeoTiff(
    bbox: { x0: number; y0: number; x1: number; y1: number },
    clip: number[][][] | undefined,
    label: string,
    /** kam se hlásí průběh — panel, ze kterého se export spustil */
    ui = runner.cutoutUi,
  ) {
    const plan = planGeoTiff(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0, mapRes, !!clip)
    // Strop 4 GB je vlastnost klasického TIFFu; PNG ani JPEG ho nemají.
    if (mapFormat === 'tiff' && !plan.tiffOk) { toast.error(`${plan.W}×${plan.H} px = ${fmtBytes(plan.bytes)}. Klasický TIFF má strop 4 GB — zvol hrubší detail nebo PNG.`); return }
    const hasPicker = 'showSaveFilePicker' in window
    const warn = [
      !plan.afterEffectsOk && 'After Effects zvládne kompozici do 30 000 px — tohle je nad to.',
      !plan.photoshopOk && 'Photoshop zvládne do 300 000 px na stranu — tohle je nad to.',
    ].filter(Boolean).join('\n')
    // odhad souboru stejně jako poznámka v panelu (exportUi.imagePlan): PNG ortofota ~60 %, JPEG ~10 %
    const layerCount = exportLayers().length
    const est = plan.bytes * (mapFormat === 'jpeg' ? 0.1 : mapFormat === 'png' ? 0.6 : 1) * layerCount
    const fmtName = mapFormat === 'png' ? 'PNG' : mapFormat === 'jpeg' ? 'JPEG' : 'GeoTIFF'
    if (!(await ask({
      title: label,
      message: `Jeden obrázek ${fmtName}: ${plan.W}×${plan.H} px · ~${fmtBytes(est)}${layerCount > 1 ? ' (obě vrstvy)' : ''}${warn ? `\n\n${warn}` : ''}`,
      okLabel: 'Exportovat',
    }))) return
    // Obě vrstvy jdou přes TUTÉŽ obálku i rozlišení, takže vyjdou pixel na pixel a v Photoshopu
    // nebo AE se dají položit přes sebe bez dorovnávání — proto se jen zopakuje tentýž export.
    const ov = overlay()
    await runner.runExport(ui, 'Export mapy selhal', async ctx => {
      const ext = mapFormat === 'png' ? 'png' : mapFormat === 'jpeg' ? 'jpg' : 'tif'
      let last = ''
      for (const layer of exportLayers()) {
        last = await exportGeoTiffCore(bbox, {
          res: mapRes, layer, clip,
          toDisk: plan.bytes > 500e6 && hasPicker,
          format: mapFormat,
          overlay: ov,
          katastr: withKatastr(),
          // Název podle ÚZEMÍ, ne obecné „mapa": cílem bývá složka s víc kraji vedle sebe
          // a stejnojmenné soubory by se přepisovaly.
          name: `${slug(label)}_${layer}_${String(mapRes).replace('.', '_')}m.${ext}`,
        }, ctx)
      }
      return last
    })
  }

  /** Katastr jen tam, kde ho ČÚZK v daném detailu ještě kreslí — jinak by se stahovalo prázdno. */
  const withKatastr = () => mapKatastr && mapRes <= KATASTR_MAX_RES

  /** Které vrstvy se mají vyexportovat — „obojí" znamená totéž území dvakrát, pixel na pixel. */
  const exportLayers = (): MapLayer[] => (mapLayer === 'both' ? ['ortofoto', 'topo'] : [mapLayer])

  /** Název souboru z názvu území — bez diakritiky a mezer, ať to snese každý disk. */
  const slug = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').toLowerCase()

  /**
   * Postupné stažení VŠECH krajů do vybrané složky — každý kraj do vlastní podsložky.
   *
   * Složka se vybírá JEDNOU předem (`showDirectoryPicker`); jinak by se prohlížeč u čtrnácti
   * krajů × dvou vrstev ptal osmadvacetkrát a stahování by nešlo nechat běžet bez dozoru.
   *
   * Kraje jdou za sebou, ne souběžně: ČÚZK při paralelní zátěži vrací prázdné dlaždice, a u
   * několikahodinového běhu je spolehlivost přednější než rychlost.
   */
  async function exportAllRegions() {
    type DirPicker = () => Promise<OutDir>
    const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker
    if (!picker) { toast.error('Tenhle prohlížeč neumí zápis do složky. Použij Chrome nebo Edge.'); return }

    setRegionBusy(true)
    let kraje: Array<{ kod: number; nazev: string; rings: [number, number][][] }>
    try {
      kraje = await ruianQuery(17, '1=1', true) // vrstva 17 = kraj, s geometrií
    } catch (e) {
      console.error('Načtení krajů selhalo:', e); toast.error('Načtení krajů z RÚIAN selhalo'); return
    } finally { setRegionBusy(false) }
    if (!kraje.length) { toast.error('RÚIAN nevrátil žádné kraje'); return }

    const layers: MapLayer[] = mapLayer === 'both' ? ['ortofoto', 'topo'] : [mapLayer]
    let px = 0
    for (const k of kraje) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const r of k.rings) for (const [x, y] of r) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      }
      px += planGeoTiff(x1 - x0, y1 - y0, mapRes, true).bytes
    }
    const each = `${mapRes < 1 ? `${mapRes * 100} cm` : `${mapRes} m`}/px`
    if (!(await ask({
      title: `Exportovat všech ${kraje.length} krajů?`,
      message: `${kraje.length} krajů × ${layers.length} ${layers.length === 1 ? 'vrstva' : 'vrstvy'} v ${each}, odhad celkem ${fmtBytes(px * layers.length)}.\n\n` +
        'Každý kraj dostane vlastní podsložku. Poběží to dlouho (klidně hodiny) a jde to kdykoliv přerušit — hotové kraje zůstanou.',
      okLabel: 'Vybrat složku a spustit',
    }))) return

    const root = await picker()
    await runner.runExport(runner.cutoutUi, 'Dávkový export selhal', async ctx => {
      let done = 0
      for (const k of kraje) {
        throwIfAborted(ctx.signal)
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const r of k.rings) for (const [x, y] of r) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
        }
        const dir = await root.getDirectoryHandle(slug(k.nazev), { create: true })
        for (const layer of layers) {
          throwIfAborted(ctx.signal)
          const ext = mapFormat === 'png' ? 'png' : mapFormat === 'jpeg' ? 'jpg' : 'tif'
          await exportGeoTiffCore({ x0, y0, x1, y1 }, {
            res: mapRes, layer, clip: k.rings, format: mapFormat, dir, toDisk: false,
            name: `${slug(k.nazev)}_${layer}_${String(mapRes).replace('.', '_')}m.${ext}`,
          }, {
            signal: ctx.signal,
            // vlastní průběh: k pruhům uvnitř jednoho kraje přidáme, kolikátý kraj to je
            report: (p, m) => ctx.report((done + Math.max(0, p)) / (kraje.length * layers.length),
              `${k.nazev} · ${layer} · ${m}`),
          })
          done++
        }
      }
      return `Hotovo: ${kraje.length} krajů ve složce`
    })
  }

  /** Spojený GeoTIFF zvýrazněného území, oříznutý na jeho obrys. */
  function exportRegionGeoTiff() {
    const a = regionActiveRef.current
    if (!a) { toast.info('Nejdřív vyber území ve vyhledávání nahoře'); return }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const r of a.sjtskRings) for (const [x, y] of r) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
    if (!isFinite(x0)) { toast.error('Území nemá geometrii'); return }
    void exportOneGeoTiff({ x0, y0, x1, y1 }, a.sjtskRings, a.name)
  }

  /**
   * Jeden obrázek přes vybrané dlaždice, ve tvaru výběru: co do výběru nepatří, je průhledné
   * (u JPEGu bílé). Výběr vyplňující celý obdélník se neořezává — zbytečná alfa by soubor zvětšila.
   */
  function exportTilesGeoTiff() {
    const tiles = [...tilesRef.current.values()]
    if (!tiles.length) { toast.info('Nejsou vybrané žádné dlaždice'); return }
    const b = tilesBounds(tiles)
    void exportOneGeoTiff({ x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY }, tilesOutline(tiles), `${tiles.length} dlaždic`, runner.tileUi)
  }

  /** Obálka vybraných parcel v S-JTSK (odhad velikosti v panelu), nebo null. */
  function parcelsBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of parcelsRef.current.values()) for (const [lo, la] of p.ring) {
      const [x, y] = sjtskOf(lo, la)
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
  }

  /**
   * 2D mapa vybraných parcel jako jeden obrázek ořezaný přesně do jejich tvaru. Sousední parcely
   * splynou v jeden obrys (bez švů mezi nimi), vykrojené parcely uvnitř zůstanou průhledné.
   */
  function exportParcelsImage() {
    const list = [...parcelsRef.current.values()].filter(p => p.ring.length >= 3)
    const b = parcelsBox()
    if (!list.length || !b) { toast.error('Nejdřív vyber parcelu'); return }
    const toS = (r: number[][]) => {
      const s = r.map(([lo, la]) => sjtskOf(lo, la) as [number, number])
      const [f, l] = [s[0], s[s.length - 1]]
      if (f[0] !== l[0] || f[1] !== l[1]) s.push([f[0], f[1]])
      return s
    }
    const polys = list.map(p => [toS(p.ring), ...p.holes.filter(h => h.length >= 3).map(toS)])
    let rings: [number, number][][]
    try {
      rings = polygonClipping.union(polys[0], ...polys.slice(1)).flat() as [number, number][][]
    } catch (e) {
      // Sjednocení umí spadnout na zdegenerované geometrii; holý seznam prstenců se ořízne taky,
      // jen se švy mezi sousedními parcelami (parcely se nepřekrývají, takže evenodd sedí).
      console.error('Sjednocení parcel selhalo, ořezávám po jedné:', e)
      rings = polys.flat()
    }
    const labels = list.map(p => p.label).filter(Boolean)
    const label = `${list.length === 1 ? 'Parcela' : 'Parcely'} ${labels.slice(0, 4).join(', ')}${labels.length > 4 ? ' …' : ''}`.trim()
    void exportOneGeoTiff({ x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY }, rings, label)
  }

  /**
   * 2D mapa zvýrazněného ÚZEMÍ ve zvoleném rozlišení, oříznutá na jeho skutečný obrys.
   *
   * Dlaždice se berou režimem `touch`, ne `center`: do ořezaného exportu musí i okrajové, jinak
   * by po nich zbyly díry a mapa by na krajích končila schodovitě místo po hranici.
   */
  async function exportRegionMapTiles() {
    const a = regionActiveRef.current
    if (!a) { toast.info('Nejdřív vyber území ve vyhledávání nahoře'); return }
    const res = tilesInShape(a.sjtskRings, tileSize, 'touch', AREA_TILES_MAX)
    if (res === 'too-many') { toast.error(`Území pokrývá přes ${AREA_TILES_MAX} dlaždic. Přepni na větší dlaždici.`); return }
    if (!res.length) { toast.error('Území nepokrývá žádnou dlaždici'); return }
    const est = estimateMapTiles(res.length, tileSize, mapRes)
    const hasPicker = 'showSaveFilePicker' in window
    const big = est.bytes > 500e6
    if (!(await ask({
      title: `Exportovat ${a.name} po dlaždicích?`,
      message: `${res.length} dlaždic, ~${fmtBytes(est.bytes)}.${big && !hasPicker ? '\n\nTenhle prohlížeč neumí zápis na disk — u téhle velikosti může spadnout.' : ''}`,
      okLabel: 'Exportovat',
    }))) return
    const ov = overlay()
    await runner.runExport(runner.cutoutUi, 'Export mapy selhal', async ctx => {
      let last = ''
      for (const layer of exportLayers()) {
        last = await exportMapTilesCore(res, { tileSize, res: mapRes, layer, toDisk: big && hasPicker, clip: a.sjtskRings, overlay: ov, katastr: withKatastr() }, ctx)
      }
      return last
    })
  }


  async function bakeAreaPyramid(minLon: number, minLat: number, maxLon: number, maxLat: number) {
    const v = viewerRef.current
    const provider = ortoRef.current?.imageryProvider
    if (!v || v.isDestroyed() || runner.tileBusy) return
    if (LOCAL_TILES || !provider) { toast.error('Lokální mapa není v tomto režimu k dispozici'); return }
    if (!(maxLon > minLon && maxLat > minLat)) { toast.error('Neplatná oblast'); return }
    // stejná mřížka jako zobrazení (cache ORTOFOTO_WM, Web Mercator) — klíče pak sedí na dlaždice mapy
    const ts = provider.tilingScheme
    const sw = Cesium.Cartographic.fromDegrees(minLon, minLat), ne = Cesium.Cartographic.fromDegrees(maxLon, maxLat)
    /**
     * Rozsah úrovní a strop počtu. Dlaždice cache má 256 px (WMS dřív 512 px), takže na tutéž
     * plochu a jemnost jich je čtyřikrát víc — proto ten čtyřnásobný strop. Bajtů je zhruba stejně
     * (27 kB proti ~100 kB) a stahuje se to několikrát rychleji. Úroveň 20 je nejjemnější, co cache
     * má (~9 cm na pixel na zemi); u velké oblasti se strop sníží, nejvýš ale na 16 (~1,5 m).
     */
    const MIN_LEVEL = 14, CAP = 48000
    const rangeAt = (level: number) => {
      const a = ts.positionToTileXY(sw, level), b = ts.positionToTileXY(ne, level)
      if (!a || !b) return null
      return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) }
    }
    const countTo = (top: number) => { let n = 0; for (let L = MIN_LEVEL; L <= top; L++) { const r = rangeAt(L); if (r) n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) } return n }
    let maxLevel = ORTO_MAX_LEVEL
    while (maxLevel > 16 && countTo(maxLevel) > CAP) maxLevel-- // velká oblast → o úroveň hrubší, ať to nezabije disk
    const list: { x: number; y: number; level: number }[] = []
    for (let L = MIN_LEVEL; L <= maxLevel; L++) { const r = rangeAt(L); if (!r) continue; for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) list.push({ x, y, level: L }) }
    if (!list.length) { toast.error('Oblast nemá dlaždice'); return }
    // velikost pixelu na zemi: Web Mercator se k severu natahuje, u nás zhruba na 1,6×
    const cmpx = 156543.03 / Math.pow(2, maxLevel) * Math.cos(Cesium.Math.toRadians((minLat + maxLat) / 2)) * 100

    const ac = new AbortController(); runner.abortRef.current = ac
    runner.tileUi.setBusy(true); runner.tileUi.setPct(0); runner.tileUi.setMsg(`0/${list.length} dlaždic…`)
    let done = 0, fail = 0, added = 0
    try {
      await pool(list, 4, async ({ x, y, level }) => {
        if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
        const key = orthoBakedKey(level, x, y)
        if (!bakedKeys.has(key)) {
          // resumable: co je napečené, znovu nestahuj
          const got = (await bakedGet(key)) ?? await fetchCacheTile(orthoTileUrl(level, x, y), ac.signal)
          // 'missing' = cache dlaždici nemá (za hranicí ČR) — není co uložit, ale ani to není chyba
          if (got instanceof Uint8Array) { await bakedPut(key, got); bakedKeys.add(key); added++ }
          else if (got === null) fail++
        }
        done++
        if (done % 20 === 0 || done === list.length) { runner.tileUi.setPct(done / list.length); runner.tileUi.setMsg(`${done}/${list.length} dlaždic…`) }
      })
      setBakedInfo(bakedKeys.size)
      refreshOrtoLayer() // napečené dlaždice se hned použijí bez pan/refresh
      toast.success(`Lokální mapa napečena: ${added} dlaždic (~${cmpx.toFixed(0)} cm/px, z${maxLevel})${fail ? ` — ${fail} selhalo, pusť znovu` : ''}. Uloženo, přežije refresh.`)
    } catch (e) {
      setBakedInfo(bakedKeys.size)
      if (isAbortError(e)) toast.info(`Napékání zrušeno (${added} dlaždic zůstává uloženo)`)
      else { console.error('Napékání lokální mapy selhalo:', e); toast.error('Napékání selhalo') }
    } finally {
      runner.abortRef.current = null; runner.tileUi.setBusy(false); runner.tileUi.setMsg(''); runner.tileUi.setPct(-1)
    }
  }

  // lokální mapa z VÝBĚRU DLAŽDIC (obálka S-JTSK dlaždic → lon/lat)
  async function loadLocal2DMap() {
    const tiles = [...tilesRef.current.values()]
    if (!tiles.length || runner.tileBusy) return
    let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity
    for (const t of tiles) { ix0 = Math.min(ix0, t.ix); ix1 = Math.max(ix1, t.ix); iy0 = Math.min(iy0, t.iy); iy1 = Math.max(iy1, t.iy) }
    const minXm = ix0 * tileSize, maxXm = (ix1 + 1) * tileSize, minYm = iy0 * tileSize, maxYm = (iy1 + 1) * tileSize
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const [x, y] of [[minXm, minYm], [maxXm, minYm], [maxXm, maxYm], [minXm, maxYm]] as [number, number][]) {
      const [lo, la] = wgsOf(x, y)
      minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la)
    }
    await bakeAreaPyramid(minLon, minLat, maxLon, maxLat)
  }

  // lokální mapa z VYHLEDANÉHO ÚZEMÍ (obálka prstenců území v S-JTSK → lon/lat)
  async function loadRegionLocal2D() {
    const a = regionActiveRef.current
    if (!a || runner.tileBusy) return
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const ring of a.sjtskRings) for (const [x, y] of ring) {
      const [lo, la] = wgsOf(x, y)
      minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la)
    }
    await bakeAreaPyramid(minLon, minLat, maxLon, maxLat)
  }


  async function exportParcelsDxf() {
    if (parcelsRef.current.size === 0) { toast.error('Nejdřív vyber parcelu'); return }
    const rings = [...parcelsRef.current.values()].map(p => p.ring.map(([lo, la]) => sjtskOf(lo, la)))
    await exportDxfRings(rings, 'hranice_parcel', 'PARCELY')
  }

  // hranice vybraného správního území jako uzavřená 3D křivka (DXF), drapovaná na DMR
  async function exportRegionDxf() {
    const a = regionActiveRef.current
    if (!a) { toast.error('Nejdřív vyber a zobraz území'); return }
    await exportDxfRings(a.sjtskRings, `hranice_${slug(a.name)}`, 'HRANICE_UZEMI')
  }

  /**
   * Katastr vyhledaného území jako DXF: hranice jednotlivých parcel (hladina PARCELY) + obrys
   * území (hladina HRANICE_UZEMI) v jednom výkresu. Reálné S-JTSK (EPSG:5514), výšky Bpv z DMR —
   * stejný rámec jako „Terén (OBJ)" i export dlaždic, takže v CADu / 3ds Max lícuje s terénem.
   */
  async function exportRegionKatastrDxf() {
    const a = regionActiveRef.current
    if (!a || exporting) { if (!a) toast.error('Nejdřív vyber a zobraz území'); return }
    setExporting(true)
    try {
      // S-JTSK obálka území
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const r of a.sjtskRings) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }

      const kp = await fetchKatastrPolylines(minX, minY, maxX, maxY, a.sjtskRings)
      const groups: { layer: string; polylines: [number, number, number][][] }[] = []
      if (kp) groups.push({ layer: 'PARCELY', polylines: kp.polylines })

      // obrys území ve stejném rámci (výšky z téhož DMR vzorkovače, jinak plochý fallback)
      const outline = a.sjtskRings
        .map(r => { const c = r.slice(); if (c.length > 1) { const p = c[0], q = c[c.length - 1]; if (Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6) c.pop() } return c })
        .filter(r => r.length >= 3)
        .map(r => r.map(([x, y]) => [x, y, kp ? kp.sampleZ(x, y) : 0] as [number, number, number]))
      if (outline.length) groups.push({ layer: 'HRANICE_UZEMI', polylines: outline })

      if (!groups.some(g => g.polylines.length)) { toast.error('V oblasti nenalezeny žádné parcely ani obrys'); return }
      download(buildDxfLayers(groups), `katastr_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.dxf`, 'application/dxf')
      toast.success(`Katastr (DXF): ${kp?.count ?? 0} parcel + obrys území`)
    } catch (e) {
      console.error('Export katastru území selhal:', e)
      toast.error('Export katastru selhal')
    } finally {
      setExporting(false)
    }
  }

  /**
   * Jádro: hranice jako uzavřené 3D křivky (DXF pro 3ds Max), drapované na DMR 5G.
   *
   * Prstence přicházejí v S-JTSK a ven jdou v REÁLNÉM S-JTSK s výškou Bpv, bez posunu — tedy
   * ve stejném rámci jako „Terén + ortofoto (OBJ)", katastr DXF i export dlaždic, takže na sebe
   * v Maxu sednou. (Dřív to bylo lokální ENU kolem kotvy s výškou nad elipsoidem a s výřezem
   * terénu z téhož panelu to nelícovalo.)
   */
  async function exportDxfRings(sjtskRings: [number, number][][], name: string, layer: string) {
    if (exporting) return
    // DXF uzavře smyčku sám (flag), takže se duplicitní koncový bod zahodí
    const rings = sjtskRings.map(r => {
      const c = r.slice()
      if (c.length > 1) { const a = c[0], b = c[c.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3) c.pop() }
      return c
    }).filter(r => r.length >= 3)
    if (!rings.length) { toast.error('Žádná hranice k exportu'); return }
    setExporting(true)
    try {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const r of rings) for (const [x, y] of r) {
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
      }
      // Výšky ze stejného zdroje a ve stejné hustotě jako výřez terénu (~2 m/px, strop 2048 px).
      // Okraj kolem obálky, ať krajní body nevzorkují úplně na hraně rastru.
      const PAD = 5
      const x0 = minX - PAD, y0 = minY - PAD, x1 = maxX + PAD, y1 = maxY + PAD
      const span = Math.max(x1 - x0, y1 - y0)
      const long = Math.min(2048, Math.max(64, Math.ceil(span / 2)))
      const sw = Math.max(2, Math.round(long * (x1 - x0) / span))
      const sh = Math.max(2, Math.round(long * (y1 - y0) / span))
      const sampler = await fetchElevSamplerSJTSK('dmr5g', x0, y0, x1, y1, sw, sh)

      // náhrada za díry v DMR: medián toho, co se vzorkovat povedlo
      const known = rings.flat().map(([x, y]) => sampler(x, y)).filter((h): h is number => h != null).sort((a, b) => a - b)
      const fallback = known.length ? known[Math.floor(known.length / 2)] : 0
      // decimetr nad terénem, ať křivka v Maxu neprobliká skrz plochu terénu
      const LIFT = 0.1
      const polylines = rings.map(r => r.map(([x, y]) => [x, y, (sampler(x, y) ?? fallback) + LIFT] as [number, number, number]))
      download(buildDxf(polylines, layer), `${name}_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.dxf`, 'application/dxf')
    } catch (e) {
      console.error('Export DXF hranic selhal:', e)
      toast.error('Export DXF selhal')
    } finally {
      setExporting(false)
    }
  }

  /** obrysy vybraných parcel jako uzavřené lon/lat polygony (vstup pro výřez i Google mesh) */
  function parcelPolys(): [number, number][][][] {
    return [...parcelsRef.current.values()].map(p => {
      const r = p.ring.map(([lo, la]) => [lo, la] as [number, number])
      if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]])
      return [r] as [number, number][][]
    })
  }

  async function exportParcelCutout() {
    if (parcelsRef.current.size === 0) { toast.error('Nejdřív vyber parcelu'); return }
    await runner.runExport(runner.cutoutUi, 'Export výřezu selhal', ctx => exportCutoutCore(parcelPolys(), meshStep, ctx))
  }

  // export terénu (DMR 5G) + zapečené ortofoto ořezaný na vybrané správní území
  async function exportRegionCutout() {
    const a = regionActiveRef.current
    if (!a) { toast.error('Nejdřív vyber a zobraz území'); return }
    const polys = a.sjtskRings.map(r => {
      const ll = r.map(([x, y]) => wgsOf(x, y) as [number, number])
      if (ll.length && (ll[0][0] !== ll[ll.length - 1][0] || ll[0][1] !== ll[ll.length - 1][1])) ll.push([ll[0][0], ll[0][1]])
      return [ll] as [number, number][][]
    })
    await runner.runExport(runner.cutoutUi, 'Export výřezu selhal', ctx => exportCutoutCore(polys, meshStep, ctx))
  }

  /**
   * Google mesh vybrané oblasti — geometrie se bere z právě vykreslených dlaždic, takže co není
   * na obrazovce načtené, to v exportu nebude. Odtud ty kontroly před spuštěním.
   */
  async function exportGoogleMesh() {
    const v = viewerRef.current
    const ts = googleRef.current
    if (!v || v.isDestroyed()) return
    if (base !== 'google' || !ts) { toast.error('Nejdřív zapni „3D realita (Google)" a najeď kamerou na oblast'); return }
    if (parcelsRef.current.size === 0) { toast.error('Vyber parcelu/oblast pro ořez'); return }
    const tiles = (ts as unknown as { _selectedTiles: GoogleTile[] })._selectedTiles
    if (!tiles || !tiles.length) { toast.error('Google dlaždice ještě nejsou vykreslené — počkej, až se scéna dokreslí'); return }
    await runner.runExport(runner.cutoutUi, 'Export Google meshe selhal', ctx => exportGoogleMeshCore(tiles, parcelPolys(), ctx))
  }



  return {
    exporting,
    exportAllRegions,
    exportBuildings,
    exportGoogleMesh,
    exportKatastr,
    exportMapTiles2D,
    exportParcelCutout,
    exportParcelsImage,
    exportParcelsDxf,
    exportRegionCutout,
    exportRegionDxf,
    exportRegionGeoTiff,
    exportRegionKatastrDxf,
    exportOrtho,
    exportRegionMapTiles,
    exportTilesGeoTiff,
    exportTilesObj,
    hasDrawings,
    loadLocal2DMap,
    loadRegionLocal2D,
    mapDrawings,
    mapKatastr,
    parcelsBox,
    mapFormat,
    mapLayer,
    mapRes,
    meshStep,
    setExportBuildings,
    setExportKatastr,
    setExportOrtho,
    setMapDrawings,
    setMapKatastr,
    setMapFormat,
    setMapLayer,
    setMapRes,
    setMeshStep,
    setTexSize,
    texSize,
  }
}
