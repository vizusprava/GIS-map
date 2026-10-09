import { useEffect, useMemo, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { toast } from 'sonner'
import { ChevronRight, Loader2, Sparkles, Trash2 } from 'lucide-react'
import { ENABLE_MODEL_SECTION, NEEDS_ION, SHARP_KEY } from './config'
import { effectiveIonToken, useUserIonToken } from './lib/ionKey'
import { geoidN } from './geoid'
import { perfSettings, readPerfChoice, resolvePerf, savePerfChoice, type PerfChoice } from './perfProfile'
import { readOrtoDetail, saveOrtoDetail, type OrtoDetail } from './imagery'
import { tilesBounds, wgsOf } from './tiles'
import type { ParcelHit } from './katastr'
import { captureThumb } from './snapshot'
import { turnCamera } from './sceneUtils'
import { MissingFilesPanel } from './panels/MissingFilesPanel'
import type { MapClickOwner, SceneObj } from './types'
import type { ScenePersist } from './lib/scenePersist'
import { CalloutLayer } from './callouts'
import { useMinimapPref } from './miniMap'
import { NavCorner } from './navCorner'
import { MapBanners } from './mapBanners'
import { CoordsPanel } from './coords'
import { MapTools } from './mapTools'
import { MapSearch } from './mapSearch'
import { Section, SectionFocusContext } from './ui'
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
import { useFileStorage } from './useFileStorage'
import { useSceneRestore } from './useSceneRestore'
import { usePanelSections, type FocusTarget } from './usePanelSections'
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
import { ImportPanel } from './panels/ImportPanel'
import { PanelHeader } from './panels/PanelHeader'
import { TourOverlay } from './tour/TourOverlay'
import { useCameraBounds } from './cameraBounds'
import { useCrHighlight } from './useCrHighlight'
import { useTourStore } from './tour/tourStore'
import type { TourCtx } from './tour/steps'

/**
 * Mapa jedné scény. Co se má pamatovat, hlásí přes `scene` (viz lib/scenePersist.ts) —
 * o Supabase ani o přihlášeném uživateli tady nevíme nic.
 *
 * Jednotlivé věci v mapě (podklady, parcely, modely, výkresy, měření, pohledy…) žijí každá ve
 * svém hooku `use*` a v panelu `panels/*`, stejně jako úložiště souborů (useFileStorage),
 * obnova scény (useSceneRestore) a sekce panelu (usePanelSections). Tady zůstává jen to, co
 * je spojuje: kdo právě vlastní klik do mapy, Esc a rozložení mapy a levého panelu.
 */
export function MapView({ scene }: { scene: ScenePersist }) {
  // ── kam se ukládají soubory a ukládací kanál scény (useFileStorage.ts) ──
  const storage = useFileStorage(scene)
  const { sceneRef, files } = storage
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
      // Nejčastější viník je model, který se ještě ani jednou nevykreslil (materiál, na kterém
      // spadne shader). Ten se odebere z mapy a kreslí se dál — jinak by pomohlo jen F5.
      const dropped = models.dropUndrawn()
      if (dropped.length) {
        viewer.resumeRendering()
        toast.error(`Model „${dropped.join('“, „')}“ se nepodařilo vykreslit — odebral jsem ho z mapy, soubor ve scéně zůstal.`, { duration: 12000 })
        return
      }
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
  // kamera nesmí z dosahu republiky (výška, posun za hranice) a zarazí skoky (cameraBounds.ts)
  useCameraBounds({ viewerRef, viewerReady })
  // minimapa v rohu: zapnutí a podklad si pamatuje tenhle počítač (miniMap.tsx)
  const mini = useMinimapPref()

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
  // v Google 3D (dlaždice celého světa) ztmavit okolí republiky a protáhnout hranici
  useCrHighlight({ viewerRef, viewerReady, on: layers.base === 'google' })

  // ── řez modelem v mapě: veškerý jeho stav a obsluha žije v `useSectionTool` ──
  // (zatím vypnutý přepínačem ENABLE_MODEL_SECTION — sekce v panelu i výkresy se nevykreslí)
  const sec = useSectionTool({
    viewerRef, modelsRef, selectedId, selectedIdRef: models.selectedIdRef, setSelectedId: models.setSelectedId, viewerReady,
    enabled: ENABLE_MODEL_SECTION,
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

  // ── obnova scény po otevření: nejdřív mapa, pak soubory (useSceneRestore.ts) ──
  const restore = useSceneRestore({
    viewerRef, viewerReady, sceneRef, importModel, renderDrawing, mountRaster, restoreParcels,
    onMissing: () => setPanelOpen(true),
  })
  const { restoring, missingFiles } = restore

  /** Kde leží soubor objektu z panelu Scéna (model, výkres), nebo null (parcela, plocha, nenahraný). */
  function assetOf(o: SceneObj): string | undefined {
    if (o.kind === 'model') return modelsRef.current.get(o.id)?.assetId
    if (o.kind === 'drawing') return drawings.drawingsRef.current.get(o.id.replace('drawing-', ''))?.assetId
    return undefined
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
  const hasParcels = parcelCount > 0
  const hasTiles = tileCount > 0
  const hasRegion = region.regionChoices.length > 0 || region.regionParts.length > 0 || !!region.regionName
  const hasModelSel = !!placement
  const hasDistrict = districtsOn && !!selectedDistrict
  const hasRasters = rasterList.length > 0

  // Soustředění panelu na zapnutý nástroj (barva nástroje, sbalení ostatních) — viz usePanelSections.
  // Bez nástroje drží panel vybraný model: jeho sekce i řez, Scéna zůstane (kliká se v ní na model).
  const modelSecs = { also: ENABLE_MODEL_SECTION ? ['rez'] : [], keep: ['scena'] }
  const focusTarget: FocusTarget | null =
    parcelMode ? (parcelCount > 0 ? { id: 'parcely', tool: 'parcel' } : null)
    : areaMode ? { id: 'vyber', tool: 'area' }
    : tileMode ? { id: tileCount > 0 ? 'dlazdice' : 'vyber', tool: 'tiles' }
    : region.regionMode ? (region.regionName ? { id: 'uzemi', tool: 'region' } : null)
    : rulerMode ? { id: 'mereni', tool: 'ruler' }
    : coordsMode ? { id: 'souradnice', tool: 'coords' }
    : moveMode && placement ? { id: 'model', tool: 'move', ...modelSecs }
    : placement && !guest ? { id: 'model', tool: 'model', ...modelSecs }
    : null
  const { openSec, toggleSec, panelScrollRef, sectionFocus } = usePanelSections({
    reveal: { parcely: hasParcels, dlazdice: hasTiles, uzemi: hasRegion, model: hasModelSel, mestcast: hasDistrict, rastr: hasRasters },
    focusTarget,
    openPanel: () => setPanelOpen(true),
  })

  // co průvodce aplikací (tour/) potřebuje vědět o mapě a co v ní umí udělat
  const tourCtx: TourCtx = {
    viewer: viewerReady ? viewerRef.current : null,
    guest,
    canShare: !!scene.share,
    tool: clickOwner,
    rulers: rulers.map(r => ({ id: r.id, pts: r.pts.length })),
    parcelCount,
    selectedModel: selectedId,
    modelCount: objects.filter(o => o.kind === 'model').length,
    drawingCount: objects.filter(o => o.kind === 'drawing').length,
    objectCount: objects.length,
    viewCount: camViews.length,
    openPanel: () => setPanelOpen(true),
    openSection: id => toggleSec(id, true),
    removeRulers: rulerTool.delRulers,
  }

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
      <div ref={containerRef} data-tour="mapa" className="absolute inset-0" />

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

      <MapBanners restoring={restoring} needIon={NEEDS_ION && !effectiveIonToken() && layers.base === 'google'} guest={guest} left={mapLeft} />
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
          onMinimap={mini.toggle}
          onTurn={deg => { const v = viewerRef.current; if (v && !v.isDestroyed()) turnCamera(v, deg) }}
          onTour={() => useTourStore.getState().start('resume')}
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
      <NavCorner viewer={viewerReady ? viewerRef.current : null} mini={mini} size={winW - mapLeft < 560 ? 132 : compactTools ? 160 : 208} />

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
      <div data-tour="panel" className={`absolute inset-y-0 left-0 z-20 flex w-80 flex-col border-r border-gray-700 bg-gray-900/95 transition-transform ${panelOpen ? '' : '-translate-x-full'}`}>
        <PanelHeader scene={scene} guest={guest} restoring={restoring} onLeave={() => void leaveScene()} onHide={() => setPanelOpen(false)} />

        {/* Jediná scrollovaná oblast. Pořadí sekcí kopíruje postup práce: podklad → výběr →
            co z výběru vzniklo → scéna → kamera → prezentace. Kontextové sekce (Parcely,
            Dlaždice, …) stojí hned pod tím, co je vyrobilo, a revealSection k nim odscrolluje. */}
        <SectionFocusContext.Provider value={sectionFocus}>
        <div ref={panelScrollRef} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
          {missingFiles.length > 0 && !guest && (
          <Section id="chybi" title="Chybějící soubory" dflt={true} badge={missingFiles.length} open={openSec} onToggle={toggleSec}>
            <MissingFilesPanel files={missingFiles} onRelink={(a, picked) => void restore.relinkMissing(a, picked)} onRemove={a => void restore.removeMissing(a)} />
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
              onMoveFile={canEditFiles ? (id, to) => void storage.moveOne(id, to) : undefined}
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
            <ImportPanel
              storage={storage} canEditFiles={canEditFiles}
              onModel={() => fileRef.current?.click()}
              onDrawing={() => dwgRef.current?.click()} drawingLoading={drawingLoading}
              onRaster={() => rasterFileRef.current?.click()} rasterBusy={rasterBusy}
            />
          </Section>
          )}
          {objects.length > 0 && (
          <Section id="scena" title="Scéna" dflt={true} badge={objects.length} open={openSec} onToggle={toggleSec}>
            <ScenePanel
              ui={sceneUi} objects={objects} selectedId={selectedId} drawings={drawings} models={models} selectObject={selectObject}
              locateObject={locateObject} toggleVisible={toggleVisible} deleteObject={deleteObject} onRename={renameObject}
              readOnly={guest}
              fileAt={o => { const id = assetOf(o); return id ? files[id]?.at ?? null : null }}
              onMoveFile={canEditFiles ? (o, to) => { const id = assetOf(o); if (id) void storage.moveOne(id, to) } : undefined}
            />
          </Section>
          )}
          {placement && !guest && (
          <Section id="model" title="Vybraný model" dflt={true} open={openSec} onToggle={toggleSec}>
            <ModelPanel models={models} objects={objects} placement={placement} />
          </Section>
          )}
          {ENABLE_MODEL_SECTION && placement && !guest && (
          <Section id="rez" title="Řez modelem" dflt={true} open={openSec} onToggle={toggleSec}>
            <SectionPanel sec={sec} setMoveMode={setMoveMode} />
          </Section>
          )}
        </div>
        </SectionFocusContext.Provider>

        <StorageFooter cache={cache} />
      </div>

      {/* Výkresy řezu jako plovoucí okna — ať je pod nimi pořád vidět model v mapě */}
      {ENABLE_MODEL_SECTION && sec.secDrawings.map((d, i) => sec.secShown.has(d.key) && (
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

      {/* průvodce aplikací (tour/) — vypnutý nic nevykresluje */}
      <TourOverlay ctx={tourCtx} />
    </div>
  )
}
