import { useEffect, useMemo, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Cloud, Eye, HardDrive, Layers, Loader2, LocateFixed, Sparkles, Trash2, Upload, Users } from 'lucide-react'
import { NEEDS_ION, SHARP_KEY } from './config'
import { effectiveIonToken, useUserIonToken } from './lib/ionKey'
import { openIonKeyDialog } from './ionKeyDialog'
import { geoidN } from './geoid'
import { perfSettings, readPerfChoice, resolvePerf, savePerfChoice, type PerfChoice } from './perfProfile'
import { readOrtoDetail, saveOrtoDetail, type OrtoDetail } from './imagery'
import { tilesBounds, wgsOf } from './tiles'
import type { ParcelHit } from './katastr'
import { loadGeoRaster, disposeRasterSrc, type CrsId } from './worldRaster'
import { parseDrawingFile } from './drawingClient'
import { captureThumb } from './snapshot'
import { fetchAssetFile, fetchAssetSidecar, isLocalAsset, relinkLocalAsset } from './lib/assets'
import { nextFrame, turnCamera, waitForMap } from './sceneUtils'
import { MissingLocalFile } from './lib/localFiles'
import type { AssetRow, FileStorage } from './lib/types'
import { ask } from './dialog'
import { MissingFilesPanel } from './panels/MissingFilesPanel'
import type { MapClickOwner, SceneObj } from './types'
import type { ScenePersist } from './lib/scenePersist'
import { CalloutLayer } from './callouts'
import { Compass } from './compass'
import { MiniMap, readMinimap, saveMinimap } from './miniMap'
import { CoordsPanel } from './coords'
import { MapTools } from './mapTools'
import { MapSearch } from './mapSearch'
import { Section, SectionFocusContext, type SectionFocus } from './ui'
import type { ToolId } from './toolColors'
// jen okno výkresu — geometrie řezu i jeho obsluha žijí v `useSectionTool`
import { SectionDrawing } from './viewer-core/SectionDrawing'
import { useCesiumViewer } from './useCesiumViewer'
import { useMapLayers } from './useMapLayers'
import { useLookTool } from './useLookTool'
import { useCameraMotion } from './useCameraMotion'
import { useCamViews } from './useCamViews'
import { usePresentation } from './usePresentation'
import { useMapSearch } from './useMapSearch'
import { useRegionTool } from './useRegionTool'
import { useParcels } from './useParcels'
import { useModels } from './useModels'
import { useSectionTool } from './useSectionTool'
import { useRulers } from './useRulers'
import { useTiles } from './useTiles'
import { useCoords } from './useCoords'
import { useDrawings } from './useDrawings'
import { useRasters } from './useRasters'
import { useDistricts } from './useDistricts'
import { useLocalCache } from './useLocalCache'
import { useExportRunner } from './useExportRunner'
import { useExports } from './useExports'
import { BasePanel } from './panels/BasePanel'
import { RasterPanel } from './panels/RasterPanel'
import { SelectionPanel } from './panels/SelectionPanel'
import { RulersPanel } from './panels/RulersPanel'
import { ParcelsPanel } from './panels/ParcelsPanel'
import { TilesPanel } from './panels/TilesPanel'
import { RegionPanel } from './panels/RegionPanel'
import { ScenePanel, useScenePanelUi } from './panels/ScenePanel'
import { ModelPanel } from './panels/ModelPanel'
import { SectionPanel } from './panels/SectionPanel'
import { CameraMenu } from './panels/CameraMenu'
import { PresentationMenu } from './panels/PresentationMenu'
import { StorageFooter } from './panels/StorageFooter'

/** Kam ukládat soubory v nové scéně: poslední volba uživatele v tomhle prohlížeči, jinak cloud. */
const STORAGE_KEY = 'geo.fileStorage'
function readStorageDefault(): FileStorage {
  try { return localStorage.getItem(STORAGE_KEY) === 'local' ? 'local' : 'cloud' } catch { return 'cloud' }
}

/**
 * Mapa jedné scény. Co se má pamatovat, hlásí přes `scene` (viz lib/scenePersist.ts) —
 * o Supabase ani o přihlášeném uživateli tady nevíme nic.
 *
 * Jednotlivé věci v mapě (podklady, parcely, modely, výkresy, měření, pohledy…) žijí každá ve
 * svém hooku `use*` a v panelu `panels/*`. Tady zůstává jen to, co je spojuje: kdo právě vlastní
 * klik do mapy, obnova scény po otevření, Esc a rozložení levého panelu.
 */
export function MapView({ scene }: { scene: ScenePersist }) {
  // ── kam se ukládají soubory: cloud, nebo jen tento počítač (přepínač u Importu) ──
  const [fileStorage, setFileStorage] = useState<FileStorage>(() => scene.initial.fileStorage ?? readStorageDefault())
  const storageRef = useRef(fileStorage); storageRef.current = fileStorage
  // kde který soubor scény leží (podle id řádku) — štítky v panelu a přesun při přepnutí
  const [files, setFiles] = useState<Record<string, { at: FileStorage; name: string }>>(
    () => Object.fromEntries(scene.assets.map(a => [a.id, { at: isLocalAsset(a) ? 'local' : 'cloud', name: a.name }])),
  )
  const warnedShared = useRef(false)
  // Ukládací kanál si držíme v refu: volají ho i callbacky Cesia, které se registrují jednou
  // při startu a jinak by pořád koukaly na první verzi propu. Nahrání a mazání jde přes obal:
  // nahrání dostane, kam ukládat, a obojí si poznamená, kde soubor leží.
  const sceneRef = useRef(scene)
  sceneRef.current = useMemo<ScenePersist>(() => ({
    ...scene,
    uploadAsset: async opts => {
      const row = await scene.uploadAsset({ ...opts, local: opts.local ?? storageRef.current === 'local' })
      const local = isLocalAsset(row)
      setFiles(f => ({ ...f, [row.id]: { at: local ? 'local' : 'cloud', name: row.name } }))
      if (local && scene.shared && !warnedShared.current) {
        warnedShared.current = true
        toast.info(`„${row.name}" zůstal jen v tomto počítači — kolegové ani návštěvníci odkazu ho neuvidí.`, { duration: 9000 })
      }
      return row
    },
    deleteAsset: async id => {
      await scene.deleteAsset(id)
      setFiles(f => { const n = { ...f }; delete n[id]; return n })
    },
  }), [scene])
  // veřejný prohlížeč (odkaz bez registrace): bez exportů, importu, výběrů a úprav
  const guest = !!scene.guest
  const canEditFiles = scene.access !== 'viewer'
  const containerRef = useRef<HTMLDivElement>(null)
  /**
   * Kdo právě vlastní klik do mapy.
   *
   * Dřív si každý nástroj držel vlastní `xxxMode` a jeden dispečer je při přepnutí všechny
   * vypínal — musel tedy o všech vědět. Stavy si navíc mohly odporovat: nic nebránilo tomu,
   * aby byly dva zapnuté naráz, drželo to jen to vypínání. Takhle to nejde ze zákona: stav
   * je jeden a nemůže mít dvě hodnoty. Nástroj si aktivitu ODVOZUJE, nedrží ji.
   */
  const [clickOwner, setClickOwner] = useState<MapClickOwner>('none')
  const calloutMode = clickOwner === 'callout'   // klik do mapy položí popisek
  // odečet souřadnic pro přenos do Maxu / SynthEyes (viz coords.tsx)
  const coordsMode = clickOwner === 'coords'
  const moveMode = clickOwner === 'move'
  const parcelMode = clickOwner === 'parcel'
  // výběr oblasti: naklikat body → vybrat všechny parcely uvnitř polygonu
  const areaMode = clickOwner === 'area'
  const rulerMode = clickOwner === 'ruler'
  const tileMode = clickOwner === 'tile'
  // Sbalení sekcí levého panelu. Klíč chybí = použij výchozí hodnotu sekce, takže nové sekce
  // nemusí nic doplňovat a stav přežije i jejich přejmenování.
  // Panel překrývá levých 320 px mapy, takže musí jít odsunout — jinak se pod ním nedá klikat.
  // Na úzké obrazovce (tablet na výšku) začíná zavřený — mapa má přednost.
  const [panelOpen, setPanelOpen] = useState(() => innerWidth >= 900)
  // Šířka okna: na úzké mapě (tablet, otevřený panel) je lišta dole jen z ikon.
  const [winW, setWinW] = useState(() => innerWidth)
  useEffect(() => {
    const onResize = () => setWinW(innerWidth)
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])
  const PANEL_W = 320
  const mapLeft = panelOpen ? PANEL_W : 0
  const compactTools = winW - mapLeft < 780
  // Hlavní vypínač prezentace (popisky + efekty pohledů). Při běžné práci s mapou překážejí.
  const [presentOn, setPresentOn] = useState(true)
  // Co bylo zapnuté, než se prezentace vypnula — aby zapnutí vrátilo přesně to, ne nějaký default.
  const presentSnapRef = useRef<{ dofOn: boolean } | null>(null)
  const [openSec, setOpenSec] = useState<Record<string, boolean>>(() => {
    try { const v = localStorage.getItem('geo.opensec'); if (v) return JSON.parse(v) as Record<string, boolean> } catch { /* */ }
    return {}
  })
  // Sekce, na které uživatel sám klikl, zatímco panel drží nástroj (viz `sectionFocus` níž) —
  // ty se pak řídí jeho volbou, ne nástrojem. Se začátkem i koncem soustředění se maže.
  const [secTouched, setSecTouched] = useState<ReadonlySet<string>>(() => new Set())
  const toggleSec = (id: string, next: boolean) => {
    setSecTouched(s => (s.has(id) ? s : new Set(s).add(id)))
    setOpenSec(prev => {
      const v = { ...prev, [id]: next }
      try { localStorage.setItem('geo.opensec', JSON.stringify(v)) } catch { /* */ }
      return v
    })
  }
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
  // Ostrost obrazu = supersampling NAD RÁMEC fyzických pixelů displeje (scéna se vykreslí větší
  // a zmenší se až při zobrazení). Pomáhá tam, kam MSAA nedosáhne: na jemnou kresbu v ortofotu,
  // která se při zmenšování třepí. Cena roste s druhou mocninou — 1,5× = 2,25× pixelů.
  const [sharpness, setSharpness] = useState(() => {
    try { const v = Number(localStorage.getItem(SHARP_KEY)); return v >= 1 && v <= 2 ? v : 1 } catch { return 1 }
  })
  // Detail ortofota (imagery.ts): standardní, nebo o úroveň jemnější za víc stahování.
  const [ortoDetail, setOrtoDetailState] = useState<OrtoDetail>(readOrtoDetail)
  const setOrtoDetail = (d: OrtoDetail) => { saveOrtoDetail(d); setOrtoDetailState(d) }
  // Profil výkonu (perfProfile.ts): úsporný pro integrovanou grafiku, kvalitní = jak to bylo.
  const [perfChoice, setPerfChoiceState] = useState<PerfChoice>(readPerfChoice)
  const perfLevel = resolvePerf(perfChoice)
  const perf = useMemo(() => perfSettings(perfLevel), [perfLevel])
  const setPerfChoice = (c: PerfChoice) => { savePerfChoice(c); setPerfChoiceState(c) }

  // Seznam objektů v panelu Scéna — hlásí se do něj modely, parcely i výkresy.
  const [objects, setObjects] = useState<SceneObj[]>([])
  function upsertObj(o: SceneObj) { setObjects(list => [...list.filter(x => x.id !== o.id), o]) }
  function removeObj(id: string) { setObjects(list => list.filter(x => x.id !== id)) }

  // ── viewer a jeho podklady ──
  // Hook vieweru je první schválně: jeho efekt staví viewer a ostatní efekty (i jejich úklid)
  // musí jít až po něm — viz poznámka u chvění kamery v `useCameraMotion`.
  const viewer = useCesiumViewer({
    containerRef, sceneRef, perf, sharpness, ortoDetail,
    clipCollections: () => sec.secClipRef.current.values(),
    // Záchranná brzda: když vykreslování spadne, Cesium se zastaví a zbyde bílé okno. Ořez
    // modelu je nejpravděpodobnější příčina, tak ho shodíme a zkusíme kreslit dál.
    onRenderError: () => {
      let had = false
      for (const coll of sec.secClipRef.current.values()) if (coll.enabled) { coll.enabled = false; had = true }
      if (had) {
        sec.setSecClipMap(false)   // výkres nechat funkční, shodit jen ořez v mapě
        toast.error('Vykreslování spadlo — ořez modelu v mapě jsem vypnul. Načti stránku znovu (F5).')
      }
    },
  })
  const { viewerRef, viewerReady } = viewer

  // Vlastní klíč Cesium ion jde změnit i za běhu (okno Klíč Cesium ion) — mapa ho hned použije
  // a 3D realitu připojí znovu, bez obnovení stránky.
  const ownIon = useUserIonToken()
  const prevIonRef = useRef(ownIon)
  useEffect(() => {
    if (prevIonRef.current === ownIon) return
    prevIonRef.current = ownIon
    const t = effectiveIonToken()
    if (t) Cesium.Ion.defaultAccessToken = t
    layers.reloadGoogle()
  }, [ownIon])

  // ── vzhled kamery: hloubka ostrosti a zorný úhel — stav i obsluha žijí v `useLookTool` ──
  const look = useLookTool({ viewerRef })
  const { applyDof, dofOn, setDofOn } = look
  const motion = useCameraMotion({ viewerRef, presentOn, fov: look.fov, applyFovRaw: look.applyFovRaw })
  const { camProj, camPerspective, camTopOrtho } = motion
  // minimapa v rohu: zapnutí a podklad si pamatuje tenhle počítač (miniMap.tsx)
  const [mini, setMini] = useState(readMinimap)
  useEffect(() => { saveMinimap(mini.on, mini.base) }, [mini])
  const toggleMini = () => setMini(m => ({ ...m, on: !m.on }))

  // ── hledání a správní území (obojí píše do téže nabídky v liště nahoře) ──
  const search = useMapSearch({
    viewerRef,
    showAdmin: (units, parts) => { region.setRegionChoices(units); region.setRegionParts(parts) },
    pickSingleUnit: u => region.isolateRegion(u),
    pickParcel: h => pickParcelHit(h),
  })
  const { query, setQuery, runSearch, searching, placeHits, setPlaceHits, searchOpen, setSearchOpen, flyToPlace } = search
  // ── zvýraznění správního území: stav i obsluha žijí v `useRegionTool` ──
  const region = useRegionTool({
    viewerRef, claimMapClick, clickOwner, exclusiveSelect,
    clearPlaceHits: () => setPlaceHits([]), setSearchOpen,
  })

  // ── parcely, modely a co z nich mapa skrývá ──
  const parcels = useParcels({
    viewerRef, sceneRef, parcelMode, areaMode, upsertObj, removeObj, releaseMapClick,
    onSelectionChange: () => layers.parcelsChanged(),
    onCleared: () => layers.clipOff(),
  })
  const { parcelsRef, parcelCount, clearAllParcels, clearArea, removeParcel, restoreParcels } = parcels
  const models = useModels({
    viewerRef, sceneRef, moveMode, setObjects, releaseMapClick,
    updateExcavation: () => layers.updateExcavation(),
    onModelRemoved: id => {
      const v = viewerRef.current
      const ghost = sec.secGhostRef.current.get(id)
      if (ghost && v && !v.isDestroyed()) { v.scene.primitives.remove(ghost); sec.secGhostRef.current.delete(id) }
      // kolekci rovin vlastní model, takže ji zničil spolu se sebou — zbývá zapomenout odkaz
      sec.secClipRef.current.delete(id)
      sec.secGeomRef.current.delete(id)
    },
  })
  const { modelsRef, fileRef, selectedId, placement, selectObject, importModel, deleteModel, renameModel } = models
  const layers = useMapLayers({ viewer, sceneRef, perf, parcelsRef, modelsRef, setObjects })

  // ── řez modelem v mapě: veškerý jeho stav a obsluha žije v `useSectionTool` ──
  const sec = useSectionTool({
    viewerRef, modelsRef, selectedId, selectedIdRef: models.selectedIdRef, setSelectedId: models.setSelectedId, viewerReady,
    sceneRef, initialSections: scene.initial.sections ?? [],
  })

  /**
   * Klik na model v mapě ho vybere.
   *
   * Bez tohohle šel model vybrat JEN kliknutím na řádek v seznamu v panelu — a protože se přes
   * výběr otevírá sekce „Vybraný model", vypadalo to, že kliknutí na
   * model v 3D nedělá nic. Aktivní klikací režimy mají přednost, ať jim klik nepřebíráme.
   */
  const modelPickIdle = !calloutMode && !coordsMode && !region.regionMode && !moveMode && !sec.secPick
    && !parcelMode && !areaMode && !rulerMode && !tileMode
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !viewerReady || !modelPickIdle) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = v.scene.pick(evt.position) as { primitive?: unknown } | undefined
      if (!picked?.primitive) return
      for (const [id, e] of modelsRef.current) {
        // sekci „Vybraný model" rozbalí a odscrolluje k ní `revealSection` navázaná na výběr
        if (e.model === picked.primitive) { selectObject(id); return }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [viewerReady, modelPickIdle]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── nástroje a vrstvy, které kreslí do mapy ──
  const rulerTool = useRulers({ viewerRef, viewerReady, sceneRef, rulerMode, claimMapClick, setClickOwner })
  const { rulers, rulerKind, rulerDraftId, rulerSnap, startRuler, finishRuler, setRulerSel } = rulerTool
  const tiles = useTiles({
    viewerRef, viewerReady, sceneRef, tileMode, claimMapClick, setClickOwner, exclusiveSelect,
    areaPolyLL: parcels.areaPolyLL, region,
  })
  const { tilesRef, tileSize, tileCount, clearTiles, setGridOn, addRegionTiles } = tiles
  const coords = useCoords({ viewerRef, viewerReady, sceneRef, coordsMode })
  const { coordPts, coordShift, persistCoords } = coords
  const drawings = useDrawings({ viewerRef, sceneRef, objects, upsertObj, removeObj, setObjects })
  const { drawingsRef, dwgRef, drawingLoading, loadDrawing, renderDrawing, removeDrawing } = drawings
  const rasters = useRasters({ viewerRef, sceneRef, katastrRef: viewer.katastrRef })
  const { rasterFileRef, rasterBusy, rasterList, importRasters, mountRaster } = rasters
  const districts = useDistricts({ viewerRef, clickFree: !parcelMode && !areaMode && !moveMode && !tileMode })
  const { districtsOn, districtsRef, selectedDistrict, selectDistrict } = districts

  // ── pohledy kamery a prezentace na nich ──
  const views = useCamViews({
    viewerRef, viewerReady, sceneRef, look, motion, presentOn, presentSnapRef,
    viewRefs: id => pres.viewRefs(id),
    onViewDeleted: id => pres.forgetView(id),
  })
  const { camViews, activeViewId } = views
  const pres = usePresentation({ viewerRef, viewerReady, sceneRef, calloutMode, activeViewId, presentOn, releaseMapClick })
  const { callouts, calloutSel, setCalloutSel, updateCallout, visibleCallouts } = pres

  // ── disk prohlížeče a exporty ──
  const cache = useLocalCache({ refreshOrtoLayer: () => layers.refreshOrtoLayer() })
  // ── dlouhé exporty: průběh, zrušení a chyby na jednom místě ──
  const runner = useExportRunner()
  const outputs = useExports({
    viewerRef, runner, tilesRef, tileSize, parcelsRef, regionActiveRef: region.regionActiveRef,
    coordShift, coordPts, googleRef: viewer.googleRef, refreshOrtoLayer: layers.refreshOrtoLayer,
    setRegionBusy: region.setRegionBusy, ortoRef: viewer.ortoRef, setBakedInfo: cache.setBakedInfo, base: layers.base,
    drawingOverlays: drawings.drawingOverlays, sceneRef,
  })
  const { exporting } = outputs
  const sceneUi = useScenePanelUi()

  // ── Obnova scény po otevření ─────────────────────────────────────────────────────
  // Nahrané soubory se stáhnou z úložiště a projdou STEJNÝM importem jako z disku (jen bez
  // přeletů a s uloženým usazením), parcely se vykreslí z uložených prstenců. Jede to
  // POSTUPNĚ: modely i výkresy jsou velké a paralelní dekódování by appku na chvíli zabilo.
  const restoredRef = useRef(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  // Soubory scény uložené jen v jiném počítači (lib/localFiles.ts) — panel je nabídne dohledat.
  const [missingFiles, setMissingFiles] = useState<AssetRow[]>([])

  /** Načte soubor scény do mapy podle druhu — při obnově scény i po dohledání chybějícího. */
  async function mountAsset(a: AssetRow, file: File, alive: () => boolean = () => true) {
    if (a.kind === 'model') {
      await importModel(file, { assetId: a.id, name: a.name, config: a.config })
    } else if (a.kind === 'drawing') {
      const parse = await parseDrawingFile(file)
      if (!alive()) return
      await renderDrawing(parse, a.file_name, { assetId: a.id, config: a.config })
    } else {
      const world = await fetchAssetSidecar(a)
      const raster = await loadGeoRaster(file, world ?? undefined)
      const v2 = viewerRef.current
      if (!alive() || !v2 || v2.isDestroyed()) { disposeRasterSrc(raster.src); return }
      mountRaster(v2, raster, {
        crsId: (a.config.crsId as CrsId | undefined) ?? raster.crsId,
        alpha: a.config.rasterAlpha ?? 1,
        visible: a.config.rasterVisible ?? true,
        assetId: a.id,
      })
    }
  }

  /**
   * Dohledaný chybějící soubor: sedí-li název a velikost, rovnou se použije, jinak se zeptá.
   * Uloží se do tohohle počítače (příště se načte sám) a načte se do mapy.
   */
  async function relinkMissing(a: AssetRow, picked: File[]) {
    const ext = (n: string) => n.slice(n.lastIndexOf('.')).toLowerCase()
    const main = picked.find(p => p.name === a.file_name) ?? picked.find(p => ext(p.name) === ext(a.file_name)) ?? picked[0]
    const side = a.sidecar_name
      ? picked.find(p => p !== main && p.name === a.sidecar_name) ?? picked.find(p => p !== main && ext(p.name) === ext(a.sidecar_name as string)) ?? null
      : null
    const size = main.size + (side?.size ?? 0)
    const fits = main.name === a.file_name && (a.size_bytes == null || a.size_bytes === size)
    if (!fits && !(await ask({
      title: 'Je to ten správný soubor?',
      message: `Ve scéně byl „${a.file_name}“${a.size_bytes ? ` (${(a.size_bytes / 1048576).toFixed(1)} MB)` : ''}, vybraný je „${main.name}“ (${(size / 1048576).toFixed(1)} MB).`,
      okLabel: 'Použít',
    }))) return
    if (a.sidecar_name && !side && !(await ask({
      title: `Chybí „${a.sidecar_name}“`,
      message: 'K rastru patří i soubor s georeferencí. Vyber příště oba najednou — bez něj se snímek nemusí umístit.',
      okLabel: 'Přesto načíst',
    }))) return
    try {
      await relinkLocalAsset(a, main, side)
      setMissingFiles(list => list.filter(x => x.id !== a.id))
      await mountAsset(a, main)
      toast.success(`„${a.name}“ je zpátky — příště se načte sám`)
    } catch (e) {
      console.error(`Dohledaný soubor „${a.name}“ se nepodařilo načíst:`, e)
      toast.error(`„${a.name}“ se nepodařilo načíst`)
    }
  }

  // ── soubory: cloud, nebo jen tento počítač ──
  const [movingFiles, setMovingFiles] = useState(false)
  const placeName = (to: FileStorage) => (to === 'local' ? 'do tohoto počítače' : 'do cloudu')
  const moveError = (e: unknown) => e instanceof MissingLocalFile
    ? 'soubor v tomhle počítači není (nahrál se jinde)'
    : e instanceof Error ? e.message : String(e)

  /** Přesune jeden soubor; vrátí, jestli se to povedlo. */
  async function moveFile(assetId: string, to: FileStorage): Promise<boolean> {
    try {
      const row = await sceneRef.current.moveAsset(assetId, to)
      setFiles(f => ({ ...f, [assetId]: { at: isLocalAsset(row) ? 'local' : 'cloud', name: row.name } }))
      return true
    } catch (e) {
      console.error('Přesun souboru selhal:', e)
      throw e
    }
  }

  /** Přesun jednoho souboru z panelu (s potvrzením — do počítače se z cloudu smaže). */
  async function moveOne(assetId: string, to: FileStorage) {
    const name = files[assetId]?.name ?? 'soubor'
    const msg = to === 'local'
      ? 'Stáhne se do tohoto počítače a z cloudu se smaže. Na jiném počítači se pak scéna zeptá, kde soubor je.'
        + (scene.shared ? '\n\nScénu vidí i další lidé — tenhle soubor pak neuvidí.' : '')
      : 'Nahraje se do cloudu a tady se smaže — pak půjde otevřít odkudkoliv a uvidí ho i kolegové.'
    if (!(await ask({ title: `Přesunout „${name}" ${placeName(to)}?`, message: msg, okLabel: 'Přesunout' }))) return
    const t = toast.loading(`Přesouvám „${name}" ${placeName(to)}…`)
    try { await moveFile(assetId, to); toast.success(`„${name}" je ${to === 'local' ? 'jen v tomto počítači' : 'v cloudu'}`, { id: t }) } catch (e) { toast.error(`„${name}" se nepřesunul: ${moveError(e)}`, { id: t }) }
  }

  /**
   * Přepnutí, kam scéna ukládá soubory. Platí hned pro nové importy; když už scéna nějaké
   * soubory na druhém místě má, zeptá se, jestli je přesunout taky (jinak zůstanou, kde jsou).
   */
  async function changeStorage(to: FileStorage) {
    if (to === fileStorage || movingFiles) return
    if (to === 'local' && scene.shared && !(await ask({
      title: 'Ukládat jen do tohoto počítače?',
      message: 'Scénu vidí i další lidé (kolegové nebo odkaz pro prohlížení). Soubory, které zůstanou jen tady, neuvidí — u nich se scéna zeptá, kde jsou.',
      okLabel: 'Přesto jen do počítače',
    }))) return
    setFileStorage(to)
    sceneRef.current.patchState({ fileStorage: to })
    try { localStorage.setItem(STORAGE_KEY, to) } catch { /* jen výchozí pro nové scény */ }
    const others = Object.entries(files).filter(([, f]) => f.at !== to).map(([id]) => id)
    if (!others.length) { toast.success(`Nové soubory se budou ukládat ${placeName(to)}`); return }
    const move = await ask({
      title: `Přesunout i stávající soubory (${others.length}) ${placeName(to)}?`,
      message: to === 'local'
        ? 'Stáhnou se z cloudu do tohoto počítače a z cloudu se smažou. Na jiném počítači se pak scéna zeptá, kde jsou.'
        : 'Nahrají se z tohoto počítače do cloudu a tady se smažou. Pak půjdou otevřít odkudkoliv.',
      okLabel: 'Přesunout', cancelLabel: 'Jen nové soubory',
    })
    if (!move) { toast.success(`Nové soubory se budou ukládat ${placeName(to)}, stávající zůstanou, kde jsou`); return }
    setMovingFiles(true)
    const t = toast.loading(`Přesouvám soubory ${placeName(to)} (0/${others.length})…`)
    const failed: string[] = []
    let done = 0
    for (const id of others) {
      try { await moveFile(id, to) } catch (e) { failed.push(`„${files[id]?.name ?? id}": ${moveError(e)}`) }
      done++
      toast.loading(`Přesouvám soubory ${placeName(to)} (${done}/${others.length})…`, { id: t })
    }
    setMovingFiles(false)
    if (!failed.length) toast.success(`Přesunuto ${others.length} ${others.length === 1 ? 'soubor' : others.length < 5 ? 'soubory' : 'souborů'} ${placeName(to)}`, { id: t })
    else toast.warning(`Přesunuto ${others.length - failed.length} z ${others.length}. Nepovedlo se: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? ' …' : ''}`, { id: t, duration: 15000 })
  }

  /** Kde leží soubor objektu z panelu Scéna (model, výkres), nebo null (parcela, plocha, nenahraný). */
  function assetOf(o: SceneObj): string | undefined {
    if (o.kind === 'model') return modelsRef.current.get(o.id)?.assetId
    if (o.kind === 'drawing') return drawings.drawingsRef.current.get(o.id.replace('drawing-', ''))?.assetId
    return undefined
  }

  /** Soubor je nenávratně pryč — odebere se ze scény, ať se na něj neptá pořád dokola. */
  async function removeMissing(a: AssetRow) {
    if (!(await ask({
      title: `Odebrat „${a.name}“ ze scény?`,
      message: 'Soubor se pak už nebude hledat. Usazení a nastavení, které k němu patřily, se smažou.',
      okLabel: 'Odebrat', danger: true,
    }))) return
    try {
      await sceneRef.current.deleteAsset(a.id)
      setMissingFiles(list => list.filter(x => x.id !== a.id))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Odebrání se nepovedlo') }
  }

  useEffect(() => {
    if (!viewerReady || restoredRef.current) return
    restoredRef.current = true

    restoreParcels(sceneRef.current.initial.parcels ?? [])

    const assets = sceneRef.current.assets
    if (!assets.length) return
    let alive = true
    void (async () => {
      // Nejdřív mapa: dokud se dotahují dlaždice pod pohledem, soubory čekají — jinak by
      // se o procesor a grafiku praly a nebylo by vidět nic. Pomalé dlaždice ale čekají
      // nejdéle pár vteřin.
      const v0 = viewerRef.current
      if (!v0 || v0.isDestroyed()) return
      const n = assets.length
      setRestoring(`Nejdřív mapa, pak ${n === 1 ? 'soubor' : `${n} ${n <= 4 ? 'soubory' : 'souborů'}`} scény…`)
      await waitForMap(v0)
      // Stahování jde po síti a mapu nebrzdí: další soubor se stahuje, zatímco se předchozí staví.
      const files = new Map<number, Promise<File>>()
      const fileAt = (i: number) => {
        let p = files.get(i)
        if (!p) { p = fetchAssetFile(assets[i]); p.catch(() => { /* ozve se, až na něj dojde */ }); files.set(i, p) }
        return p
      }
      const missing: AssetRow[] = []
      for (let i = 0; i < assets.length; i++) {
        const a = assets[i]
        const v = viewerRef.current
        if (!alive || !v || v.isDestroyed()) return
        setRestoring(`Načítám „${a.name}" (${i + 1}/${assets.length})`)
        try {
          const file = await fileAt(i)
          files.delete(i)
          if (i + 1 < assets.length) fileAt(i + 1)
          if (!alive) return
          await mountAsset(a, file, () => alive)
          // mezi soubory dát mapě snímek — překreslí, co přibylo, a chytí myš
          await nextFrame()
        } catch (e) {
          // uložený jen v jiném počítači → nabídnout k dohledání, ne hlásit jako chybu
          if (e instanceof MissingLocalFile) { missing.push(a); continue }
          console.error(`Obnova souboru „${a.name}" selhala:`, e)
          toast.error(`Soubor „${a.name}" se nepodařilo načíst`)
        }
      }
      if (!alive) return
      setRestoring(null)
      if (missing.length) {
        setMissingFiles(missing)
        setPanelOpen(true)
        toast.warning(missing.length === 1 ? `„${missing[0].name}“ je uložený jen v jiném počítači` : `${missing.length} soubory jsou uložené jen v jiném počítači`, {
          description: 'Najdi je na disku v panelu vlevo, sekce Chybějící soubory.',
          duration: 8000,
        })
      }
    })()
    return () => { alive = false }
  }, [viewerReady])

  /**
   * Odchod na přehled scén. Cestou se udělá náhled scény z aktuálního záběru — v přehledu se
   * pak pozná, co která scéna je. Selhání náhledu odchod nezdrží (je to jen obrázek).
   */
  async function leaveScene() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) {
      try {
        // Snímek se musí sebrat DŘÍV, než odchod odmountuje viewer — pak už canvas nestojí.
        // Samotné nahrání dojede na pozadí, na to se nečeká; přehled se po něm sám obnoví.
        const blob = await captureThumb(v)
        if (blob && blob.size > 1000) void sceneRef.current.saveThumb(blob).catch(e => console.warn('Náhled scény se neuložil:', e))
      } catch { /* náhled je jen bonus, odchod nesmí zdržet */ }
    }
    sceneRef.current.exit()
  }

  function toggleAreaMode() {
    if (areaMode) { setClickOwner('none'); return }
    claimMapClick('area')
    exclusiveSelect('parcel') // oblast parcely plní → jejich data nemazat, jen ostatní zdroje
    setClickOwner('area')
  }

  // Jen JEDEN zdroj výběru naráz: parcely (klik/oblast) × dlaždice × území. Při zapnutí jednoho
  // vyčisti ostatní (jejich VÝBĚR i REŽIM), ať nejde mít „zaškrtnuté" víc věcí současně.
  /**
   * Klik do mapy má právě jednoho majitele.
   *
   * Každý režim si registruje vlastní posluchač levého kliku. Když jich běželo víc naráz, udělal
   * jeden klik několik věcí — a dělo se to: `calloutMode` nevypínal nikdo a `region.regionMode` se při
   * zapnutí neptal, takže „přidat popisek" a „vybrat parcelu" spolu klidně jely a jedno kliknutí
   * položilo bublinu A vybralo parcelu. Vypínalo se to na třech místech (exclusiveSelect,
   * startRuler, toggleMove), pokaždé jiným výčtem — proto to teď dělá jedna funkce.
   *
   * DATA se tím nemažou. Od toho je `exclusiveSelect`, který hlídá jinou věc: aby výběr
   * (parcely × dlaždice × území) měl vždycky jen jeden zdroj.
   */
  /**
   * Klik do mapy si bere jeden nástroj. Ostatní se tím samy vypnou — jsou odvozené
   * z `clickOwner`, takže tu není co vypínat. Po sobě si každý uklidí v efektu níž.
   */
  function claimMapClick(owner: MapClickOwner) { setClickOwner(owner) }

  /** vypne nástroj, ale jen když klik opravdu drží on */
  function releaseMapClick(who: MapClickOwner) { setClickOwner(o => (o === who ? 'none' : o)) }

  /**
   * Úklid po nástroji, kterému klik právě vzal někdo jiný.
   *
   * Dřív ho dělal dispečer a musel proto vědět, co po sobě která funkce uklízí — rozdělaný
   * polygon oblasti, nedokončené měření, mřížku dlaždic. Uklízí se JEN po tom, kdo klik
   * opravdu držel; slepé volání při startu by z prázdného měření udělalo prázdnou úsečku.
   */
  const prevOwnerRef = useRef<MapClickOwner>('none')
  useEffect(() => {
    const was = prevOwnerRef.current
    prevOwnerRef.current = clickOwner
    if (was === clickOwner) return
    if (was === 'area') clearArea()
    if (was === 'ruler') finishRuler()
    if (was === 'tile') setGridOn(false)   // ať mřížka nezůstane viset bez tlačítka
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clickOwner])

  /** Jen JEDEN zdroj výběru naráz — maže DATA. Režimy klikání řeší `claimMapClick`. */
  /**
   * Parcela z vyhledávání: přidá se k výběru stejně jako klikem (ruší dlaždice a území jako nástroj
   * parcel) a kamera přeletí nad ni. Národní číslo v `id` je stejné jako u kliknuté, takže se
   * táž parcela nevybere dvakrát.
   */
  function pickParcelHit(h: ParcelHit) {
    setSearchOpen(false)
    if (!parcelsRef.current.size) exclusiveSelect('parcel')
    const toCart = (r: number[][]) => r.map(([x, y]) => { const [lo, la] = wgsOf(x, y); return Cesium.Cartesian3.fromDegrees(lo, la) })
    parcels.addParcelSel({ id: h.id, label: h.label, knArea: h.knArea, iskn: h.iskn, ku: h.ku, positions: toCart(h.ring), holes: h.holes.map(toCart) })
    void parcels.flyToParcel(h.id)
  }

  function exclusiveSelect(keep: 'parcel' | 'tile' | 'region') {
    if (keep !== 'parcel') { clearAllParcels(); clearArea() }
    // Území dlaždice NERUŠÍ: kraj se do nich právě převádí (addRegionTiles) a víc krajů se má
    // sečíst do jednoho výběru. Ostatní zdroje si dlaždice pořád vylučují.
    if (keep !== 'tile' && keep !== 'region') clearTiles()
    if (keep !== 'region') region.clearRegion()
  }

  // Vypínání ostatních režimů schválně MIMO funkci pro nastavení stavu: ta se v StrictMode volá
  // dvakrát a vedlejší účinky uvnitř ní by proběhly taky dvakrát.
  function toggleMove() { setClickOwner(o => (o === 'move' ? 'none' : 'move')) }
  /** panel řezu si umí říct o vypnutí posouvání modelu */
  const setMoveMode = (on: boolean) => (on ? claimMapClick('move') : releaseMapClick('move'))
  function toggleCallout() { setClickOwner(o => (o === 'callout' ? 'none' : 'callout')) }
  function toggleCoords() { setClickOwner(o => (o === 'coords' ? 'none' : 'coords')) }
  function toggleRegionMode() { setClickOwner(o => (o === 'region' ? 'none' : 'region')) }
  function toggleParcel() {
    if (parcelMode) { setClickOwner('none'); return }
    exclusiveSelect('parcel')
    setClickOwner('parcel')
  }

  /**
   * Esc = o krok zpátky k výchozímu stavu.
   *
   * Schválně DVOUSTUPŇOVĚ, ne všechno naráz: první Esc vypne jen nástroj, teprve druhý zahodí
   * výběr. Kdo naklikal tři tisíce dlaždic, nemá o ně přijít jedním omylem — a kdo chce obojí,
   * zmáčkne Esc dvakrát, což je pořád rychlejší než hledat tlačítko.
   *
   * Pořadí odpovídá tomu, co je „nejvíc navrchu": rozbalená nabídka hledání, pak aktivní nástroj,
   * pak výběr. Rozdělaná oblast nebo měření zmizí s nástrojem, protože bez něj nemají smysl.
   */
  function handleEscape() {
    if (searchOpen) { setSearchOpen(false); return }

    if (sec.secPick) { sec.setSecPick(null); toast.info(sec.secPick === 'drag' ? 'Tažení řezu vypnuto' : 'Zadávání řezu zrušeno'); return }

    if (parcelMode || areaMode || tileMode || region.regionMode || rulerMode || calloutMode || moveMode || coordsMode) {
      claimMapClick('none')
      toast.info('Nástroj vypnut · Esc znovu zruší výběr', { duration: 2000 })
      return
    }

    const sel: string[] = []
    if (parcelCount) sel.push(`parcely (${parcelCount})`)
    if (tileCount) sel.push(`dlaždice (${tileCount})`)
    if (region.regionName) sel.push('území')
    if (selectedId) sel.push('model')
    if (!sel.length) return

    clearAllParcels(); clearArea(); clearTiles(); region.clearRegion()
    // přes selectObject, ne holým setSelectedId: jinak zůstane viset `placement` i ref s id
    // a panel modelu (včetně řezu) se tváří, že model je pořád vybraný
    selectObject(null)
    setCalloutSel(null); setRulerSel(null)
    toast.info(`Výběr zrušen: ${sel.join(', ')}`)
  }

  const escRef = useRef(handleEscape)
  useEffect(() => { escRef.current = handleEscape })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // v poli Esc patří rozepsanému textu (přejmenování pohledu, popisek…)
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      escRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * Hlavní vypínač prezentace: popisky a obrazové efekty pohledů (rozostření; chvění a kroužení
   * běží jen v prezentaci samy) naráz.
   * Vypnutí si pamatuje, co bylo zapnuté, takže zapnutí nevrací výchozí hodnoty, ale ty tvoje.
   */
  function togglePresent() {
    const nv = !presentOn
    setPresentOn(nv)
    if (!nv) {
      presentSnapRef.current = { dofOn }
      setDofOn(false); applyDof({ on: false })
    } else {
      const snap = presentSnapRef.current
      if (snap) { setDofOn(snap.dofOn); applyDof({ on: snap.dofOn }) }
    }
    // popisky si zajedou samy — řídí je visibleCallouts
  }

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

  function toggleVisible(o: SceneObj) {
    const vis = !o.visible
    if (o.kind === 'model') models.setModelVisible(o.id, vis)
    else if (o.kind === 'parcel') parcels.setParcelVisible(o.id.replace('parcel-', ''), vis)
    else if (o.kind === 'drawing') drawings.setDrawingVisible(o.id.replace('drawing-', ''), vis)
    setObjects(list => list.map(x => x.id === o.id ? { ...x, visible: vis } : x))
  }

  function deleteObject(o: SceneObj) {
    if (o.kind === 'model') deleteModel(o.id)
    else if (o.kind === 'parcel') removeParcel(o.id.replace('parcel-', ''))
    else if (o.kind === 'drawing') removeDrawing(o.id.replace('drawing-', ''))
  }

  function renameObject(id: string, name: string) {
    renameModel(id, name)
    setObjects(list => list.map(x => x.id === id ? { ...x, name } : x))
  }

  const activeView = camViews.find(cv => cv.id === activeViewId) ?? null
  // Sjetí k sekci, která právě vznikla. Sleduje se jen „je / není", ne obsah — jinak by panel
  // poskakoval při každé přidané parcele.
  const hasParcels = parcelCount > 0
  const hasTiles = tileCount > 0
  const hasRegion = region.regionChoices.length > 0 || region.regionParts.length > 0 || !!region.regionName
  const hasModelSel = !!placement
  const hasDistrict = districtsOn && !!selectedDistrict
  const hasRasters = rasterList.length > 0
  useEffect(() => { if (hasParcels) revealSection('parcely') }, [hasParcels])
  useEffect(() => { if (hasTiles) revealSection('dlazdice') }, [hasTiles])
  useEffect(() => { if (hasRegion) revealSection('uzemi') }, [hasRegion])
  useEffect(() => { if (hasModelSel) revealSection('model') }, [hasModelSel])
  useEffect(() => { if (hasDistrict) revealSection('mestcast') }, [hasDistrict])
  useEffect(() => { if (hasRasters) revealSection('rastr') }, [hasRasters])

  /**
   * Soustředění panelu na zapnutý nástroj: jeho sekce se rozbalí a obarví barvou nástroje
   * (`toolColors.ts`), ostatní se sbalí, ať je hned po ruce, co k nástroji patří. Začne, až
   * sekce existuje (parcely s první vybranou, území s vybraným územím), a skončí vypnutím
   * nástroje — panel se pak vrátí, jak byl (viz `SectionFocus`). Dlaždice drží do první
   * vybrané sekci s velikostí a mřížkou, pak sekci Dlaždice s exporty.
   * Nástroje berou mapu výhradně (`claimMapClick`), takže zapnutý je vždy nanejvýš jeden.
   */
  const focusTarget: { id: string; tool: ToolId } | null =
    parcelMode ? (parcelCount > 0 ? { id: 'parcely', tool: 'parcel' } : null)
    : areaMode ? { id: 'vyber', tool: 'area' }
    : tileMode ? { id: tileCount > 0 ? 'dlazdice' : 'vyber', tool: 'tiles' }
    : region.regionMode ? (region.regionName ? { id: 'uzemi', tool: 'region' } : null)
    : rulerMode ? { id: 'mereni', tool: 'ruler' }
    : coordsMode ? { id: 'souradnice', tool: 'coords' }
    : moveMode && placement ? { id: 'model', tool: 'move' }
    : null
  const focusId = focusTarget?.id ?? null
  const focusTool = focusTarget?.tool ?? null
  useEffect(() => {
    setSecTouched(new Set())
    if (!focusId) return
    setPanelOpen(true) // nástroj se dá zapnout i se zavřeným panelem — nastavení má být vidět
    requestAnimationFrame(() => {
      panelScrollRef.current?.querySelector(`[data-sec="${focusId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [focusId])
  const sectionFocus = useMemo<SectionFocus>(
    () => (focusId && focusTool ? { id: focusId, tool: focusTool, touched: secTouched } : null),
    [focusId, focusTool, secTouched],
  )

  /**
   * Pojistka pro kreslení na vyžádání: po každém překreslení panelu jeden snímek mapy.
   *
   * Skoro každá změna scény jde přes stav Reactu — přepnutý podklad, posuvník průhlednosti,
   * vybraná parcela, posunutý model. Většinu z nich Cesium samo nepozná (přepnutá vrstva,
   * nová entita, změněná matice), takže tady se o snímek řekne za všechny najednou. Stojí to
   * nanejvýš jedno vykreslení navíc, a jen když se v panelu něco opravdu změnilo.
   *
   * Efekt je SCHVÁLNĚ poslední a bez závislostí: běží po všech ostatních efektech téhož
   * průchodu, tedy až když už do scény zapsaly, co měly.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) v.scene.requestRender()
  })

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />

      <MapSearch
        query={query}
        onQuery={setQuery}
        onSubmit={runSearch}
        busy={searching || region.regionBusy}
        units={region.regionChoices}
        parts={region.regionParts}
        places={placeHits}
        parcels={search.parcelHits}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpen={() => setSearchOpen(true)}
        onPickUnit={u => { setSearchOpen(false); region.isolateRegion(u) }}
        onPickPlace={flyToPlace}
        onPickParcel={pickParcelHit}
        onExpandParts={region.loadParts}
        pickMode={region.regionMode}
        onTogglePickMode={guest ? undefined : toggleRegionMode}
        activeName={region.regionName}
        onClearActive={region.clearRegion}
        left={panelOpen ? PANEL_W : 48 /* vlevo nahoře je tlačítko, které panel zase otevře */}
      />

      {/* Pod vyhledávací lištou, ať se nepřekrývají — obojí míří doprostřed VIDITELNÉ mapy
          (vedle panelu), jinak by na užší obrazovce zajely pod panel. */}
      {(restoring || (NEEDS_ION && !effectiveIonToken() && layers.base === 'google')) && (
        <div className="pointer-events-none absolute right-0 top-16 z-30 flex flex-col items-center gap-2 px-3 transition-[left]" style={{ left: mapLeft }}>
          {restoring && (
            <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/90 px-3 py-1.5 text-xs text-gray-200">
              <Loader2 size={13} className="animate-spin" /> {restoring}
            </div>
          )}
          {NEEDS_ION && !effectiveIonToken() && layers.base === 'google' && (
            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-amber-600/50 bg-amber-900/80 px-3 py-1.5 text-xs text-amber-200">
              3D realita potřebuje klíč Cesium ion
              {!guest && <button onClick={openIonKeyDialog} className="rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-500">Nastavit</button>}
            </div>
          )}
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

      {/* loader při exportu */}
      {exporting && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
          <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-gray-900/95 border border-gray-700 text-gray-100">
            <Loader2 size={20} className="animate-spin text-emerald-400" />
            <div className="text-sm">
              <div className="font-medium">Exportuji…</div>
              <div className="text-[11px] text-gray-400">stahuji hranice a výšky z ČÚZK</div>
            </div>
          </div>
        </div>
      )}

      {/* Rychlá lišta dole: podklad, výběr, nástroje a pohled — to, na co se sahá pořád, i se
          zavřeným panelem. Volá tytéž funkce jako panel, takže se to nemůže rozejít.
          Střed se počítá z VIDITELNÉ mapy, ne z okna, aby lišta neutíkala pod panel; vpravo
          nechává místo kompasu. Na úzké mapě jsou skupiny jen ikony (compact).
          `bottom-6` míjí pruh s popiskami zdrojů, který si Cesium kreslí úplně dole. */}
      <div className="pointer-events-none absolute bottom-6 right-16 z-20 flex justify-center transition-[left]" style={{ left: mapLeft }}>
        <MapTools
          guest={guest}
          compact={compactTools}
          viewer={viewerReady ? viewerRef.current : null}
          layers={layers}
          parcels={parcels}
          tiles={tiles}
          region={region}
          parcelMode={parcelMode}
          areaMode={areaMode}
          tileMode={tileMode}
          onParcel={toggleParcel}
          onArea={toggleAreaMode}
          onRegion={toggleRegionMode}
          rulerMode={rulerMode}
          rulerKind={rulerKind}
          rulerDrafting={!!rulerDraftId}
          rulerSnap={rulerSnap}
          onRuler={startRuler}
          onFinishRuler={finishRuler}
          coordsMode={coordsMode}
          onCoords={toggleCoords}
          moveMode={moveMode}
          onMove={toggleMove}
          canMove={!!placement}
          camProj={camProj}
          onPersp={camPerspective}
          onOrtho={camTopOrtho}
          minimapOn={mini.on}
          onMinimap={toggleMini}
          onTurn={deg => { const v = viewerRef.current; if (v && !v.isDestroyed()) turnCamera(v, deg) }}
          viewCount={camViews.length}
          cameraMenu={<CameraMenu views={views} look={look} motion={motion} presentOn={presentOn} readOnly={guest} />}
          presentOn={presentOn}
          calloutMode={calloutMode}
          presentationMenu={
            <PresentationMenu
              pres={pres} activeView={activeView} activeViewId={activeViewId} presentOn={presentOn}
              togglePresent={togglePresent} calloutMode={calloutMode} toggleCallout={toggleCallout} readOnly={guest}
            />
          }
        />
      </div>
      {/* Kompas v rohu, mimo střed s lištou — ať se s ní neperou o místo, když je okno úzké.
          Vlastní pozadí má kruhové v SVG, takže tady kolem něj není žádný rámeček navíc. */}
      <div className="pointer-events-none absolute bottom-5 right-4 z-20">
        <Compass viewer={viewerReady ? viewerRef.current : null} />
      </div>
      {/* Minimapa nad kompasem (kompas končí ~92 px ode dna). Pod lištou (z-10), ať přes ni
          nabídky skupin, které se otvírají nahoru, na úzké mapě nezajedou. */}
      {viewerReady && (
        <div className="pointer-events-none absolute bottom-[104px] right-4 z-10">
          {mini.on ? (
            <MiniMap
              viewer={viewerRef.current}
              base={mini.base}
              onBase={base => setMini(m => ({ ...m, base }))}
              onClose={toggleMini}
              size={winW - mapLeft < 560 ? 132 : compactTools ? 160 : 208}
            />
          ) : (
            // zavřená minimapa: malé tlačítko nad kompasem, ať se dá vrátit i bez klávesy N
            <div className="flex w-16 justify-center">
              <button
                onClick={toggleMini}
                title="Zobrazit minimapu (N)"
                data-minimap-open
                className="pointer-events-auto rounded-lg border border-gray-700 bg-gray-900/90 p-1.5 text-gray-300 shadow-lg hover:text-gray-100 pointer-coarse:p-2.5"
              ><LocateFixed size={16} /></button>
            </div>
          )}
        </div>
      )}

      {/* Levý panel — jediné místo pro ovládání. Dřív se panely otevíraly jeden přes druhý,
          takže se překrývaly; teď je vše v jednom sloupci ve sbalitelných sekcích.
          Nad mapou nikde `backdrop-blur`: plátno se překresluje každý snímek a prohlížeč by
          rozmazání pod panelem počítal znovu a znovu — na integrované grafice je to znát. */}
      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          title="Zobrazit panel"
          className="absolute left-3 top-3 z-20 rounded-lg border border-gray-700 bg-gray-900/90 p-1.5 text-gray-300 hover:text-gray-100"
        ><ChevronRight size={16} /></button>
      )}
      <div className={`absolute inset-y-0 left-0 z-20 flex w-80 flex-col border-r border-gray-700 bg-gray-900/95 transition-transform ${panelOpen ? '' : '-translate-x-full'}`}>
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-gray-700 p-2">
          {/* Navigace; vypínač prezentace se přestěhoval do lišty dole (panel Prezentace). */}
          <div className="flex items-center gap-1">
            {guest ? (
              <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-gray-300"><Eye size={14} className="text-sky-400" /> Prohlížeč scény</span>
            ) : (
              <button onClick={() => void leaveScene()} title="Zpět na přehled scén" className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-200 transition-colors hover:bg-gray-700">
                <ChevronLeft size={14} /> Scény
              </button>
            )}
            <div className="flex-1" />
            <button onClick={() => setPanelOpen(false)} title="Skrýt panel" className="rounded p-0.5 text-gray-500 hover:text-gray-200"><ChevronLeft size={16} /></button>
          </div>
          {/* Název scény + co se zrovna obnovuje z úložiště. Bez toho se při víc scénách
              nepozná, ve které z nich vlastně jsi. */}
          <div className="flex min-w-0 items-center gap-1.5 px-1">
            <Layers size={12} className="shrink-0 text-emerald-500" />
            <span className="truncate text-xs font-medium text-gray-200" title={scene.sceneName}>{scene.sceneName}</span>
            {scene.share && (
              <button onClick={scene.share} title="Sdílet scénu s kolegy" data-share-open className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200">
                <Users size={12} /> Sdílet
              </button>
            )}
          </div>
          {/* Cizí scéna: čí je a jestli se změny ukládají — u „jen prohlížet" by jinak člověk
              pracoval a po zavření by nic nenašel. */}
          {scene.access !== 'owner' && (
            <div data-access={scene.access} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${scene.access === 'viewer' ? 'bg-amber-950/60 text-amber-200' : 'bg-sky-950/60 text-sky-200'}`}>
              {scene.access === 'viewer' ? <Eye size={12} className="shrink-0" /> : <Users size={12} className="shrink-0" />}
              <span className="truncate" title={scene.ownerName ? `Scénu sdílí ${scene.ownerName}` : undefined}>
                {guest ? 'Můžeš se rozhlížet a měřit, nic se neuloží' : scene.access === 'viewer' ? 'Jen prohlížíš — nic se neuloží' : 'Sdílená scéna — změny se ukládají'}
                {scene.ownerName ? ` · ${scene.ownerName}` : ''}
              </span>
            </div>
          )}
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
        <SectionFocusContext.Provider value={sectionFocus}>
        <div ref={panelScrollRef} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
          {missingFiles.length > 0 && !guest && (
          <Section id="chybi" title="Chybějící soubory" dflt={true} badge={missingFiles.length} open={openSec} onToggle={toggleSec}>
            <MissingFilesPanel files={missingFiles} onRelink={(a, picked) => void relinkMissing(a, picked)} onRemove={a => void removeMissing(a)} />
          </Section>
          )}
          <Section id="podklad" title="Podklad a překryvy" dflt={true} open={openSec} onToggle={toggleSec}>
            <BasePanel
              layers={layers} districts={districts} perfChoice={perfChoice} setPerfChoice={setPerfChoice} perfLevel={perfLevel}
              sharpness={sharpness} setSharpness={setSharpness} ortoDetail={ortoDetail} setOrtoDetail={setOrtoDetail}
              viewerReady={viewerReady} viewerRef={viewerRef} guest={guest}
            />
          </Section>
          {rasterList.length > 0 && (
          <Section id="rastr" title="Vlastní ortofoto" dflt={true} badge={rasterList.length} open={openSec} onToggle={toggleSec}>
            <RasterPanel
              rasters={rasters} readOnly={guest}
              fileAt={id => (id ? files[id]?.at ?? null : null)}
              onMoveFile={canEditFiles ? (id, to) => void moveOne(id, to) : undefined}
            />
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
          {/* Nastavení zapnutého výběru — jen u oblasti a dlaždic, ostatní nástroje žádné nemají.
              Zapínají se v liště dole nebo klávesou. */}
          {(areaMode || tileMode) && (
          <Section id="vyber" title={areaMode ? 'Výběr oblasti' : 'Výběr dlaždic'} dflt={true} open={openSec} onToggle={toggleSec}>
            <SelectionPanel parcels={parcels} tiles={tiles} areaMode={areaMode} toggleAreaMode={toggleAreaMode} />
          </Section>
          )}
          {/* Souřadnice pro přenos do Maxu / SynthEyes. Vlastní sekce, protože je to jiná práce
              než měření: tam jde o vzdálenosti, tady o absolutní polohu bodu. */}
          {!guest && (
          <Section id="souradnice" title="Souřadnice" dflt={false} badge={coordPts.length} open={openSec} onToggle={toggleSec}>
            <CoordsPanel
              pts={coordPts}
              shift={coordShift}
              onShift={s => persistCoords(coordPts, s)}
              onDelete={id => persistCoords(coordPts.filter(p => p.id !== id), coordShift)}
              onClear={() => persistCoords([], coordShift)}
              onGoto={p => {
                const v = viewerRef.current
                if (v && !v.isDestroyed()) v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.z + geoidN(p.lon, p.lat) + 500) })
              }}
              tileCenter={(() => {
                const ts = [...tilesRef.current.values()]
                if (!ts.length) return null
                const b = tilesBounds(ts)
                return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] as [number, number]
              })()}
              picking={coordsMode}
              onTogglePicking={toggleCoords}
            />
          </Section>
          )}

          <Section id="mereni" title="Měření" dflt={false} badge={rulers.length} open={openSec} onToggle={toggleSec}>
            <RulersPanel rulers={rulerTool} rulerMode={rulerMode} />
          </Section>
          {parcelCount > 0 && !guest && (
          <Section id="parcely" title="Parcely" dflt={true} badge={parcelCount} open={openSec} onToggle={toggleSec}>
            <ParcelsPanel parcels={parcels} layers={layers} outputs={outputs} runner={runner} />
          </Section>
          )}
          {tileCount > 0 && !guest && (
          <Section id="dlazdice" title="Dlaždice" dflt={true} badge={tileCount} open={openSec} onToggle={toggleSec}>
            <TilesPanel outputs={outputs} runner={runner} tilesRef={tilesRef} tileCount={tileCount} tileSize={tileSize} clearTiles={clearTiles} coordShift={coordShift} coordPts={coordPts} persistCoords={persistCoords} />
          </Section>
          )}
          {/* Nalezená území se vybírají v liště nahoře uprostřed (mapSearch.tsx). Tady zůstává
              jen to, co následuje po výběru: co je zvýrazněné, ztmavení okolí a exporty. */}
          {region.regionName && !guest && (
          <Section id="uzemi" title="Správní území" dflt={true} open={openSec} onToggle={toggleSec}>
            <RegionPanel region={region} outputs={outputs} runner={runner} addRegionTiles={addRegionTiles} tileSize={tileSize} />
          </Section>
          )}
          {!guest && (
          <Section id="import" title="Import" dflt={false} open={openSec} onToggle={toggleSec}>
            {/* Kam se soubory scény ukládají — platí pro celou scénu a jde přepnout kdykoliv
                (scéna se pak zeptá, jestli přesunout i stávající soubory). */}
            {canEditFiles && (() => {
              const n = Object.values(files)
              const local = n.filter(f => f.at === 'local').length
              const opt = (to: FileStorage, icon: React.ReactNode, label: string) => (
                <button
                  onClick={() => void changeStorage(to)}
                  disabled={movingFiles}
                  aria-pressed={fileStorage === to}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-60 pointer-coarse:py-2 ${fileStorage === to ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
                >{icon}{label}</button>
              )
              return (
                <div data-file-storage={fileStorage} className="flex flex-col gap-1.5 rounded-lg border border-gray-800 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">Ukládat soubory</div>
                  <div className="flex gap-1 rounded-lg bg-gray-800/70 p-0.5">
                    {opt('cloud', <Cloud size={13} />, 'Cloud')}
                    {opt('local', <HardDrive size={13} />, 'Tento počítač')}
                  </div>
                  <div className="text-[10px] leading-snug text-gray-500">
                    {fileStorage === 'cloud'
                      ? 'Nahrají se na účet — otevřeš je odkudkoliv a uvidí je i kolegové.'
                      : 'Zůstanou jen v tomhle počítači a prohlížeči. Jinde se scéna zeptá, kde soubory jsou; kolegové ani odkaz je neuvidí.'}
                    {n.length > 0 && local > 0 && local < n.length && <> Teď: v cloudu {n.length - local}, jen tady {local}.</>}
                  </div>
                  {movingFiles && <div className="flex items-center gap-1.5 text-[10px] text-gray-400"><Loader2 size={11} className="animate-spin" /> Přesouvám soubory…</div>}
                </div>
              )
            })()}
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
          </Section>
          )}
          {objects.length > 0 && (
          <Section id="scena" title="Scéna" dflt={true} badge={objects.length} open={openSec} onToggle={toggleSec}>
            <ScenePanel
              ui={sceneUi} objects={objects} selectedId={selectedId} drawings={drawings} selectObject={selectObject}
              locateObject={locateObject} toggleVisible={toggleVisible} deleteObject={deleteObject} onRename={renameObject}
              readOnly={guest}
              fileAt={o => { const id = assetOf(o); return id ? files[id]?.at ?? null : null }}
              onMoveFile={canEditFiles ? (o, to) => { const id = assetOf(o); if (id) void moveOne(id, to) } : undefined}
            />
          </Section>
          )}
          {placement && !guest && (
          <Section id="model" title="Vybraný model" dflt={true} open={openSec} onToggle={toggleSec}>
            <ModelPanel models={models} objects={objects} placement={placement} />
          </Section>
          )}
          {placement && !guest && (
          <Section id="rez" title="Řez modelem" dflt={true} open={openSec} onToggle={toggleSec}>
            <SectionPanel sec={sec} setMoveMode={setMoveMode} />
          </Section>
          )}
        </div>
        </SectionFocusContext.Provider>

        <StorageFooter cache={cache} />
      </div>

      {/* Výkresy řezu jako plovoucí okna — ať je pod nimi pořád vidět model v mapě */}
      {sec.secDrawings.map((d, i) => sec.secShown.has(d.key) && (
        <SectionDrawing
          key={d.key}
          float
          slot={i}
          epoch={sec.secEpoch}
          result={d.result}
          name={((selectedId ? modelsRef.current.get(selectedId)?.name : null) ?? 'model') + ' — ' + d.label}
          bgView={d.bg}
          originZ={d.originZ}
          onNewSection={rect => sec.sectionFromDrawing(d.key, rect)}
          onClose={() => sec.setSecShown(s => { const n = new Set(s); n.delete(d.key); return n })}
        />
      ))}
    </div>
  )
}
