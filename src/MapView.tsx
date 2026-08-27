import { useEffect, useMemo, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import {
  TILE_SIZES, MESH_STEPS, MESH_STEP_DEFAULT, TEX_SIZES, type TileSize, type MeshStep, type TexSize,
  type MapLayer, type Tile, tileKey, tileAt, tileRingLL, wgsOf, sjtskOf, pool, gridSize, estimateObjBytes,
  tilesBounds,
} from './tiles'
import { cacheStats, cacheClear, bakedGet, bakedPut, bakedAllKeys, bakedClear } from './cache'
import { fetchOrthoUrl, orthoExport4326Url } from './orthoTiles'
import { solveSimilarity, type V3 } from './similarity'
import { dxfToPrims, type DrawParse, type DrawPrim } from './dxf'
import { buildTextPrims } from './dxfText'
import { createCircleDofStage, type CircleDofUniforms } from './dofCircle'
import { CalloutLayer, DOT_DEFAULT, FRAME_DEFAULT, SIZE_DEFAULT, type Callout } from './callouts'
import { Compass } from './compass'
import { PulseLayer, PULSE_COLOR_DEFAULT, PULSE_COUNT_DEFAULT, type PulseSet } from './pulse'
// pozn.: `Ruler` je i ikona z lucide-react → typ si přejmenujeme, ať se to nepere
import { RulerLayer, fmtLen, rulerTotals, rulerArea, type Ruler as RulerData, type RulerPoint } from './ruler'
import { applyBackground, BG_MODES, type BgMode } from './background'
import proj4 from 'proj4'
import polygonClipping from 'polygon-clipping'
import { toast } from 'sonner'
import { Box, Layers, Map as MapIcon, Image, Search, Loader2, Building2, Upload, Move, Crosshair, Trash2, ArrowDownToLine, RotateCcw, MapPin, Mountain, Download, Eye, EyeOff, Hexagon, Check, Sparkles, Grid3x3, X, ChevronRight, ChevronLeft, ChevronDown, Landmark, Play, Ruler } from 'lucide-react'
import {
  ION_TOKEN, isAbortError, ENABLE_GOOGLE_3D, ENABLE_OSM_BUILDINGS, ENABLE_LIBEREC_DISTRICTS, NEEDS_ION,
  GOOGLE_3D_ION_ASSET, SPLAT_ASSET_ID, SPLAT_ANCHOR, SPLAT_BASE_ROLL,
  SHAKE_KEY, SHAKE_MAX_DEG, SHARP_KEY, SPIN_KEY, SPIN_DEFAULT_DEG_S, ZOOM_SENS, ZOOM_TAU, ZOOM_MAX,
  CR_EXTENT, LIBEREC_EXTENT, GEOID_CZ, GOOGLE_LIFT_M, MAX_GLB_YAW_DEG, OSM_LIFT_M, MODEL_GLOW, EMPTY_NAMESET,
  VIEW_THUMB_W, VIEW_THUMB_H, VIEW_THUMB_Q, VIEW_DIRTY_M, VIEW_DIRTY_DEG,
  GOOGLE_SSE_STILL, GOOGLE_SSE_MOVING, MOVE_SETTLE_MS, AREA_TILES_MAX, AREA_TILES_CONFIRM,
} from './config'
import type {
  Base, Placement, CamLook, CamView, Parcel, Anchor, ModelEntry, SceneObj, DrawLayer, DrawingEntry,
} from './types'
import { CachedWmsOrtho, WMS_TILE, LOCAL_TILES, bakedKeys, ortofotoProvider, ZTM_TIERS, ztmProvider, pickZtmTier, katastrProvider } from './imagery'
import {
  pairRasterFiles, loadGeoRaster, makeRasterView, disposeRasterSrc, CRS_IDS, CRS_LABELS,
  type GeoRaster, type CrsId,
} from './worldRaster'
import { CamViews } from './camViews'
import { MapTools } from './mapTools'
import { MapSearch, type PlaceHit } from './mapSearch'
import { makeDmrTerrain } from './terrain'
import { fetchElevSampler } from './elevation'
import { simplifyRingCapped, pointInRing, ringCentroid } from './rings'
import { MEASURE_MAX_EDGES, MEASURE_MIN_EDGE, measureRing, fmtArea, type ParcelMeasure } from './measure'
import { ruianQuery, fetchAdminUnits, fetchAdminParts, fetchAdminGeom, fetchParcelAt, fetchParcelsInBbox, type AdminUnit } from './katastr'
import { AURORA_HEIGHT_M, AURORA_LABEL_LIFT_M, AURORA_SINK_M, auroraMaterial, smoothClosedRing, fetchLiberecDistricts } from './districts'
import { pickGround, pickTerrain, viewCenterGround, buildMatrix } from './sceneUtils'
import { computeBottomZ, georeferenceSjtskGlb } from './model3d'
import { parseAnchor, download, anchorFilename, buildDxf, buildDxfLayers } from './exportUtils'
import { fetchKatastrPolylines } from './export/katastrDxf'
import { stitchMapsCore } from './export/maps'
import type { ExportCtx } from './export/ctx'
import { exportTilesObj as exportTilesObjCore } from './export/tilesObj'
import { exportMapTiles as exportMapTilesCore, estimateMapTiles, tilesInShape, fmtBytes, MAP_RES, type MapRes } from './export/mapTiles'
import { exportGeoTiff as exportGeoTiffCore, planGeoTiff } from './export/geotiff'
import { exportCutout as exportCutoutCore } from './export/cutout'
import { exportGoogleMesh as exportGoogleMeshCore, type GoogleTile } from './export/googleMesh'
import { NumRow, ProjSwitch, Section, ToggleBtn, type CamProj } from './ui'
import type { ScenePersist } from './lib/scenePersist'
import type { AssetConfig, SavedParcel } from './lib/types'
import { fetchAssetFile, fetchAssetSidecar } from './lib/assets'

/**
 * Shodují se dva vzhledy pohledu?
 *
 * Nejde porovnat přes JSON: pohledy uložené dřív nemají klíče `shake*`/`spin*` vůbec, a chybějící
 * hodnota přitom znamená totéž co vypnuto. Doprovodné hodnoty (intenzita, rychlost) se porovnávají
 * jen když je efekt zapnutý — jinak by „upraveno" naskočilo po pohnutí sliderem, který stejně nic
 * nedělá, protože je vypínač zhasnutý.
 */
function sameLook(a: CamLook, b: CamLook): boolean {
  if (a.fov !== b.fov || a.bloom !== b.bloom) return false
  if (a.dofOn !== b.dofOn) return false
  if (a.dofOn && (a.dofMode !== b.dofMode || a.dofBlur !== b.dofBlur)) return false
  if (a.dofOn && a.dofMode === 'dist' && a.dofFocal !== b.dofFocal) return false
  if (a.dofOn && a.dofMode === 'circle' && (a.dofRadius !== b.dofRadius || a.dofFeather !== b.dofFeather)) return false
  if (!!a.shakeOn !== !!b.shakeOn) return false
  if (a.shakeOn && a.shakeAmt !== b.shakeAmt) return false
  if (!!a.spinOn !== !!b.spinOn) return false
  if (a.spinOn && a.spinSpeed !== b.spinSpeed) return false
  return true
}

/**
 * Mapa jedné scény. Co se má pamatovat, hlásí přes `scene` (viz lib/scenePersist.ts) —
 * o Supabase ani o přihlášeném uživateli tady nevíme nic.
 */
export function MapView({ scene }: { scene: ScenePersist }) {
  // Ukládací kanál si držíme v refu: volají ho i callbacky Cesia, které se registrují jednou
  // při startu a jinak by pořád koukaly na první verzi propu.
  const sceneRef = useRef(scene); sceneRef.current = scene
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const ortoRef = useRef<Cesium.ImageryLayer | null>(null)
  const ztmRefs = useRef<Record<string, Cesium.ImageryLayer>>({})
  const katastrRef = useRef<Cesium.ImageryLayer | null>(null)
  // vlastní georeferencované rastry (.jgw + snímek): dekódované pixely, vrstva a obálka pro přelet
  const rastersRef = useRef<Map<string, { raster: GeoRaster; layer: Cesium.ImageryLayer; rect: Cesium.Rectangle }>>(new Map())
  const rasterFileRef = useRef<HTMLInputElement>(null)
  const googleRef = useRef<Cesium.Cesium3DTileset | null>(null)
  // rozpracované načítání Google dlaždic — než dojde ze sítě, je googleRef ještě null, takže
  // rychlé přepnutí tam a zpět by jinak spustilo druhé stahování a první tileset osiřel ve scéně
  const googlePendingRef = useRef<Promise<Cesium.Cesium3DTileset | null> | null>(null)
  const osmRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const osmPendingRef = useRef<Promise<Cesium.Cesium3DTileset | null> | null>(null)
  const modelsRef = useRef<Map<string, ModelEntry>>(new Map())
  const selectedIdRef = useRef<string | null>(null)
  // multi-parcela: vybrané parcely (klíč = id parcely)
  // `label` = číslo parcely z KN; drží se tady, aby šel výběr uložit do scény a obnovit i s popisem
  const parcelsRef = useRef<Map<string, { positions: Cesium.Cartesian3[]; ring: number[][]; holes: number[][][]; knArea: number; label: string; ents: Cesium.Entity[]; hidden?: boolean }>>(new Map())
  // popisky měření (kóty stran + výměra) po parcelách — mimo p.ents, ať jdou zhasnout zvlášť od zvýraznění
  const measureRef = useRef<Map<string, Cesium.Entity[]>>(new Map())
  // nahrané výkresy (DXF/DWG): čáry/popisky/body po hladinách + obalové bounds
  const drawingsRef = useRef<Map<string, DrawingEntry>>(new Map())
  const [drawH, setDrawH] = useState<Record<string, number>>({})   // svislý posun výkresu (m)
  const [drawA, setDrawA] = useState<Record<string, number>>({})   // průhlednost výkresu (0..1)
  // Zrcadla pro ukládání: `saveDrawingCfg` se volá i z asynchronního uploadu, kde by closure
  // viděla hodnoty staré několik sekund — a přepsala by tím, co mezitím uživatel nastavil.
  const drawHRef = useRef(drawH); drawHRef.current = drawH
  const drawARef = useRef(drawA); drawARef.current = drawA
  // vlastní rastry v panelu (pixely a vrstva jsou v rastersRef, tady jen to, co kreslí UI)
  // `assetId` = řádek v `geo_assets`; chybí, dokud se snímek nahrává (nebo když nahrání selhalo)
  const [rasterList, setRasterList] = useState<{ id: string; name: string; crsId: CrsId; visible: boolean; alpha: number; gsd: number; px: string; assetId?: string }[]>([])
  const [rasterBusy, setRasterBusy] = useState(false)
  // kamera: uložené pohledy + DOF/FOV/bloom
  const [camViews, setCamViews] = useState<CamView[]>(() =>
    // Pohledy uložené dřív nemají id — doplň ho při načtení, ať se na ně popisky můžou odkazovat.
    (scene.initial.camViews ?? []).map((cv, i) => cv.id ? cv : { ...cv, id: `v${i}_${Date.now()}` }),
  )
  const [activeViewId, setActiveViewId] = useState<string | null>(null)   // pohled, ve kterém právě jsme
  const [callouts, setCallouts] = useState<Callout[]>(() => scene.initial.callouts ?? [])
  const [calloutMode, setCalloutMode] = useState(false)                   // klik do mapy položí popisek
  const [calloutSel, setCalloutSel] = useState<string | null>(null)
  const [viewerReady, setViewerReady] = useState(false)
  // Sbalení sekcí levého panelu. Klíč chybí = použij výchozí hodnotu sekce, takže nové sekce
  // nemusí nic doplňovat a stav přežije i jejich přejmenování.
  // Panel překrývá levých 320 px mapy, takže musí jít odsunout — jinak se pod ním nedá klikat.
  const [panelOpen, setPanelOpen] = useState(true)
  // Hlavní vypínač prezentačních prvků (popisky + pulz). Při běžné práci s mapou překážejí.
  const [presentOn, setPresentOn] = useState(true)
  // Co bylo zapnuté, než se prezentace vypnula — aby zapnutí vrátilo přesně to, ne nějaký default.
  const presentSnapRef = useRef<{ dofOn: boolean; bloom: boolean } | null>(null)
  const [openSec, setOpenSec] = useState<Record<string, boolean>>(() => {
    try { const v = localStorage.getItem('geo.opensec'); if (v) return JSON.parse(v) as Record<string, boolean> } catch { /* */ }
    return {}
  })
  const toggleSec = (id: string, next: boolean) => setOpenSec(prev => {
    const v = { ...prev, [id]: next }
    try { localStorage.setItem('geo.opensec', JSON.stringify(v)) } catch { /* */ }
    return v
  })
  // Kontextové sekce (Parcely, Dlaždice, Vybraný model…) existují jen když je co ukazovat.
  // Sedí hned pod tím, co je vyrobilo, ale panel může být odscrollovaný jinde — po objevení
  // je proto rozbalíme a sjedeme k nim, ať se po výběru nemusí nic hledat.
  const panelScrollRef = useRef<HTMLDivElement>(null)
  function revealSection(id: string) {
    setOpenSec(prev => {
      if (prev[id] !== false) return prev            // sbalená jen když ji uživatel sám zavřel
      const v = { ...prev, [id]: true }
      try { localStorage.setItem('geo.opensec', JSON.stringify(v)) } catch { /* */ }
      return v
    })
    requestAnimationFrame(() => {
      panelScrollRef.current?.querySelector(`[data-sec="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }
  // vzhled posledně upravovaného popisku → nový ho zdědí, ať se nemusí stylovat pokaždé znovu
  const calloutStyleRef = useRef<Pick<Callout, 'dot' | 'frame' | 'size'>>({})
  const [pulses, setPulses] = useState<PulseSet[]>(() => scene.initial.pulses ?? [])
  const [pulseColor, setPulseColor] = useState(PULSE_COLOR_DEFAULT)
  const [pulseCount, setPulseCount] = useState(PULSE_COUNT_DEFAULT)
  const pulseLayerRef = useRef<PulseLayer | null>(null)
  // pohled, jehož název se právě přepisuje (nový nebo duplikovaný se otevře rovnou).
  // Pozor na `renamingId` níž — to je přejmenování OBJEKTU scény, jiná věc.
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null)
  const [dofOn, setDofOn] = useState(false)
  // 'dist' = ostré je vše v dané vzdálenosti (vestavěná DOF), 'circle' = ostrý kruh uprostřed obrazovky
  const [dofMode, setDofMode] = useState<'dist' | 'circle'>('circle')
  const [dofFocal, setDofFocal] = useState(300)
  const [dofBlur, setDofBlur] = useState(2)
  const [dofRadius, setDofRadius] = useState(0.84)
  const [dofFeather, setDofFeather] = useState(0.7)
  const [fov, setFov] = useState(60)
  // Projekce kamery. Pravdu drží frustum v Cesiu, tohle je jen zrcadlo pro UI — přepínač musí
  // ukazovat, v čem právě jsi, jinak se při rychlém přepínání ztratíš.
  const [camProj, setCamProj] = useState<CamProj>('persp')
  const [bloomOn, setBloomOn] = useState(false)
  const [orbitOn, setOrbitOn] = useState(true)        // přelet obloukem kolem středu pohledu (výchozí)
  // Ostrost obrazu = supersampling NAD RÁMEC fyzických pixelů displeje (scéna se vykreslí větší
  // a zmenší se až při zobrazení). Pomáhá tam, kam MSAA nedosáhne: na jemnou kresbu v ortofotu,
  // která se při zmenšování třepí. Cena roste s druhou mocninou — 1,5× = 2,25× pixelů.
  const [sharpness, setSharpness] = useState(() => {
    try { const v = Number(localStorage.getItem(SHARP_KEY)); return v >= 1 && v <= 2 ? v : 1 } catch { return 1 }
  })
  // „Kroužení" — kamera pomalu obíhá kolem místa, na které se pohled dívá. Stejně jako chvění je
  // to součást VZHLEDU POHLEDU (CamLook), ne globální volba, a po startu je vždycky vypnuté.
  // V localStorage zůstává jen naposledy nastavená rychlost jako výchozí hodnota slideru.
  const [spinOn, setSpinOn] = useState(false)
  const [spinSpeed, setSpinSpeed] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(SPIN_KEY) || '{}').speed; return typeof s === 'number' && s !== 0 ? s : SPIN_DEFAULT_DEG_S } catch { return SPIN_DEFAULT_DEG_S }
  })
  const spinRef = useRef({ on: false, speed: 0 })
  // Pivot = bod, kolem kterého se krouží. Vzorkuje se jednou při rozjezdu (null = vzorkuj znovu),
  // ne každý snímek: kroužením se střed obrazu drobně posouvá a dopočítávaný pivot by se rozjel.
  const spinPivotRef = useRef<Cesium.Cartesian3 | null>(null)
  // Do kdy se kroužit NEMÁ (ms, performance.now). Přelet na pohled si kameru řídí sám a kroužení
  // by se s ním pralo — tak počká, až doletí, a teprve pak si vezme nový pivot.
  const spinHoldRef = useRef(0)
  // „Kamera z ruky" — jemné chvění pohledu v prezentaci. Je součástí VZHLEDU POHLEDU (CamLook),
  // ne globální volba: každý uložený pohled si nese vlastní zapnutí i intenzitu, takže se chvění
  // dá dát jen na záběry, kterým sluší. Po startu je proto vždy VYPNUTÉ a čeká, až přiletíš na
  // pohled, který ho má. V localStorage zůstává jen naposledy nastavená intenzita jako výchozí
  // hodnota slideru — zapnutí se neukládá, aby se refreshem nikdy nevrátilo samo.
  const [shakeOn, setShakeOn] = useState(false)
  const [shakeAmt, setShakeAmt] = useState(() => {
    try { const a = JSON.parse(localStorage.getItem(SHAKE_KEY) || '{}').amt; return typeof a === 'number' ? a : 0.35 } catch { return 0.35 }
  })
  // čte ho renderovací smyčka každý snímek → ref, ať se listenery nepřepínají při každém tahu slideru
  const shakeRef = useRef({ on: false, amt: 0.35 })
  const dofRef = useRef<Cesium.PostProcessStageComposite | null>(null)
  const dofCircleRef = useRef<Cesium.PostProcessStageComposite | null>(null)
  const orbitAnimRef = useRef(0)                       // token běžící orbit animace (pro zrušení předchozí)
  const lookAnimRef = useRef(0)                        // totéž pro přechod vzhledu (FOV/DOF) při přeletu
  const fileRef = useRef<HTMLInputElement>(null)
  const dwgRef = useRef<HTMLInputElement>(null)

  const [base, setBase] = useState<Base>(() => scene.initial.base ?? 'ortofoto')
  const [ztmTier, setZtmTier] = useState<string>('ZTM250')
  const [katastrOn, setKatastrOn] = useState(false)
  // ořez podle vybraných parcel: 'hide' = skryj parcelu, 'only' = nech jen parcelu (inverse)
  // 'g3d' = topo/ortofoto všude + Google 3D realita JEN uvnitř vybraných parcel (inverzní ořez)
  const [parcelClip, setParcelClip] = useState<'off' | 'hide' | 'only' | 'g3d'>('off')
  const [parcelBuffer, setParcelBuffer] = useState(0) // odsazení hranice parcel při ořezu (m, ±)
  // „Jen parcelu": izolace ztlumením okolí (poloprůhledný překryv s dírou v parcele).
  // okoliVis = viditelnost okolí (0 = černé/skryté, 1 = plně vidět)
  const [okoliVis, setOkoliVis] = useState(0)
  const [keep3DAround, setKeep3DAround] = useState(true) // u „Jen parcelu": defaultně nechat vidět okolní 3D budovy
  const dimEntityRef = useRef<Cesium.Entity | null>(null)
  const dimAlphaRef = useRef(0)               // aktuální (animovaná) alfa překryvu
  const dimTargetRef = useRef(0)              // cílová alfa
  const dimRafRef = useRef<number | null>(null)
  const [parcelHl, setParcelHl] = useState(true) // zvýraznění (tyrkys výplň+obrys) vybraných parcel
  const [parcelMeasure, setParcelMeasure] = useState(false) // kóty délek u stran + výměra uprostřed parcely
  // area = součet výměr z KN, mapArea = součet spočítaný z geometrie mapy
  const [measureSum, setMeasureSum] = useState<{ area: number; mapArea: number; note: string }>({ area: 0, mapArea: 0, note: '' })
  // zvýraznění správního území (kraj/okres/obec): klik → vnořené jednotky → izolace ztlumením okolí
  const [regionMode, setRegionMode] = useState(false)
  const [regionBusy, setRegionBusy] = useState(false)
  const [regionChoices, setRegionChoices] = useState<AdminUnit[]>([])
  const [regionName, setRegionName] = useState<string | null>(null)
  const [regionDim, setRegionDim] = useState(0.2) // viditelnost okolí (0 = černé, 1 = plné)
  const [regionParts, setRegionParts] = useState<AdminUnit[]>([]) // katastrální území vybrané obce
  const regionEntsRef = useRef<Cesium.Entity[]>([])
  const regionDimEntRef = useRef<Cesium.Entity | null>(null)
  const regionActiveRef = useRef<{ name: string; worldRings: Cesium.Cartesian3[][]; sjtskRings: [number, number][][] } | null>(null)
  const regionPrimsRef = useRef<Cesium.Primitive[]>([]) // hranice jako primitivy (vždy viditelné)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleErr, setGoogleErr] = useState<string | null>(null)
  const [googleAlpha, setGoogleAlpha] = useState(1)               // průhlednost 3D reality (1 = plná, 0 = jen mapa pod ní)
  const [googleUnder, setGoogleUnder] = useState<'ortofoto' | 'zm' | 'none'>('none') // plochá mapa pod 3D; default 'none' = čistě 3D

  // pozadí scény (kolem glóbu / pod 3D dlaždicemi) — viz background.ts
  const [bgMode, setBgMode] = useState<BgMode>(() => {
    const v = scene.initial.bgMode
    return (BG_MODES.some(m => m.id === v) ? v : 'vesmir') as BgMode
  })
  const [bgCustom, setBgCustom] = useState<string>(() => scene.initial.bgCustom || '#121820')
  const bgStageRef = useRef<Cesium.PostProcessStage | null>(null)

  // scéna: seznam objektů + vybraný + umístění vybraného modelu
  const [objects, setObjects] = useState<SceneObj[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // rozbalené výkresy v panelu Scéna (ukazují seznam hladin)
  const [expandedDrawings, setExpandedDrawings] = useState<Set<string>>(new Set())
  // text pro filtrování hladin, klíč = id objektu výkresu
  const [layerFilter, setLayerFilter] = useState<Record<string, string>>({})
  // výběr hladin (multi-select klikáním i tažením), klíč = id objektu výkresu → množina názvů hladin
  const [layerSel, setLayerSel] = useState<Record<string, Set<string>>>({})
  const lastLayerClick = useRef<Record<string, string>>({}) // poslední klik pro Shift-rozsah
  // aktivní tažení výběru: přes které hladiny přejedeš se stejným režimem přidají/odeberou
  const dragRef = useRef<{ oid: string; mode: 'add' | 'remove' } | null>(null)
  useEffect(() => { const up = () => { dragRef.current = null }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up) }, [])
  const [placement, setPlacement] = useState<Placement | null>(null)
  // TEST: Gaussian splat (Kryry) — samostatná manipulace mimo model systém (tileset, ne Model)
  const splatRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const [splatOn, setSplatOn] = useState(false)
  const [splatShow, setSplatShow] = useState(true)  // zobrazit/skrýt splat (ať je vidět terén pod ním)
  const [splatMove, setSplatMove] = useState(false) // tažení splatu po terénu
  const [splatCP, setSplatCP] = useState(false)     // vlícovací režim (kontrolní body)
  const [cpCount, setCpCount] = useState(0)
  const [cpPending, setCpPending] = useState(false) // čeká se na mapový bod k rozklikanému bodu splatu
  const cpRef = useRef<{ s: V3; q: V3 }[]>([])       // dvojice (bod ve světě splatu, bod na reálné mapě)
  const cpPendingRef = useRef<V3 | null>(null)
  const cpEntsRef = useRef<Cesium.Entity[]>([])      // vizuální značky kliknutých bodů
  const [splatLoading, setSplatLoading] = useState(false)
  const [splatP, setSplatP] = useState<Placement>(() =>
    scene.initial.splat?.placement
    ?? { lon: SPLAT_ANCHOR.lon, lat: SPLAT_ANCHOR.lat, groundH: SPLAT_ANCHOR.h + GEOID_CZ, heightOffset: 0, heading: 0, pitch: 0, roll: SPLAT_BASE_ROLL, scale: 1 },
  )
  const [moveMode, setMoveMode] = useState(false)
  // řez terénem: svislá clipping rovina odřízne terén/Google → profil model+terén
  const [sectionOn, setSectionOn] = useState(false)
  const [sectionAz, setSectionAz] = useState(0)       // azimut normály roviny (°)
  const [sectionOffset, setSectionOffset] = useState(0) // posun roviny podél normály (m)
  const [sectionFlip, setSectionFlip] = useState(false) // která strana se odřízne

  // výběr parcel (multi)
  const [parcelMode, setParcelMode] = useState(false)
  const [parcelLoading, setParcelLoading] = useState(false)
  const [parcelCount, setParcelCount] = useState(0)
  const [cutoutBusy, setCutoutBusy] = useState(false)      // export výřezu (terén+ortofoto) běží
  const [cutoutPct, setCutoutPct] = useState(-1)           // 0..1 určitý průběh, -1 = neurčitý
  const [cutoutProgress, setCutoutProgress] = useState('') // textový popis fáze
  // výběr oblasti: naklikat body → vybrat všechny parcely uvnitř polygonu
  const [areaMode, setAreaMode] = useState(false)
  // ── ruční měření vzdáleností ────────────────────────────────────────────────────────────────
  // Hotová měření žijí ve stavu (a v localStorage), rozkreslené se pozná podle `rulerDraftId`.
  // Vrstva si kreslení řídí sama (ruler.ts) a čte živá data, takže tažení bodu nemusí přes React.
  const [rulerMode, setRulerMode] = useState(false)
  const [rulerKind, setRulerKind] = useState<'line' | 'area'>('line') // co založí další klik do prázdna
  const [rulers, setRulers] = useState<RulerData[]>(() => scene.initial.rulers ?? [])
  const [rulerDraftId, setRulerDraftId] = useState<string | null>(null)
  const [rulerSel, setRulerSel] = useState<string | null>(null)
  const rulerLayerRef = useRef<RulerLayer | null>(null)
  const rulersRef = useRef(rulers); rulersRef.current = rulers
  const rulerDraftRef = useRef<string | null>(null); rulerDraftRef.current = rulerDraftId
  const kindRef = useRef(rulerKind); kindRef.current = rulerKind
  const [areaPtCount, setAreaPtCount] = useState(0)
  const [areaLoading, setAreaLoading] = useState(false)
  const areaPtsRef = useRef<Cesium.Cartesian3[]>([])
  const areaEntsRef = useRef<Cesium.Entity[]>([])

  const [tileMode, setTileMode] = useState(false)
  const [tileSize, setTileSize] = useState<TileSize>(1000)
  const [texSize, setTexSize] = useState<TexSize>(2048)
  const [meshStep, setMeshStep] = useState<MeshStep>(MESH_STEP_DEFAULT)
  // strop delší strany spojené 2D mapy (px). 16384 ≈ hranice canvasu prohlížeče (~1 GB paměti).
  const [stitchMax, setStitchMax] = useState(8192)
  // dlaždicový 2D export: zvolené rozlišení drží bez ohledu na velikost území
  const [mapRes, setMapRes] = useState<MapRes>(0.2)
  const [mapLayer, setMapLayer] = useState<MapLayer>('ortofoto')
  const [tileCount, setTileCount] = useState(0)
  const [tileBusy, setTileBusy] = useState(false)
  const [tileProgress, setTileProgress] = useState('')
  const [tilePct, setTilePct] = useState(-1) // 0..1 = určitý průběh (stahování), -1 = neurčitý (skládání apod.)
  const abortRef = useRef<AbortController | null>(null) // pro zrušení běžícího exportu
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
  // přibalit do exportu i hranice parcel (katastr) jako DXF křivky
  const [exportKatastr, setExportKatastr] = useState(false)
  const [exportBuildings, setExportBuildings] = useState(false)
  const [drawingLoading, setDrawingLoading] = useState(false)
  // trvalá cache dlaždic (IndexedDB) — stav pro UI
  const [cacheInfo, setCacheInfo] = useState<{ count: number; bytes: number; pinnedBytes: number }>({ count: 0, bytes: 0, pinnedBytes: 0 })
  const refreshCache = () => { cacheStats().then(setCacheInfo).catch(() => {}) }
  /**
   * Sahá zrovna uživatel na mapu? Řídí kvalitu renderu za pohybu (níž).
   *
   * Schválně se to věší na VSTUP, ne na `camera.moveStart/moveEnd`. Kroužení a chvění hýbou
   * kamerou v každém snímku — s událostmi kamery by prezentace jela natrvalo ve zhoršené kvalitě,
   * tedy přesně tam, kde na obraze záleží nejvíc. Ze stejného důvodu se nesnižuje ani při přeletu
   * na uložený pohled: ten končí tam, kam se člověk dívá.
   *
   * Reaguje se na tažení a kolečko, ne na samotné stisknutí — jinak by kvalita klesla i při
   * obyčejném kliknutí na parcelu, kterým se nikam nehýbe.
   */
  const [interacting, setInteracting] = useState(false)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const el = v.scene.canvas
    let t: ReturnType<typeof setTimeout> | undefined
    const settle = () => { clearTimeout(t); t = setTimeout(() => setInteracting(false), MOVE_SETTLE_MS) }
    const busy = () => { clearTimeout(t); setInteracting(true) }
    const onMove = (e: PointerEvent) => { if (e.buttons) busy() }
    const onUp = () => settle()
    const onWheel = () => { busy(); settle() }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('pointerup', onUp) // puštění může padnout mimo plátno
    return () => {
      clearTimeout(t)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointerup', onUp)
    }
  }, [viewerReady])

  useEffect(() => {
    const v = viewerRef.current
    // Převzorkování nad rámec displeje je čistá práce navíc, tak za pohybu padá na nativní
    // rozlišení. Kdo má ostrost na 1, nepozná nic — jemu tohle nemá co ubrat.
    if (v && !v.isDestroyed()) v.resolutionScale = interacting ? Math.min(sharpness, 1) : sharpness
    if (googleRef.current) googleRef.current.maximumScreenSpaceError = interacting ? GOOGLE_SSE_MOVING : GOOGLE_SSE_STILL
    try { localStorage.setItem(SHARP_KEY, String(sharpness)) } catch { /* */ }
  }, [sharpness, interacting, viewerReady])

  useEffect(() => { refreshCache(); const id = setInterval(refreshCache, 4000); return () => clearInterval(id) }, [])
  // „Lokální mapa" = dlaždicová pyramida napečená do IndexedDB (store BAKED). `bakedInfo` = počet
  // dlaždic (pro UI). Při startu načteme klíče do `bakedKeys`, ať je requestImage bere lokálně.
  const [bakedInfo, setBakedInfo] = useState(0)
  useEffect(() => { bakedAllKeys().then(ks => { ks.forEach(k => bakedKeys.add(k)); setBakedInfo(bakedKeys.size) }).catch(() => {}) }, [])
  const [exporting, setExporting] = useState(false)
  // OSM budovy (globální šedé bloky přes ion) — spolehlivé pokrytí
  const [osmOn, setOsmOn] = useState(false)
  const [osmLoading, setOsmLoading] = useState(false)
  // městské části Liberce (katastrální území) se zářícím obrysem
  const [districtsOn, setDistrictsOn] = useState(false)
  const [districtsLoading, setDistrictsLoading] = useState(false)
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null)
  const districtsRef = useRef<Map<string, { name: string; color: Cesium.Color; rings: Cesium.Cartesian3[][]; ents: Cesium.Entity[]; prims: Cesium.Primitive[] }>>(new Map())

  // vyhledávání (lišta nahoře uprostřed — území i místa naráz, viz mapSearch.tsx)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [placeHits, setPlaceHits] = useState<PlaceHit[]>([])
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    if (ION_TOKEN) Cesium.Ion.defaultAccessToken = ION_TOKEN

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      timeline: false,
      animation: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true } }, // nutné pro snímky (canvas.toBlob)
      // Renderovat ve SKUTEČNÝCH pixelech displeje. Cesium má `useBrowserRecommendedResolution`
      // defaultně true, což znamená, že `window.devicePixelRatio` ignoruje a kreslí do CSS pixelů.
      // Na displeji se škálováním (Windows běžně 125/150 %, retina 200 %) vznikne menší obraz,
      // který prohlížeč roztáhne na plnou velikost — a to přeškálování rozdrolí každou ostrou
      // hranu v ortofotu na jemný šum. Není to aliasing geometrie (MSAA i anizotropní filtrování
      // jedou v Cesiu ve výchozím stavu naplno), ale renderování pod rozlišením obrazovky.
      useBrowserRecommendedResolution: false,
    })
    viewerRef.current = viewer
    setViewerReady(true)

    // Kolečko si bere naše plynulé přiblížení (efekt „plynulé přiblížení" níž) — Cesium by na
    // každý zářez skočilo o kus a při rychlém rolování to nadskakuje. Pravé tažení a pinch
    // zůstávají Cesiu, tam je pohyb spojitý sám od sebe.
    viewer.scene.screenSpaceCameraController.zoomEventTypes = [Cesium.CameraEventType.RIGHT_DRAG, Cesium.CameraEventType.PINCH]

    // pořadí přidání = pořadí vykreslení zdola nahoru: podklady → katastr
    const orto = viewer.imageryLayers.addImageryProvider(ortofotoProvider())
    ortoRef.current = orto
    for (const t of ZTM_TIERS) {
      const layer = viewer.imageryLayers.addImageryProvider(ztmProvider(t.code))
      layer.show = false
      ztmRefs.current[t.code] = layer
    }
    const katastr = viewer.imageryLayers.addImageryProvider(katastrProvider())
    katastrRef.current = katastr
    if (scene.initial.splat?.on) void loadSplat(false) // splat byl zapnutý → načti sám (bez přeletu)

    // terén celé mapy = ČÚZK DMR 5G (ortofoto/ZTM se drapují na přesný terén)
    viewer.terrainProvider = makeDmrTerrain()

    // přepínání ZTM tieru podle výšky kamery
    viewer.camera.percentageChanged = 0.2
    const onCamChange = () => {
      const h = viewer.camera.positionCartographic?.height
      if (h != null) setZtmTier(pickZtmTier(h))
    }
    viewer.camera.changed.addEventListener(onCamChange)

    // glóbus (ČÚZK podklad) renderuje jen výřez ČR — mimo ni se nic nekreslí
    viewer.scene.globe.cartographicLimitRectangle = CR_EXTENT
    // model se schová za kopce a zapadne pod povrch (nebude prosvítat) — platí pro ČÚZK terén;
    // v Google 3D zaclonění dělají samotné dlaždice
    viewer.scene.globe.depthTestAgainstTerrain = true
    // ── plynulejší načítání rastrových dlaždic ČÚZK (ortofoto/topo) + terénu DMR ──
    // Větší cache dlaždic → míň „reload" bliknutí při návratu na místo (default 100). Terén i imagery
    // se cachují společně. `preloadSiblings` = natáhni i sousední dlaždice → při posunu jsou hotové dřív.
    // Pozn.: ZTM ČÚZK je při paralelní zátěži FLAKY (bílé dlaždice) → víc požadavků = větší riziko;
    // kdyby topo bílalo, `preloadSiblings` je první podezřelý na vypnutí.
    viewer.scene.globe.tileCacheSize = 1000
    viewer.scene.globe.preloadSiblings = true

    // Kamera scény: kde jsi ji nechal. Nová scéna začíná nad Libercem.
    const saved = scene.initial.camera
    if (saved) {
      viewer.camera.setView({
        destination: new Cesium.Cartesian3(saved.dest[0], saved.dest[1], saved.dest[2]),
        orientation: { heading: saved.h, pitch: saved.p, roll: saved.r },
      })
    } else {
      viewer.camera.setView({ destination: LIBEREC_EXTENT })
    }
    onCamChange()

    return () => {
      viewer.camera.changed.removeEventListener(onCamChange)
      // Kam se scéna kouká, se ukládá až tady: při každém pohybu kamery by to byl vodopád
      // zápisů. Odložené uložení běží mimo komponentu, takže se dopíše i po odmountování.
      if (!viewer.isDestroyed()) {
        const c = viewer.camera
        sceneRef.current.patchState({
          camera: { dest: [c.position.x, c.position.y, c.position.z], h: c.heading, p: c.pitch, r: c.roll },
        })
      }
      viewerRef.current = null
      setViewerReady(false)
      for (const e of modelsRef.current.values()) URL.revokeObjectURL(e.url)
      modelsRef.current.clear()
      // Tilesety patřily viewru, který se za chvíli zničí. Kdyby reference přežily, `ensureGoogle`
      // by je považovala za načtené a vrátila mrtvé objekty místo aby si řekla o nové —
      // v novém viewru by se pak 3D dlaždice nezobrazily vůbec a nebylo by z čeho poznat proč.
      googleRef.current = null; googlePendingRef.current = null
      osmRef.current = null; osmPendingRef.current = null
      splatRef.current = null
      if (!viewer.isDestroyed()) viewer.destroy()
    }
  }, [])

  // ── Obnova scény po otevření ─────────────────────────────────────────────────────
  // Nahrané soubory se stáhnou z úložiště a projdou STEJNÝM importem jako z disku (jen bez
  // přeletů a s uloženým usazením), parcely se vykreslí z uložených prstenců. Jede to
  // POSTUPNĚ: modely i výkresy jsou velké a paralelní dekódování by appku na chvíli zabilo.
  const restoredRef = useRef(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  useEffect(() => {
    if (!viewerReady || restoredRef.current) return
    restoredRef.current = true

    restoreParcels(sceneRef.current.initial.parcels ?? [])

    const assets = sceneRef.current.assets
    if (!assets.length) return
    let alive = true
    void (async () => {
      let done = 0
      for (const a of assets) {
        const v = viewerRef.current
        if (!alive || !v || v.isDestroyed()) return
        setRestoring(`Načítám „${a.name}" (${++done}/${assets.length})`)
        try {
          const file = await fetchAssetFile(a)
          if (!alive) return
          if (a.kind === 'model') {
            await importModel(file, { assetId: a.id, name: a.name, config: a.config })
          } else if (a.kind === 'drawing') {
            const parse = await parseDrawingFile(file)
            if (!alive) return
            await renderDrawing(parse, a.file_name, { assetId: a.id, config: a.config })
          } else {
            const world = await fetchAssetSidecar(a)
            const raster = await loadGeoRaster(file, world ?? undefined)
            const v2 = viewerRef.current
            if (!alive || !v2 || v2.isDestroyed()) { disposeRasterSrc(raster.src); return }
            mountRaster(v2, raster, {
              crsId: (a.config.crsId as CrsId | undefined) ?? raster.crsId,
              alpha: a.config.rasterAlpha ?? 1,
              visible: a.config.rasterVisible ?? true,
              assetId: a.id,
            })
          }
        } catch (e) {
          console.error(`Obnova souboru „${a.name}" selhala:`, e)
          toast.error(`Soubor „${a.name}" se nepodařilo načíst`)
        }
      }
      if (alive) setRestoring(null)
    })()
    return () => { alive = false }
  }, [viewerReady])

  // líné vytvoření Google fotorealistických 3D dlaždic (přes ion token — vzhled Google Earth)
  async function ensureGoogle(viewer: Cesium.Viewer): Promise<Cesium.Cesium3DTileset | null> {
    if (googleRef.current) return googleRef.current
    if (googlePendingRef.current) return googlePendingRef.current
    googlePendingRef.current = (async () => {
    const ts = await Cesium.Cesium3DTileset.fromIonAssetId(GOOGLE_3D_ION_ASSET)
    if (viewer.isDestroyed()) return null
    // Vzniká SKRYTÝ. Než dlaždice dorazí ze sítě, uživatel už může být zpátky na ortofotu —
    // a Cesium má u nového tilesetu show=true, takže by se samy zjevily nad špatným podkladem.
    // Viditelnost nastaví až applyGoogleAlpha() podle aktuálního stavu.
    ts.show = false
    ts.enableCollision = true
    // ── ladění streamování/LOD, ať je „skákání" dlaždic klidnější (kompromis detail ↔ výkon/data) ──
    // Nižší SSE = jemnější dlaždice načtené dřív (i z dálky), takže přiblížení není tak skokové.
    // Za pohybu se zvedne na GOOGLE_SSE_MOVING (viz efekt u `interacting`) — tady je klidová hodnota.
    ts.maximumScreenSpaceError = GOOGLE_SSE_STILL
    ts.cacheBytes = 1024 * 1024 * 1024                   // 1 GB (default 512 MB) → míň „reload" lupnutí při návratu
    ts.maximumCacheOverflowBytes = 768 * 1024 * 1024     // dočasný přetok, ať se nezahazuje při špičce
    ts.preloadFlightDestinations = true                  // při flyTo natáhni cíl předem (default true, explicitně)
    ts.preloadWhenHidden = true                          // drž načtené i když je dočasně schované (míň reloadů)
    ts.foveatedScreenSpaceError = true                   // priorita na střed obrazovky (default true)
    // zvednutí dlaždic o ~0,5 m podél „nahoru" (střed ČR), ať lícují s DMR terénem
    const c = Cesium.Cartesian3.fromDegrees(15.5, 49.8)
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(c, new Cesium.Cartesian3())
    ts.modelMatrix = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(up, GOOGLE_LIFT_M, new Cesium.Cartesian3()))
    viewer.scene.primitives.add(ts)
    googleRef.current = ts
    updateExcavation() // kdyby byl model naimportovaný dřív, než se Google načetl
    applySection()     // aplikuj řez na čerstvě načtené dlaždice
    return ts
    })()
    try { return await googlePendingRef.current } finally { googlePendingRef.current = null }
  }

  // skryje mapu (ortofoto/topo + terén na globu i Google dlaždice) pod modely s maskou nebo uvnitř
  // vybraných parcel ('hide'). „Jen parcelu" ('only') se řeší ztlumením okolí v updateDim, ne ořezem.
  // Každý cíl (globe / Google) potřebuje vlastní instanci kolekce (nesdílet).
  // sjednotí vybrané parcely (S-JTSK) a robustně odsadí jejich vnější hranici o buffer m. Odsazení
  // NEdělá per-vrchol miter (ten se u úzkých/konkávních míst protne a začne odečítat), ale Minkowského
  // pás (kvádry na hranách + disky na vrcholech) → union (zvětšení) / difference (zmenšení), takže se
  // protínající odsazení samo srovná. Vrací world prstence pro ořez i masku.
  function parcelUnionRings(bufferM: number): Cesium.Cartesian3[][] {
    const src = [...parcelsRef.current.values()].filter(p => p.ring && p.ring.length >= 3)
    if (!src.length) return []
    const polys = src.map(p => {
      const r = p.ring.map(([lo, la]) => sjtskOf(lo, la) as [number, number])
      if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]])
      return [r] as [number, number][][]
    })
    let mp: [number, number][][][]
    try { mp = polygonClipping.union(polys[0], ...polys.slice(1)) as [number, number][][][] } catch { mp = polys }

    if (Math.abs(bufferM) > 1e-6) {
      const R = Math.abs(bufferM), seg = 12
      const band: [number, number][][][] = []
      const disc = (cx: number, cy: number): [number, number][][] => {
        const ring: [number, number][] = []
        for (let i = 0; i <= seg; i++) { const a = 2 * Math.PI * i / seg; ring.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]) }
        return [ring]
      }
      for (const poly of mp) for (const ring of poly) {
        for (let i = 0; i + 1 < ring.length; i++) { // prstenec je uzavřený (poslední == první)
          const [x1, y1] = ring[i], [x2, y2] = ring[i + 1]
          let dx = x2 - x1, dy = y2 - y1; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L
          const nx = dy * R, ny = -dx * R
          band.push([[[x1 - nx, y1 - ny], [x2 - nx, y2 - ny], [x2 + nx, y2 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny]]])
          band.push(disc(x1, y1))
        }
      }
      if (band.length) {
        try {
          const bandMP = polygonClipping.union(band[0], ...band.slice(1))
          mp = (bufferM > 0 ? polygonClipping.union(mp, bandMP) : polygonClipping.difference(mp, bandMP)) as [number, number][][][]
        } catch (e) { console.error('Odsazení parcel selhalo:', e) }
      }
    }

    const out: Cesium.Cartesian3[][] = []
    for (const poly of mp) {
      const simp = simplifyRingCapped(poly[0].map(([x, y]) => [x, y] as [number, number]))
      if (!simp) continue
      out.push(simp.map(([x, y]) => { const [lon, lat] = wgsOf(x, y) as number[]; return Cesium.Cartesian3.fromDegrees(lon, lat) }))
    }
    return out
  }

  function updateExcavation() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const modelRings: Cesium.Cartesian3[][] = []
    for (const m of modelsRef.current.values()) if (m.excavate && m.footprint) modelRings.push(...m.footprint)
    const parcelR = parcelClip !== 'off' ? parcelUnionRings(parcelBuffer) : []
    const mk = (rings: Cesium.Cartesian3[][], inverse: boolean) => rings.length
      ? new Cesium.ClippingPolygonCollection({ polygons: rings.map(r => new Cesium.ClippingPolygon({ positions: r })), inverse })
      : undefined
    // GLOBUS (zem): model masky + (hide → parcela dovnitř). U „only" glóbus neklipe — zem ztmaví překryv.
    // „g3d": když je 3D plné (alpha ~1), schovej topo POD ním (ořez glóbu uvnitř parcely) → neprosvítá/nebliká;
    // když se 3D zprůhlední, topo necháme, ať přes něj prosvítá.
    const g3dHideTopo = parcelClip === 'g3d' && googleAlpha >= 0.95
    const globeRings = (parcelClip === 'hide' || g3dHideTopo) ? [...modelRings, ...parcelR] : [...modelRings]
    v.scene.globe.clippingPolygons = mk(globeRings, false) as Cesium.ClippingPolygonCollection
    // GOOGLE dlaždice:
    //  „g3d" → INVERZNÍ ořez na parcelu = Google se vykreslí JEN uvnitř výběru (topo zůstane všude);
    //  „only" → inverzní ořez na parcelu (okolní budovy fakt zmizí = skutečná izolace);
    //  „hide" → ořez dovnitř; jinak jen model masky.
    if (googleRef.current) {
      const gPoly =
        parcelClip === 'g3d' ? mk(parcelR, true)
          : parcelClip === 'only' ? (keep3DAround ? mk([...modelRings], false) : mk(parcelR, true))
            : mk(parcelClip === 'hide' ? [...modelRings, ...parcelR] : [...modelRings], false)
      googleRef.current.clippingPolygons = gPoly as Cesium.ClippingPolygonCollection
    }
  }

  // „Jen parcelu": ztlumí okolí poloprůhledným tmavým překryvem (díra = parcela). Alfa se animuje
  // (plynulý fade in/out) přes dimAlphaRef; materiál ji čte přes CallbackProperty.
  const dimTarget = () => (parcelClip === 'only' && parcelsRef.current.size > 0) ? Math.min(1, Math.max(0, 1 - okoliVis)) : 0
  function buildDimEntity() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (dimEntityRef.current) { v.entities.remove(dimEntityRef.current); dimEntityRef.current = null }
    const holes = parcelUnionRings(parcelBuffer).map(r => new Cesium.PolygonHierarchy(r))
    if (!holes.length) return
    const R = CR_EXTENT
    const outer = [
      Cesium.Cartesian3.fromRadians(R.west, R.south), Cesium.Cartesian3.fromRadians(R.east, R.south),
      Cesium.Cartesian3.fromRadians(R.east, R.north), Cesium.Cartesian3.fromRadians(R.west, R.north),
    ]
    dimEntityRef.current = v.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outer, holes),
        material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => Cesium.Color.BLACK.withAlpha(dimAlphaRef.current), false)),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    })
  }
  function animateDim() {
    dimTargetRef.current = dimTarget()
    if (dimRafRef.current != null) return // tween už běží, jen si přebere nový cíl
    let last = performance.now()
    const step = () => {
      const now = performance.now(), dt = (now - last) / 1000; last = now
      const cur = dimAlphaRef.current, tgt = dimTargetRef.current
      const dir = Math.sign(tgt - cur)
      dimAlphaRef.current = Math.abs(tgt - cur) < 0.02 ? tgt : cur + dir * Math.min(Math.abs(tgt - cur), dt * 3.5)
      if (dimAlphaRef.current === tgt) {
        dimRafRef.current = null
        if (tgt <= 0.001) { const v = viewerRef.current; if (v && !v.isDestroyed() && dimEntityRef.current) { v.entities.remove(dimEntityRef.current); dimEntityRef.current = null } }
        return
      }
      dimRafRef.current = requestAnimationFrame(step)
    }
    dimRafRef.current = requestAnimationFrame(step)
  }
  // rebuild = přestav geometrii (změna parcel/okraje/zapnutí); jinak jen doanimuj na nový cíl
  function syncDim(rebuild: boolean) {
    if (rebuild && dimTarget() > 0) buildDimEntity()
    animateDim()
  }
  useEffect(() => { updateExcavation(); syncDim(true) }, [parcelClip, parcelBuffer, keep3DAround, googleAlpha])
  useEffect(() => { syncDim(false) }, [okoliVis])

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
        setRegionParts([]); setRegionChoices(units); setPlaceHits([])
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
  // překreslí tmavý překryv okolí (díra = území) podle aktuální viditelnosti regionDim
  function drawRegionDim() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (regionDimEntRef.current) { v.entities.remove(regionDimEntRef.current); regionDimEntRef.current = null }
    const a = regionActiveRef.current
    if (!a) return
    const alpha = Math.min(1, Math.max(0, 1 - regionDim))
    if (alpha <= 0.01) return
    const R = CR_EXTENT
    const outer = [
      Cesium.Cartesian3.fromRadians(R.west, R.south), Cesium.Cartesian3.fromRadians(R.east, R.south),
      Cesium.Cartesian3.fromRadians(R.east, R.north), Cesium.Cartesian3.fromRadians(R.west, R.north),
    ]
    const holes = a.worldRings.map(r => new Cesium.PolygonHierarchy(r))
    regionDimEntRef.current = v.entities.add({
      polygon: { hierarchy: new Cesium.PolygonHierarchy(outer, holes), material: Cesium.Color.BLACK.withAlpha(alpha), classificationType: Cesium.ClassificationType.BOTH },
    })
  }
  useEffect(() => { drawRegionDim() }, [regionDim])

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
  async function searchAdminUnits(q: string): Promise<{ units: AdminUnit[]; parts: AdminUnit[] }> {
    const like = `UPPER(nazev) LIKE UPPER('%${q.replace(/'/g, "''")}%')`
    const layers: [number, string][] = [[17, 'Kraj'], [15, 'Okres'], [12, 'Obec'], [7, 'k.ú.']]
    const found: AdminUnit[] = []
    for (const [layer, level] of layers) {
      // Vrstvy se ptají nezávisle — když jedna vypadne, zbytek výsledků má pořád cenu ukázat.
      try { for (const r of (await ruianQuery(layer, like, false)).slice(0, 12)) found.push({ level, name: r.nazev, kod: r.kod, layer }) } catch { /* přeskoč */ }
    }
    return { units: found.filter(u => u.level !== 'k.ú.'), parts: found.filter(u => u.level === 'k.ú.') }
  }

  /** Název → místa z geokodéru (jen ČR). Slouží čistě k přeletu, nic se tím nevybírá. */
  async function searchPlaces(q: string): Promise<PlaceHit[]> {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=cz&limit=5&q=${encodeURIComponent(q)}`
      const data = await (await fetch(url, { headers: { 'Accept-Language': 'cs' } })).json() as
        Array<{ display_name: string; lat: string; lon: string; boundingbox?: [string, string, string, string] }>
      return data.map(h => ({
        name: h.display_name,
        lon: Number(h.lon),
        lat: Number(h.lat),
        bbox: h.boundingbox ? (h.boundingbox.map(Number) as [number, number, number, number]) : undefined,
      }))
    } catch { return [] } // geokodér je doplněk; když neodpoví, RÚIAN výsledky stačí
  }

  // Jedno hledání pro obojí. Dřív se uživatel musel dopředu rozhodnout, jestli chce „najít místo"
  // (přelet) nebo „vybrat území" (výběr) — a psal do obou stejný název. Teď se ptáme jednou a
  // obě sady výsledků nabídneme vedle sebe; co je co, rozliší skupina v nabídce.
  async function runSearch() {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchOpen(true)
    try {
      // souběžně: RÚIAN je pomalejší (čtyři vrstvy za sebou), ať na něj geokodér nečeká
      const [admin, places] = await Promise.all([searchAdminUnits(q), searchPlaces(q)])
      setRegionChoices(admin.units)
      setRegionParts(admin.parts)
      setPlaceHits(places)
      // právě jedna možnost → rovnou ji zobraz, ať se nekliká do nabídky o jedné položce
      if (admin.units.length === 1 && !admin.parts.length && !places.length) {
        setSearchOpen(false)
        await isolateRegion(admin.units[0])
      }
    } catch (err) {
      console.error('Vyhledávání selhalo:', err)
      toast.error('Vyhledávání selhalo')
    } finally {
      setSearching(false)
    }
  }

  /** Přelet na místo z geokodéru — na obálku, když ji nabídne, jinak na bod z 10 km. */
  function flyToPlace(h: PlaceHit) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    setSearchOpen(false)
    if (h.bbox) {
      const [s, n, w, e] = h.bbox
      v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w, s, e, n) })
    } else {
      v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, 10000) })
    }
  }

  // počká, až se dokreslí terén i Google dlaždice (nebo timeout) — ať snímek není rozmazaný/nedočtený
  function waitTilesLoaded(v: Cesium.Viewer, signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const start = performance.now()
      let stable = 0
      const tick = () => {
        if (signal.aborted) return resolve()
        const loaded = v.scene.globe.tilesLoaded && (googleRef.current ? googleRef.current.tilesLoaded : true)
        stable = loaded ? stable + 1 : 0
        if (stable >= 4 || performance.now() - start > timeoutMs) return resolve()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }

  async function captureCanvasPng(v: Cesium.Viewer): Promise<Uint8Array> {
    v.render()
    const blob = await new Promise<Blob | null>(res => v.scene.canvas.toBlob(res, 'image/png'))
    if (!blob) throw new Error('Snímek se nepovedl (canvas)')
    return new Uint8Array(await blob.arrayBuffer())
  }

  /**
   * Odchod na přehled scén. Cestou se udělá náhled scény z aktuálního záběru — v přehledu se
   * pak pozná, co která scéna je. Selhání náhledu odchod nezdrží (je to jen obrázek).
   */
  async function leaveScene() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) {
      try {
        // Snímek se musí sebrat DŘÍV, než odchod odmountuje viewer — pak už canvas nestojí.
        // Samotné nahrání dojede na pozadí, na to se nečeká.
        v.render()
        const blob = await new Promise<Blob | null>(res => v.scene.canvas.toBlob(res, 'image/png'))
        if (blob && blob.size > 1000) void sceneRef.current.saveThumb(blob).catch(() => {})
      } catch { /* náhled je jen bonus, odchod nesmí zdržet */ }
    }
    sceneRef.current.exit()
  }

  // 4 snímky vybrané budovy ze světových stran (kamera obletí, počká na dlaždice, vyfotí) → zip PNG
  async function captureParcelViews() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (parcelsRef.current.size === 0) { toast.error('Vyber parcelu s budovou'); return }
    if (cutoutBusy) return
    const pts: Cesium.Cartesian3[] = []
    for (const p of parcelsRef.current.values()) if (p.positions) pts.push(...p.positions)
    if (pts.length < 3) { toast.error('Vybraná parcela nemá platný obrys'); return }
    const bs = Cesium.BoundingSphere.fromPoints(pts)
    const range = Math.max(35, bs.radius * 2.6)
    const pitch = Cesium.Math.toRadians(-18)
    const dirs = [{ n: '1_predni', h: 0 }, { n: '2_prava', h: 90 }, { n: '3_zadni', h: 180 }, { n: '4_leva', h: 270 }]
    const ac = new AbortController(); abortRef.current = ac
    setCutoutBusy(true); setCutoutPct(0); setCutoutProgress('připravuji pohledy…')
    const ents = [...parcelsRef.current.values()].flatMap(p => p.ents)
    const prevShow = ents.map(e => e.show)
    ents.forEach(e => { e.show = false }) // schovej tyrkysové zvýraznění → čisté snímky
    // Snímek chceme ostřejší než obrazovka. `resolutionScale` se ale násobí ještě rozlišením
    // displeje (viewer jede v device pixelech), takže napevno zvolené 2× by na 150% displeji
    // znamenalo 9× pixelů. Míříme proto na PEVNÝ počet pixelů (~12 Mpx, dost na A4/300 dpi)
    // a dopočítáme si, jaké násobení to je — nikdy míň, než na kolik je scéna nastavená.
    const prevScale = v.resolutionScale
    const cw = v.scene.canvas.clientWidth || 1, ch = v.scene.canvas.clientHeight || 1
    const dpr = window.devicePixelRatio || 1
    v.resolutionScale = Math.min(3, Math.max(sharpness, Math.sqrt(12e6 / (cw * ch)) / dpr))
    try {
      const files: Record<string, Uint8Array> = {}
      let i = 0
      for (const d of dirs) {
        if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
        i++; setCutoutProgress(`pohled ${i}/4…`); setCutoutPct(i / 4)
        v.camera.lookAt(bs.center, new Cesium.HeadingPitchRange(Cesium.Math.toRadians(d.h), pitch, range))
        await waitTilesLoaded(v, ac.signal, 9000)
        files[`pohled_${d.n}.png`] = await captureCanvasPng(v)
      }
      download(zipSync(files), 'pohledy_budova.zip', 'application/zip')
      toast.success('Vyvedeny 4 pohledy (PNG)')
    } catch (e) {
      if (isAbortError(e)) toast.info('Snímkování zrušeno')
      else { console.error('Snímkování selhalo:', e); toast.error(e instanceof Error ? e.message : 'Snímkování selhalo') }
    } finally {
      v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY) // uvolni kameru zpět do volného režimu
      v.resolutionScale = prevScale
      ents.forEach((e, k) => { e.show = prevShow[k] })
      abortRef.current = null; setCutoutBusy(false); setCutoutProgress(''); setCutoutPct(-1)
    }
  }

  // přepínání podkladu: ČÚZK imagery (ortofoto/ZTM/katastr na glóbu) vs Google 3D dlaždice
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const google = base === 'google'
    // „Google jen ve výběru" (parcelClip==='g3d'): podklad zůstává topo/ortofoto (google=false),
    // ale Google dlaždice se přesto načtou a zobrazí — jen je updateExcavation inverzně ořízne na parcely.
    const googleWanted = google || parcelClip === 'g3d'
    // v google režimu zůstane pod 3D vidět plochá mapa (googleUnder) → jde přes ni „prosvítat"
    const showOrto = google ? googleUnder === 'ortofoto' : base === 'ortofoto'
    const showZtm = google ? googleUnder === 'zm' : base === 'zm'
    if (ortoRef.current) ortoRef.current.show = showOrto
    for (const t of ZTM_TIERS) {
      const layer = ztmRefs.current[t.code]
      if (layer) layer.show = showZtm && t.code === ztmTier
    }
    if (katastrRef.current) katastrRef.current.show = katastrOn
    v.scene.globe.show = google ? googleUnder !== 'none' : true // 'none' = čistě 3D, glóbus schovat

    // Načítání dlaždic trvá vteřiny a `applyGoogleAlpha` níž si drží `base` z TOHOHLE průchodu.
    // Bez téhle pojistky by doběhlé stahování zaplo dlaždice podle podkladu, který už neplatí.
    let alive = true

    if (googleWanted) {
      setGoogleErr(null)
      setGoogleLoading(true)
      ensureGoogle(v)
        .then(ts => { if (alive && ts) { applyGoogleAlpha(); updateExcavation() } }) // po načtení nastav i ořez (g3d)
        .catch((e: unknown) => {
          console.error('Google 3D Tiles selhalo:', e)
          // Cesium RequestErrorEvent nese statusCode; podle něj poznáme, co je vážně špatně,
          // místo abychom natvrdo hlásili „chybí asset" (což bývá nejmíň častá příčina).
          const code = (e as { statusCode?: number })?.statusCode
          const msg = e instanceof Error ? e.message : String(e)
          if (code === 401 || /401|unauthor|token/i.test(msg))
            setGoogleErr('Google 3D: ion token odmítnut (401). Zkontroluj, že token v nasazené appce je platný a nemá doménové omezení, které blokuje tuhle stránku.')
          else if (code === 404)
            setGoogleErr('Google 3D: asset 2275207 nenalezen (404) — přidej „Google Photorealistic 3D Tiles" ve svém ion účtu (Asset Depot).')
          else
            setGoogleErr(`Google 3D se nenačetlo${code ? ` (HTTP ${code})` : ''}: ${msg}`)
        })
        .finally(() => setGoogleLoading(false))
    } else if (googleRef.current) {
      googleRef.current.show = false
      googleRef.current.style = undefined
    }

    return () => { alive = false }
  }, [base, ztmTier, katastrOn, googleUnder, parcelClip])

  // pozadí scény: hvězdy / přechod / plná barva. Řeší i barvu glóbu MIMO dostupná data
  // (ČÚZK končí na hranicích ČR) — jinak by kolem republiky svítil obdélník.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    applyBackground(v, bgMode, bgCustom, bgStageRef)
    sceneRef.current.patchState({ bgMode, bgCustom })
  }, [viewerReady, bgMode, bgCustom])

  // podklad mapy (ortofoto / topo / Google) patří ke scéně — po otevření má být ten, co jsi nechal
  useEffect(() => { sceneRef.current.patchState({ base }) }, [base])

  // průhlednost Google 3D dlaždic (přes styl) → nižší = víc prosvítá plochá mapa pod nimi
  function applyGoogleAlpha() {
    const ts = googleRef.current
    if (!ts) return
    if (base !== 'google') {
      // „Google jen ve výběru": tvar dělá inverzní ořez (updateExcavation), průhlednost přes googleAlpha. Jinak skrýt.
      if (parcelClip === 'g3d') {
        ts.show = googleAlpha > 0.005
        ts.style = googleAlpha >= 0.995 ? undefined : new Cesium.Cesium3DTileStyle({ color: `color('white', ${googleAlpha.toFixed(3)})` })
      } else ts.show = false
      return
    }
    ts.show = googleAlpha > 0.005
    ts.style = googleAlpha >= 0.995 ? undefined : new Cesium.Cesium3DTileStyle({ color: `color('white', ${googleAlpha.toFixed(3)})` })
  }
  useEffect(() => { applyGoogleAlpha() }, [googleAlpha, base])

  // řez terénem: svislá clipping rovina v místě vybraného modelu (jinak střed pohledu); odřízne terén i Google
  function applySection() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (!sectionOn) {
      v.scene.globe.clippingPlanes = undefined as unknown as Cesium.ClippingPlaneCollection
      if (googleRef.current) googleRef.current.clippingPlanes = undefined as unknown as Cesium.ClippingPlaneCollection
      return
    }
    const e = selectedId ? modelsRef.current.get(selectedId) : null
    let lon: number, lat: number, h: number
    if (e) { lon = e.placement.lon; lat = e.placement.lat; h = e.placement.groundH }
    else { const c = viewCenterGround(v); lon = c.lon; lat = c.lat; h = c.height }
    const originECEF = Cesium.Cartesian3.fromDegrees(lon, lat, h)
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(originECEF)
    const az = Cesium.Math.toRadians(sectionAz)
    const sign = sectionFlip ? -1 : 1
    const nx = sign * Math.cos(az), ny = sign * Math.sin(az)
    // vlastní instance kolekce i roviny pro každý cíl (nesdílet!)
    const mk = () => new Cesium.ClippingPlaneCollection({
      planes: [new Cesium.ClippingPlane(new Cesium.Cartesian3(nx, ny, 0), sectionOffset)],
      modelMatrix, edgeColor: MODEL_GLOW, edgeWidth: 1.0,
    })
    v.scene.globe.clippingPlanes = mk()
    if (googleRef.current) googleRef.current.clippingPlanes = mk()
  }
  useEffect(() => { applySection() }, [sectionOn, sectionAz, sectionOffset, sectionFlip, selectedId, base])

  // promítnutí stavu umístění do matice VYBRANÉHO modelu
  useEffect(() => {
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (e && placement) {
      e.placement = placement
      e.model.modelMatrix = buildMatrix(placement, e.center, e.yawDeg)
      saveModel(e) // odloženě → tažení sliderem nevystřelí request na každý pixel
    }
  }, [placement])

  // reset ořezu: vypni parcelový ořez, ztlumení i masky modelů → zase je vidět celá mapa (i Google 3D)
  function resetClipping() {
    const v = viewerRef.current
    for (const m of modelsRef.current.values()) m.excavate = false
    setParcelBuffer(0)
    setOkoliVis(0)
    setKeep3DAround(true)
    setParcelClip('off')
    if (v && !v.isDestroyed()) {
      v.scene.globe.clippingPolygons = undefined as unknown as Cesium.ClippingPolygonCollection
      if (googleRef.current) googleRef.current.clippingPolygons = undefined as unknown as Cesium.ClippingPolygonCollection
      if (dimRafRef.current != null) { cancelAnimationFrame(dimRafRef.current); dimRafRef.current = null }
      dimAlphaRef.current = 0
      if (dimEntityRef.current) { v.entities.remove(dimEntityRef.current); dimEntityRef.current = null }
    }
    setObjects(list => [...list]) // překreslit panel (tlačítka masek modelů)
  }

  // režim přesunu: tažení vybraného modelu po mapě (kamera se při tahu vypne)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !moveMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    let dragging = false
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
      const picked = v.scene.pick(evt.position)
      if (picked && e && picked.primitive === e.model) {
        dragging = true
        v.scene.screenSpaceCameraController.enableInputs = false
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!dragging) return
      const g = pickTerrain(v, evt.endPosition)
      if (g) setPlacement(p => p ? { ...p, lon: g.lon, lat: g.lat, groundH: g.height } : p)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    const end = () => { if (dragging) { dragging = false; v.scene.screenSpaceCameraController.enableInputs = true } }
    handler.setInputAction(end, Cesium.ScreenSpaceEventType.LEFT_UP)
    // `v.scene` si držíme z registrace — při zániku komponenty je viewer už zničený a getter
    // by spadl (Viewer.isDestroyed() to nezachytí, v Cesiu vrací vždy false).
    const ssc = v.scene.screenSpaceCameraController
    return () => { handler.destroy(); ssc.enableInputs = true }
  }, [moveMode])

  // TEST: tažení splatu po terénu (posun jeho kotvy). Levé táhne splat, pravé posouvá mapu (jako dlaždice).
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !splatMove) return
    const cam = v.scene.screenSpaceCameraController
    const prevRotate = cam.rotateEventTypes, prevZoom = cam.zoomEventTypes
    cam.rotateEventTypes = [Cesium.CameraEventType.RIGHT_DRAG]
    cam.zoomEventTypes = [Cesium.CameraEventType.PINCH] // kolečko obsluhuje naše plynulé přiblížení
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    let dragging = false
    const moveTo = (screen: Cesium.Cartesian2) => { const g = pickTerrain(v, screen); if (g) updateSplat({ lon: g.lon, lat: g.lat, groundH: g.height }) }
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => { dragging = true; cam.enableInputs = false; moveTo(e.position) }, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => { if (dragging) moveTo(e.endPosition) }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    const end = () => { if (dragging) { dragging = false; cam.enableInputs = true } }
    handler.setInputAction(end, Cesium.ScreenSpaceEventType.LEFT_UP)
    window.addEventListener('pointerup', end)
    return () => {
      handler.destroy(); window.removeEventListener('pointerup', end)
      if (!v.isDestroyed()) { cam.enableInputs = true; cam.rotateEventTypes = prevRotate; cam.zoomEventTypes = prevZoom }
    }
  }, [splatMove])

  // TEST: vlícovací režim — klikni bod NA SPLATU (depth buffer), pak TENTÝŽ bod NA MAPĚ (terén).
  // LEFT_CLICK (ne drag) → kamera se dá pořád normálně ovládat tažením mezi kliky.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !splatCP) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    // Splaty NEzapisují hloubku → pickPosition by vracelo terén za nimi. Proto obojí bereme jako bod
    // na TERÉNU (ray na globus): u ZEMNÍCH prvků (pata zdi, značka) je terén pod nakresleným prvkem ≈
    // aktuální světová poloha toho prvku ve splatu — spolehlivé bez závislosti na hloubce splatu.
    const mark = (w: Cesium.Cartesian3, color: Cesium.Color) => {
      cpEntsRef.current.push(v.entities.add({
        position: w,
        point: { pixelSize: 13, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }))
    }
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickTerrain(v, e.position)
      if (!g) { toast.error('Miř na terén/mapu (u země)'); return }
      const w = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      if (!cpPendingRef.current) {
        cpPendingRef.current = [w.x, w.y, w.z]; setCpPending(true) // ➊ kde prvek JE ve splatu teď
        mark(w, Cesium.Color.CYAN)
      } else {
        const from = Cesium.Cartesian3.unpack(cpPendingRef.current)
        mark(w, Cesium.Color.LIME) // ➋ kam PATŘÍ
        cpEntsRef.current.push(v.entities.add({ polyline: { positions: [from, w], width: 2, arcType: Cesium.ArcType.NONE, material: Cesium.Color.YELLOW } }))
        cpRef.current.push({ s: cpPendingRef.current, q: [w.x, w.y, w.z] })
        cpPendingRef.current = null; setCpPending(false); setCpCount(cpRef.current.length)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [splatCP])

  // režim výběru parcely: klik → načti obrys z katastru a vykresli polygon
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !parcelMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction(async (evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) return
      setParcelLoading(true)
      const parcel = await fetchParcelAt(g.lon, g.lat)
      setParcelLoading(false)
      if (parcel) toggleParcelSel(parcel)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [parcelMode])

  // Režim přidání popisku: klik do mapy položí kotvu. Popisek se rovnou přiřadí aktivnímu pohledu,
  // aby po vytvoření hned vyjel — jinak by uživatel udělal popisek a nic by se nestalo.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !calloutMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) { toast.info('Tady se nepodařilo najít povrch'); return }
      const p = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      const last = calloutStyleRef.current
      const c: Callout = { id: `c${Date.now()}`, text: 'Nový popisek', anchor: [p.x, p.y, p.z], off: [110, -80], views: activeViewId ? [activeViewId] : [], ...last }
      setCallouts(prev => { const next = [...prev, c]; saveCallouts(next); return next })  // funkční tvar → efekt nemusí viset na `callouts`
      setCalloutSel(c.id)
      setCalloutMode(false)
      if (!activeViewId) toast.info('Popisek vznikl, ale není vybraný žádný pohled — zůstane zasunutý')
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [calloutMode, activeViewId])

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
        point: { pixelSize: 9, color: Cesium.Color.ORANGE, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }))
      // výplň polygonu (od 3 bodů) — CallbackProperty ať se překresluje
      if (areaPtsRef.current.length === 3) {
        areaEntsRef.current.push(v.entities.add({
          polygon: {
            hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy(areaPtsRef.current), false),
            material: Cesium.Color.ORANGE.withAlpha(0.15),
            classificationType: Cesium.ClassificationType.BOTH,
          },
          polyline: {
            positions: new Cesium.CallbackProperty(() => [...areaPtsRef.current, areaPtsRef.current[0]], false),
            width: 2, material: Cesium.Color.ORANGE, clampToGround: true,
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
    setTileMode(true)
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
    const a = regionActiveRef.current
    if (!a) { toast.info('Nejdřív vyber území ve vyhledávání nahoře'); return }
    applyBulkTiles(tilesInRings(a.sjtskRings, tileSize), `Území ${a.name}`, true)
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
        const [clon, clat] = proj4('EPSG:5514', 'EPSG:4326', [cx, cy]) as [number, number]
        if (!pointInRing(clon, clat, poly)) continue
        // vybraná parcela → teprve teď reprojektuj celou geometrii (vnější prstenec i díry)
        const toCart = (r: number[][]) => r.map(([x, y]) => {
          const [lo, la] = proj4('EPSG:5514', 'EPSG:4326', [x, y]) as [number, number]
          return Cesium.Cartesian3.fromDegrees(lo, la)
        })
        addParcelSel({
          id: parcel.id, label: parcel.label, knArea: parcel.knArea,
          positions: toCart(parcel.ring), holes: parcel.holes.map(toCart),
        })
      }
    } finally {
      setAreaLoading(false)
      clearArea()
      setAreaMode(false)
    }
  }


  // ── měření: vrstva, ukládání a ovládání myší ────────────────────────────────────────────────
  function persistRulers(rs: RulerData[]) {
    setRulers(rs)
    sceneRef.current.patchState({ rulers: rs })
  }

  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const layer = new RulerLayer(v)
    rulerLayerRef.current = layer
    return () => { layer.destroy(); rulerLayerRef.current = null }
  }, [viewerReady])

  useEffect(() => { rulerLayerRef.current?.sync(rulers, rulerSel) }, [rulers, rulerSel, viewerReady])

  /**
   * Klikání a tažení bodů měření.
   *
   * Tažení má přednost před přidáním bodu: LEFT_DOWN se nejdřív podívá, jestli pod kurzorem není
   * existující bod. Když je, vypne se ovládání kamery a bod jede za myší; teprve když není, nechá
   * se událost projít a bod se přidá až na LEFT_CLICK (tedy po puštění, ne při tažení kamery).
   *
   * Během tažení se zapisuje rovnou do živých dat vrstvy — do Reactu se výsledek propíše až po
   * puštění, jinak by se při každém pohybu myší překresloval celý panel.
   *
   * Bod se bere z povrchu i s výškou (`pickGround` čte terén, modely i Google dlaždice), takže
   * měření sedí i na svahu a na budově.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !rulerMode) return
    const layer = rulerLayerRef.current
    if (!layer) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    const ssc = v.scene.screenSpaceCameraController
    let drag: { id: string; idx: number } | null = null
    // Cesium pošle LEFT_CLICK i po velmi krátkém tažení (nepřekročí práh pohybu). Bez téhle
    // pojistky by drobné posunutí bodu rovnou přidalo další bod na totéž místo.
    // Nuluje se při KAŽDÉM stisku, ne až v kliku — po opravdovém tažení totiž LEFT_CLICK vůbec
    // nepřijde a příznak by zůstal viset, takže by spolkl další klik.
    let justDragged = false

    const pointAt = (screen: Cesium.Cartesian2): RulerPoint | null => {
      const g = pickGround(v, screen)
      return g ? [g.lon, g.lat, g.height] : null
    }

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      justDragged = false
      const h = layer.hit(v.scene.pick(e.position))
      if (!h) return
      drag = h
      ssc.enableInputs = false
      setRulerSel(h.id)
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!drag) return
      const p = pointAt(e.endPosition)
      if (p) layer.liveMove(drag.id, drag.idx, p)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    const endDrag = () => {
      if (!drag) return
      const moved = drag
      drag = null
      justDragged = true
      ssc.enableInputs = true
      // živá data vrstvy jsou zdroj pravdy — přepiš z nich stav, ať se posun uloží
      persistRulers(rulersRef.current.map(r => r.id === moved.id ? { ...r, pts: [...r.pts] } : r))
    }
    handler.setInputAction(endDrag, Cesium.ScreenSpaceEventType.LEFT_UP)

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (drag || justDragged) return // klik bezprostředně po tažení bod nepřidává
      if (layer.hit(v.scene.pick(e.position))) return
      const p = pointAt(e.position)
      if (!p) { toast.error('Tady není povrch — klikni na terén nebo model'); return }
      const draft = rulerDraftRef.current
      if (draft) {
        persistRulers(rulersRef.current.map(r => r.id === draft ? { ...r, pts: [...r.pts, p] } : r))
      } else {
        const id = `m${Date.now()}`
        persistRulers([...rulersRef.current, { id, name: `${kindRef.current === 'area' ? 'Plocha' : 'Měření'} ${rulersRef.current.length + 1}`, pts: [p], kind: kindRef.current }])
        setRulerDraftId(id)
        setRulerSel(id)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    // pravý klik ukončí rozkreslené měření (kreslení dál pokračuje novým)
    handler.setInputAction(() => finishRuler(), Cesium.ScreenSpaceEventType.RIGHT_CLICK)

    return () => { handler.destroy(); ssc.enableInputs = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulerMode])

  /** Ukončí rozkreslené měření. Zahodí nedodělky, které nic neměří: čáru o jednom bodu
   *  a plochu, která nemá aspoň tři body (dvěma body se plocha vymezit nedá). */
  function finishRuler() {
    const draft = rulerDraftRef.current
    if (!draft) return
    const r = rulersRef.current.find(x => x.id === draft)
    const need = r?.kind === 'area' ? 3 : 2
    if (r && r.pts.length < need) persistRulers(rulersRef.current.filter(x => x.id !== draft))
    setRulerDraftId(null)
  }

  /** Zapnutí měření vypne ostatní klikací režimy — jinak by jeden klik dělal dvě věci naráz.
   *  Hotová měření v mapě ale zůstávají, ta na režimu nezávisí. */
  function startRuler(kind: 'line' | 'area') {
    if (rulerMode && rulerKind === kind) { finishRuler(); setRulerMode(false); return }
    finishRuler()                 // rozkreslené se ukončí, i když se jen přepíná druh
    setRulerKind(kind)
    claimMapClick('ruler')
    setRulerMode(true)
  }

  function delRuler(id: string) {
    persistRulers(rulersRef.current.filter(r => r.id !== id))
    if (rulerDraftRef.current === id) setRulerDraftId(null)
    if (rulerSel === id) setRulerSel(null)
  }

  function clearRulers() {
    persistRulers([])
    setRulerDraftId(null)
    setRulerSel(null)
  }
  function toggleAreaMode() {
    if (areaMode) { clearArea(); setAreaMode(false); return }
    claimMapClick('area')
    exclusiveSelect('parcel') // oblast parcely plní → jejich data nemazat, jen ostatní zdroje
    setAreaMode(true)
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
    if (!tiles.length) return
    const per = tiles.length > 400 ? 2 : 8
    const fill = MODEL_GLOW.withAlpha(0.12)
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
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(MODEL_GLOW) },
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
  }

  /** Zapne/vypne dlaždici. Idempotentní — malování tahem po ní jezdí opakovaně. */
  function setTileSelected(tile: Tile, on: boolean) {
    const key = tileKey(tile)
    if (on === tilesRef.current.has(key)) return
    if (on) tilesRef.current.set(key, tile); else tilesRef.current.delete(key)
    setTileCount(tilesRef.current.size)
    scheduleTileGfx()
  }

  function clearTiles() {
    tilesRef.current.clear()
    setTileCount(0)
    scheduleTileGfx()
  }

  function toggleTileMode() {
    if (tileMode) { setTileMode(false); setGridOn(false); return } // ať mřížka nezůstane viset bez tlačítka
    claimMapClick('tile')
    exclusiveSelect('tile') // zruš parcely/oblast/území — jen jeden zdroj výběru naráz
    setTileMode(true)
  }

  // jiná velikost = jiná mřížka; míchat čtverce dvou velikostí by dělalo překryvy
  function changeTileSize(s: TileSize) {
    if (s === tileSize) return
    clearTiles()
    setTileSize(s)
  }

  // ── Overlay mřížky dlaždic s názvy (jako kladení listů na ČÚZK) ──────────────────
  // Přepočítává se podle pohledu kamery. Aby to nezahltilo scénu, čáry i názvy mají strop:
  // moc dlaždic ve výřezu → napíšeme „přibliž" místo tisíců entit.
  const GRID_MAX_LINES = 4000  // nad tolik dlaždic nekreslíme ani čáry
  const GRID_MAX_LABELS = 400  // nad tolik jen čáry, názvy až po přiblížení

  function clearGrid() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) for (const e of gridEntsRef.current) v.entities.remove(e)
    gridEntsRef.current = []
  }

  function redrawGrid() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    clearGrid()
    if (!gridOn) { setGridNote(''); return }

    // co je vidět (obdélník lon/lat); při pohledu k horizontu je undefined
    const rect = v.camera.computeViewRectangle(v.scene.globe.ellipsoid)
    if (!rect) { setGridNote('Naklop kameru na mapu'); return }
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
    if (count <= 0 || count > GRID_MAX_LINES) { setGridNote(count > GRID_MAX_LINES ? 'Přibliž pro zobrazení mřížky' : ''); return }

    // přímka v S-JTSK je ve WGS84 mírně zakřivená → zhustit body na hranách buněk
    const linePts = (x0: number, y0: number, x1: number, y1: number, seg: number) => {
      const out: Cesium.Cartesian3[] = []
      for (let k = 0; k <= seg; k++) { const t = k / seg; const [lo, la] = wgsOf(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t); out.push(Cesium.Cartesian3.fromDegrees(lo, la)) }
      return out
    }
    const gridColor = MODEL_GLOW.withAlpha(0.55)
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

    // názvy do středů buněk — jen když jich není moc, jinak by se překrývaly a brzdily
    if (count > GRID_MAX_LABELS) { setGridNote(`${count} dlaždic — přibliž pro názvy`); return }
    setGridNote('')
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const [lo, la] = wgsOf((ix + 0.5) * size, (iy + 0.5) * size)
        gridEntsRef.current.push(v.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lo, la),
          label: {
            text: `${ix}, ${iy}`,
            font: 'bold 12px monospace',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2000, 1.0, 30000, 0.5),
          },
        }))
      }
    }
  }

  // překresli mřížku při zapnutí, změně velikosti dlaždice a po každém pohybu kamery
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    redrawGrid()
    if (!gridOn) return
    const off = () => redrawGrid()
    // událost si držíme z registrace, ať cleanup nesahá na getter zničeného viewru (viz výše)
    const moveEnd = v.camera.moveEnd
    moveEnd.addEventListener(off)
    return () => { moveEnd.removeEventListener(off); clearGrid() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOn, tileSize])

  // ── dlouhé exporty: jeden ukazatel průběhu, jedno zrušení, jedno místo na chyby ────────────
  // Vlastní práci dělají moduly v `export/` — ty stav komponenty neznají a dostanou jen `ExportCtx`
  // (signál zrušení + hlášení průběhu) a vrátí hlášku pro úspěšný toast. Tady zůstala jen obsluha:
  // zamknout tlačítka, nastavit ukazatel, přeložit chybu na toast a po sobě uklidit. Dřív měl tuhle
  // pětiřádkovou obálku každý export vlastní (a každý o kousek jinak).
  type ExportUi = { busy: boolean; setBusy: (b: boolean) => void; setPct: (p: number) => void; setMsg: (m: string) => void }
  const tileUi: ExportUi = { busy: tileBusy, setBusy: setTileBusy, setPct: setTilePct, setMsg: setTileProgress }
  const cutoutUi: ExportUi = { busy: cutoutBusy, setBusy: setCutoutBusy, setPct: setCutoutPct, setMsg: setCutoutProgress }

  async function runExport(ui: ExportUi, failMsg: string, job: (ctx: ExportCtx) => Promise<string>) {
    if (ui.busy) return
    const ac = new AbortController()
    abortRef.current = ac
    ui.setBusy(true); ui.setPct(-1); ui.setMsg('připravuji…')
    try {
      toast.success(await job({ signal: ac.signal, report: (pct, msg) => { ui.setPct(pct); ui.setMsg(msg) } }))
    } catch (e) {
      if (isAbortError(e)) { toast.info('Export zrušen'); return }
      console.error(`${failMsg}:`, e)
      toast.error(e instanceof Error ? e.message : failMsg)
    } finally {
      abortRef.current = null
      ui.setBusy(false); ui.setMsg(''); ui.setPct(-1)
    }
  }

  async function exportTilesObj() {
    const tiles = [...tilesRef.current.values()]
    if (!tiles.length) return
    await runExport(tileUi, 'Export dlaždic selhal', ctx =>
      exportTilesObjCore(tiles, { tileSize, meshStep, texSize, buildings: exportBuildings, katastr: exportKatastr }, ctx))
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
    if (big && !hasPicker && !confirm(
      `Odhad ${fmtBytes(est.bytes)} v ${tiles.length} dlaždicích.\n\n` +
      'Tenhle prohlížeč neumí zapisovat rovnou na disk, takže se zip poskládá v paměti a u téhle ' +
      'velikosti může spadnout. Doporučuju hrubší rozlišení, nebo Chrome/Edge.\n\nPokračovat?')) return
    await runExport(tileUi, 'Export mapy selhal', ctx =>
      exportMapTilesCore(tiles, { tileSize, res: mapRes, layer: mapLayer, toDisk: big && hasPicker }, ctx))
  }

  /**
   * Jeden spojený GeoTIFF — pro Photoshop a After Effects, kde se s dlaždicemi pracovat nedá.
   *
   * Nepočítá se přes canvas, takže neplatí jeho strop 16 384 px: zapisuje se po pruzích rovnou
   * do souboru. Limitem je až samotný cíl — kompozice v AE končí na 30 000 px, Photoshop na
   * 300 000, klasický TIFF na 4 GB. Co z toho projde, ukazuje odhad v panelu.
   */
  async function exportOneGeoTiff(bbox: { x0: number; y0: number; x1: number; y1: number }, clip: number[][][] | undefined, label: string) {
    const plan = planGeoTiff(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0, mapRes, !!clip)
    if (!plan.tiffOk) { toast.error(`${plan.W}×${plan.H} px = ${fmtBytes(plan.bytes)}. Klasický TIFF má strop 4 GB — zvol hrubší detail.`); return }
    const hasPicker = 'showSaveFilePicker' in window
    const warn = [
      !plan.afterEffectsOk && 'After Effects zvládne kompozici do 30 000 px — tohle je nad to',
      !plan.photoshopOk && 'Photoshop zvládne do 300 000 px na stranu — tohle je nad to',
    ].filter(Boolean).join('\n')
    if (!confirm(`${label}\n${plan.W}×${plan.H} px · ${fmtBytes(plan.bytes)}${warn ? `\n\n${warn}` : ''}\n\nExportovat?`)) return
    await runExport(cutoutUi, 'Export mapy selhal', ctx =>
      exportGeoTiffCore(bbox, {
        res: mapRes, layer: mapLayer, clip,
        toDisk: plan.bytes > 500e6 && hasPicker,
        name: `mapa_${mapLayer}_${String(mapRes).replace('.', '_')}m.tif`,
      }, ctx))
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

  /** Spojený GeoTIFF obálky vybraných dlaždic (bez ořezu — dlaždice tvoří obdélník). */
  function exportTilesGeoTiff() {
    const tiles = [...tilesRef.current.values()]
    if (!tiles.length) { toast.info('Nejsou vybrané žádné dlaždice'); return }
    const b = tilesBounds(tiles)
    void exportOneGeoTiff({ x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY }, undefined, `${tiles.length} dlaždic`)
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
    if (!confirm(`${a.name}: ${res.length} dlaždic, ~${fmtBytes(est.bytes)}${big && !hasPicker ? '\n\nTenhle prohlížeč neumí zápis na disk — u téhle velikosti může spadnout.' : ''}\n\nExportovat?`)) return
    await runExport(cutoutUi, 'Export mapy selhal', ctx =>
      exportMapTilesCore(res, { tileSize, res: mapRes, layer: mapLayer, toDisk: big && hasPicker, clip: a.sjtskRings }, ctx))
  }


  // Stáhne ortofoto vybrané oblasti NATRVALO do prohlížeče (IndexedDB, připnuté). Používá GEOGRAPHIC
  // dlaždice STEJNÉ soustavy jako WMS (klíč owms/level/x/y) → po stažení se ta oblast bere z cache,
  // Znovu vytvoří ortofoto vrstvu → Cesium přepošle žádosti o dlaždice (napečené se hned vezmou z localu,
  // bez nutnosti popojet/refreshovat). Zachová pozici ve stacku i viditelnost.
  function refreshOrtoLayer() {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !ortoRef.current) return
    const layers = v.scene.imageryLayers
    const idx = layers.indexOf(ortoRef.current)
    const show = ortoRef.current.show
    layers.remove(ortoRef.current, true)
    const layer = layers.addImageryProvider(ortofotoProvider(), idx >= 0 ? idx : undefined)
    layer.show = show
    ortoRef.current = layer
  }

  // Smaže celou lokální mapu (napečené dlaždice) → zpět na živé ČÚZK.
  function clearBaked() {
    bakedClear().then(() => { bakedKeys.clear(); setBakedInfo(0); refreshOrtoLayer() }).catch(() => {})
  }

  // ── Vlastní ortofoto (snímek + world file) ─────────────────────────────────────────
  // Rastr jde do stacku HNED POD katastr, tedy nad ČÚZK podklad: překryje ortofoto i topo,
  // ale čáry a čísla parcel zůstanou nahoře. Průhlednost rozhoduje, jestli se to s mapou
  // jen prolne, nebo ten kus mapy natvrdo nahradí.
  function rasterIndex(v: Cesium.Viewer): number | undefined {
    const idx = katastrRef.current ? v.scene.imageryLayers.indexOf(katastrRef.current) : -1
    return idx >= 0 ? idx : undefined
  }

  const fmtGsd = (m: number) => (m < 1 ? `${Math.round(m * 100)} cm/px` : `${m.toFixed(1)} m/px`)

  /**
   * Vloží už dekódovaný rastr do mapy a do panelu. Sdílí to import z disku i obnova scény
   * z úložiště — jinak by se vrstva, pořadí a pyramida řešily dvakrát a rozešly se.
   */
  function mountRaster(
    v: Cesium.Viewer,
    raster: GeoRaster,
    opts: { crsId?: CrsId; alpha?: number; visible?: boolean; assetId?: string; fly?: boolean },
  ): { id: string; gsd: number; cut: boolean } {
    const crsId = opts.crsId ?? raster.crsId
    const view = makeRasterView(raster, crsId)
    const layer = v.scene.imageryLayers.addImageryProvider(view.provider, rasterIndex(v))
    layer.alpha = opts.alpha ?? 1
    layer.show = opts.visible ?? true
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    rastersRef.current.set(id, { raster, layer, rect: view.rectangle })
    // Snímek se zmenšuje jen když by se do paměti prohlížeče nevešel — ale pak to není
    // vidět na první pohled, tak se to řekne nahlas, ať se kvalita neztratí potichu.
    const cut = raster.src.width !== raster.native.w
    setRasterList(prev => [...prev, {
      id, name: raster.name, crsId, visible: layer.show, alpha: layer.alpha, gsd: view.gsd,
      assetId: opts.assetId,
      px: cut
        ? `${raster.src.width}×${raster.src.height} px (z ${raster.native.w}×${raster.native.h})`
        : `${raster.src.width}×${raster.src.height} px · nativní`,
    }])
    if (opts.fly) v.camera.flyTo({ destination: view.rectangle, duration: 1.2 })
    return { id, gsd: view.gsd, cut }
  }

  async function importRasters(files: File[]) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const pairs = pairRasterFiles(files)
    if (!pairs.length) { toast.error('Vyber snímek (JPG/PNG/TIF) a k němu world file (.jgw/.pgw/.tfw)'); return }
    setRasterBusy(true)
    let flew = false
    try {
      for (const { image, world, prj } of pairs) {
        // dekódovaný snímek visí v paměti (bitmap + pyramida) → dokud si ho nepřevezme
        // rastersRef, drží se tady, ať ho případná chyba po cestě uklidí
        let pending: GeoRaster | null = null
        try {
          const raster = await loadGeoRaster(image, world, prj)
          pending = raster
          if (v.isDestroyed()) return
          const fly = !flew
          const { id, gsd, cut } = mountRaster(v, raster, { fly })
          pending = null
          if (fly) flew = true
          if (cut) toast.warning(`„${raster.name}" se musel zmenšit na ${raster.src.width}×${raster.src.height} px — na plné rozlišení nestačí paměť prohlížeče`)
          else toast.success(`Snímek „${raster.name}" usazen v plném rozlišení — ${CRS_LABELS[raster.crsId]}, ${fmtGsd(gsd)}`)
          // Nahrání běží na pozadí: rastr je v mapě hned, `assetId` do panelu dojde, jak se
          // upload dokončí. Čekat na síť před zobrazením by import jen zdržovalo.
          void uploadRaster(id, image, world ?? null, raster.crsId)
        } catch (e) {
          console.error('Import rastru selhal:', e)
          toast.error(e instanceof Error ? e.message : `Import „${image.name}" selhal`)
        } finally { if (pending) disposeRasterSrc(pending.src) }
      }
    } finally { setRasterBusy(false) }
  }

  /** Uloží snímek i jeho world file do scény a doplní `assetId` do panelu. */
  async function uploadRaster(id: string, image: File, sidecar: File | null, crsId: CrsId) {
    try {
      const asset = await sceneRef.current.uploadAsset({
        kind: 'raster',
        name: image.name.replace(/\.[^.]+$/, ''),
        file: image,
        sidecar,
        config: { crsId, rasterAlpha: 1, rasterVisible: true },
      })
      setRasterList(prev => prev.map(r => (r.id === id ? { ...r, assetId: asset.id } : r)))
      // Než upload dojel, mohl uživatel hýbat průhledností nebo rastr zhasnout — a `saveRasterCfg`
      // to zahodila, protože ještě nebylo kam zapsat. Živou pravdu drží vrstva, tak ji dopíšeme.
      const layer = rastersRef.current.get(id)?.layer
      if (layer) {
        sceneRef.current.patchAssetConfig(asset.id, {
          crsId, rasterAlpha: layer.alpha, rasterVisible: layer.show,
        })
      }
    } catch (e) {
      console.error('Uložení rastru selhalo:', e)
      toast.error(e instanceof Error ? e.message : 'Rastr se nepodařilo uložit do scény — po refreshi zmizí')
    }
  }

  /** Nastavení rastru tak, jak se ukládá k jeho souboru. */
  function saveRasterCfg(id: string, patchCfg: { crsId?: CrsId; alpha?: number; visible?: boolean }) {
    const r = rasterList.find(x => x.id === id)
    if (!r?.assetId) return
    sceneRef.current.patchAssetConfig(r.assetId, {
      crsId: patchCfg.crsId ?? r.crsId,
      rasterAlpha: patchCfg.alpha ?? r.alpha,
      rasterVisible: patchCfg.visible ?? r.visible,
    })
  }

  // Ruční oprava soustavy, když ji odhad trefil špatně (snímek je pak jinde nebo zrcadlově).
  // Přepočítá se jen georeference — dekódované pixely i pyramida zůstávají, je to okamžité.
  function setRasterCrs(id: string, crsId: CrsId) {
    const v = viewerRef.current
    const e = rastersRef.current.get(id)
    if (!v || v.isDestroyed() || !e) return
    let view: ReturnType<typeof makeRasterView>
    try { view = makeRasterView(e.raster, crsId) }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Přepnutí soustavy selhalo'); return }
    const layers = v.scene.imageryLayers
    const idx = layers.indexOf(e.layer)
    const show = e.layer.show, alpha = e.layer.alpha
    layers.remove(e.layer, true)
    const layer = layers.addImageryProvider(view.provider, idx >= 0 ? idx : rasterIndex(v))
    layer.show = show; layer.alpha = alpha
    rastersRef.current.set(id, { raster: e.raster, layer, rect: view.rectangle })
    setRasterList(prev => prev.map(r => (r.id === id ? { ...r, crsId, gsd: view.gsd } : r)))
    saveRasterCfg(id, { crsId })
    v.camera.flyTo({ destination: view.rectangle, duration: 1.0 })
  }

  function setRasterAlpha(id: string, alpha: number) {
    const e = rastersRef.current.get(id)
    if (e) e.layer.alpha = alpha
    setRasterList(prev => prev.map(r => (r.id === id ? { ...r, alpha } : r)))
    saveRasterCfg(id, { alpha })
  }

  function toggleRaster(id: string) {
    const e = rastersRef.current.get(id)
    if (!e) return
    e.layer.show = !e.layer.show
    setRasterList(prev => prev.map(r => (r.id === id ? { ...r, visible: e.layer.show } : r)))
    saveRasterCfg(id, { visible: e.layer.show })
  }

  function removeRaster(id: string) {
    const v = viewerRef.current
    const e = rastersRef.current.get(id)
    const assetId = rasterList.find(r => r.id === id)?.assetId
    if (e) {
      if (v && !v.isDestroyed()) v.scene.imageryLayers.remove(e.layer, true)
      disposeRasterSrc(e.raster.src)
      rastersRef.current.delete(id)
    }
    setRasterList(prev => prev.filter(r => r.id !== id))
    if (assetId) void sceneRef.current.deleteAsset(assetId).catch(err => {
      console.error('Smazání rastru z úložiště selhalo:', err)
      toast.error('Rastr zmizel z mapy, ale v úložišti zůstal — zkus to znovu po refreshi')
    })
  }

  function locateRaster(id: string) {
    const v = viewerRef.current
    const e = rastersRef.current.get(id)
    if (v && !v.isDestroyed() && e) v.camera.flyTo({ destination: e.rect, duration: 1.0 })
  }

  // Jádro „Načíst 2D lokálně": pro danou lon/lat obálku NAPEČE ortofoto DLAŽDICE (pyramidu) do localu
  // v nativním rozlišení. Používá STEJNOU GeographicTilingScheme jako WMS zobrazení (klíč owms/L/x/y),
  // takže se napečené dlaždice zobrazí přesně na svém místě a dekódují se identicky jako živé WMS.
  // Úrovně 12..18 (18 ≈ 15 cm/px, nad nativem ortofota 20 cm); maxLevel se sníží, aby počet dlaždic
  // nepřekročil strop. Kvalita se NEZHORŠUJE s velikostí (načítá se jen viditelné). Jednorázové,
  // zrušitelné, RESUMABLE (co je napečené, znovu nestahuje), uložené natrvalo (přežije refresh/offline).
  async function bakeAreaPyramid(minLon: number, minLat: number, maxLon: number, maxLat: number) {
    const v = viewerRef.current
    const provider = ortoRef.current?.imageryProvider
    if (!v || v.isDestroyed() || tileBusy) return
    if (!(provider instanceof CachedWmsOrtho)) { toast.error('Lokální mapa není v tomto režimu k dispozici'); return }
    if (!(maxLon > minLon && maxLat > minLat)) { toast.error('Neplatná oblast'); return }
    const ts = provider.tilingScheme as Cesium.GeographicTilingScheme
    const sw = Cesium.Cartographic.fromDegrees(minLon, minLat), ne = Cesium.Cartographic.fromDegrees(maxLon, maxLat)
    const MIN_LEVEL = 12, CAP = 12000
    const rangeAt = (level: number) => {
      const a = ts.positionToTileXY(sw, level), b = ts.positionToTileXY(ne, level)
      if (!a || !b) return null
      return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) }
    }
    const countTo = (top: number) => { let n = 0; for (let L = MIN_LEVEL; L <= top; L++) { const r = rangeAt(L); if (r) n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) } return n }
    let maxLevel = 18
    while (maxLevel > 14 && countTo(maxLevel) > CAP) maxLevel-- // velká oblast → o úroveň hrubší, ať to nezabije ČÚZK/disk
    const list: { x: number; y: number; level: number }[] = []
    for (let L = MIN_LEVEL; L <= maxLevel; L++) { const r = rangeAt(L); if (!r) continue; for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) list.push({ x, y, level: L }) }
    if (!list.length) { toast.error('Oblast nemá dlaždice'); return }
    const cmpx = (180 / Math.pow(2, maxLevel)) / WMS_TILE * 111320 * 100 // ~cm/px v zeměpisné šířce na maxLevel

    const ac = new AbortController(); abortRef.current = ac
    setTileBusy(true); setTilePct(0); setTileProgress(`0/${list.length} dlaždic…`)
    let done = 0, fail = 0, added = 0
    try {
      await pool(list, 4, async ({ x, y, level }) => {
        if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
        const key = `owms/${level}/${x}/${y}`
        if (!bakedKeys.has(key)) {
          let bytes = await bakedGet(key) // resumable: co je napečené, znovu nestahuj
          if (!bytes) {
            const rct = ts.tileXYToRectangle(x, y, level)
            const url = orthoExport4326Url(Cesium.Math.toDegrees(rct.west), Cesium.Math.toDegrees(rct.south), Cesium.Math.toDegrees(rct.east), Cesium.Math.toDegrees(rct.north), WMS_TILE)
            bytes = await fetchOrthoUrl(url, ac.signal)
          }
          if (bytes) { await bakedPut(key, bytes); bakedKeys.add(key); added++ } else fail++
        }
        done++
        if (done % 20 === 0 || done === list.length) { setTilePct(done / list.length); setTileProgress(`${done}/${list.length} dlaždic…`) }
      })
      setBakedInfo(bakedKeys.size)
      refreshOrtoLayer() // napečené dlaždice se hned použijí bez pan/refresh
      toast.success(`Lokální mapa napečena: ${added} dlaždic (~${cmpx.toFixed(0)} cm/px, z${maxLevel})${fail ? ` — ${fail} selhalo, pusť znovu` : ''}. Uloženo, přežije refresh.`)
    } catch (e) {
      setBakedInfo(bakedKeys.size)
      if (isAbortError(e)) toast.info(`Napékání zrušeno (${added} dlaždic zůstává uloženo)`)
      else { console.error('Napékání lokální mapy selhalo:', e); toast.error('Napékání selhalo') }
    } finally {
      abortRef.current = null; setTileBusy(false); setTileProgress(''); setTilePct(-1)
    }
  }

  // lokální mapa z VÝBĚRU DLAŽDIC (obálka S-JTSK dlaždic → lon/lat)
  async function loadLocal2DMap() {
    const tiles = [...tilesRef.current.values()]
    if (!tiles.length || tileBusy) return
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
    if (!a || tileBusy) return
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const ring of a.sjtskRings) for (const [x, y] of ring) {
      const [lo, la] = wgsOf(x, y)
      minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la)
    }
    await bakeAreaPyramid(minLon, minLat, maxLon, maxLat)
  }

  // ── TEST: Gaussian splat (Kryry) přes Cesium ion ──
  // Splat přijde v NÁHODNÉ lokální soustavě → posadíme přes buildMatrix (ENU + hpr + scale) na věž a
  // uživatel doladí měřítko/otočení/výšku ručně (přesný georef by chtěl kontrolní body).
  function applySplatMatrix(p: Placement) {
    if (splatRef.current) splatRef.current.modelMatrix = buildMatrix(p, Cesium.Cartesian3.ZERO)
  }
  function updateSplat(part: Partial<Placement>) {
    setSplatP(p => { const np = { ...p, ...part }; applySplatMatrix(np); return np })
  }
  async function loadSplat(fly = true) {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || splatRef.current || splatLoading) return
    setSplatLoading(true)
    try {
      const ts = await Cesium.Cesium3DTileset.fromIonAssetId(SPLAT_ASSET_ID)
      if (v.isDestroyed()) return
      v.scene.primitives.add(ts)
      splatRef.current = ts
      applySplatMatrix(splatP)
      setSplatOn(true); setSplatShow(true)
      // „byl zapnutý" se pamatuje ve scéně → po dalším otevření se načte sám
      sceneRef.current.patchState({ splat: { on: true, placement: splatP } })
      if (fly) {
        v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(SPLAT_ANCHOR.lon, SPLAT_ANCHOR.lat, SPLAT_ANCHOR.h + GEOID_CZ + 500) })
        toast.success('Splat načten (Kryry). Dolaď měřítko/otočení/výšku vpravo.')
      }
    } catch (e) { console.error('Splat load selhal:', e); if (fly) toast.error('Splat se nepodařilo načíst (asset ID / ion token / přístup k assetu?)') }
    finally { setSplatLoading(false) }
  }
  function removeSplat() {
    const v = viewerRef.current
    if (splatRef.current && v && !v.isDestroyed()) { try { v.scene.primitives.remove(splatRef.current) } catch { /* už není */ } }
    splatRef.current = null; setSplatOn(false); setSplatMove(false); setSplatCP(false); cpRef.current = []; cpPendingRef.current = null; setCpCount(0); setCpPending(false); clearCpEnts()
    // usazení si necháme (kdyby ho zapnul znovu), jen se už nenačte sám
    sceneRef.current.patchState({ splat: { on: false, placement: splatP } })
  }
  function flyToSplat() {
    const v = viewerRef.current
    if (v && !v.isDestroyed() && splatRef.current) v.flyTo(splatRef.current, { duration: 1.2 }).catch(() => {})
  }
  function toggleSplatShow() { setSplatShow(s => { const nv = !s; if (splatRef.current) splatRef.current.show = nv; return nv }) }
  // Snap na Kryry + odhad rozumné velikosti (z bounding sphere → cíl ~40 m poloměr) + narovnání.
  // Dobrý výchozí bod, když splat lítá / je obří / mrňavý.
  function resetSplat() {
    const ts = splatRef.current, v = viewerRef.current
    if (!ts || !v || v.isDestroyed()) return
    let scale = splatP.scale
    const r = ts.boundingSphere?.radius ?? 0
    if (r > 0 && splatP.scale > 0) { const localR = r / splatP.scale; if (localR > 1e-6) scale = 40 / localR }
    const np: Placement = { lon: SPLAT_ANCHOR.lon, lat: SPLAT_ANCHOR.lat, groundH: SPLAT_ANCHOR.h + GEOID_CZ, heightOffset: 0, heading: 0, pitch: 0, roll: SPLAT_BASE_ROLL, scale }
    setSplatP(np); applySplatMatrix(np)
    v.flyTo(ts, { duration: 1.0 }).catch(() => {})
  }
  // uloží ruční usazení splatu do scény (splat se pak načte rovnou zarovnaný)
  function saveSplat() {
    sceneRef.current.patchState({ splat: { on: splatOn, placement: splatP } })
    toast.success('Usazení splatu uloženo do scény.')
  }
  function clearCpEnts() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) for (const e of cpEntsRef.current) v.entities.remove(e)
    cpEntsRef.current = []
  }
  function clearCP() { cpRef.current = []; cpPendingRef.current = null; setCpPending(false); setCpCount(0); clearCpEnts() }
  // z nasbíraných dvojic spočítá similarity transformaci (Umeyama/Horn) a přemístí splat co nejblíž.
  function computeCP() {
    const pairs = cpRef.current
    if (pairs.length < 3) { toast.error('Potřebuju aspoň 3 body'); return }
    const sol = solveSimilarity(pairs.map(p => p.s), pairs.map(p => p.q))
    if (!sol) { toast.error('Body jsou v přímce/degenerované — vyber je rozházené a v různých výškách'); return }
    const { c, R, t, rms } = sol
    // C (svět→svět): q = c·R·s + t  (Matrix4 konstruktor = row-major argumenty)
    const C = new Cesium.Matrix4(
      c * R[0], c * R[1], c * R[2], t[0],
      c * R[3], c * R[4], c * R[5], t[1],
      c * R[6], c * R[7], c * R[8], t[2],
      0, 0, 0, 1,
    )
    const M0 = buildMatrix(splatP, Cesium.Cartesian3.ZERO)
    const M1 = Cesium.Matrix4.multiply(C, M0, new Cesium.Matrix4()) // nová modelMatrix = C·M0
    // rozklad M1 → Placement (aby posuvníky dál seděly)
    const t1 = Cesium.Matrix4.getTranslation(M1, new Cesium.Cartesian3())
    const carto = Cesium.Cartographic.fromCartesian(t1)
    if (!carto) { toast.error('Rozklad polohy selhal'); return }
    const scl = Cesium.Matrix4.getScale(M1, new Cesium.Cartesian3())
    const c1 = (scl.x + scl.y + scl.z) / 3
    const R3 = Cesium.Matrix4.getMatrix3(M1, new Cesium.Matrix3())
    Cesium.Matrix3.multiplyByScalar(R3, 1 / c1, R3) // odstraň měřítko → čistá rotace
    const rigid = Cesium.Matrix4.fromRotationTranslation(R3, t1, new Cesium.Matrix4())
    const hpr = Cesium.Transforms.fixedFrameToHeadingPitchRoll(rigid)
    const np: Placement = {
      lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude),
      groundH: carto.height, heightOffset: 0,
      heading: Cesium.Math.toDegrees(hpr.heading), pitch: Cesium.Math.toDegrees(hpr.pitch), roll: Cesium.Math.toDegrees(hpr.roll),
      scale: c1,
    }
    setSplatP(np); applySplatMatrix(np)
    clearCP() // splat se posunul → staré značky/body zahoď (klidně naklikej další kolo)
    toast.success(`Zarovnáno z ${pairs.length} bodů (odchylka ~${rms.toFixed(2)} m). Zbytek dolaď ručně a ulož.`)
  }

  async function exportStitchedMaps() {
    const tiles = [...tilesRef.current.values()]
    if (!tiles.length) return
    // S-JTSK obálka výběru (dlaždice jsou souvislé čtverce)
    let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity
    for (const t of tiles) { ix0 = Math.min(ix0, t.ix); ix1 = Math.max(ix1, t.ix); iy0 = Math.min(iy0, t.iy); iy1 = Math.max(iy1, t.iy) }
    await runExport(tileUi, 'Export mapy selhal', ctx =>
      stitchMapsCore(ix0 * tileSize, iy0 * tileSize, (ix1 + 1) * tileSize, (iy1 + 1) * tileSize, stitchMax, ctx))
  }

  // spojená 2D mapa (ortofoto + topo) pro vybrané správní území — přes obálku území
  async function exportRegionMaps() {
    const a = regionActiveRef.current
    if (!a) { toast.error('Nejdřív vyber a zobraz území'); return }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const r of a.sjtskRings) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    // ořez přesně na tvar území (jako výřez terénu) → PNG s alfou, okolí průhledné
    await runExport(cutoutUi, 'Export mapy selhal', ctx => stitchMapsCore(minX, minY, maxX, maxY, stitchMax, ctx, a.sjtskRings))
  }

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
        ground = (lon, lat) => { const e = sampler(lon, lat); return (e != null ? e : 350) + GEOID_CZ }
      } catch { ground = () => 350 + GEOID_CZ } // fallback: cca výška Liberce
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
    if (!v || v.isDestroyed() || !districtsOn || parcelMode || areaMode || moveMode || tileMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = v.scene.pick(evt.position) as { id?: { __district?: string } } | undefined
      const code = picked?.id?.__district
      if (code) selectDistrict(code)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [districtsOn, parcelMode, areaMode, moveMode, tileMode])

  // klik na parcelu ji přidá do výběru; klik na už vybranou ji odebere (multi)
  function toggleParcelSel(parcel: Parcel) {
    const pid = parcel.id || `p${Math.round(parcel.positions[0].x)}_${Math.round(parcel.positions[0].y)}`
    if (parcelsRef.current.has(pid)) { removeParcel(pid); return }
    addParcelSel(parcel)
  }

  // přidá parcelu do výběru (bez toggle) — sdílené klikem i výběrem oblasti
  function addParcelSel(parcel: Parcel) {
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
      // díry v hierarchii → tyrkys nepřekryje vykrojené parcely uvnitř (a lícuje s výměrou)
      polygon: { hierarchy: new Cesium.PolygonHierarchy(parcel.positions, holeCarts.map(h => new Cesium.PolygonHierarchy(h))), material: Cesium.Color.CYAN.withAlpha(0.25), classificationType: Cesium.ClassificationType.BOTH },
    })
    const border = v.entities.add({
      show: parcelHl,
      polyline: { positions: [...parcel.positions, parcel.positions[0]], width: 3, material: Cesium.Color.CYAN, clampToGround: true },
    })
    // obrys i kolem děr, ať je vidět, co je z parcely vykrojené
    const holeBorders = holeCarts.map(h => v.entities.add({
      show: parcelHl,
      polyline: { positions: [...h, h[0]], width: 2, material: Cesium.Color.CYAN.withAlpha(0.7), clampToGround: true },
    }))
    parcelsRef.current.set(pid, { positions: parcel.positions, ring, holes, knArea: parcel.knArea ?? 0, label: parcel.label ?? '', ents: [fill, border, ...holeBorders] })
    upsertObj({ id: `parcel-${pid}`, kind: 'parcel', name: `Parcela ${parcel.label || parcel.id || ''}`.trim(), visible: true })
    setParcelCount(parcelsRef.current.size)
    saveParcels()
    if (parcelClip !== 'off') { updateExcavation(); syncDim(true) } // ořez i ztlumení sledují výběr parcel
  }

  /**
   * Uloží vybrané parcely do scény — prstence v lon/lat, ať se po otevření nemusí znovu ptát
   * katastru (a výběr vydrží i to, že je ČÚZK zrovna nedostupný).
   */
  function saveParcels() {
    const list: SavedParcel[] = [...parcelsRef.current.entries()].map(([pid, p]) => ({
      pid, label: p.label, knArea: p.knArea,
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
      addParcelSel({ id: p.pid, label: p.label, knArea: p.knArea, positions: toCart(p.ring), holes: (p.holes ?? []).map(toCart) })
    }
  }

  function removeParcel(pid: string) {
    const v = viewerRef.current
    const p = parcelsRef.current.get(pid)
    if (p && v && !v.isDestroyed()) p.ents.forEach(e => v.entities.remove(e))
    parcelsRef.current.delete(pid)
    removeObj(`parcel-${pid}`)
    setParcelCount(parcelsRef.current.size)
    saveParcels()
    if (parcelClip !== 'off') { updateExcavation(); syncDim(true) }
  }

  function clearAllParcels() {
    for (const pid of [...parcelsRef.current.keys()]) removeParcel(pid)
    if (parcelClip !== 'off') setParcelClip('off') // vypni ořez i ztlumení (effect přepočítá)
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

  async function exportParcelsDxf() {
    if (parcelsRef.current.size === 0) { toast.error('Nejdřív vyber parcelu'); return }
    await exportDxfRings([...parcelsRef.current.values()].map(p => p.ring.map(([lo, la]) => [lo, la] as [number, number])))
  }

  // hranice vybraného správního území jako uzavřená 3D křivka (DXF), drapovaná na DMR
  async function exportRegionDxf() {
    const a = regionActiveRef.current
    if (!a) { toast.error('Nejdřív vyber a zobraz území'); return }
    await exportDxfRings(a.sjtskRings.map(r => r.map(([x, y]) => wgsOf(x, y) as [number, number])))
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

  // jádro: hranice (lon/lat prstence) jako uzavřené 3D křivky (DXF pro 3ds Max), drapované na DMR.
  // Použije stejnou kotvu jako terén (pokud je postaven) → DXF lícuje s glb/obj exportem.
  async function exportDxfRings(lonLatRings: [number, number][][]) {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || exporting) return
    const rings = lonLatRings.filter(r => r.length >= 3)
    if (!rings.length) { toast.error('Žádná hranice k exportu'); return }
    setExporting(true)
    try {
      // kotva ze středu bboxu hranic
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
      for (const r of rings)
        for (const [lo, la] of r) { minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la) }
      const midLon = (minLon + maxLon) / 2, midLat = (minLat + maxLat) / 2
      const cc = [Cesium.Cartographic.fromDegrees(midLon, midLat)]
      await Cesium.sampleTerrain(v.terrainProvider, 18, cc)
      const anchor = { lon: midLon, lat: midLat, h: Number.isFinite(cc[0].height) ? cc[0].height : 0 }
      const anchorECEF = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.h)
      const inv = Cesium.Matrix4.inverseTransformation(Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF), new Cesium.Matrix4())
      const s = new Cesium.Cartesian3(), o = new Cesium.Cartesian3()
      const toLocalENU = (x: number, y: number, z: number): [number, number, number] => { s.x = x; s.y = y; s.z = z; Cesium.Matrix4.multiplyByPoint(inv, s, o); return [o.x, o.y, o.z] } // east, north, up

      const LIFT = 0.1
      const polylines: [number, number, number][][] = []
      for (const r0 of rings) {
        const ring = r0.slice()
        if (ring.length > 1) { const a = ring[0], b = ring[ring.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) ring.pop() }
        if (ring.length < 3) continue
        const cartos = ring.map(([lo, la]) => Cesium.Cartographic.fromDegrees(lo, la))
        await Cesium.sampleTerrain(v.terrainProvider, 18, cartos)
        if (v.isDestroyed()) return
        const pts: [number, number, number][] = []
        for (let i = 0; i < ring.length; i++) {
          const h = (Number.isFinite(cartos[i].height) ? (cartos[i].height as number) : anchor.h) + LIFT
          const P = Cesium.Cartesian3.fromDegrees(ring[i][0], ring[i][1], h)
          pts.push(toLocalENU(P.x, P.y, P.z))
        }
        polylines.push(pts)
      }
      if (!polylines.length) return
      download(buildDxf(polylines), anchorFilename(anchor, 'dxf'), 'application/dxf')
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
    await runExport(cutoutUi, 'Export výřezu selhal', ctx => exportCutoutCore(parcelPolys(), meshStep, ctx))
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
    await runExport(cutoutUi, 'Export výřezu selhal', ctx => exportCutoutCore(polys, meshStep, ctx))
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
    await runExport(cutoutUi, 'Export Google meshe selhal', ctx => exportGoogleMeshCore(tiles, parcelPolys(), ctx))
  }


  // OSM budovy (Cesium ion) — líné vytvoření + zap/vyp
  async function ensureOsm(viewer: Cesium.Viewer): Promise<Cesium.Cesium3DTileset | null> {
    if (osmRef.current) return osmRef.current
    if (osmPendingRef.current) return osmPendingRef.current
    osmPendingRef.current = (async () => {
      const ts = await Cesium.createOsmBuildingsAsync()
      if (viewer.isDestroyed()) return null
      ts.show = false // stejně jako u Google: dorazí ze sítě až po vypnutí, ať se nezjeví samo
      viewer.scene.primitives.add(ts)
      osmRef.current = ts
      return ts
    })()
    try { return await osmPendingRef.current } finally { osmPendingRef.current = null }
  }

  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    let alive = true
    if (osmOn) {
      setOsmLoading(true)
      ensureOsm(v).then(ts => {
        if (!alive || !ts) return
        // výškový posun podél „nahoru" (střed ČR) — aplikuje se při každém zapnutí (i po HMR)
        const c = Cesium.Cartesian3.fromDegrees(15.5, 49.8)
        const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(c, new Cesium.Cartesian3())
        ts.modelMatrix = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(up, OSM_LIFT_M, new Cesium.Cartesian3()))
        ts.show = true
      }).catch(() => { /* ion */ }).finally(() => setOsmLoading(false))
    } else if (osmRef.current) {
      osmRef.current.show = false
    }
    return () => { alive = false }
  }, [osmOn])

  // Jen JEDEN zdroj výběru naráz: parcely (klik/oblast) × dlaždice × území. Při zapnutí jednoho
  // vyčisti ostatní (jejich VÝBĚR i REŽIM), ať nejde mít „zaškrtnuté" víc věcí současně.
  /**
   * Klik do mapy má právě jednoho majitele.
   *
   * Každý režim si registruje vlastní posluchač levého kliku. Když jich běželo víc naráz, udělal
   * jeden klik několik věcí — a dělo se to: `calloutMode` nevypínal nikdo a `regionMode` se při
   * zapnutí neptal, takže „přidat popisek" a „vybrat parcelu" spolu klidně jely a jedno kliknutí
   * položilo bublinu A vybralo parcelu. Vypínalo se to na třech místech (exclusiveSelect,
   * startRuler, toggleMove), pokaždé jiným výčtem — proto to teď dělá jedna funkce.
   *
   * DATA se tím nemažou. Od toho je `exclusiveSelect`, který hlídá jinou věc: aby výběr
   * (parcely × dlaždice × území) měl vždycky jen jeden zdroj.
   */
  function claimMapClick(owner: 'parcel' | 'area' | 'tile' | 'region' | 'ruler' | 'callout' | 'move' | 'none') {
    if (owner !== 'parcel') setParcelMode(false)
    if (owner !== 'area' && areaMode) { clearArea(); setAreaMode(false) }
    if (owner !== 'tile') { setTileMode(false); setGridOn(false) } // ať mřížka nezůstane viset bez tlačítka
    if (owner !== 'region') setRegionMode(false)
    if (owner !== 'ruler' && rulerMode) { finishRuler(); setRulerMode(false) }
    if (owner !== 'callout') setCalloutMode(false)
    if (owner !== 'move') setMoveMode(false)
  }

  /** Jen JEDEN zdroj výběru naráz — maže DATA. Režimy klikání řeší `claimMapClick`. */
  function exclusiveSelect(keep: 'parcel' | 'tile' | 'region') {
    if (keep !== 'parcel') { clearAllParcels(); clearArea() }
    // Území dlaždice NERUŠÍ: kraj se do nich právě převádí (addRegionTiles) a víc krajů se má
    // sečíst do jednoho výběru. Ostatní zdroje si dlaždice pořád vylučují.
    if (keep !== 'tile' && keep !== 'region') clearTiles()
    if (keep !== 'region') clearRegion()
  }

  // Vypínání ostatních režimů schválně MIMO funkci pro nastavení stavu: ta se v StrictMode volá
  // dvakrát a vedlejší účinky uvnitř ní by proběhly taky dvakrát.
  function toggleMove() { const nv = !moveMode; if (nv) claimMapClick('move'); setMoveMode(nv) }
  function toggleCallout() { const nv = !calloutMode; if (nv) claimMapClick('callout'); setCalloutMode(nv) }
  function toggleRegionMode() { const nv = !regionMode; if (nv) claimMapClick('region'); setRegionMode(nv) }
  function toggleParcel() { const nv = !parcelMode; if (nv) { claimMapClick('parcel'); exclusiveSelect('parcel') } setParcelMode(nv) }

  // ── Výkresy (DXF/DWG) ──────────────────────────────────────────────────────────────
  const dwgColor = (rgb: number) => Cesium.Color.fromBytes((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255)

  // nastaví viditelnost všech Cesium primitivů jedné hladiny (čáry + popisky + body)
  const setLayerShow = (ly: DrawLayer, show: boolean) => { if (ly.prim) ly.prim.show = show; for (const lp of ly.labels) lp.show = show; if (ly.points) ly.points.show = show }

  function removeDrawing(id: string) {
    const v = viewerRef.current
    const d = drawingsRef.current.get(id)
    if (d && v && !v.isDestroyed()) {
      for (const ly of d.layers) {
        if (ly.prim) v.scene.primitives.remove(ly.prim)
        for (const lp of ly.labels) v.scene.primitives.remove(lp)
        if (ly.points) v.scene.primitives.remove(ly.points)
      }
    }
    drawingsRef.current.delete(id)
    removeObj(`drawing-${id}`)
    if (d?.assetId) void sceneRef.current.deleteAsset(d.assetId).catch(err => {
      console.error('Smazání výkresu z úložiště selhalo:', err)
      toast.error('Výkres zmizel z mapy, ale v úložišti zůstal — zkus to znovu po refreshi')
    })
  }

  // Nakreslí parse na mapu: čáry/popisky/body seskupené po hladinách (každá hladina = vlastní
  // primitivy, aby šly samostatně vypínat). Vše v jedné ploché výšce blízko terénu, vždy viditelné.
  // Souřadnice: rozpozná S-JTSK (proj4 záporné i „civilní" kladné) → reálné umístění; jinak lokální
  // (střed kresby položí do středu pohledu).
  /**
   * Postaví výkres v mapě a vrátí jeho id (nebo null, když se nedalo nic vykreslit).
   * S `restore` se obnovuje ze scény: dosadí se uložená výška, průhlednost i vypnuté hladiny
   * a nikam se nelétá. Pozn.: výkres BEZ S-JTSK souřadnic se usazuje do středu aktuálního
   * pohledu, takže se po obnově objeví jinde — u takových výkresů to jinak nejde poznat.
   */
  async function renderDrawing(
    parse: DrawParse,
    name: string,
    restore?: { assetId: string; config: AssetConfig },
  ): Promise<string | null> {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return null
    const { minX, minY, maxX, maxY } = parse
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    let toLL: (x: number, y: number) => [number, number]
    let mode: string
    if (cx > -950000 && cx < -380000 && cy > -1260000 && cy < -890000) { toLL = (x, y) => wgsOf(x, y) as [number, number]; mode = 'S-JTSK' }
    else if (cx > 380000 && cx < 950000 && cy > 890000 && cy < 1260000) { toLL = (x, y) => wgsOf(-x, -y) as [number, number]; mode = 'S-JTSK (kladné)' }
    else {
      const g = viewCenterGround(v)
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height))
      const tmp = new Cesium.Cartesian3(), out = new Cesium.Cartesian3()
      toLL = (x, y) => {
        tmp.x = x - cx; tmp.y = y - cy; tmp.z = 0
        Cesium.Matrix4.multiplyByPoint(enu, tmp, out)
        const c = Cesium.Cartographic.fromCartesian(out)
        return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)]
      }
      mode = 'lokální (umístěno do středu pohledu)'
    }

    // Jedna plochá výška blízko terénu (vzorek DMR ve středu výkresu). Výkres se ZÁMĚRNĚ nedrapuje
    // na terén — leží v jedné rovině a vykresluje se s vypnutým depth testem, aby byl vidět vždy,
    // i když je místy pod terénem.
    const [clon, clat] = toLL(cx, cy)
    let h0 = 300 + GEOID_CZ
    try {
      const dd = 0.001
      const es = await fetchElevSampler('dmr5g', clon - dd, clat - dd, clon + dd, clat + dd, 4)
      const bpv = es(clon, clat)
      if (bpv != null) h0 = bpv + GEOID_CZ
    } catch { /* nech výchozí */ }
    if (v.isDestroyed()) return null

    // svislý směr ve středu (pro posun výšky) + sběr odkazů na prvky (pro živou průhlednost)
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(Cesium.Cartesian3.fromDegrees(clon, clat, h0), new Cesium.Cartesian3())
    const textMats: DrawingEntry['textMats'] = []
    const pointRefs: DrawingEntry['pointRefs'] = []
    const polyRefs: DrawingEntry['polyRefs'] = []

    // Báze pro texty: kotva každého textu jde přes toLL (přesně jako čáry), ale rohy písmen se
    // odsazují o metry v této sdílené ENU bázi — na vzdálenost pár km je odchylka směru < 0,05°.
    const enuC = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(clon, clat, h0))
    const east = Cesium.Matrix4.getColumn(enuC, 0, new Cesium.Cartesian4())
    const north = Cesium.Matrix4.getColumn(enuC, 1, new Cesium.Cartesian4())
    const eastC = new Cesium.Cartesian3(east.x, east.y, east.z)
    const northC = new Cesium.Cartesian3(north.x, north.y, north.z)
    const toXYZ = (x: number, y: number) => { const [lo, la] = toLL(x, y); return Cesium.Cartesian3.fromDegrees(lo, la, h0) }
    // Konvergence poledníků: osa +X výkresu v S-JTSK NENÍ východ (Křovák je šikmá kuželová
    // projekce), takže bez téhle korekce by byly všechny texty stočené o několik stupňů.
    const dv = Cesium.Cartesian3.subtract(toXYZ(cx + 1, cy), toXYZ(cx, cy), new Cesium.Cartesian3())
    const conv = Math.atan2(Cesium.Cartesian3.dot(dv, northC), Cesium.Cartesian3.dot(dv, eastC))

    let wlon = Infinity, elon = -Infinity, slat = Infinity, nlat = -Infinity
    const seen = (lon: number, lat: number) => { if (lon < wlon) wlon = lon; if (lon > elon) elon = lon; if (lat < slat) slat = lat; if (lat > nlat) nlat = lat }

    // seskup prvky podle hladiny → každá hladina má vlastní čáry/popisky/body, aby šla samostatně vypínat
    const byLayer = new Map<string, DrawPrim[]>()
    for (const p of parse.prims) { const arr = byLayer.get(p.layer); if (arr) arr.push(p); else byLayer.set(p.layer, [p]) }

    const layers: DrawLayer[] = []
    // Velké výkresy mají desetitisíce textů → strop na počet. Vzdálenostní LOD už není potřeba:
    // texty jsou teď v metrech, takže se při oddálení samy zmenší do neviditelna.
    let labelBudget = 30000
    for (const [lname, lprims] of byLayer) {
      const instances: Cesium.GeometryInstance[] = []
      const polyMeta: { id: string; c: Cesium.Color }[] = []
      for (const p of lprims) {
        if (p.kind !== 'poly') continue
        const deg: number[] = []
        for (const [x, y] of p.pts) { const [lon, lat] = toLL(x, y); deg.push(lon, lat, h0); seen(lon, lat) }
        if (deg.length < 6) continue
        const col = dwgColor(p.color)
        const iid = `${lname}#${polyMeta.length}`
        instances.push(new Cesium.GeometryInstance({
          id: iid,
          geometry: new Cesium.PolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(deg), width: 2, arcType: Cesium.ArcType.NONE, vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col) },
        }))
        polyMeta.push({ id: iid, c: col })
      }
      // depthTest vypnutý → čáry se kreslí přes vše, takže výkres je vidět i pod terénem
      const prim = instances.length
        ? v.scene.primitives.add(new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PolylineColorAppearance({ renderState: { lineWidth: 1, depthTest: { enabled: false }, depthMask: false, blending: Cesium.BlendingState.ALPHA_BLEND } }),
            asynchronous: false,
          }))
        : null
      if (prim) for (const m of polyMeta) polyRefs.push({ prim, id: m.id, c: m.c })

      // Texty jako geometrie v rovině výkresu (ne Labely) → drží rotaci i výšku v metrech z DXF.
      const labels: Cesium.Primitive[] = []
      const texts = lprims.filter((p): p is Extract<DrawPrim, { kind: 'text' }> => p.kind === 'text')
      if (texts.length && labelBudget > 0) {
        const take = texts.slice(0, Math.max(0, labelBudget))
        labelBudget -= take.length
        for (const t of take) { const [lon, lat] = toLL(t.pt[0], t.pt[1]); seen(lon, lat) }
        const built = buildTextPrims({
          texts: take, anchor: toXYZ, east: eastC, north: northC, up, conv,
          colorCss: rgb => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`,
        })
        for (const tp of built.prims) { v.scene.primitives.add(tp); labels.push(tp) }
        textMats.push(...built.mats)
      }

      let points: Cesium.PointPrimitiveCollection | null = null
      const pts = lprims.filter((p): p is Extract<DrawPrim, { kind: 'point' }> => p.kind === 'point')
      if (pts.length) {
        points = new Cesium.PointPrimitiveCollection()
        for (const pt of pts) { const [lon, lat] = toLL(pt.pt[0], pt.pt[1]); seen(lon, lat); const pc = dwgColor(pt.color); const pp = points.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, h0), pixelSize: 5, color: pc, disableDepthTestDistance: Number.POSITIVE_INFINITY }); pointRefs.push({ p: pp, c: pc }) }
        v.scene.primitives.add(points)
      }

      if (prim || labels.length || points) layers.push({ name: lname || '0', color: lprims[0].color, visible: true, prim, labels, points })
    }
    layers.sort((a, b) => a.name.localeCompare(b.name, 'cs'))

    const id = `${Date.now()}`
    const pad = 0.0004
    const bounds = (elon > wlon && nlat > slat) ? Cesium.Rectangle.fromDegrees(wlon - pad, slat - pad, elon + pad, nlat + pad) : null
    const entry: DrawingEntry = { layers, bounds, up, textMats, pointRefs, polyRefs, assetId: restore?.assetId }
    drawingsRef.current.set(id, entry)

    // uložený stav výkresu: vypnuté hladiny, výška nad terénem a průhlednost
    const cfg = restore?.config
    if (cfg) {
      const hidden = new Set(cfg.hiddenLayers ?? [])
      for (const ly of layers) if (hidden.has(ly.name)) { ly.visible = false; setLayerShow(ly, false) }
      const off = cfg.heightOffset ?? 0
      if (off) { applyDrawH(entry, off); setDrawH(s => ({ ...s, [id]: off })) }
      const a = cfg.alpha ?? 1
      if (a !== 1) { applyDrawAlpha(entry, a); setDrawA(s => ({ ...s, [id]: a })) }
    }

    upsertObj({ id: `drawing-${id}`, kind: 'drawing', name: `Výkres ${name}`, visible: true })
    console.log(`Výkres „${name}": ${parse.prims.length} prvků, umístění ${mode}`)
    if (bounds && !restore) v.camera.flyTo({ destination: bounds, duration: 1.2 })
    return id
  }

  /** Nastavení výkresu tak, jak se ukládá k jeho souboru. */
  function saveDrawingCfg(did: string, over?: { heightOffset?: number; alpha?: number }) {
    const d = drawingsRef.current.get(did)
    if (!d?.assetId) return
    sceneRef.current.patchAssetConfig(d.assetId, {
      heightOffset: over?.heightOffset ?? drawHRef.current[did] ?? 0,
      alpha: over?.alpha ?? drawARef.current[did] ?? 1,
      hiddenLayers: d.layers.filter(l => !l.visible).map(l => l.name),
    })
  }

  // ── posun výšky + průhlednost celého výkresu (živě, bez překreslení) ──
  function applyDrawH(e: DrawingEntry, off: number) {
    const m = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(e.up, off, new Cesium.Cartesian3()))
    for (const ly of e.layers) {
      if (ly.prim) ly.prim.modelMatrix = m
      for (const lp of ly.labels) lp.modelMatrix = m
      if (ly.points) ly.points.modelMatrix = m
    }
  }
  function applyDrawAlpha(e: DrawingEntry, a: number) {
    for (const mt of e.textMats) mt.uniforms.opacity = a
    for (const r of e.pointRefs) r.p.color = r.c.withAlpha(a)
    for (const r of e.polyRefs) { const at = r.prim.getGeometryInstanceAttributes(r.id); if (at) at.color = Cesium.ColorGeometryInstanceAttribute.toValue(r.c.withAlpha(a), at.color) }
    viewerRef.current?.scene.requestRender()
  }
  function setDrawingHeight(did: string, off: number) { const e = drawingsRef.current.get(did); if (e) { applyDrawH(e, off); setDrawH(s => ({ ...s, [did]: off })); saveDrawingCfg(did, { heightOffset: off }) } }
  function setDrawingAlpha(did: string, a: number) { const e = drawingsRef.current.get(did); if (e) { applyDrawAlpha(e, a); setDrawA(s => ({ ...s, [did]: a })); saveDrawingCfg(did, { alpha: a }) } }

  // ── kamera: perspektiva ↔ pohled shora (ortho, jako půdorys) ──
  // POZOR: Cesium ve `switchToPerspectiveFrustum` staví nový frustum a natvrdo mu dá 60°.
  // Bez vrácení našeho `fov` by tedy každý návrat z ortha potichu přepsal nastavený zorný úhel.
  function camPerspective() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    v.scene.camera.switchToPerspectiveFrustum()
    applyFovRaw(fov)
    setCamProj('persp')
  }
  function camTopOrtho() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const g = viewCenterGround(v)
    const h = Math.max(150, v.camera.positionCartographic?.height ?? 2000)
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(g.lon, g.lat, h),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 0.5,
      // Až po doletu: kdyby přelet uživatel přerušil, `complete` se nezavolá a přepínač zůstane
      // stát na perspektivě — tedy na tom, co je opravdu vidět.
      complete: () => { if (!v.isDestroyed()) { v.scene.camera.switchToOrthographicFrustum(); setCamProj('ortho') } },
    })
  }

  useEffect(() => {
    shakeRef.current = { on: shakeOn && presentOn, amt: shakeAmt } // mimo prezentaci se nechvěje
    // ukládá se JEN intenzita (výchozí pro slider); zapnutí patří uloženému pohledu, ne prohlížeči
    try { localStorage.setItem(SHAKE_KEY, JSON.stringify({ amt: shakeAmt })) } catch { /* */ }
  }, [shakeOn, shakeAmt, presentOn])

  useEffect(() => {
    const wasOn = spinRef.current.on
    spinRef.current = { on: spinOn && presentOn, speed: spinSpeed }
    if (!wasOn && spinRef.current.on) spinPivotRef.current = null // rozjezd → vezmi si čerstvý střed
    // ukládá se JEN rychlost (výchozí pro slider); zapnutí patří uloženému pohledu, ne prohlížeči
    try { localStorage.setItem(SPIN_KEY, JSON.stringify({ speed: spinSpeed })) } catch { /* */ }
  }, [spinOn, spinSpeed, presentOn])

  /**
   * „Kroužení": kamera pomalu obíhá kolem místa, na které se dívá.
   *
   * Na rozdíl od chvění je to SKUTEČNÝ pohyb kamery, ne optický trik — o to jde, jinak by nevznikla
   * paralaxa a scéna by nepůsobila prostorově. Kamera se proto opravdu přesouvá po kružnici kolem
   * pivotu a orientace se otáčí s ní, takže předmět zůstává pořád uprostřed.
   *
   * Otáčí se přes `lookAtTransform` do ENU rámce pivotu, tam se udělá `rotate` kolem místné svislice
   * a rámec se hned zase pustí (`Matrix4.IDENTITY`). Kamera si přitom nechá výslednou polohu ve
   * světě, ale `camera.transform` zůstane jednotková — na tom stojí zbytek appky (chvění, snímkování
   * i `viewCenterGround` počítají s neposunutým rámcem), takže si ho tu nesmíme nechat nastavený.
   *
   * Běží v `preUpdate`, tedy MIMO okno mezi pre/postRender, kde sedí chvění kamery — jinak by si
   * obojí přepisovalo pozici. Ze stejného důvodu tu sedí i plynulé přiblížení.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const scene = v.scene
    const cam = scene.camera
    const spinFrame = new Cesium.Matrix4() // scratch — 60fps smyčka, ať se nealokuje každý snímek
    let last = performance.now()
    const onPreUpdate = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000) // po přepnutí tabu ať to neskočí naráz
      last = now
      const { on, speed } = spinRef.current
      if (!on || !speed) return
      if (now < spinHoldRef.current) { spinPivotRef.current = null; return } // ještě se letí
      // Snímkování pohledů si kameru drží přes lookAt (nenulový transform) a chce klidné záběry.
      if (!Cesium.Matrix4.equals(cam.transform, Cesium.Matrix4.IDENTITY)) return
      if (!spinPivotRef.current) {
        const g = viewCenterGround(v)
        spinPivotRef.current = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      }
      const frame = Cesium.Transforms.eastNorthUpToFixedFrame(spinPivotRef.current, undefined, spinFrame)
      cam.lookAtTransform(frame)
      cam.rotate(Cesium.Cartesian3.UNIT_Z, -Cesium.Math.toRadians(speed) * dt)
      cam.lookAtTransform(Cesium.Matrix4.IDENTITY)
    }
    scene.preUpdate.addEventListener(onPreUpdate)
    return () => { scene.preUpdate.removeEventListener(onPreUpdate) }
  }, [])

  /**
   * „Kamera z ruky": jemné rozechvění pohledu v prezentaci.
   *
   * Nasazuje se PŘED vykreslením snímku a hned po něm se kamera vrátí přesně tam, kde byla.
   * Skutečný stav kamery tak zůstává čistý — přelety (flyTo i orbit), ovládání myší, ukládání
   * pohledů a `viewCenterGround` pracují s nerozechvěnou kamerou a chvění se nikam nenasčítá.
   * (Kdyby se chvění do kamery zapisovalo natrvalo, po minutě prezentace by ujela jinam.)
   *
   * Otáčí se jen POHLED (yaw/pitch/roll kolem vlastních os kamery), pozicí nehýbeme: je to to,
   * co na „z ruky" čte, kamera se nemůže dostat do terénu a nevzniká gimbal u pohledu shora.
   * Rotace jdou přes `look*`/`twist*`, takže se nepřevádí na heading/pitch/roll a zpět —
   * obnova je pak bitově přesná a nedrift.
   *
   * Šum = součet nesouměřitelných sinusovek (žádná knihovna): pomalé plutí + rychlejší
   * mikrochvění, každá osa s jiným rozfázováním, aby se vzor dlouho neopakoval. Amplituda
   * se škáluje zorným úhlem — u úzkého FOV je stejný úhel na obraze větší, takže by přizoomovaný
   * záběr jinak vibroval mnohem víc.
   *
   * POZOR na okno mezi `onPre` a `onPost`: uvnitř něj je kamera rozechvělá a JEN TAM se smí
   * promítat kotvy do obrazovky. `CalloutLayer` (callouts.tsx) proto počítá pozice popisků
   * v `preRender` — kdyby to dělal v `postRender`, dostal by už narovnanou kameru a popisky by
   * po scéně klouzaly o celou výchylku. Nepřehazovat ani jednu z těch registrací.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    // Scénu i obě události si držíme z doby registrace. V odhlašování se na `v.scene` sahat NESMÍ:
    // cleanup běží při zrušení komponenty, tedy až po zničení viewru (init efekt je deklarovaný
    // dřív, takže jeho cleanup jde první), a getter `Viewer.scene` pak sáhne do už zahozeného
    // widgetu a spadne. `Viewer.isDestroyed()` to nezachytí — v Cesiu vrací vždy false.
    const scene = v.scene
    const cam = scene.camera
    const C3 = Cesium.Cartesian3
    let saved: { pos: Cesium.Cartesian3; dir: Cesium.Cartesian3; up: Cesium.Cartesian3 } | null = null
    const t0 = performance.now()
    const wave = (t: number, parts: [number, number][]) =>
      parts.reduce((s, [hz, amp]) => s + Math.sin(t * hz * Math.PI * 2) * amp, 0)

    const onPre = () => {
      const { on, amt } = shakeRef.current
      if (!on || amt <= 0) return
      // Snímkování 4 pohledů si kameru drží přes camera.lookAt (nenulový transform) a chce čisté
      // záběry — tam do ní nesaháme.
      if (!Cesium.Matrix4.equals(cam.transform, Cesium.Matrix4.IDENTITY)) return
      const t = (performance.now() - t0) / 1000
      const fov = (cam.frustum as Cesium.PerspectiveFrustum).fov // ortho frustum ho nemá → bez škálování
      const k = Cesium.Math.toRadians(SHAKE_MAX_DEG) * amt * (fov ? fov / Cesium.Math.toRadians(60) : 1)
      saved = {
        pos: C3.clone(cam.positionWC, new C3()),
        dir: C3.clone(cam.directionWC, new C3()),
        up: C3.clone(cam.upWC, new C3()),
      }
      cam.lookRight(wave(t, [[0.077, 0.62], [0.26, 0.26], [0.77, 0.12]]) * k)
      cam.lookUp(wave(t + 3.7, [[0.063, 0.58], [0.29, 0.28], [0.91, 0.14]]) * k)
      cam.twistRight(wave(t + 11.3, [[0.049, 0.50], [0.203, 0.22]]) * k * 0.5) // klopení jen poloviční
    }
    const onPost = () => {
      if (!saved) return
      cam.setView({ destination: saved.pos, orientation: { direction: saved.dir, up: saved.up } })
      saved = null
    }
    scene.preRender.addEventListener(onPre)
    scene.postRender.addEventListener(onPost)
    // Odhlášení stačí odebrat posluchače (jen splice v poli, bezpečné i po zničení scény).
    // Kameru tu nesrovnáváme zpátky — cleanup přichází jen se zánikem komponenty, kdy už
    // viewer stejně mizí, a `cam.setView` na zničené scéně by spadl.
    return () => {
      scene.preRender.removeEventListener(onPre)
      scene.postRender.removeEventListener(onPost)
    }
  }, [])

  /**
   * Plynulé přiblížení kolečkem.
   *
   * Cesium na každý zářez kolečka kameru posune skokem — při rychlejším rolování to nadskakuje.
   * Kolečko si proto bereme sami (WHEEL jsme mu odebrali při inicializaci): každý zářez se
   * přičte do „nedojetého“ zoomu a ten k nule dotáhne kriticky tlumená pružina, takže se pohyb
   * plynule rozjede i doklouže — bez kopnutí na začátku a bez přestřelení na konci.
   *
   * Krok je NÁSOBNÝ vůči výšce nad terénem — u země jemný, z výšky velký. Výška nad elipsoidem
   * by u kopců lhala (terén v Liberci je ~400 m), proto se výška terénu odečítá.
   *
   * Běží v `preUpdate`, tedy mimo okno mezi pre/postRender, kde sedí chvění kamery — jinak by
   * si obojí přepisovalo pozici. Sražení s terénem řeší ovladač až v dalším cyklu, takže si krok
   * omezujeme sami; bez toho kamera na jeden snímek propadne pod zem, než ji vytlačí zpátky.
   */
  const zoomRef = useRef(0) // nedojetý zoom v log jednotkách (+ = přiblížit)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const scene = v.scene, cam = scene.camera, canvas = scene.canvas
    const ssc = scene.screenSpaceCameraController

    const onWheel = (e: WheelEvent) => {
      if (!ssc.enableInputs) return // režimy, které si vstupy berou (posun modelu, malování dlaždic)
      e.preventDefault()
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1) // řádky/stránky → pixely
      zoomRef.current = Cesium.Math.clamp(zoomRef.current - px * ZOOM_SENS, -ZOOM_MAX, ZOOM_MAX)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    let last = performance.now()
    let zoomVel = 0 // rychlost pružiny (log jednotek/s) — musí přežít mezi snímky, jinak nemá setrvačnost
    const onPreUpdate = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000) // po přepnutí tabu ať to neskočí naráz
      last = now
      const rest = zoomRef.current
      if (Math.abs(rest) < 1e-4 && Math.abs(zoomVel) < 1e-4) { zoomRef.current = 0; zoomVel = 0; return }
      // Kriticky tlumená pružina táhne zbytek k nule. Prostý exponenciální doběh by na každý
      // zářez skočil z nuly rovnou na plnou rychlost — a právě to kopnutí je zbytkové cukání.
      // Pružina má rychlost spojitou, takže se pohyb rozjede i doklouže. Kriticky tlumená =
      // nejrychlejší možný náběh BEZ přestřelení, jinak by zoom na konci gumoval.
      // Tvar je semi-implicitní (jmenovatel), aby to bylo stabilní i při vynechaném snímku.
      const w = 2 / ZOOM_TAU
      zoomVel = (zoomVel - dt * w * w * rest) / (1 + 2 * w * dt + w * w * dt * dt)
      let step = -zoomVel * dt
      const cc = cam.positionCartographic
      const h = Math.max(3, cc.height - (scene.globe.getHeight(cc) ?? 0))
      zoomRef.current = rest - step
      if (step > 0) { // přibližování zastav nad zemí, oddalování omezovat netřeba
        const maxStep = Math.log(h / Math.max(1.5, ssc.minimumZoomDistance))
        if (step > maxStep) { step = Math.max(0, maxStep); zoomRef.current = 0; zoomVel = 0 } // u země zastav i pružinu
      }
      if (step !== 0) cam.zoomIn(h * (1 - Math.exp(-step))) // step < 0 → negativní posun = oddálení
    }
    scene.preUpdate.addEventListener(onPreUpdate)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      scene.preUpdate.removeEventListener(onPreUpdate)
    }
  }, [])

  // ── uložené pohledy kamery (přežijí refresh) ──
  function persistCamViews(vs: CamView[]) { setCamViews(vs); sceneRef.current.patchState({ camViews: vs }) }
  const currentLook = (): CamLook => ({ fov, bloom: bloomOn, dofOn, dofMode, dofFocal, dofBlur, dofRadius, dofFeather, shakeOn, shakeAmt, spinOn, spinSpeed })
  /**
   * Přejede vzhled na cílový během přeletu — stejně dlouho a stejnou easeInOut jako pohyb kamery,
   * takže obojí dosedne naráz.
   *
   * Nespojité věci se interpolovat nedají, každá se řeší jinak:
   *  - `dofMode` (kruh × vzdálenost) se rozhodne hned na začátku — mezi poloměrem kruhu a ohniskovou
   *    vzdáleností není co prolínat. Animují se pak už jen parametry cílového režimu.
   *  - `dofOn` se nepřepíná skokem: rozostření zůstane celou dobu zapnuté a přejíždí se jeho SÍLA
   *    z/na nulu, takže zapnutí i vypnutí vyblednou místo cvaknutí (stepSize 0 = žádné rozmazání).
   *  - `bloom` je jen přepínač, sepne se na konci.
   *  - `spinOn`/`spinSpeed` (kroužení) se do přeletu vůbec nemíchají: kameru po tu dobu řídí let,
   *    tak se zapnou až po doletu (drží je `spinHoldRef`) a vezmou si čerstvý střed pohledu.
   *  - `shakeOn`/`shakeAmt` jedou přes intenzitu jako rozostření (viz níž) — chvění patří k pohledu,
   *    takže se mezi záběry musí umět jak nasadit, tak utichnout.
   *
   * Stav Reactu se přepisuje AŽ na konci — nastavovat ho každý snímek by 3 s překreslovalo celou
   * komponentu. Slidery se proto rozhýbou až po doletu.
   */
  function animateCamLook(target: CamLook, dur = 3000) {
    // Při vypnuté prezentaci se efekty nezapínají — přílet na pohled by je jinak vrátil zpátky
    // a vypínač by nic neznamenal. Cílové hodnoty se ale schovají, takže zapnutí prezentace
    // navazuje na pohled, na kterém zrovna stojíš.
    let to = target
    if (!presentOn) {
      presentSnapRef.current = { dofOn: target.dofOn, bloom: target.bloom }
      to = { ...target, dofOn: false, bloom: false }
    }
    const from = currentLook()
    const token = ++lookAnimRef.current
    const mode = to.dofMode
    const anyDof = from.dofOn || to.dofOn
    const blurFrom = from.dofOn ? from.dofBlur : 0
    const blurTo = to.dofOn ? to.dofBlur : 0
    // Chvění se taky nepřepíná skokem: jede se přes jeho INTENZITU z/na nulu (stejný trik jako
    // u rozostření), takže se kamera rozechvěje i uklidní plynule místo cvaknutí. Chybějící
    // hodnoty (starší pohledy) znamenají vypnuto → přílet na takový pohled chvění zase utiší.
    const shakeFrom = from.shakeOn ? (from.shakeAmt ?? 0) : 0
    const shakeTo = to.shakeOn ? (to.shakeAmt ?? 0) : 0
    const anyShake = shakeFrom > 0 || shakeTo > 0
    const t0 = performance.now()
    const step = () => {
      const v = viewerRef.current
      if (!v || v.isDestroyed() || lookAnimRef.current !== token) return
      let t = (performance.now() - t0) / dur; if (t > 1) t = 1
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2   // stejná easeInOut jako orbit
      const mix = (a: number, b: number) => a + (b - a) * e
      applyFovRaw(mix(from.fov, to.fov))
      applyDofRaw({
        on: anyDof, mode,
        focal: mix(from.dofFocal, to.dofFocal), blur: mix(blurFrom, blurTo),
        radius: mix(from.dofRadius, to.dofRadius), feather: mix(from.dofFeather, to.dofFeather),
      })
      if (anyShake) shakeRef.current = { on: presentOn, amt: mix(shakeFrom, shakeTo) }
      if (t < 1) { requestAnimationFrame(step); return }
      // dosedni přesně na cíl a srovnej s ním stav ovládání
      setFov(to.fov); setBloomOn(to.bloom); applyBloom(to.bloom)
      setDofOn(to.dofOn); setDofMode(to.dofMode); setDofFocal(to.dofFocal); setDofBlur(to.dofBlur)
      setDofRadius(to.dofRadius); setDofFeather(to.dofFeather)
      applyDofRaw({ on: to.dofOn, mode: to.dofMode, focal: to.dofFocal, blur: to.dofBlur, radius: to.dofRadius, feather: to.dofFeather })
      // amt si při vypnutém chvění nechá poslední hodnotu, ať slider nespadne na nulu
      setShakeOn(to.shakeOn ?? false); setShakeAmt(to.shakeAmt ?? shakeAmt)
      // Kroužení se nerozjíždí postupně jako chvění — nemá cenu ho míchat do přeletu, kde kameru
      // řídí let. Zapne se až po doletu (drží ho `spinHoldRef`) a vezme si čerstvý střed pohledu.
      setSpinOn(to.spinOn ?? false); setSpinSpeed(to.spinSpeed ?? spinSpeed)
    }
    requestAnimationFrame(step)
  }
  /**
   * Náhled pohledu — malý JPEG rovnou do stavu scény (proč ne do Storage viz `CamView.thumb`).
   * 160×90 stačí na to, aby se v seznamu poznal záběr, a vyjde na ~2 kB.
   */
  function captureViewThumb(v: Cesium.Viewer): string | undefined {
    try {
      v.render() // bez překreslení drží buffer minulý snímek (jedeme s preserveDrawingBuffer)
      const src = v.scene.canvas
      const c = document.createElement('canvas')
      c.width = VIEW_THUMB_W; c.height = VIEW_THUMB_H
      const ctx = c.getContext('2d')
      if (!ctx) return undefined
      // „cover": poměr stran zůstane, přebytek se ořízne — jinak by byl náhled roztažený
      const sr = src.width / src.height, dr = VIEW_THUMB_W / VIEW_THUMB_H
      const sw = sr > dr ? src.height * dr : src.width
      const sh = sr > dr ? src.height : src.width / dr
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, VIEW_THUMB_W, VIEW_THUMB_H)
      return c.toDataURL('image/jpeg', VIEW_THUMB_Q)
    } catch { return undefined } // náhled je bonus; kvůli němu ukládání pohledu spadnout nesmí
  }

  /** Aktuální kamera + vzhled + náhled jako tělo pohledu (společné pro uložení i přepsání). */
  function currentViewBody(v: Cesium.Viewer) {
    const c = v.camera, pos = c.positionWC
    return { dest: [pos.x, pos.y, pos.z] as [number, number, number], h: c.heading, p: c.pitch, r: c.roll, look: currentLook(), thumb: captureViewThumb(v) }
  }

  // Ukládá se HNED, bez předchozího psaní názvu. Dřív se muselo nejdřív vyplnit pole a teprve
  // pak kliknout — jenže záběr máš právě teď, kdežto pojmenovat ho jde i za pět minut. Nový
  // pohled proto dostane pracovní název a rovnou se otevře k přejmenování.
  function saveCamView() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const id = `v${Date.now()}`
    persistCamViews([...camViews, { id, name: `Pohled ${camViews.length + 1}`, ...currentViewBody(v) }])
    setActiveViewId(id)
    setRenamingViewId(id)
  }
  /** přepíše kameru i vzhled uloženého pohledu aktuálním stavem (pohled zůstane na svém místě v seznamu) */
  function updateCamView(i: number) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    persistCamViews(camViews.map((cv, j) => j === i ? { ...cv, ...currentViewBody(v) } : cv))
  }
  function renameCamView(id: string, name: string) {
    const n = name.trim()
    if (n) persistCamViews(camViews.map(cv => cv.id === id ? { ...cv, name: n } : cv))
    setRenamingViewId(null)
  }
  /** Kopie i s náhledem — základ pro variantu záběru, kterou pak jen doladíš a přepíšeš. */
  function duplicateCamView(i: number) {
    const src = camViews[i]; if (!src) return
    const id = `v${Date.now()}`
    const copy = { ...src, id, name: `${src.name} (kopie)` }
    persistCamViews([...camViews.slice(0, i + 1), copy, ...camViews.slice(i + 1)])
    setRenamingViewId(id)
  }
  /** Přesun v seznamu — pohledy jsou scénář prezentace, takže na pořadí záleží. */
  function moveCamView(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= camViews.length || to >= camViews.length) return
    const next = [...camViews]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    persistCamViews(next)
  }
  /**
   * Sedí aktivní pohled na to, co je právě vidět?
   *
   * Tohle je jádro toho, co dřív chybělo: slidery zorného úhlu, rozostření, chvění a kroužení
   * JSOU vzhledem pohledu (jdou do `CamLook`), jenže když se s nimi hnulo, nic o tom neřeklo —
   * uložený pohled se tiše rozešel se skutečností a bylo na uživateli si vzpomenout na přepsání.
   *
   * Kamera se mění mimo React, takže se to přepočítá po dojetí pohybu (`moveEnd`); vzhled je
   * ve stavu, ten si React ohlídá sám.
   */
  const [camTick, setCamTick] = useState(0)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const bump = () => setCamTick(t => t + 1)
    v.camera.moveEnd.addEventListener(bump)
    return () => { if (!v.isDestroyed()) v.camera.moveEnd.removeEventListener(bump) }
  }, [viewerReady])

  const activeDirty = useMemo(() => {
    void camTick // závislost schválně: kamera se hýbe mimo React a přepočet visí na moveEnd
    const v = viewerRef.current
    const cv = camViews.find(x => x.id === activeViewId)
    if (!v || v.isDestroyed() || !cv) return false
    const c = v.camera
    const moved = Cesium.Cartesian3.distance(c.positionWC, new Cesium.Cartesian3(cv.dest[0], cv.dest[1], cv.dest[2])) > VIEW_DIRTY_M
    // rozdíl úhlů přes hranici 0/360 musí vyjít malý, ne skoro celá otáčka
    const turned = (a: number, b: number) => {
      let d = Cesium.Math.toDegrees(a - b) % 360
      if (d > 180) d -= 360
      if (d < -180) d += 360
      return Math.abs(d) > VIEW_DIRTY_DEG
    }
    const rotated = turned(c.heading, cv.h) || turned(c.pitch, cv.p) || turned(c.roll, cv.r)
    // Starší pohledy `look` nemají — z jejich chybějícího vzhledu se „upraveno" dělat nesmí,
    // jinak by u nich svítilo pořád a nešlo by to nijak umlčet.
    const lookOff = !!cv.look && !sameLook(cv.look, currentLook())
    return moved || rotated || lookOff
  }, [camTick, camViews, activeViewId, fov, bloomOn, dofOn, dofMode, dofFocal, dofBlur, dofRadius, dofFeather, shakeOn, shakeAmt, spinOn, spinSpeed])

  /** Další/předchozí pohled — pro procházení scénáře při prezentaci (tlačítka i šipky). */
  function stepCamView(dir: 1 | -1) {
    if (!camViews.length) return
    const cur = camViews.findIndex(cv => cv.id === activeViewId)
    // bez aktivního pohledu začni od kraje podle směru, jinak cyklicky dokola
    const next = cur < 0 ? (dir === 1 ? 0 : camViews.length - 1) : (cur + dir + camViews.length) % camViews.length
    gotoCamView(camViews[next])
  }

  // Šipkami se dá projít scénář bez klikání do seznamu. Posluchač se registruje jednou a sahá
  // na aktuální `stepCamView` přes ref — jinak by se musel přepisovat při každé změně pohledů.
  const stepRef = useRef(stepCamView)
  useEffect(() => { stepRef.current = stepCamView })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      // v poli se šipkami posouvá kurzor — tam prezentace co dělat nemá
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      stepRef.current(e.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  function gotoCamView(cv: CamView) {
    setActiveViewId(cv.id)               // řídí, které popisky jsou vysunuté
    // Přelet trvá 3 s a kameru si po tu dobu řídí sám — kroužení musí počkat, jinak si přepisují
    // pozici. Pivot se zahodí, ať si po doletu vezme střed NOVÉHO pohledu, ne toho, odkud se letělo.
    spinHoldRef.current = performance.now() + 3200
    spinPivotRef.current = null
    pulseLayerRef.current?.trigger(new Set(presentOn ? pulses.filter(p => p.views.includes(cv.id)).map(p => p.id) : []))
    if (cv.look) animateCamLook(cv.look) // starší pohledy `look` nemají → nastavení se nechá být
    if (orbitOn) orbitToCamView(cv); else gotoCamViewDirect(cv)
  }
  function gotoCamViewDirect(cv: CamView) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    orbitAnimRef.current++ // zruš případný běžící orbit
    v.camera.flyTo({ destination: new Cesium.Cartesian3(cv.dest[0], cv.dest[1], cv.dest[2]), orientation: { heading: cv.h, pitch: cv.p, roll: cv.r }, duration: 3 })
  }
  // Přelet OBLOUKEM: kamera obíhá po nejkratším oblouku kolem STŘEDU aktuálního pohledu a přitom se
  // pořád dívá na ten střed → objekt uprostřed zůstane uprostřed. Konec = pozice uloženého pohledu.
  function orbitToCamView(cv: CamView) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const C3 = Cesium.Cartesian3, M3 = Cesium.Matrix3
    const g = viewCenterGround(v)
    const P = C3.fromDegrees(g.lon, g.lat, g.height)               // pivot = na co koukám
    const startPos = C3.clone(v.camera.positionWC, new C3())
    const endPos = new C3(cv.dest[0], cv.dest[1], cv.dest[2])
    const oS = C3.subtract(startPos, P, new C3()), oE = C3.subtract(endPos, P, new C3())
    const magS = C3.magnitude(oS), magE = C3.magnitude(oE)
    if (magS < 1 || magE < 1) { gotoCamViewDirect(cv); return }     // degenerace → přímý let

    // Kam se ULOŽENÝ pohled dívá (v ECEF). Počítá se stejně, jako to dělá Cesium v Camera.setView3D:
    // heading posunutý o -90°, ze vzniklé rotační matice je směr sloupec 0 — a to celé v ENU rámci
    // cílové pozice. (Přes pickPosition to nešlo: čte depth buffer minulého snímku, tedy staré kamery.)
    const hpr = new Cesium.HeadingPitchRoll(cv.h - Cesium.Math.PI_OVER_TWO, cv.p, cv.r)
    const rotM = M3.fromQuaternion(Cesium.Quaternion.fromHeadingPitchRoll(hpr, new Cesium.Quaternion()), new M3())
    const enuEnd = Cesium.Matrix4.getMatrix3(Cesium.Transforms.eastNorthUpToFixedFrame(endPos), new M3())
    const endDir = C3.normalize(M3.multiplyByVector(enuEnd, M3.getColumn(rotM, 0, new C3()), new C3()), new C3())

    // Oblouk dává smysl JEN když se oba pohledy dívají zhruba na totéž — obíhá se přece kolem
    // společného předmětu. Když jsem si mezitím odletěl jinam po mapě, pivot s uloženým pohledem
    // nesouvisí a orbit kolem něj by skončil úplně jinde. Změř, jak daleko paprsek uloženého
    // pohledu míjí pivot; když moc, leť napřímo.
    const toP = C3.subtract(P, endPos, new C3())
    const along = C3.dot(toP, endDir)
    const miss = C3.magnitude(C3.subtract(toP, C3.multiplyByScalar(endDir, along, new C3()), new C3()))
    if (along <= 0 || miss > 0.35 * magE) { gotoCamViewDirect(cv); return }

    // orbit ve sférických souřadnicích ENU rámce pivotu: zvlášť AZIMUT (otáčení do strany) a NÁKLON
    // (elevace) + vzdálenost → kamera obíhá kolem BOKU, ne přes vršek (zenit).
    const enuR = Cesium.Matrix4.getMatrix3(Cesium.Transforms.eastNorthUpToFixedFrame(P), new M3())
    const enuRT = M3.transpose(enuR, new M3())
    const toLocal = (o: Cesium.Cartesian3) => M3.multiplyByVector(enuRT, C3.normalize(o, new C3()), new C3()) // ECEF→ENU
    const lS = toLocal(oS), lE = toLocal(oE)
    const azS = Math.atan2(lS.x, lS.y), azE = Math.atan2(lE.x, lE.y)                 // heading od severu
    const elS = Math.asin(Cesium.Math.clamp(lS.z, -1, 1)), elE = Math.asin(Cesium.Math.clamp(lE.z, -1, 1))
    let dAz = azE - azS; while (dAz > Math.PI) dAz -= 2 * Math.PI; while (dAz < -Math.PI) dAz += 2 * Math.PI // nejkratší

    // Orientace se interpoluje v heading/pitch/roll od SOUČASNÉ k uložené, a to stejnou easeInOut
    // jako pozice — tím jde otáčení i posun jedním gestem.
    //
    // Dřív se orientace držela „koukej na pivot" a na uloženou sjížděla až v posledních 45 %. To
    // dělalo trhnutí: pozice se kvůli easeInOut na konci téměř zastaví, takže se kamera dotáčela
    // (klidně o 19°) prakticky na místě. Interpolace headingu navíc změnu azimutu oblouku sama
    // kopíruje, takže když oba pohledy míří na týž předmět, zůstane uprostřed i bez dohánění.
    const hS = v.camera.heading, pS = v.camera.pitch, rS = v.camera.roll
    const shortest = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
    // Heading musí točit na TUTÉŽ stranu, kam obíhá pozice. Dřív se obojí rozhodovalo zvlášť
    // („nejkratší cesta“ pro azimut oblouku a nezávisle na tom pro heading) a u protilehlých
    // pohledů, kde je rozdíl kolem 180°, si to sem tam zvolilo opačná znaménka — kamera pak
    // obíhala doleva a otáčela se doprava, tedy se cestou přestala dívat na předmět a dotočila
    // se až na konci. Základ je proto swing oblouku a k němu jen nejkratší ZBYTEK, aby se
    // pořád dosedlo přesně na uložený heading.
    const dH = dAz + shortest(cv.h - hS - dAz), dP = cv.p - pS, dR = shortest(cv.r - rS)

    const token = ++orbitAnimRef.current
    const dur = 3000, t0 = performance.now(), tmp = new C3()
    const step = () => {
      if (v.isDestroyed() || orbitAnimRef.current !== token) return
      let t = (performance.now() - t0) / dur; if (t > 1) t = 1
      if (t >= 1) {
        // Dosedni PŘESNĚ na uložený pohled, ne na dopočítanou orientaci — jinak kamera skončí na
        // správné pozici, ale natočená na starý pivot, což vypadá, jako by doletěla někam jinam.
        v.camera.setView({ destination: endPos, orientation: { heading: cv.h, pitch: cv.p, roll: cv.r } })
        return
      }
      const te = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2   // easeInOut
      const az = azS + dAz * te, el = elS + (elE - elS) * te, rng = magS + (magE - magS) * te
      const ch = Math.cos(el)
      const arc = M3.multiplyByVector(enuR, new C3(Math.sin(az) * ch, Math.cos(az) * ch, Math.sin(el)), new C3()) // ENU→ECEF
      const pos = C3.add(P, C3.multiplyByScalar(arc, rng, tmp), new C3())
      v.camera.setView({ destination: pos, orientation: { heading: hS + dH * te, pitch: pS + dP * te, roll: rS + dR * te } })
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  // Smazání pohledu s sebou vezme i vazby popisků a pulzů, které na něm visely. Dřív zmizely
  // tiše a nebylo je jak vrátit — proto se ptáme a rovnou řekneme, čeho se to týká.
  function delCamView(i: number) {
    const gone = camViews[i]; if (!gone) return
    const nc = callouts.filter(c => c.views.includes(gone.id)).length
    const np = pulses.filter(p => p.views.includes(gone.id)).length
    const parts: string[] = []
    if (nc) parts.push(`${nc}× popisek`)
    if (np) parts.push(`${np}× pulz`)
    const tail = parts.length ? `\n\nPřestane se v něm ukazovat: ${parts.join(', ')}.` : ''
    if (!confirm(`Smazat pohled „${gone.name}"?${tail}`)) return
    persistCamViews(camViews.filter((_, j) => j !== i))
    persistCallouts(callouts.map(c => c.views.includes(gone.id) ? { ...c, views: c.views.filter(x => x !== gone.id) } : c))
    persistPulses(pulses.map(p => p.views.includes(gone.id) ? { ...p, views: p.views.filter(x => x !== gone.id) } : p))
    if (activeViewId === gone.id) setActiveViewId(null)
  }

  useEffect(() => {
    const v = viewerRef.current
    if (!viewerReady || !v || v.isDestroyed()) return
    const layer = new PulseLayer(v)
    pulseLayerRef.current = layer
    layer.sync(pulses)
    return () => { layer.destroy(); pulseLayerRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady])
  useEffect(() => { pulseLayerRef.current?.sync(pulses) }, [pulses])

  // ── pulzující zvýraznění parcel ──
  function persistPulses(ps: PulseSet[]) { setPulses(ps); sceneRef.current.patchState({ pulses: ps }) }
  /** Okopíruje prstence PRÁVĚ vybraných parcel do nové sady — od té chvíle je na výběru nezávislá. */
  function addPulseFromSelection() {
    const rings = [...parcelsRef.current.values()]
      .map(p => p.ring.map(([lo, la]) => [lo, la] as [number, number]))
      .filter(r => r.length >= 3)
    if (!rings.length) { toast.error('Nejdřív vyber parcely'); return }
    const set: PulseSet = { id: `pl${Date.now()}`, name: `${rings.length}× parcela`, rings, color: pulseColor, count: pulseCount, views: activeViewId ? [activeViewId] : [] }
    persistPulses([...pulses, set])
    if (!activeViewId) toast.info('Sada vznikla, ale není vybraný pohled — nemá se kde spustit')
  }
  function delPulse(id: string) { persistPulses(pulses.filter(p => p.id !== id)) }
  /** úprava už vytvořené sady — barva se přebarví za běhu, geometrie se nepřestavuje */
  function updatePulse(id: string, patch: Partial<PulseSet>) { persistPulses(pulses.map(p => p.id === id ? { ...p, ...patch } : p)) }
  function togglePulseHere(id: string, on: boolean) {
    if (!activeViewId) return
    persistPulses(pulses.map(p => p.id !== id ? p
      : { ...p, views: on ? [...new Set([...p.views, activeViewId])] : p.views.filter(x => x !== activeViewId) }))
  }
  function playPulse(id: string) { pulseLayerRef.current?.trigger(new Set([id])) }
  /**
   * Hlavní vypínač prezentace: popisky, pulz a obrazové efekty (rozostření, bloom) naráz.
   * Vypnutí si pamatuje, co bylo zapnuté, takže zapnutí nevrací výchozí hodnoty, ale ty tvoje.
   */
  function togglePresent() {
    const nv = !presentOn
    setPresentOn(nv)
    if (!nv) {
      presentSnapRef.current = { dofOn, bloom: bloomOn }
      setDofOn(false); applyDof({ on: false })
      setBloomOn(false); applyBloom(false)
    } else {
      const snap = presentSnapRef.current
      if (snap) {
        setDofOn(snap.dofOn); applyDof({ on: snap.dofOn })
        setBloomOn(snap.bloom); applyBloom(snap.bloom)
      }
    }
    // Popisky si zajedou samy (řídí je visibleCallouts), pulz je ale primitiv — musí se říct hned.
    pulseLayerRef.current?.trigger(new Set(nv && activeViewId ? pulses.filter(p => p.views.includes(activeViewId)).map(p => p.id) : []))
  }

  // ── prezentační popisky (tečka + čára + bublina), vázané na uložené pohledy ──
  function saveCallouts(cs: Callout[]) { sceneRef.current.patchState({ callouts: cs }) }
  function persistCallouts(cs: Callout[]) { setCallouts(cs); saveCallouts(cs) }
  function updateCallout(id: string, patch: Partial<Callout>) {
    if (patch.dot || patch.frame || patch.size) {
      const { dot, frame, size } = { ...calloutStyleRef.current, ...patch }
      calloutStyleRef.current = { dot, frame, size }
    }
    persistCallouts(callouts.map(c => c.id === id ? { ...c, ...patch } : c))
  }
  function delCallout(id: string) { persistCallouts(callouts.filter(c => c.id !== id)); if (calloutSel === id) setCalloutSel(null) }
  /** zapne/vypne popisek v PRÁVĚ aktivním pohledu */
  function toggleCalloutHere(id: string, on: boolean) {
    if (!activeViewId) return
    persistCallouts(callouts.map(c => c.id !== id ? c
      : { ...c, views: on ? [...new Set([...c.views, activeViewId])] : c.views.filter(x => x !== activeViewId) }))
  }

  // ── DOF / FOV / bloom ──
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
  function applyBloom(on: boolean) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    v.scene.postProcessStages.bloom.enabled = on
  }

  // odletí kamerou na daný objekt (výkres / model / parcela)
  function locateObject(o: SceneObj) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    try {
      if (o.kind === 'drawing') {
        const d = drawingsRef.current.get(o.id.replace('drawing-', ''))
        if (d?.bounds) { v.camera.flyTo({ destination: d.bounds, duration: 1.0 }); return }
      } else if (o.kind === 'model') {
        const bs = modelsRef.current.get(o.id)?.model?.boundingSphere
        if (bs) { v.camera.flyToBoundingSphere(bs, { duration: 1.0 }); return }
      } else if (o.kind === 'parcel') {
        const p = parcelsRef.current.get(o.id.replace('parcel-', ''))
        if (p?.positions?.length) { v.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(p.positions), { duration: 1.0 }); return }
      }
      toast.info('Polohu tohoto objektu neumím zaměřit')
    } catch (e) { console.error('Zaměření selhalo:', e) }
  }

  /** Rozparsuje DXF/DWG na primitivy. DWG jde přes WASM převodník, který se natáhne až teď. */
  async function parseDrawingFile(file: File): Promise<DrawParse> {
    if (file.name.toLowerCase().endsWith('.dwg')) {
      const { dwgToPrims } = await import('./dwg')
      return dwgToPrims(await file.arrayBuffer())
    }
    return dxfToPrims(await file.text())
  }

  async function loadDrawing(file: File) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    setDrawingLoading(true)
    try {
      const parse = await parseDrawingFile(file)
      const did = await renderDrawing(parse, file.name)
      toast.success(`Výkres „${file.name}" načten (${parse.prims.length} prvků)`)
      // Nahrání běží na pozadí — výkres je v mapě hned, `assetId` dojde, jak upload dojede.
      if (did) void uploadDrawing(did, file)
    } catch (e) {
      console.error('Načtení výkresu selhalo:', e)
      toast.error(e instanceof Error ? e.message : 'Načtení výkresu selhalo')
    } finally { setDrawingLoading(false) }
  }

  /** Uloží výkres do scény a doplní mu `assetId`. */
  async function uploadDrawing(did: string, file: File) {
    try {
      const asset = await sceneRef.current.uploadAsset({
        kind: 'drawing', name: file.name.replace(/\.(dxf|dwg)$/i, ''), file,
        config: { heightOffset: drawHRef.current[did] ?? 0, alpha: drawARef.current[did] ?? 1, hiddenLayers: [] },
      })
      const d = drawingsRef.current.get(did)
      // Během uploadu se mohly vypnout hladiny nebo posunout výška — dopíšeme aktuální stav.
      if (d) { d.assetId = asset.id; saveDrawingCfg(did) }
    } catch (e) {
      console.error('Uložení výkresu selhalo:', e)
      toast.error(e instanceof Error ? e.message : 'Výkres se nepodařilo uložit do scény — po refreshi zmizí')
    }
  }

  /**
   * Nastavení modelu tak, jak se ukládá k jeho souboru. `center` ani `footprint` se neukládají
   * schválně — obojí se ze stejného souboru spočítá znovu a stejně, tak ať to nemůže zestárnout.
   */
  function modelConfig(e: ModelEntry): AssetConfig {
    return {
      placement: e.placement,
      yawDeg: e.yawDeg,
      visible: e.visible,
      excavate: !!e.excavate,
      outline: !!e.outline,
    }
  }

  /** Zapamatuj si usazení a přepínače modelu (odloženě — tažení sliderem je jinak vodopád). */
  function saveModel(e: ModelEntry | null | undefined) {
    if (e?.assetId) sceneRef.current.patchAssetConfig(e.assetId, modelConfig(e))
  }

  /** Nahraje model do scény na pozadí a doplní mu `assetId`. */
  async function uploadModel(entry: ModelEntry, file: File) {
    try {
      const asset = await sceneRef.current.uploadAsset({
        kind: 'model', name: entry.name, file, config: modelConfig(entry),
      })
      entry.assetId = asset.id
      // usazení se mohlo mezitím změnit (model jde posouvat, než upload dojede)
      sceneRef.current.patchAssetConfig(asset.id, modelConfig(entry))
    } catch (e) {
      console.error('Uložení modelu selhalo:', e)
      toast.error(e instanceof Error ? e.message : 'Model se nepodařilo uložit do scény — po refreshi zmizí')
    }
  }

  /**
   * Vloží model do mapy. Bez `restore` je to ruční import (usadí se podle kotvy nebo do středu
   * a soubor se nahraje do scény), s `restore` je to obnova scény z úložiště: soubor projde
   * stejnou přípravou, ale usazení a přepínače se vezmou z uloženého nastavení a nikam se nelétá.
   */
  async function importModel(file: File, restore?: { assetId: string; name: string; config: AssetConfig }) {
    if (!/\.(glb|gltf|obj)$/i.test(file.name)) return
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return

    const isGlb = /\.(glb|gltf)$/i.test(file.name)
    // glb URL pro Cesium (OBJ převedeme přes three) + promise na nejnižší bod + případná geo-kotva
    let url: string
    let bottomPromise: Promise<number | null>
    let anchor = parseAnchor(file.name) // kotva z názvu (geo_lon_lat_h.*) → reimport našeho exportu
    let footprint: Cesium.Cartesian3[][] | null = null // obrys(y) půdorysu ve světě pro skrytí mapy (jen S-JTSK)
    if (/\.obj$/i.test(file.name)) {
      try {
        const group = new OBJLoader().parse(await file.text())
        group.traverse(o => {
          const m = o as THREE.Mesh
          if (m.isMesh && m.geometry) { m.geometry.rotateX(-Math.PI / 2); m.geometry.rotateY(-Math.PI / 2) }
        })
        const box = new THREE.Box3().setFromObject(group)
        bottomPromise = Promise.resolve(Number.isFinite(box.min.y) ? box.min.y : null)
        const glbBuf = await new Promise<ArrayBuffer>((res, rej) => new GLTFExporter().parse(group, r => res(r as ArrayBuffer), rej, { binary: true }))
        url = URL.createObjectURL(new Blob([glbBuf], { type: 'model/gltf-binary' }))
      } catch (e) { console.error('Import OBJ selhal:', e); return }
    } else {
      // glb bez kotvy v názvu: zkus rozpoznat reálné S-JTSK souřadnice v geometrii a usadit přesně
      const geo = !anchor ? await georeferenceSjtskGlb(file).catch(e => { console.error('Georeference selhala:', e); return null }) : null
      if (geo) {
        url = geo.url
        bottomPromise = Promise.resolve(geo.bottomZ)
        anchor = geo.anchor
        footprint = geo.footprint
        if (!restore) toast.success('Model usazen podle S-JTSK souřadnic z geometrie')
      } else {
        url = URL.createObjectURL(file)
        bottomPromise = computeBottomZ(file)
      }
    }

    let base: Anchor
    if (anchor) base = anchor
    else { const c = viewCenterGround(v); base = { lon: c.lon, lat: c.lat, h: c.height } }
    // glb (náš export i georeferencovaný) je otočený o 90° kolem svislé osy → kompenzace přes matici
    const autoYaw = (anchor && isGlb) ? MAX_GLB_YAW_DEG : 0
    // Uložené usazení má přednost před automatickým: model se od té doby mohl ručně posunout.
    const p: Placement = restore?.config.placement
      ?? { lon: base.lon, lat: base.lat, groundH: base.h, heightOffset: 0, heading: 0, pitch: 0, roll: 0, scale: 1 }
    const yawDeg = restore?.config.yawDeg ?? autoYaw
    if (!restore) {
      if (anchor && parseAnchor(file.name)) toast.success('Model usazen přesně podle geo-kotvy z názvu')
      else if (!anchor) toast.message('Soubor bez souřadnic — umístěno do středu, dolaď ručně')
    }

    try {
      const model = await Cesium.Model.fromGltfAsync({
        url,
        modelMatrix: buildMatrix(p, Cesium.Cartesian3.ZERO, yawDeg),
      })
      if (v.isDestroyed()) { URL.revokeObjectURL(url); return }
      v.scene.primitives.add(model)
      model.environmentMapManager.enabled = true
      model.environmentMapManager.atmosphereScatteringIntensity = 4.0
      model.environmentMapManager.brightness = 1.3
      // svítící obrys (glow) kolem modelu — výchozí VYPNUTÝ (jde zapnout v panelu modelu)
      model.silhouetteColor = MODEL_GLOW
      model.silhouetteSize = restore?.config.outline ? 2.0 : 0
      model.show = restore?.config.visible ?? true

      const id = crypto.randomUUID()
      const entry: ModelEntry = {
        id, name: restore?.name ?? file.name.replace(/\.(glb|gltf|obj)$/i, ''),
        model, url, center: Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO), yawDeg, placement: p,
        visible: restore?.config.visible ?? true,
        footprint: footprint ?? undefined,
        excavate: restore?.config.excavate ?? false,
        outline: restore?.config.outline ?? false,
        assetId: restore?.assetId,
      }
      modelsRef.current.set(id, entry)
      setObjects(list => [...list, { id, kind: 'model', name: entry.name, visible: entry.visible }])
      if (!restore) selectObject(id)

      model.readyEvent.addEventListener(async () => {
        if (v.isDestroyed()) return
        if (!anchor) {
          const inv = Cesium.Matrix4.inverse(model.modelMatrix, new Cesium.Matrix4())
          const localCenter = Cesium.Matrix4.multiplyByPoint(inv, model.boundingSphere.center, new Cesium.Cartesian3())
          const bottomZ = await bottomPromise
          entry.center = new Cesium.Cartesian3(localCenter.x, localCenter.y, bottomZ ?? 0)
          model.modelMatrix = buildMatrix(entry.placement, entry.center, entry.yawDeg)
        }
        if (entry.excavate) updateExcavation() // matice i obrys jsou hotové → přepočítej masku
        // Při obnově scény se nikam nelétá: kamera se vrací na svoje uložené místo a přelet
        // na poslední načtený model by ji z něj sundal.
        if (!restore) v.camera.flyToBoundingSphere(model.boundingSphere, { duration: 1.0 })
      })

      if (!restore) void uploadModel(entry, file)
    } catch {
      URL.revokeObjectURL(url)
      toast.error(restore ? `Model „${file.name}" se nepodařilo obnovit` : 'Import modelu selhal')
    }
  }

  // ── správa scény ──
  function upsertObj(o: SceneObj) { setObjects(list => [...list.filter(x => x.id !== o.id), o]) }
  function removeObj(id: string) { setObjects(list => list.filter(x => x.id !== id)) }

  function selectObject(id: string | null) {
    selectedIdRef.current = id
    setSelectedId(id)
    const e = id ? modelsRef.current.get(id) : null
    setPlacement(e ? { ...e.placement } : null)
    setMoveMode(false)
  }

  function deleteModel(id: string) {
    const v = viewerRef.current
    const e = modelsRef.current.get(id)
    if (!e) return
    if (v && !v.isDestroyed()) v.scene.primitives.remove(e.model)
    URL.revokeObjectURL(e.url)
    modelsRef.current.delete(id)
    if (e.excavate) updateExcavation() // uklidit masku po smazaném modelu
    setObjects(list => list.filter(o => o.id !== id))
    if (selectedIdRef.current === id) selectObject(null)
    if (e.assetId) void sceneRef.current.deleteAsset(e.assetId).catch(err => {
      console.error('Smazání modelu z úložiště selhalo:', err)
      toast.error('Model zmizel z mapy, ale v úložišti zůstal — zkus to znovu po refreshi')
    })
  }

  // zapnout/vypnout skrytí mapy (ortofoto/topo + terén + Google) pod/nad vybraným modelem
  function toggleExcavation(id: string) {
    const e = modelsRef.current.get(id)
    if (!e || !e.footprint) return
    e.excavate = !e.excavate
    updateExcavation()
    saveModel(e)
    setObjects(list => [...list]) // překreslit panel (stav se čte z ref)
  }

  // zapnout/vypnout svítící obrys (silhouette) kolem vybraného modelu
  function toggleOutline(id: string) {
    const e = modelsRef.current.get(id)
    if (!e) return
    e.outline = !e.outline
    e.model.silhouetteSize = e.outline ? 2.0 : 0
    saveModel(e)
    setObjects(list => [...list]) // překreslit panel (stav se čte z ref)
  }

  function toggleVisible(o: SceneObj) {
    const vis = !o.visible
    if (o.kind === 'model') { const e = modelsRef.current.get(o.id); if (e) { e.model.show = vis; e.visible = vis; saveModel(e) } }
    else if (o.kind === 'parcel') {
      const pid = o.id.replace('parcel-', '')
      const p = parcelsRef.current.get(pid)
      if (p) { p.hidden = !vis; p.ents.forEach(en => { en.show = vis && parcelHl }) }
      measureRef.current.get(pid)?.forEach(en => { en.show = vis })
    }
    else if (o.kind === 'drawing') { const d = drawingsRef.current.get(o.id.replace('drawing-', '')); if (d) for (const ly of d.layers) setLayerShow(ly, vis && ly.visible) }
    setObjects(list => list.map(x => x.id === o.id ? { ...x, visible: vis } : x))
  }

  // přepne jednu hladinu výkresu (viditelnost = master výkresu && stav hladiny)
  function toggleLayer(drawingId: string, layerName: string) {
    const d = drawingsRef.current.get(drawingId)
    if (!d) return
    const ly = d.layers.find(l => l.name === layerName)
    if (!ly) return
    ly.visible = !ly.visible
    const master = objects.find(o => o.id === `drawing-${drawingId}`)?.visible ?? true
    setLayerShow(ly, master && ly.visible)
    saveDrawingCfg(drawingId)
    setObjects(list => [...list]) // překreslit panel (stav hladin se čte z ref)
  }

  // hromadně nastaví viditelnost více hladin naráz (výběr / výsledek hledání)
  function setLayersVisibility(drawingId: string, names: string[], visible: boolean) {
    const d = drawingsRef.current.get(drawingId)
    if (!d) return
    const master = objects.find(o => o.id === `drawing-${drawingId}`)?.visible ?? true
    const set = new Set(names)
    for (const ly of d.layers) if (set.has(ly.name)) { ly.visible = visible; setLayerShow(ly, master && ly.visible) }
    saveDrawingCfg(drawingId)
    setObjects(list => [...list])
  }

  // stisk na hladině: Shift = rozsah od posledního kliku; jinak zahájí tažení (přidávání/odebírání
  // podle toho, jestli hladina ve výběru už je) a rovnou přepne tu první
  function startLayerDrag(oid: string, name: string, shownNames: string[], shift: boolean) {
    const cur = new Set(layerSel[oid] ?? [])
    const last = lastLayerClick.current[oid]
    if (shift && last) {
      const a = shownNames.indexOf(last), b = shownNames.indexOf(name)
      if (a >= 0 && b >= 0) for (let k = Math.min(a, b); k <= Math.max(a, b); k++) cur.add(shownNames[k])
      setLayerSel(prev => ({ ...prev, [oid]: cur }))
      lastLayerClick.current[oid] = name
      return // Shift = jen rozsah, ne tažení
    }
    const mode: 'add' | 'remove' = cur.has(name) ? 'remove' : 'add'
    dragRef.current = { oid, mode }
    if (mode === 'add') cur.add(name); else cur.delete(name)
    setLayerSel(prev => ({ ...prev, [oid]: cur }))
    lastLayerClick.current[oid] = name
  }
  // přejezd přes hladinu během tažení = přidá/odebere ji stejným režimem jako začátek tažení
  function dragOverLayer(oid: string, name: string) {
    const d = dragRef.current
    if (!d || d.oid !== oid) return
    setLayerSel(prev => {
      const cur = new Set(prev[oid] ?? [])
      if (d.mode === 'add') cur.add(name); else cur.delete(name)
      return { ...prev, [oid]: cur }
    })
  }
  const selectAllLayers = (oid: string, names: string[]) => setLayerSel(prev => ({ ...prev, [oid]: new Set(names) }))
  const clearLayerSel = (oid: string) => setLayerSel(prev => ({ ...prev, [oid]: new Set() }))

  const toggleExpand = (id: string) => setExpandedDrawings(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  function deleteObject(o: SceneObj) {
    if (o.kind === 'model') deleteModel(o.id)
    else if (o.kind === 'parcel') removeParcel(o.id.replace('parcel-', ''))
    else if (o.kind === 'drawing') removeDrawing(o.id.replace('drawing-', ''))
  }

  function commitRename() {
    const id = renamingId
    if (id) {
      const name = renameDraft.trim() || 'objekt'
      const e = modelsRef.current.get(id)
      if (e) e.name = name
      setObjects(list => list.map(x => x.id === id ? { ...x, name } : x))
    }
    setRenamingId(null)
  }

  function focusModel() {
    const v = viewerRef.current
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (v && !v.isDestroyed() && e) v.camera.flyToBoundingSphere(e.model.boundingSphere, { duration: 1.0 })
  }

  // přesné posazení vybraného modelu na povrch (terén i Google dlaždice)
  function dropToGround() {
    const v = viewerRef.current
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (!v || v.isDestroyed() || !placement || !e) return
    if (!v.scene.sampleHeightSupported) return
    const carto = Cesium.Cartographic.fromDegrees(placement.lon, placement.lat)
    const h = v.scene.sampleHeight(carto, [e.model])
    if (h != null) setPlacement(pp => pp ? { ...pp, groundH: h, heightOffset: 0 } : pp)
  }

  function patch(part: Partial<Placement>) {
    setPlacement(p => p ? { ...p, ...part } : p)
  }

  const activeView = camViews.find(cv => cv.id === activeViewId) ?? null
  // vysunuté jsou jen popisky patřící aktivnímu pohledu; bez pohledu nesvítí nic
  const visibleCallouts = new Set(presentOn && activeViewId ? callouts.filter(c => c.views.includes(activeViewId)).map(c => c.id) : [])

  // Sjetí k sekci, která právě vznikla. Sleduje se jen „je / není", ne obsah — jinak by panel
  // poskakoval při každé přidané parcele.
  const hasParcels = parcelCount > 0
  const hasTiles = tileCount > 0
  const hasRegion = regionChoices.length > 0 || regionParts.length > 0 || !!regionName
  const hasModelSel = !!placement
  const hasDistrict = districtsOn && !!selectedDistrict
  const hasRasters = rasterList.length > 0
  useEffect(() => { if (hasParcels) revealSection('parcely') }, [hasParcels])
  useEffect(() => { if (hasTiles) revealSection('dlazdice') }, [hasTiles])
  useEffect(() => { if (hasRegion) revealSection('uzemi') }, [hasRegion])
  useEffect(() => { if (hasModelSel) revealSection('model') }, [hasModelSel])
  useEffect(() => { if (hasDistrict) revealSection('mestcast') }, [hasDistrict])
  useEffect(() => { if (hasRasters) revealSection('rastr') }, [hasRasters])
  useEffect(() => { if (splatOn) revealSection('splat') }, [splatOn])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />

      <MapSearch
        query={query}
        onQuery={setQuery}
        onSubmit={runSearch}
        busy={searching || regionBusy}
        units={regionChoices}
        parts={regionParts}
        places={placeHits}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpen={() => setSearchOpen(true)}
        onPickUnit={u => { setSearchOpen(false); isolateRegion(u) }}
        onPickPlace={flyToPlace}
        onExpandParts={loadParts}
        pickMode={regionMode}
        onTogglePickMode={toggleRegionMode}
        activeName={regionName}
        onClearActive={clearRegion}
      />

      {/* pod vyhledávací lištou, ať se nepřekrývají — obojí míří doprostřed nahoru */}
      {restoring && (
        <div className="absolute top-16 left-1/2 z-30 -translate-x-1/2 flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/90 px-3 py-1.5 text-xs text-gray-200 backdrop-blur">
          <Loader2 size={13} className="animate-spin" /> {restoring}
        </div>
      )}
      <CalloutLayer
        viewer={viewerReady ? viewerRef.current : null}
        callouts={callouts}
        visibleIds={visibleCallouts}
        selectedId={calloutSel}
        onPick={setCalloutSel}
        onMove={(id, off) => updateCallout(id, { off })}
      />

      <input
        ref={fileRef}
        type="file"
        accept=".glb,.gltf,.obj"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) importModel(f); e.target.value = '' }}
      />
      <input
        ref={dwgRef}
        type="file"
        accept=".dxf,.dwg"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) loadDrawing(f); e.target.value = '' }}
      />
      {/* Snímek a world file jsou dva soubory → `multiple`; párují se podle názvu (pairRasterFiles). */}
      <input
        ref={rasterFileRef}
        type="file"
        multiple
        accept=".jpg,.jpeg,.png,.webp,.tif,.tiff,.jgw,.jpgw,.jpegw,.pgw,.pngw,.tfw,.tifw,.wld,.prj"
        className="hidden"
        onChange={e => { const fs = [...(e.target.files ?? [])]; if (fs.length) importRasters(fs); e.target.value = '' }}
      />

      {NEEDS_ION && !ION_TOKEN && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-lg bg-amber-900/80 border border-amber-600/50 text-amber-200 text-xs">
          Chybí VITE_CESIUM_ION_TOKEN — Google 3D / OSM budovy nepoběží
        </div>
      )}

      {/* loader při exportu */}
      {exporting && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-gray-900/95 border border-gray-700 text-gray-100">
            <Loader2 size={20} className="animate-spin text-emerald-400" />
            <div className="text-sm">
              <div className="font-medium">Exportuji…</div>
              <div className="text-[11px] text-gray-400">stahuji budovy (OSM) a výšky (ČÚZK)</div>
            </div>
          </div>
        </div>
      )}

      {/* Rychlá lišta dole. Projekce se přepíná pořád dokola i s panelem zavřeným, takže sedí
          i tady — je to tatáž komponenta i tytéž funkce jako v sekci Kamera, nemůže se to
          rozejít. Střed se počítá z VIDITELNÉ mapy, ne z okna, aby lišta neutíkala pod panel.
          `bottom-6` míjí pruh s popiskami zdrojů, který si Cesium kreslí úplně dole. */}
      <div className={`pointer-events-none absolute bottom-6 right-0 z-20 flex justify-center transition-[left] ${panelOpen ? 'left-80' : 'left-0'}`}>
        <MapTools
          rulerMode={rulerMode}
          rulerKind={rulerKind}
          rulerDrafting={!!rulerDraftId}
          onRuler={startRuler}
          onFinishRuler={finishRuler}
          moveMode={moveMode}
          onMove={toggleMove}
          canMove={!!placement}
        >
          <ProjSwitch mode={camProj} onPersp={camPerspective} onOrtho={camTopOrtho} />
        </MapTools>
      </div>

      {/* Kompas v rohu, mimo střed s lištou — ať se s ní neperou o místo, když je okno úzké.
          Vlastní pozadí má kruhové v SVG, takže tady kolem něj není žádný rámeček navíc. */}
      <div className="pointer-events-none absolute bottom-5 right-4 z-20">
        <Compass viewer={viewerReady ? viewerRef.current : null} />
      </div>

      {/* Levý panel — jediné místo pro ovládání. Dřív se panely otevíraly jeden přes druhý,
          takže se překrývaly; teď je vše v jednom sloupci ve sbalitelných sekcích. */}
      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          title="Zobrazit panel"
          className="absolute left-3 top-3 z-20 rounded-lg border border-gray-700 bg-gray-900/85 p-1.5 text-gray-300 backdrop-blur hover:text-gray-100"
        ><ChevronRight size={16} /></button>
      )}
      <div className={`absolute inset-y-0 left-0 z-20 flex w-80 flex-col border-r border-gray-700 bg-gray-900/90 backdrop-blur transition-transform ${panelOpen ? '' : '-translate-x-full'}`}>
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-gray-700 p-2">
          {/* Navigace a hlavní vypínač prezentace na jednom řádku — dřív zabíraly dva. */}
          <div className="flex items-center gap-1">
            <button onClick={() => void leaveScene()} title="Zpět na přehled scén" className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-200 transition-colors hover:bg-gray-700">
              <ChevronLeft size={14} /> Scény
            </button>
            <button
              onClick={togglePresent}
              title={presentOn ? 'Skrýt popisky a pulz' : 'Zobrazit popisky a pulz'}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs ${presentOn ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
            >
              {presentOn ? <Eye size={14} /> : <EyeOff size={14} />} Prezentace
            </button>
            <div className="flex-1" />
            <button onClick={() => setPanelOpen(false)} title="Skrýt panel" className="rounded p-0.5 text-gray-500 hover:text-gray-200"><ChevronLeft size={16} /></button>
          </div>
          {/* Název scény + co se zrovna obnovuje z úložiště. Bez toho se při víc scénách
              nepozná, ve které z nich vlastně jsi. */}
          <div className="flex min-w-0 items-center gap-1.5 px-1">
            <Layers size={12} className="shrink-0 text-emerald-500" />
            <span className="truncate text-xs font-medium text-gray-200" title={scene.sceneName}>{scene.sceneName}</span>
          </div>
          {restoring && (
            <div className="flex items-center gap-1.5 px-1 text-[11px] text-gray-400">
              <Loader2 size={12} className="shrink-0 animate-spin" />
              <span className="truncate">{restoring}</span>
            </div>
          )}
        </div>

        {/* Jediná scrollovaná oblast. Pořadí sekcí kopíruje postup práce: podklad → výběr →
            co z výběru vzniklo → scéna → kamera → prezentace. Kontextové sekce (Parcely,
            Dlaždice, …) stojí hned pod tím, co je vyrobilo, a revealSection k nim odscrolluje. */}
        <div ref={panelScrollRef} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
          <Section id="podklad" title="Podklad a překryvy" dflt={true} open={openSec} onToggle={toggleSec}>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Podklad</div>
            <ToggleBtn active={base === 'ortofoto'} onClick={() => setBase('ortofoto')} icon={<Image size={15} />} label="Ortofoto ČR" />
            <ToggleBtn active={base === 'zm'} onClick={() => setBase('zm')} icon={<MapIcon size={15} />} label={base === 'zm' ? `Topografická mapa (${ztmTier})` : 'Topografická mapa ČR'} />
            {ENABLE_GOOGLE_3D && (
              <ToggleBtn active={base === 'google'} onClick={() => setBase('google')} icon={googleLoading ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />} label="3D realita (Google)" />
            )}
            {ENABLE_GOOGLE_3D && base === 'google' ? (
              <div className="flex flex-col gap-1 px-1 max-w-[190px]">
                <div className="text-[10px] text-gray-500 leading-snug">
                  {googleErr ? <span className="text-amber-400">{googleErr}</span> : <>Fotorealistické 3D. Posuvníkem prosvítíš mapu pod ním.</>}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-gray-400 w-9 shrink-0">3D</span>
                  <input type="range" min={0} max={1} step={0.05} value={googleAlpha} onChange={e => setGoogleAlpha(parseFloat(e.target.value))} className="flex-1 min-w-0 accent-cyan-500" title="Průhlednost 3D reality — vlevo jen mapa, vpravo plná 3D" />
                  <span className="text-[10px] text-gray-300 tabular-nums w-8">{Math.round(googleAlpha * 100)}%</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-gray-400 w-9 shrink-0">Pod</span>
                  <button onClick={() => setGoogleUnder('ortofoto')} className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'ortofoto' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>ortofoto</button>
                  <button onClick={() => setGoogleUnder('zm')} className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'zm' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>topo</button>
                  <button onClick={() => setGoogleUnder('none')} title="Čistě 3D bez podkladu (skryje glóbus)" className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'none' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>nic</button>
                </div>
                <div className="h-px bg-gray-700 my-0.5" />
                <ToggleBtn active={katastrOn} onClick={() => setKatastrOn(v => !v)} icon={<Layers size={15} />} label="Katastr" />
              </div>
            ) : (
              <>
                <div className="h-px bg-gray-700 my-0.5" />
                <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Překryv</div>
                <ToggleBtn active={katastrOn} onClick={() => setKatastrOn(v => !v)} icon={<Layers size={15} />} label="Katastr" />
              </>
            )}
            {ENABLE_OSM_BUILDINGS && (
              <ToggleBtn active={osmOn} onClick={() => setOsmOn(v => !v)} icon={osmLoading ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />} label="Budovy (OSM)" />
            )}
            {ENABLE_LIBEREC_DISTRICTS && (
              <ToggleBtn active={districtsOn} onClick={toggleDistricts} icon={districtsLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} label="Městské části Liberce" />
            )}
            <div className="h-px bg-gray-700 my-0.5" />
            <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Pozadí</div>
            <div className="flex flex-wrap items-center gap-1 px-1 max-w-[190px]">
              {BG_MODES.map(m => (
                <button key={m.id} onClick={() => setBgMode(m.id)} title={m.title}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${bgMode === m.id ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>{m.label}</button>
              ))}
              {bgMode === 'vlastni' && (
                <input type="color" value={bgCustom} onChange={e => setBgCustom(e.target.value)} title="Barva pozadí"
                  className="h-5 w-7 shrink-0 cursor-pointer rounded border border-gray-700 bg-transparent p-0" />
              )}
            </div>
            {/* Ostrost obrazu — supersampling. Scéna už jede v pixelech displeje, tohle jde nad ně. */}
            <div className="flex flex-col gap-1 border-t border-gray-700 pt-2">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="shrink-0 text-gray-400">Ostrost obrazu</span>
                <div className="ml-auto flex gap-1">
                  {[1, 1.5, 2].map(s => (
                    <button
                      key={s}
                      onClick={() => setSharpness(s)}
                      title={s === 1
                        ? 'Nativní rozlišení displeje — nejrychlejší'
                        : `Scéna se vykreslí ${s}× větší a zmenší se až na obrazovku. Uklidní třepení jemné kresby v ortofotu, ale stojí ${(s * s).toFixed(2).replace('.', ',')}× víc pixelů.`}
                      className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums ${sharpness === s ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >{String(s).replace('.', ',')}×</button>
                  ))}
                </div>
              </div>
              <div className="px-1 text-[10px] leading-snug text-gray-600">
                {viewerReady && `Renderuje se ${viewerRef.current?.scene.canvas.width ?? 0}×${viewerRef.current?.scene.canvas.height ?? 0} px`}
                {viewerReady && (window.devicePixelRatio || 1) !== 1 && ` · displej ${Math.round((window.devicePixelRatio || 1) * 100)} %`}
              </div>
            </div>
          </Section>
          {rasterList.length > 0 && (
          <Section id="rastr" title="Vlastní ortofoto" dflt={true} badge={rasterList.length} open={openSec} onToggle={toggleSec}>
            {rasterList.map(r => (
              <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-gray-700/70 bg-gray-800/40 p-1.5">
                <div className="flex items-center gap-1">
                  <button onClick={() => toggleRaster(r.id)} title={r.visible ? 'Skrýt' : 'Zobrazit'} className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-gray-100">
                    {r.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-200" title={r.name}>{r.name}</span>
                  <button onClick={() => locateRaster(r.id)} title="Zaměřit" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-cyan-300">
                    <Crosshair size={13} />
                  </button>
                  <button onClick={() => removeRaster(r.id)} title="Odebrat" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-red-300">
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-11 shrink-0 text-[10px] text-gray-400">Krytí</span>
                  <input
                    type="range" min={0} max={1} step={0.05} value={r.alpha}
                    onChange={e => setRasterAlpha(r.id, parseFloat(e.target.value))}
                    title="0 % = jen mapa pod tím, 100 % = snímek ten kus mapy nahradí"
                    className="min-w-0 flex-1 accent-emerald-500"
                  />
                  <span className="w-8 text-[10px] tabular-nums text-gray-300">{Math.round(r.alpha * 100)}%</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-11 shrink-0 text-[10px] text-gray-400">Systém</span>
                  <select
                    value={r.crsId}
                    onChange={e => setRasterCrs(r.id, e.target.value as CrsId)}
                    title="Soustava world filu. Odhaduje se z .prj a z řádu souřadnic — přepni, když snímek skončil jinde, než má být."
                    className="min-w-0 flex-1 rounded bg-gray-800 px-1 py-0.5 text-[11px] text-gray-200 outline-none"
                  >
                    {CRS_IDS.map(c => <option key={c} value={c}>{CRS_LABELS[c]}</option>)}
                  </select>
                </div>
                <div className="px-0.5 text-[10px] tabular-nums text-gray-600">{r.px} · {fmtGsd(r.gsd)}</div>
              </div>
            ))}
          </Section>
          )}
          {districtsOn && selectedDistrict && (
          <Section id="mestcast" title="Městská část" dflt={true} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1.5">
              <Sparkles size={14} className="shrink-0 text-cyan-400" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">{districtsRef.current.get(selectedDistrict)?.name}</span>
              <button onClick={() => selectDistrict('')} title="Zrušit zvýraznění" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300">
                <Trash2 size={14} />
              </button>
            </div>
          </Section>
          )}
          <Section id="vyber" title="Výběr v mapě" dflt={true} open={openSec} onToggle={toggleSec}>
            <ToggleBtn active={parcelMode} onClick={toggleParcel} icon={parcelLoading ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />} label={parcelMode ? 'Klikni na parcelu' : 'Vybrat parcelu'} />
            <ToggleBtn active={areaMode} onClick={toggleAreaMode} icon={areaLoading ? <Loader2 size={15} className="animate-spin" /> : <Hexagon size={15} />} label={areaMode ? `Klikej body (${areaPtCount})` : 'Vybrat oblast'} />
            {areaMode && areaPtCount >= 3 && (
              // Tentýž nakreslený obrys umí dvě věci; co z něj vznikne, se rozhoduje až tady.
              <div className="flex flex-col gap-1">
                <button onClick={finalizeArea} disabled={areaLoading} className="flex items-center gap-2 rounded-lg bg-orange-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-orange-500 disabled:opacity-50">
                  {areaLoading ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Parcely uvnitř
                </button>
                <button onClick={finalizeAreaTiles} disabled={areaLoading} title={`Vybere dlaždice ${tileSize} m, jejichž střed padne dovnitř oblasti`} className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-cyan-500 disabled:opacity-50">
                  <Grid3x3 size={15} /> Dlaždice uvnitř ({tileSize} m)
                </button>
              </div>
            )}
            <ToggleBtn active={tileMode} onClick={toggleTileMode} icon={<Grid3x3 size={15} />} label={tileMode ? `Klikej / táhni (${tileCount})` : 'Vybrat dlaždice'} />
            <ToggleBtn active={regionMode} onClick={toggleRegionMode} icon={regionBusy ? <Loader2 size={15} className="animate-spin" /> : <Landmark size={15} />} label={regionMode ? 'Klikni na mapu (kraj/obec)' : 'Vybrat území'} />
            {regionMode && (
              <div className="px-1 pb-0.5 max-w-[200px] text-[10px] leading-snug text-gray-500">
                Klikni na mapu. Podle názvu se hledá v liště nahoře uprostřed.
              </div>
            )}
            {tileMode && (
              <div className="flex flex-col gap-1 px-1 pb-0.5">
                <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
                  Tažením maluješ přes víc dlaždic; tah, co začne na vybrané, naopak odebírá.
                  <span className="text-gray-400"> Mapu tady posouváš pravým tlačítkem, zoom kolečkem.</span>
                </div>
                {/* Zkratka na kreslení oblasti — kdo maluje dlaždice, hledá to tady, ne o dva
                    přepínače výš u parcel. Je to tentýž režim, jen se pak zvolí „Dlaždice uvnitř". */}
                <button
                  onClick={toggleAreaMode}
                  title="Místo malování obtáhni oblast a vyber dlaždice uvnitř"
                  className="flex items-center gap-2 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-700"
                >
                  <Hexagon size={13} /> Vybrat oblastí
                </button>
                <button
                  onClick={() => setGridOn(g => !g)}
                  className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs transition-colors ${gridOn ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                >
                  {gridOn ? <Eye size={13} /> : <EyeOff size={13} />} Mřížka s názvy
                </button>
                {gridOn && (
                  <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
                    {gridNote || `Názvy odpovídají „dlazdice_<X>_<Y>" v exportu.`}
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-gray-500 w-11 shrink-0">Dlaždice</span>
                  {TILE_SIZES.map(s => (
                    <button
                      key={s}
                      onClick={() => changeTileSize(s)}
                      className={`px-1.5 py-0.5 rounded text-[11px] ${tileSize === s ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >{s} m</button>
                  ))}
                </div>
                {tileCount > 0 && (
                  <div className="max-w-[190px] text-[10px] leading-snug text-gray-500">
                    Kvalitu a export najdeš níž v sekci <span className="text-gray-300">Dlaždice</span>.
                  </div>
                )}
              </div>
            )}
          </Section>
          <Section id="mereni" title="Měření" dflt={false} badge={rulers.length} open={openSec} onToggle={toggleSec}>
            {/* Spouštění měření je v liště dole nad mapou (mapTools.tsx) — je to nástroj, u kterého
                se pak kliká do mapy, takže patří k mapě. Tady zůstávají jen výsledky. */}
            {rulers.map(r => {
              // u plochy je hlavní číslo výměra, u čáry celková délka
              const a = r.kind === 'area' ? rulerArea(r.pts) : null
              const val = r.kind === 'area'
                ? (a ? fmtArea(a.area) : '—')
                : (r.pts.length > 1 ? fmtLen(rulerTotals(r.pts).len) : '—')
              return (
                <div
                  key={r.id}
                  onMouseEnter={() => setRulerSel(r.id)}
                  onMouseLeave={() => setRulerSel(s => (s === r.id ? null : s))}
                  className={`flex items-center gap-1 rounded px-1 py-0.5 ${rulerSel === r.id ? 'bg-gray-700/50' : ''}`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-200">
                    {r.name}
                    {r.id === rulerDraftId && <span className="ml-1 text-[9px] text-amber-500/80">kreslí se</span>}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-amber-300">{val}</span>
                  <button onClick={() => delRuler(r.id)} title={r.kind === 'area' ? 'Smazat tuto plochu' : 'Smazat toto měření'} className="shrink-0 rounded p-0.5 text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
                </div>
              )
            })}
            {rulers.length > 1 && (
              <button onClick={clearRulers} className="self-start px-1 text-[10px] text-gray-500 hover:text-red-300">smazat všechna měření</button>
            )}
            {!rulers.length && !rulerMode && (
              <div className="max-w-[200px] px-1 text-[10px] leading-snug text-gray-600">
                Zatím žádné — začni tlačítkem <span className="text-gray-400">Měření</span> v liště dole.
                Měří se v prostoru: bod se bere z povrchu i s výškou, takže sedí na svahu i na budově.
              </div>
            )}
          </Section>
          {parcelCount > 0 && (
          <Section id="parcely" title="Parcely" dflt={true} badge={parcelCount} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1.5">
              <MapPin size={14} className="shrink-0 text-cyan-400" />
              <span className="min-w-0 flex-1 text-sm text-gray-200">Vybráno: <span className="font-medium">{parcelCount}</span></span>
              <button onClick={clearAllParcels} title="Zrušit výběr všech parcel" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300">
                <Trash2 size={14} />
              </button>
            </div>
            {cutoutBusy ? (
              <div className="flex items-center gap-2">
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-700">
                  {cutoutPct >= 0
                    ? <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.max(3, Math.round(cutoutPct * 100))}%` }} />
                    : <div className="h-full w-1/3 animate-pulse bg-emerald-500/70" />}
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-300">{cutoutProgress || 'pracuji…'}</span>
                <button onClick={() => abortRef.current?.abort()} title="Zrušit stahování" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={14} /></button>
              </div>
            ) : (
              <>
                {/* Dřív to byla jedna dlouhá řada tlačítek — teď zvlášť „jak to vypadá" a „co z toho vyleze". */}
                <div className="px-0.5 text-[10px] uppercase tracking-wide text-gray-500">Zobrazení v mapě</div>
                <div className="grid grid-cols-2 gap-1">
                  <button onClick={() => setParcelClip(m => m === 'hide' ? 'off' : 'hide')} title="Skrýt mapu (ortofoto/topo + terén + Google) uvnitř vybraných parcel" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'hide' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                    <EyeOff size={13} /> Skrýt parcelu
                  </button>
                  <button onClick={() => setParcelClip(m => m === 'only' ? 'off' : 'only')} title="Nechat jen vybrané parcely a ztlumit okolí — nastav okraj a viditelnost okolí" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'only' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                    <Hexagon size={13} /> Jen parcelu
                  </button>
                </div>
                {ENABLE_GOOGLE_3D && (
                  <button onClick={() => setParcelClip(m => m === 'g3d' ? 'off' : 'g3d')} title="Topografická mapa všude + Google 3D realita JEN uvnitř vybraných parcel (potřebuje ion token)" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'g3d' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                    <Building2 size={13} /> Google jen ve výběru
                  </button>
                )}
                {parcelClip !== 'off' && (
                  <label className="flex items-center gap-1.5" title="Rovnoměrně zvětšit (+) nebo zmenšit (−) hranici">
                    <span className="w-14 shrink-0 text-[11px] text-gray-400">Okraj</span>
                    <input type="range" min={-50} max={50} step={0.5} value={parcelBuffer} onChange={e => setParcelBuffer(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                    <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{parcelBuffer > 0 ? '+' : ''}{parcelBuffer.toFixed(1)} m</span>
                  </label>
                )}
                {parcelClip === 'g3d' && (
                  <label className="flex items-center gap-1.5" title="Průhlednost 3D reality ve výběru — 100 % = plné 3D (topo pod ním skryté), níž = prosvítá topo mapa">
                    <span className="w-14 shrink-0 text-[11px] text-gray-400">3D realita</span>
                    <input type="range" min={0.1} max={1} step={0.05} value={googleAlpha} onChange={e => setGoogleAlpha(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                    <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(googleAlpha * 100)} %</span>
                  </label>
                )}
                {parcelClip === 'only' && (
                  <>
                    <label className="flex items-center gap-1.5" title="Viditelnost okolní ZEMĚ — 0 % = černá/skrytá, 100 % = plně vidět">
                      <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolí</span>
                      <input type="range" min={0} max={1} step={0.05} value={okoliVis} onChange={e => setOkoliVis(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(okoliVis * 100)} %</span>
                    </label>
                    <div className="flex items-center gap-1" title="Okolní 3D budovy: skrýt (čistá izolace) nebo nechat vidět (kontext)">
                      <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolní 3D</span>
                      <button onClick={() => setKeep3DAround(false)} className={`rounded px-1.5 py-0.5 text-[11px] ${!keep3DAround ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>skrýt</button>
                      <button onClick={() => setKeep3DAround(true)} className={`rounded px-1.5 py-0.5 text-[11px] ${keep3DAround ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>zobrazit</button>
                    </div>
                  </>
                )}
                <div className="flex gap-1">
                  <button onClick={toggleParcelHighlight} title="Zap/vyp tyrkysové zvýraznění parcely (výběr i ořez zůstanou) — koukat na parcelu načisto" className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelHl ? 'bg-gray-800 text-gray-200 hover:bg-gray-700' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}>
                    {parcelHl ? <Eye size={13} /> : <EyeOff size={13} />} Zvýraznění
                  </button>
                  <button onClick={() => setParcelMeasure(m => !m)} title="Kóty délek u každé strany + výměra uprostřed parcely. Počítá se v S-JTSK jako v katastru, takže čísla lícují s výměrou z KN." className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelMeasure ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                    <Ruler size={13} /> Měření
                  </button>
                </div>
                {parcelMeasure && (
                  <div className="rounded-lg bg-gray-800/60 px-2 py-1 text-[11px] text-gray-300">
                    Výměra výběru: <span className="font-medium tabular-nums text-emerald-300">{fmtArea(measureSum.area)}</span>
                    <span className="text-[10px] text-gray-500"> z KN</span>
                    {Math.abs(measureSum.mapArea - measureSum.area) >= 1 && (
                      <div className="mt-0.5 text-[10px] text-gray-400" title="Spočítáno z geometrie mapy — lícuje s kótami po obvodu a s DXF exportem. Výměra v KN není z mapy přepočítaná, je zapsaná.">
                        z mapy <span className="tabular-nums">{fmtArea(measureSum.mapArea)}</span>
                      </div>
                    )}
                    {measureSum.note && <div className="mt-0.5 text-[10px] text-amber-400/90">{measureSum.note}</div>}
                  </div>
                )}
                <button onClick={resetClipping} title="Reset ořezu — vypnout masky i parcelový ořez, zobrazit celou mapu" className="flex items-center justify-center gap-1 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700">
                  <RotateCcw size={13} /> Reset ořezu
                </button>
                <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">Export výběru</div>
                <button onClick={exportParcelCutout} title="Výřez terénu DMR 5G ořezaný na hranici výběru + zapečené ortofoto → zip (OBJ + MTL + JPEG + V-Ray) pro 3ds Max" className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500">
                  <Download size={13} /> Terén + ortofoto (OBJ)
                </button>
                {base === 'google' && (
                  <button onClick={exportGoogleMesh} title="Vytáhnout mesh z Google 3D dlaždic pro vybranou oblast včetně fototextur (reference) → zip (OBJ + MTL + JPEG)" className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500">
                    <Download size={13} /> Google mesh + textury (OBJ)
                  </button>
                )}
                <button onClick={exportParcelsDxf} disabled={exporting} title="Export hranic parcel jako křivky (DXF pro 3ds Max)" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">
                  {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Hranice parcel (DXF)
                </button>
                <button onClick={captureParcelViews} title="Vyfotit vybranou budovu ze 4 stran (kamera obletí, počká na dokreslení) → zip PNG. Nejlepší v 3D realitě." className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-2 py-1.5 text-xs text-white hover:bg-violet-500">
                  <Image size={13} /> 4 pohledy (PNG)
                </button>
              </>
            )}
          </Section>
          )}
          {tileCount > 0 && (
          <Section id="dlazdice" title="Dlaždice" dflt={true} badge={tileCount} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1.5">
              <Grid3x3 size={14} className="shrink-0 text-cyan-400" />
              <span className="min-w-0 flex-1 text-sm text-gray-200">Vybráno: <span className="font-medium">{tileCount}</span> × {tileSize} m</span>
              <button onClick={clearTiles} title="Zrušit výběr dlaždic" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300">
                <Trash2 size={14} />
              </button>
            </div>
            {tileBusy ? (
              <div className="flex items-center gap-2">
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-700">
                  {tilePct >= 0
                    ? <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.max(3, Math.round(tilePct * 100))}%` }} />
                    : <div className="h-full w-1/3 animate-pulse bg-emerald-500/70" />}
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-300">{tileProgress || 'pracuji…'}</span>
                <button onClick={() => abortRef.current?.abort()} title="Zrušit stahování" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={14} /></button>
              </div>
            ) : (
              <>
                {/* Nastavení exportu bývalo nahoře ve „Výběru" — nastavovalo se jinde, než se exportovalo. */}
                <div className="px-0.5 text-[10px] uppercase tracking-wide text-gray-500">Co přibalit</div>
                <button
                  onClick={() => setExportKatastr(v => !v)}
                  title="Přibalit do zipu i hranice parcel (katastr) jako DXF křivky"
                  className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs transition-colors ${exportKatastr ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                >
                  {exportKatastr ? <Check size={13} /> : <Layers size={13} />} Přidat katastr (DXF)
                </button>
                <button
                  onClick={() => setExportBuildings(v => !v)}
                  title="Přidat budovy z ČÚZK — výška a tvar střechy (plochá/sedlová/valbová) z výškových modelů, low-poly, hnědý materiál"
                  className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs transition-colors ${exportBuildings ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                >
                  {exportBuildings ? <Check size={13} /> : <Building2 size={13} />} Přidat budovy
                </button>
                <div className="mt-0.5 px-0.5 text-[10px] uppercase tracking-wide text-gray-500">Kvalita</div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-gray-500 w-11 shrink-0">Textura</span>
                  {TEX_SIZES.map(s => (
                    <button
                      key={s}
                      onClick={() => setTexSize(s)}
                      className={`px-1.5 py-0.5 rounded text-[11px] ${texSize === s ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >{s}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-gray-500 w-11 shrink-0">Terén</span>
                  {MESH_STEPS.map(s => (
                    <button
                      key={s}
                      onClick={() => setMeshStep(s)}
                      title={s === 3 ? 'Sedne na zdrojová data (body DMR 5G mají rozteč ~2,8 m)' : s === 2 ? 'Hustší než zdroj — jen interpoluje, 2× víc trojúhelníků' : 'Řidší než zdroj — ubere detail, ušetří trojúhelníky'}
                      className={`px-1.5 py-0.5 rounded text-[11px] ${meshStep === s ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >{s} m</button>
                  ))}
                </div>
                <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
                  Ortofoto {(tileSize / texSize * 100).toFixed(0)} cm/px{tileSize / texSize < 0.2 ? ' (nad nativních 20 cm)' : ''}
                  {' · '}
                  {meshStep === 3 ? 'terén sedne na zdroj (body 5G mají ~2,8 m)' : meshStep === 2 ? 'terén hustší než zdroj — jen interpolace' : `terén po ${meshStep} m — řidší než zdroj`}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-gray-500 w-11 shrink-0" title="Strop rozlišení spojené 2D mapy">Mapa px</span>
                  {[8192, 12288, 16384].map(s => (
                    <button
                      key={s}
                      onClick={() => setStitchMax(s)}
                      title={s === 16384 ? 'Nejostřejší, ale ~1 GB paměti — u velkých oblastí může spadnout' : undefined}
                      className={`px-1.5 py-0.5 rounded text-[11px] ${stitchMax === s ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >{s / 1024}k</button>
                  ))}
                </div>
                {tileCount > 0 && (() => {
                  // odhad rozlišení spojené mapy pro aktuální výběr (nativní 20 cm/px, zastropováno)
                  let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity
                  for (const t of tilesRef.current.values()) { ix0 = Math.min(ix0, t.ix); ix1 = Math.max(ix1, t.ix); iy0 = Math.min(iy0, t.iy); iy1 = Math.max(iy1, t.iy) }
                  const spanX = (ix1 - ix0 + 1) * tileSize, spanY = (iy1 - iy0 + 1) * tileSize
                  const nW = spanX / 0.2, nH = spanY / 0.2
                  let sc = Math.min(1, stitchMax / Math.max(nW, nH))
                  if (nW * sc * nH * sc > 16384 * 16384) sc = Math.sqrt(16384 * 16384 / (nW * nH))
                  const cmpx = 0.2 / sc * 100
                  const W = Math.round(nW * sc), H = Math.round(nH * sc)
                  return (
                    <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
                      Ortofoto: {W}×{H} px · {cmpx.toFixed(0)} cm/px{sc >= 1 ? ' (nativní)' : ''}<br />
                      <span className="text-gray-600">topo jen orientační podklad (menší)</span>
                    </div>
                  )
                })()}
                <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
                  Vyveze se v reálných S-JTSK souřadnicích, bez posunu.
                </div>
                {(() => {
                  const n = gridSize({ ix: 0, iy: 0, size: tileSize }, meshStep)
                  const tris = tileCount * 2 * (n - 1) ** 2
                  const mb = estimateObjBytes(tileCount, tileSize, meshStep) / 1e6
                  const heavy = mb > 150
                  return (
                    <span className={`max-w-[190px] text-[10px] leading-snug ${heavy ? 'text-amber-400' : 'text-gray-500'}`} title={heavy ? 'Velký OBJ — zvaž řidší mřížku terénu nebo míň dlaždic' : undefined}>
                      {tris >= 1e6 ? `~${(tris / 1e6).toFixed(1)} M trojúh.` : `~${Math.round(tris / 1e3)} k trojúh.`}
                      {' · OBJ ~'}{mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`}
                    </span>
                  )
                })()}
                <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">Export výběru</div>
                <button onClick={exportTilesObj} title="Čistý terén DMR 5G s ortofoto texturou → zip s OBJ + MTL + JPEG pro 3ds Max" className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500">
                  <Download size={13} /> Terén + ortofoto (OBJ)
                </button>
                <button onClick={exportStitchedMaps} title="Spojená 2D mapa přes výběr — ortofoto i topografická mapa jako jeden georeferencovaný obrázek (world file)" className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500">
                  <Image size={13} /> Spojená mapa (2D)
                </button>

                {/* Dlaždicový 2D export. Na rozdíl od „Spojené mapy" drží zvolené rozlišení
                    i u velkého území — místo jednoho zmenšeného obrázku vyjde sada dlaždic. */}
                <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">
                  2D mapa po dlaždicích
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-11 shrink-0 text-[10px] text-gray-500">Vrstva</span>
                  {([['ortofoto', 'ortofoto'], ['topo', 'topo']] as const).map(([v, lbl]) => (
                    <button key={v} onClick={() => setMapLayer(v)} className={`rounded px-1.5 py-0.5 text-[11px] ${mapLayer === v ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>{lbl}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-11 shrink-0 text-[10px] text-gray-500" title="Metry na pixel. Ortofoto ČÚZK má nativně 20 cm.">Detail</span>
                  {MAP_RES.map(r => (
                    <button
                      key={r}
                      onClick={() => setMapRes(r)}
                      title={r === 0.2 ? 'Nativní rozlišení ČÚZK — nejostřejší, co existuje' : `${(r / 0.2).toFixed(0)}× hrubší než zdroj, ${(r / 0.2) ** 2}× menší soubor`}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${mapRes === r ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >{r < 1 ? `${r * 100}cm` : `${r}m`}</button>
                  ))}
                </div>
                {(() => {
                  const e = estimateMapTiles(tileCount, tileSize, mapRes)
                  const disk = e.bytes > 500e6
                  return (
                    <div className={`max-w-[190px] px-1 text-[10px] leading-snug ${disk ? 'text-amber-400' : 'text-gray-500'}`}>
                      {tileCount}× {e.side}×{e.side} px · {(e.px / 1e9).toFixed(1)} Gpx · ~{fmtBytes(e.bytes)}
                      {disk && <><br />Velké — zapíše se rovnou na disk (zeptá se kam). Chrome/Edge.</>}
                    </div>
                  )
                })()}
                <button onClick={exportMapTiles2D} title="Každá dlaždice jako georeferencovaný JPEG + world file. Rozlišení se drží i u velkého území." className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500">
                  <Grid3x3 size={13} /> Export 2D po dlaždicích
                </button>
                <button onClick={exportTilesGeoTiff} title="Jeden spojený obrázek přes obálku výběru, s georeferencí. Otevře ho Photoshop i After Effects." className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2 py-1.5 text-xs text-white hover:bg-emerald-500">
                  <Image size={13} /> Spojený GeoTIFF
                </button>
                {!LOCAL_TILES && (
                  <button onClick={loadLocal2DMap} title="Napéct ortofoto vybrané oblasti do localu jako dlaždicovou pyramidu (nativní rozlišení, kvalita se nezhoršuje s velikostí, jde zoomovat hloub). Jednorázové stahování z ČÚZK (u větší oblasti to chvíli trvá), pak lokální/offline a uložené natrvalo. Nenapečené oblasti jedou dál z ČÚZK." className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500">
                    <ArrowDownToLine size={13} /> Načíst 2D lokálně
                  </button>
                )}
              </>
            )}
          </Section>
          )}
          {/* Nalezená území se vybírají v liště nahoře uprostřed (mapSearch.tsx). Tady zůstává
              jen to, co následuje po výběru: co je zvýrazněné, ztmavení okolí a exporty. */}
          {regionName && (
          <Section id="uzemi" title="Správní území" dflt={true} open={openSec} onToggle={toggleSec}>
            {regionName && (
              <>
                <div className="flex items-center gap-1.5">
                  <Landmark size={14} className="shrink-0 text-cyan-400" />
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-200">Zvýrazněno: <span className="font-medium">{regionName}</span></span>
                  <button onClick={clearRegion} title="Zrušit zvýraznění území" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300"><RotateCcw size={14} /></button>
                </div>
                {/* Území → dlaždice. Výběr se SČÍTÁ, takže jde poskládat víc krajů za sebou:
                    najdi území, přidej, najdi další, přidej. Dlaždice se přitom neruší. */}
                <button
                  onClick={addRegionTiles}
                  title={`Vyplní hranici území dlaždicemi ${tileSize} m a přidá je k už vybraným`}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-2 py-1.5 text-xs text-white transition-colors hover:bg-cyan-500"
                >
                  <Grid3x3 size={13} /> Přidat jako dlaždice ({tileSize} m)
                </button>
                <label className="flex items-center gap-1.5" title="Viditelnost okolí — 0 % = tmavé, 100 % = plně vidět">
                  <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolí</span>
                  <input type="range" min={0} max={1} step={0.05} value={regionDim} onChange={e => setRegionDim(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                  <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(regionDim * 100)} %</span>
                </label>
                {cutoutBusy ? (
                  <div className="flex items-center gap-2">
                    <Loader2 size={13} className="shrink-0 animate-spin text-gray-300" />
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-300">{cutoutProgress || 'exportuji…'}</span>
                    <button onClick={() => abortRef.current?.abort()} title="Zrušit export" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">Export území</div>
                    <button onClick={exportRegionCutout} title="Výřez terénu DMR 5G + zapečené ortofoto ořezaný na hranici území → OBJ (velké území = hrubší mřížka / velký soubor)" className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500"><Download size={13} /> Terén + ortofoto (OBJ)</button>
                    <button onClick={exportRegionMaps} title="Spojená 2D mapa ořezaná na tvar území (jako výřez terénu) — ortofoto (PNG s alfou) + topo jako georeferencovaný obrázek (world file), okolí průhledné. JEDEN obrázek → u velkého území klesne rozlišení." className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500"><Image size={13} /> Spojená mapa (2D)</button>

                    {/* Dlaždicová varianta téhož: drží zvolený detail i u kraje, protože nemusí
                        skončit v jednom canvasu. Ořez na obrys je stejný, jen po dlaždicích. */}
                    <div className="flex items-center gap-1">
                      <span className="w-11 shrink-0 text-[10px] text-gray-500" title="Metry na pixel. Ortofoto ČÚZK má nativně 20 cm.">Detail</span>
                      {MAP_RES.map(r => (
                        <button
                          key={r}
                          onClick={() => setMapRes(r)}
                          className={`rounded px-1.5 py-0.5 text-[11px] ${mapRes === r ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                        >{r < 1 ? `${r * 100}cm` : `${r}m`}</button>
                      ))}
                    </div>
                    <button onClick={exportRegionMapTiles} title="2D mapa po dlaždicích, oříznutá na skutečný obrys území. Na rozdíl od spojené mapy drží zvolený detail i u kraje." className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500">
                      <Grid3x3 size={13} /> Mapa po dlaždicích ({mapRes < 1 ? `${mapRes * 100} cm` : `${mapRes} m`}/px)
                    </button>
                    {/* Jeden spojený soubor pro Photoshop / AE. Nejde přes canvas, takže na rozdíl
                        od „Spojené mapy" ho neomezuje jeho strop 16 384 px. */}
                    <button onClick={exportRegionGeoTiff} title="Jeden spojený obrázek oříznutý na obrys území, s georeferencí. Otevře ho Photoshop i After Effects." className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2 py-1.5 text-xs text-white hover:bg-emerald-500">
                      <Image size={13} /> Spojený GeoTIFF ({mapRes < 1 ? `${mapRes * 100} cm` : `${mapRes} m`}/px)
                    </button>
                    {(() => {
                      const a = regionActiveRef.current
                      if (!a) return null
                      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
                      for (const r of a.sjtskRings) for (const [x, y] of r) {
                        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
                      }
                      if (!isFinite(x0)) return null
                      const p = planGeoTiff(x1 - x0, y1 - y0, mapRes, true)
                      return (
                        <div className={`max-w-[190px] px-1 text-[10px] leading-snug ${p.tiffOk ? 'text-gray-500' : 'text-amber-400'}`}>
                          {p.W}×{p.H} px · {fmtBytes(p.bytes)}<br />
                          {p.tiffOk ? 'TIFF ok' : 'nad 4 GB — hrubší detail'}
                          {' · '}{p.photoshopOk ? 'Photoshop ok' : 'nad Photoshop'}
                          {' · '}{p.afterEffectsOk ? 'AE ok' : 'nad AE (30k px)'}
                        </div>
                      )
                    })()}
                    <button onClick={exportRegionKatastrDxf} disabled={exporting} title="Katastr území do DXF: hranice jednotlivých parcel (hladina PARCELY) + obrys území (HRANICE_UZEMI), reálné S-JTSK + výšky DMR → lícuje s Terén (OBJ) i dlaždicemi" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">{exporting ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />} Katastr (DXF)</button>
                    <button onClick={exportRegionDxf} disabled={exporting} title="Jen obrys území jako uzavřená 3D křivka (DXF R12) drapovaná na DMR — lokální ENU rámec" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">{exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Obrys území (DXF)</button>
                    {!LOCAL_TILES && (
                      <button onClick={loadRegionLocal2D} title="Napéct ortofoto území do localu jako dlaždicovou pyramidu (nativní rozlišení, jde zoomovat hloub). Jednorázové stahování z ČÚZK (u velkého území to chvíli trvá), pak lokální/offline a uložené natrvalo." className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500"><ArrowDownToLine size={13} /> Načíst 2D lokálně</button>
                    )}
                  </>
                )}
              </>
            )}
          </Section>
          )}
          <Section id="import" title="Import" dflt={false} open={openSec} onToggle={toggleSec}>
            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-colors">
              <Upload size={15} /> Import modelu
            </button>
            <button onClick={() => dwgRef.current?.click()} disabled={drawingLoading} title="Nahrát výkres DXF/DWG a zobrazit ho na mapě (v S-JTSK se umístí na správné místo; DWG se převede přes WASM)" className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">
              {drawingLoading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Nahrát výkres (DXF/DWG)
            </button>
            {/* Vlastní ortofoto bývalo samostatnou sekcí — je to ale taky „přines soubor zvenčí",
                jen jiného druhu. Načtené snímky se vypisují níž ve vlastní sekci, jako parcely
                nebo dlaždice: objeví se, až nějaké jsou. */}
            <button
              onClick={() => rasterFileRef.current?.click()}
              disabled={rasterBusy}
              title="Vyber najednou obrázek i world file (u GeoTIFFu stačí .tif sám). Snímek se natáhne na terén nad ČÚZK podklad."
              className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              {rasterBusy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Vlastní ortofoto (snímek + .jgw)
            </button>
            <button onClick={() => loadSplat()} disabled={splatLoading || splatOn} title="TEST: načíst Gaussian splat (Schillerova rozhledna, Kryry) z Cesium ion a posadit na mapu" className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-fuchsia-600 hover:bg-fuchsia-500 text-white transition-colors disabled:opacity-50">
              {splatLoading ? <Loader2 size={15} className="animate-spin" /> : <Box size={15} />} Splat (Kryry)
            </button>
          </Section>
          {objects.length > 0 && (
          <Section id="scena" title="Scéna" dflt={true} badge={objects.length} open={openSec} onToggle={toggleSec}>
            {objects.map(o => {
              const draw = o.kind === 'drawing' ? drawingsRef.current.get(o.id.replace('drawing-', '')) : null
              const hasLayers = !!draw && draw.layers.length > 0
              const isExpanded = hasLayers && expandedDrawings.has(o.id)
              return (
              <div key={o.id} className="flex flex-col">
              <div
                onClick={() => o.kind === 'model' ? selectObject(o.id) : o.kind === 'drawing' ? locateObject(o) : selectObject(null)}
                className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm cursor-pointer ${
                  selectedId === o.id ? 'bg-emerald-600/25 text-emerald-100' : 'text-gray-300 hover:bg-gray-800'
                }`}
              >
                {hasLayers ? (
                  <button onClick={e => { e.stopPropagation(); toggleExpand(o.id) }} title={`Hladiny (${draw!.layers.length})`} className="shrink-0 -ml-1 p-0.5 rounded text-gray-400 hover:text-gray-100">
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                ) : null}
                <span className="text-[10px] text-gray-500 w-9 shrink-0">{o.kind === 'model' ? 'model' : o.kind === 'parcel' ? 'parc' : o.kind === 'drawing' ? 'výkr' : 'ploch'}</span>
                {renamingId === o.id ? (
                  <input
                    autoFocus value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null) }}
                    onClick={e => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-gray-800 rounded px-1 text-gray-100 outline-none"
                  />
                ) : (
                  <span
                    className="flex-1 min-w-0 truncate"
                    onDoubleClick={e => { if (o.kind === 'model') { e.stopPropagation(); setRenamingId(o.id); setRenameDraft(o.name) } }}
                    title={o.name}
                  >{o.name}</span>
                )}
                <button onClick={e => { e.stopPropagation(); locateObject(o) }} title="Zaměřit na mapě (odletět na místo)" className="shrink-0 p-0.5 rounded text-gray-400 hover:text-cyan-300">
                  <Crosshair size={13} />
                </button>
                <button onClick={e => { e.stopPropagation(); toggleVisible(o) }} title="Zobrazit/skrýt" className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-100">
                  {o.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button onClick={e => { e.stopPropagation(); deleteObject(o) }} title="Smazat" className="shrink-0 p-0.5 rounded text-gray-400 hover:text-red-300 opacity-0 group-hover:opacity-100">
                  <Trash2 size={13} />
                </button>
              </div>
              {isExpanded && draw && (() => {
                const did = o.id.replace('drawing-', '')
                const q = (layerFilter[o.id] || '').toLowerCase().trim()
                const shown = q ? draw.layers.filter(l => l.name.toLowerCase().includes(q)) : draw.layers
                const shownNames = shown.map(l => l.name)
                const sel = layerSel[o.id] ?? EMPTY_NAMESET
                const selCount = sel.size
                const bulk = selCount > 0 ? [...sel] : shownNames // očka pracují nad výběrem, jinak nad zobrazenými
                return (
                <div className="ml-5 mb-1 mt-0.5 flex flex-col gap-0.5 border-l border-gray-700 pl-2">
                  <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-400" onClick={e => e.stopPropagation()}>
                    <span className="w-10 shrink-0">Výška</span>
                    <input type="range" min={-100} max={100} step={0.5} value={drawH[did] ?? 0} onChange={e => setDrawingHeight(did, Number(e.target.value))} className="flex-1 min-w-0" />
                    <span className="w-10 text-right tabular-nums shrink-0">{(drawH[did] ?? 0).toFixed(1)} m</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-400" onClick={e => e.stopPropagation()}>
                    <span className="w-10 shrink-0">Průhled.</span>
                    <input type="range" min={0.05} max={1} step={0.05} value={drawA[did] ?? 1} onChange={e => setDrawingAlpha(did, Number(e.target.value))} className="flex-1 min-w-0" />
                    <span className="w-10 text-right tabular-nums shrink-0">{Math.round((drawA[did] ?? 1) * 100)} %</span>
                  </div>
                  <div className="flex items-center gap-1 px-1 pb-0.5">
                    <Search size={11} className="shrink-0 text-gray-500" />
                    <input
                      value={layerFilter[o.id] || ''}
                      onChange={e => setLayerFilter(f => ({ ...f, [o.id]: e.target.value }))}
                      onClick={e => e.stopPropagation()}
                      placeholder="hledat hladinu…"
                      className="flex-1 min-w-0 bg-gray-800 rounded px-1 py-0.5 text-xs text-gray-100 outline-none placeholder:text-gray-600"
                    />
                    <button onClick={e => { e.stopPropagation(); setLayersVisibility(did, bulk, true) }} title={selCount > 0 ? `Zobrazit vybrané (${selCount})` : q ? 'Zobrazit nalezené' : 'Zobrazit vše'} className="shrink-0 p-0.5 rounded text-gray-400 hover:text-emerald-300"><Eye size={12} /></button>
                    <button onClick={e => { e.stopPropagation(); setLayersVisibility(did, bulk, false) }} title={selCount > 0 ? `Skrýt vybrané (${selCount})` : q ? 'Skrýt nalezené' : 'Skrýt vše'} className="shrink-0 p-0.5 rounded text-gray-400 hover:text-red-300"><EyeOff size={12} /></button>
                  </div>
                  <div className="flex items-center gap-2 px-1 pb-0.5 text-[10px] text-gray-500">
                    <span className={selCount > 0 ? 'text-emerald-300' : ''}>{selCount > 0 ? `${selCount} vybráno` : `${shown.length} hladin`}</span>
                    <button onClick={e => { e.stopPropagation(); selectAllLayers(o.id, shownNames) }} className="hover:text-gray-200">vybrat vše</button>
                    {selCount > 0 && <button onClick={e => { e.stopPropagation(); clearLayerSel(o.id) }} className="hover:text-gray-200">zrušit výběr</button>}
                  </div>
                  {shown.length === 0 ? (
                    <div className="px-1 py-0.5 text-xs text-gray-600">žádná hladina</div>
                  ) : shown.map(ly => {
                    const isSel = sel.has(ly.name)
                    return (
                    <div
                      key={ly.name}
                      onMouseDown={e => { e.stopPropagation(); e.preventDefault(); startLayerDrag(o.id, ly.name, shownNames, e.shiftKey) }}
                      onMouseEnter={() => dragOverLayer(o.id, ly.name)}
                      title={`${ly.name} — klik označí, tažením označíš víc, Shift+klik rozsah`}
                      className={`flex items-center gap-1.5 px-1 py-0.5 rounded text-xs cursor-pointer select-none ${isSel ? 'bg-emerald-600/25 text-emerald-100' : `hover:bg-gray-800 ${ly.visible ? 'text-gray-300' : 'text-gray-500'}`}`}
                    >
                      <span className="shrink-0 w-2.5 h-2.5 rounded-sm border border-gray-600" style={{ background: '#' + (ly.color & 0xffffff).toString(16).padStart(6, '0') }} />
                      <span className="flex-1 min-w-0 truncate">{ly.name}</span>
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); if (sel.has(ly.name)) setLayersVisibility(did, [...sel], !ly.visible); else toggleLayer(did, ly.name) }}
                        title={sel.has(ly.name) ? `Zobrazit/skrýt všechny vybrané (${selCount})` : 'Zobrazit/skrýt tuto hladinu'}
                        className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-100"
                      >
                        {ly.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                      </button>
                    </div>
                    )
                  })}
                </div>
                )
              })()}
              </div>
              )
            })}
          </Section>
          )}
          {placement && (
          <Section id="model" title="Vybraný model" dflt={true} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-gray-100 truncate">{objects.find(o => o.id === selectedId)?.name ?? 'Model'}</div>
              <div className="flex shrink-0 items-center gap-0.5">
                {/* Editor modelu (anotace, vegetace, materiály) — jen pro modely, které už jsou
                    nahrané. Dokud upload neskončí, není co otevřít. */}
                {selectedId && modelsRef.current.get(selectedId)?.assetId && (
                  <button
                    onClick={() => {
                      const aid = selectedId ? modelsRef.current.get(selectedId)?.assetId : null
                      if (aid) sceneRef.current.openModel(aid)
                    }}
                    title="Otevřít v editoru modelu (anotace, vegetace, materiály)"
                    className="p-1 rounded-lg text-gray-400 hover:bg-gray-800 hover:text-emerald-300"
                  >
                    <Box size={15} />
                  </button>
                )}
                <button onClick={() => selectedId && deleteModel(selectedId)} title="Odebrat model" className="p-1 rounded-lg text-gray-400 hover:bg-gray-800 hover:text-red-300">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            {/* Posun je nástroj — kliká se s ním do mapy, takže sedí v liště dole (mapTools.tsx).
                Objeví se tam právě tehdy, když je model vybraný, tedy když má co posouvat. */}
            <div className="flex gap-1.5">
              <button onClick={focusModel} title="Zaměřit kameru na model" className="px-2 py-1.5 rounded-lg bg-gray-800 text-gray-200 hover:bg-gray-700">
                <Crosshair size={15} />
              </button>
            </div>

            <button onClick={dropToGround} className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-200 hover:bg-gray-700">
              <ArrowDownToLine size={14} /> Posadit na terén
            </button>

            <button
              onClick={() => setSectionOn(s => !s)}
              title="Odříznout terén/Google svislou rovinou → profil model+terén (stavební řez)"
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                sectionOn ? 'bg-cyan-600 text-white hover:bg-cyan-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
              }`}
            >
              <Layers size={14} /> {sectionOn ? 'Řez zapnutý' : 'Řez terénem'}
            </button>
            {sectionOn && (
              <div className="flex flex-col gap-2 pl-1 border-l-2 border-cyan-700/50">
                <NumRow label="Natočení řezu" value={sectionAz} min={0} max={359} step={1} unit="°" onChange={v => setSectionAz(v)} />
                <NumRow label="Posun řezu" value={sectionOffset} min={-500} max={500} step={1} unit="m" onChange={v => setSectionOffset(v)} />
                <button onClick={() => setSectionFlip(f => !f)} className="flex items-center justify-center gap-1.5 px-2 py-1 rounded-lg text-xs bg-gray-800 text-gray-300 hover:bg-gray-700">
                  <RotateCcw size={13} /> Otočit stranu řezu
                </button>
              </div>
            )}

            {selectedId && modelsRef.current.get(selectedId)?.footprint && (
              <button
                onClick={() => selectedId && toggleExcavation(selectedId)}
                title="Skrýt mapu (ortofoto/topo + terén + Google 3D) přesně pod/nad modelem podle jeho obrysu"
                className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                  modelsRef.current.get(selectedId)?.excavate ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                }`}
              >
                <Mountain size={14} /> {modelsRef.current.get(selectedId)?.excavate ? 'Mapa pod modelem skrytá' : 'Skrýt mapu pod modelem'}
              </button>
            )}

            {selectedId && (
              <button
                onClick={() => selectedId && toggleOutline(selectedId)}
                title="Zapnout/vypnout svítící obrys kolem modelu"
                className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                  modelsRef.current.get(selectedId)?.outline ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                }`}
              >
                <Sparkles size={14} /> {modelsRef.current.get(selectedId)?.outline ? 'Obrys zapnutý' : 'Obrys vypnutý'}
              </button>
            )}

            <NumRow label="Výška nad terénem" value={placement.heightOffset} min={-20} max={200} step={0.1} unit="m" onChange={v => patch({ heightOffset: v })} />
            <NumRow label="Otočení" value={placement.heading} min={0} max={359} step={1} unit="°" onChange={v => patch({ heading: v })} />
            <NumRow label="Náklon (pitch)" value={placement.pitch} min={-45} max={45} step={0.5} unit="°" onChange={v => patch({ pitch: v })} />
            <NumRow label="Náklon (roll)" value={placement.roll} min={-45} max={45} step={0.5} unit="°" onChange={v => patch({ roll: v })} />
            <NumRow label="Měřítko" value={placement.scale} min={0.1} max={20} step={0.1} unit="×" onChange={v => patch({ scale: v })} />

            <button onClick={() => patch({ heading: 0, pitch: 0, roll: 0 })} className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-300 hover:bg-gray-700">
              <RotateCcw size={13} /> Reset natočení
            </button>

            <div className="text-[10px] text-gray-500 leading-snug">
              {placement.lat.toFixed(5)}, {placement.lon.toFixed(5)}
            </div>
          </Section>
          )}
          {splatOn && (
          <Section id="splat" title="Gaussian splat (test)" dflt={true} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center justify-between">
              <span className="text-gray-100 font-medium flex items-center gap-1"><Box size={14} className="text-fuchsia-400" /> Splat (Kryry)</span>
              <div className="flex items-center gap-1">
                <button onClick={toggleSplatShow} title="Zobrazit/skrýt splat (ať vidíš ortofoto/terén pod ním)" className={`p-0.5 rounded ${splatShow ? 'text-fuchsia-300 hover:text-fuchsia-200' : 'text-gray-500 hover:text-gray-300'}`}>{splatShow ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                <button onClick={removeSplat} title="Odebrat splat" className="p-0.5 rounded text-gray-400 hover:text-red-300"><Trash2 size={14} /></button>
              </div>
            </div>
            <div className="flex gap-1.5">
              <button onClick={resetSplat} title="Skočit na Kryry + odhadnout velikost + narovnat — výchozí bod, když splat lítá/je obří/mrňavý" className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 flex items-center gap-1"><RotateCcw size={13} /> Na Kryry</button>
              <button onClick={() => setSplatMove(m => { const nv = !m; if (nv) setSplatCP(false); return nv })} title="Táhni splat levým tlačítkem po terénu; mapu posouváš pravým tlačítkem" className={`flex-1 px-2 py-1 rounded-lg text-xs flex items-center justify-center gap-1 ${splatMove ? 'bg-fuchsia-600 text-white' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                <Move size={13} /> {splatMove ? 'Táhni (pravé=mapa)' : 'Posunout'}
              </button>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-400 w-12 shrink-0">Měřítko</span>
              <button onClick={() => updateSplat({ scale: splatP.scale / 2 })} className="px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200">÷2</button>
              <input type="number" value={splatP.scale} step="0.1" onChange={e => updateSplat({ scale: Number(e.target.value) || 0.0001 })} className="w-full min-w-0 bg-gray-800 rounded px-1 py-0.5 text-gray-100 text-center" />
              <button onClick={() => updateSplat({ scale: splatP.scale * 2 })} className="px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200">×2</button>
            </div>
            {([['Otočení', 'heading', -180, 180], ['Sklon', 'pitch', -180, 180], ['Náklon', 'roll', -180, 180], ['Výška', 'heightOffset', -300, 300]] as const).map(([lbl, key, mn, mx]) => (
              <label key={key} className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-400 w-12 shrink-0">{lbl}</span>
                <input type="range" min={mn} max={mx} step={1} value={splatP[key]} onChange={e => updateSplat({ [key]: Number(e.target.value) } as Partial<Placement>)} className="flex-1 min-w-0" />
                <span className="text-gray-300 w-9 text-right tabular-nums shrink-0">{Math.round(splatP[key])}</span>
              </label>
            ))}
            <div className="border-t border-gray-700 pt-2 mt-0.5 flex flex-col gap-1.5">
              <button onClick={() => setSplatCP(m => { const nv = !m; if (nv) setSplatMove(false); return nv })} title="Vlícování: naklikej 3+ dvojice (bod na splatu ↔ tentýž bod na mapě), spočítám nejlepší usazení a splat skočí co nejblíž" className={`px-2 py-1 rounded-lg text-xs flex items-center justify-center gap-1 ${splatCP ? 'bg-fuchsia-600 text-white' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                <Crosshair size={13} /> {splatCP ? 'Vlícování zapnuto' : 'Vlícovat body (auto)'}
              </button>
              {splatCP && (
                <>
                  <div className="text-[10px] leading-snug text-gray-400">
                    <span className={cpPending ? 'text-amber-300' : 'text-fuchsia-300'}>
                      {cpPending ? '➋ Klikni, KAM to patří na ortofotu (skryj splat okem).' : '➊ SHORA klikni zem POD prvkem splatu (pata zdi, roh u země).'}
                    </span>{' '}Dvojic: <span className="text-gray-200">{cpCount}</span> · klik vždy padne na TERÉN (splat chytit nejde) → koukej kolmo shora a měj splat postavený na zemi. Body rozházené (ne v přímce). Nehýbej splatem během klikání.
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={computeCP} disabled={cpCount < 3} className="flex-1 px-2 py-1 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">Spočítat ({cpCount})</button>
                    <button onClick={clearCP} className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200">Vymazat</button>
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <button onClick={saveSplat} title="Uložit polohu/měřítko/natočení — splat se pak načte rovnou takhle zarovnaný (přežije refresh)" className="flex-1 px-2 py-1 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-500 text-white">Uložit</button>
              <button onClick={flyToSplat} title="Zaostřit kameru na splat" className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200">Doletět</button>
            </div>
          </Section>
          )}
          {/* Pohledy a vzhled kamery byly jedna sekce — přes dvacet ovládacích prvků na sobě,
              a seznam pohledů (to, co se používá nejvíc) až úplně dole pod slidery. Teď jsou
              to dvě věci: scénář nahoře a jeho vzhled zabalený pod ním. */}
          <Section id="pohledy" title="Pohledy" dflt={true} badge={camViews.length} open={openSec} onToggle={toggleSec}>
            <CamViews
              views={camViews}
              activeId={activeViewId}
              dirty={activeDirty}
              renamingId={renamingViewId}
              onRenameStart={setRenamingViewId}
              onRename={renameCamView}
              onGoto={gotoCamView}
              onOverwrite={updateCamView}
              onDuplicate={duplicateCamView}
              onDelete={delCamView}
              onMove={moveCamView}
              onSave={saveCamView}
              onStep={stepCamView}
            />
            <label className="flex cursor-pointer items-center gap-1.5 text-xs" title="Kamera nepoletí napřímo, ale obloukem kolem toho, na co zrovna koukáš — objekt uprostřed zůstane uprostřed.">
              <input type="checkbox" checked={orbitOn} onChange={e => setOrbitOn(e.target.checked)} className="accent-sky-500" />
              <span className="text-gray-200">Přelet obloukem (orbit kolem středu)</span>
            </label>
          </Section>

          <Section id="kamera" title="Vzhled kamery" dflt={false} open={openSec} onToggle={toggleSec}>
            <div className="px-1 text-[10px] leading-snug text-gray-500">
              Všechno tady se ukládá <span className="text-gray-400">s pohledem</span> — každý může vypadat jinak.
            </div>
            <ProjSwitch mode={camProj} onPersp={camPerspective} onOrtho={camTopOrtho} />
            {/* FOV — v ortho projekci nemá co dělat, tak je zhasnutý místo aby tiše nedělal nic */}
            <label className="flex items-center gap-1.5 text-xs border-t border-gray-700 pt-2">
              <span className="text-gray-400 w-16 shrink-0">Zorný úhel</span>
              <input
                type="range" min={20} max={100} step={1} value={fov}
                disabled={camProj === 'ortho'}
                title={camProj === 'ortho' ? 'Pohled shora (ortho) zorný úhel nemá — přepni na perspektivu' : undefined}
                onChange={e => { const d = Number(e.target.value); setFov(d); applyFov(d) }}
                className="flex-1 min-w-0 disabled:opacity-40"
              />
              <span className={`w-8 text-right tabular-nums ${camProj === 'ortho' ? 'text-gray-600' : 'text-gray-300'}`}>{fov}°</span>
            </label>
            {/* DOF */}
            <div className="flex flex-col gap-1.5 border-t border-gray-700 pt-2">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="checkbox" checked={dofOn} onChange={e => { setDofOn(e.target.checked); applyDof({ on: e.target.checked }) }} className="accent-sky-500" />
                <span className="text-gray-200">Rozostření okrajů</span>
              </label>
              {dofOn && <>
                <div className="flex gap-1">
                  {([['circle', 'Kruh uprostřed'], ['dist', 'Podle vzdálenosti']] as const).map(([m, lbl]) => (
                    <button
                      key={m}
                      onClick={() => { setDofMode(m); applyDof({ mode: m }) }}
                      className={`flex-1 px-2 py-1 rounded-lg text-xs ${dofMode === m ? 'bg-sky-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
                    >{lbl}</button>
                  ))}
                </div>
                {dofMode === 'circle' ? <>
                  <label className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400 w-16 shrink-0">Velikost</span>
                    <input type="range" min={0.05} max={1.2} step={0.01} value={dofRadius} onChange={e => { const r = Number(e.target.value); setDofRadius(r); applyDof({ radius: r }) }} className="flex-1 min-w-0" title="Poloměr ostrého kruhu — 1,0 sahá k bližšímu okraji obrazovky" />
                    <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(dofRadius * 100)} %</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400 w-16 shrink-0">Přechod</span>
                    <input type="range" min={0.01} max={0.8} step={0.01} value={dofFeather} onChange={e => { const f = Number(e.target.value); setDofFeather(f); applyDof({ feather: f }) }} className="flex-1 min-w-0" title="Šířka přechodu z ostrého do rozmazaného — nízká hodnota dá ostrou hranu kruhu" />
                    <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(dofFeather * 100)} %</span>
                  </label>
                </> : <>
                  <label className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400 w-16 shrink-0">Ostří v</span>
                    <input type="range" min={10} max={3000} step={10} value={dofFocal} onChange={e => { const f = Number(e.target.value); setDofFocal(f); applyDof({ focal: f }) }} className="flex-1 min-w-0" />
                    <span className="w-12 text-right text-gray-300 tabular-nums">{dofFocal} m</span>
                  </label>
                  <button onClick={dofFocusCenter} className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200">Zaostřit na střed pohledu</button>
                </>}
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-400 w-16 shrink-0">Rozmazání</span>
                  <input type="range" min={1} max={7} step={0.5} value={dofBlur} onChange={e => { const b = Number(e.target.value); setDofBlur(b); applyDof({ blur: b }) }} className="flex-1 min-w-0" />
                  <span className="w-12 text-right text-gray-300 tabular-nums">{dofBlur}</span>
                </label>
              </>}
            </div>
            {/* Bloom */}
            <label className="flex items-center gap-1.5 text-xs border-t border-gray-700 pt-2 cursor-pointer">
              <input type="checkbox" checked={bloomOn} onChange={e => { setBloomOn(e.target.checked); applyBloom(e.target.checked) }} className="accent-sky-500" />
              <span className="text-gray-200">Bloom (jemná záře)</span>
            </label>
            {/* Handheld — jemné chvění pohledu; ukládá se s pohledem, běží jen v prezentaci */}
            <div className="flex flex-col gap-1.5 border-t border-gray-700 pt-2">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer" title="Jemné rozechvění pohledu jako z ruky. Ukládá se s pohledem (tlačítko Uložit / ikona fotoaparátu), takže si ho dáš jen na záběry, kterým sluší. Pracuje jen opticky — kamera, přelety ani ovládání myší se tím nemění.">
                <input type="checkbox" checked={shakeOn} onChange={e => setShakeOn(e.target.checked)} className="accent-sky-500" />
                <span className="text-gray-200">Kamera z ruky (jemné chvění)</span>
                {shakeOn && !presentOn && <span className="ml-auto shrink-0 text-[10px] text-amber-500/80">jen v prezentaci</span>}
              </label>
              {shakeOn && (
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-400 w-16 shrink-0">Intenzita</span>
                  <input type="range" min={0.05} max={1} step={0.05} value={shakeAmt} onChange={e => setShakeAmt(Number(e.target.value))} className="flex-1 min-w-0" title="Délka tahu — i na 100 % je to asi stupeň, tedy pomalé plutí, ne třas" />
                  <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(shakeAmt * 100)} %</span>
                </label>
              )}
            </div>
            {/* Kroužení — kamera pomalu obíhá střed pohledu; ukládá se s pohledem, běží v prezentaci */}
            <div className="flex flex-col gap-1.5 border-t border-gray-700 pt-2">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer" title="Kamera velmi pomalu obíhá kolem místa, na které se pohled dívá, a drží ho uprostřed. Ukládá se s pohledem (tlačítko Uložit / ikona fotoaparátu). Střed se vezme po doletu na pohled.">
                <input type="checkbox" checked={spinOn} onChange={e => setSpinOn(e.target.checked)} className="accent-sky-500" />
                <span className="text-gray-200">Kroužení kolem místa</span>
                {spinOn && !presentOn && <span className="ml-auto shrink-0 text-[10px] text-amber-500/80">jen v prezentaci</span>}
              </label>
              {spinOn && (<>
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-400 w-16 shrink-0">Rychlost</span>
                  <input
                    type="range" min={0.1} max={3} step={0.1} value={Math.abs(spinSpeed)}
                    onChange={e => setSpinSpeed(Math.sign(spinSpeed || 1) * Number(e.target.value))}
                    className="flex-1 min-w-0"
                    title="Jak rychle kamera obíhá. I na maximu je to pomalý drift, ne otáčka."
                  />
                  <span className="w-12 text-right text-gray-300 tabular-nums">
                    {(() => { const s = Math.round(360 / Math.abs(spinSpeed || 1)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` })()}
                  </span>
                </label>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-400 w-16 shrink-0">Směr</span>
                  {([[-1, 'doleva'], [1, 'doprava']] as const).map(([dir, lbl]) => (
                    <button
                      key={dir}
                      onClick={() => setSpinSpeed(dir * Math.abs(spinSpeed || 1))}
                      className={`flex-1 rounded-lg px-2 py-1 text-xs ${Math.sign(spinSpeed || 1) === dir ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                    >{lbl}</button>
                  ))}
                </div>
                <div className="px-1 text-[10px] leading-snug text-gray-600">Čas je jedna celá otáčka.</div>
              </>)}
            </div>
          </Section>
          {/* Popisky i pulz visí na uloženém pohledu a řídí je vypínač „Prezentace" nahoře —
              patří k sobě, tak jsou v jedné sekci a ne rozstrkané pod kamerou. */}
          <Section id="prezentace" title="Prezentace" dflt={false} badge={callouts.length + pulses.length} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <span className="shrink-0">Pohled:</span>
              <span className="min-w-0 flex-1 truncate text-gray-300">{activeView ? activeView.name : 'žádný'}</span>
              {!presentOn && <span className="shrink-0 text-amber-500/80">vypnutá</span>}
            </div>
            {!activeViewId && !!(callouts.length || pulses.length) && (
              <div className="text-[10px] leading-snug text-amber-500/80">Není vybraný pohled, takže je vše zasunuté. Klikni na některý v sekci „Pohledy".</div>
            )}
            <Section id="popisky" title="Popisky" dflt={false} badge={callouts.length} open={openSec} onToggle={toggleSec}>
              <button
                onClick={toggleCallout}
                className={`px-2 py-1 rounded-lg text-xs ${calloutMode ? 'bg-sky-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
              >{calloutMode ? 'Klikni do mapy…' : 'Přidat popisek'}</button>
              {callouts.map(c => (
                <div key={c.id} className={`flex flex-col gap-1 rounded p-1.5 ${calloutSel === c.id ? 'bg-sky-900/40 ring-1 ring-sky-700' : 'bg-gray-800/50'}`}>
                  <div className="flex items-center gap-1">
                    <input
                      value={c.text}
                      onChange={e => updateCallout(c.id, { text: e.target.value })}
                      onFocus={() => setCalloutSel(c.id)}
                      className="flex-1 min-w-0 bg-gray-900 rounded px-1.5 py-0.5 text-xs text-gray-100 outline-none"
                    />
                    <button onClick={() => delCallout(c.id)} title="Smazat popisek" className="p-0.5 rounded text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                    <input type="color" value={c.dot ?? DOT_DEFAULT} onChange={e => updateCallout(c.id, { dot: e.target.value })} title="Barva tečky" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                    <input type="color" value={c.frame ?? FRAME_DEFAULT} onChange={e => updateCallout(c.id, { frame: e.target.value })} title="Barva rámečku a odpichové čáry" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                    <input type="range" min={9} max={26} step={1} value={c.size ?? SIZE_DEFAULT} onChange={e => updateCallout(c.id, { size: Number(e.target.value) })} title="Velikost textu" className="min-w-0 flex-1 accent-sky-500" />
                    <span className="w-9 shrink-0 text-right tabular-nums text-gray-500">{c.size ?? SIZE_DEFAULT} px</span>
                  </div>
                  <label className={`flex items-center gap-1.5 text-[11px] ${activeViewId ? 'cursor-pointer text-gray-300' : 'text-gray-600'}`} title={activeViewId ? 'Ve kterých pohledech se popisek ukáže' : 'Nejdřív vyber uložený pohled'}>
                    <input type="checkbox" disabled={!activeViewId} checked={!!activeViewId && c.views.includes(activeViewId)} onChange={e => toggleCalloutHere(c.id, e.target.checked)} className="accent-sky-500" />
                    <span>Ukázat v tomto pohledu</span>
                    <span className="ml-auto tabular-nums text-gray-500">{c.views.length}×</span>
                  </label>
                </div>
              ))}
              {!callouts.length && <div className="text-[10px] text-gray-600 leading-snug">Zatím žádné — vyber pohled, dej „Přidat popisek" a klikni do mapy. Bublinu pak přetáhneš myší.</div>}
            </Section>
            <Section id="pulz" title="Pulz parcel" dflt={false} badge={pulses.length} open={openSec} onToggle={toggleSec}>
              <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                <input type="color" value={pulseColor} onChange={e => setPulseColor(e.target.value)} title="Barva pulzu" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                <span className="shrink-0">pulzů</span>
                <input type="range" min={1} max={12} step={1} value={pulseCount} onChange={e => setPulseCount(Number(e.target.value))} title="Kolikrát to blikne, pak přestane" className="min-w-0 flex-1 accent-sky-500" />
                <span className="w-4 shrink-0 text-right tabular-nums text-gray-500">{pulseCount}</span>
              </div>
              <button
                onClick={addPulseFromSelection}
                disabled={!parcelCount}
                title="Zapamatuje si tvar právě vybraných parcel jako novou sadu"
                className="rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-gray-800"
              >Přidat z vybraných parcel ({parcelCount})</button>
              {pulses.map(p => (
                <div key={p.id} className="flex flex-col gap-1 rounded bg-gray-800/50 p-1.5">
                  <div className="flex items-center gap-1.5">
                    <input type="color" value={p.color} onChange={e => updatePulse(p.id, { color: e.target.value })} title="Barva této sady" className="h-4 w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-200">{p.name}</span>
                    <button onClick={() => playPulse(p.id)} title="Přehrát teď" className="rounded p-0.5 text-gray-400 hover:text-sky-300"><Play size={13} /></button>
                    <button onClick={() => delPulse(p.id)} title="Smazat sadu" className="rounded p-0.5 text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                    <span className="shrink-0">pulzů</span>
                    <input type="range" min={1} max={12} step={1} value={p.count} onChange={e => updatePulse(p.id, { count: Number(e.target.value) })} className="min-w-0 flex-1 accent-sky-500" />
                    <span className="w-4 shrink-0 text-right tabular-nums text-gray-500">{p.count}</span>
                  </div>
                  <label className={`flex items-center gap-1.5 text-[11px] ${activeViewId ? 'cursor-pointer text-gray-300' : 'text-gray-600'}`} title={activeViewId ? 'Ve kterých pohledech se pulz spustí' : 'Nejdřív vyber uložený pohled'}>
                    <input type="checkbox" disabled={!activeViewId} checked={!!activeViewId && p.views.includes(activeViewId)} onChange={e => togglePulseHere(p.id, e.target.checked)} className="accent-sky-500" />
                    <span>Spustit v tomto pohledu</span>
                    <span className="ml-auto tabular-nums text-gray-500">{p.views.length}×</span>
                  </label>
                </div>
              ))}
              {!pulses.length && <div className="text-[10px] text-gray-600 leading-snug">Zatím žádné — vyber parcely v mapě, nastav barvu a počet a dej „Přidat". Tvar se uloží, takže přežije refresh i zrušení výběru.</div>}
            </Section>
          </Section>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5 border-t border-gray-700 px-2 py-1.5">
          {/* Obojí je „co leží na disku prohlížeče" — dřív byly napečené dlaždice sekcí nahoře
              a cache dole, takže spolu zdánlivě nesouvisely. */}
          {bakedInfo > 0 && (
            <div className="flex items-center justify-between gap-2 px-1 text-[10px] text-gray-500">
              <span title="Ortofoto napečené do localu — mapa jede offline a jde zoomovat hloub.">
                Lokální mapa: <span className="text-gray-300">{bakedInfo}</span> dl. · ~{Math.round(bakedInfo * 0.06)} MB
              </span>
              <button
                onClick={clearBaked}
                title="Smazat celou lokální mapu (napečené dlaždice) — zpět na živé ČÚZK"
                className="shrink-0 text-gray-500 hover:text-red-300"
              >smazat</button>
            </div>
          )}
          {cacheInfo.count > 0 && (
            <div className="flex items-center justify-between gap-2 px-1 text-[10px] text-gray-500">
              <span title="Data terénu a mapy uložená na disku prohlížeče (přežijí refresh, zrychlují návraty). LRU maže nejstarší přes strop.">
                Cache: {(cacheInfo.bytes / 1e6).toFixed(0)} MB · {cacheInfo.count} pol.
              </span>
              <button
                onClick={() => cacheClear().then(refreshCache)}
                title="Smazat data z disku prohlížeče (cache terénu a mapy)"
                className="shrink-0 text-gray-500 hover:text-red-300"
              >vymazat</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
