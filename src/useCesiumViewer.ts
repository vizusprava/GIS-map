/**
 * Cesium viewer mapy: vznik, podklady ČÚZK, zánik — a to, co se ladí přímo na něm
 * (kvalita vykreslení podle profilu výkonu, ostrost obrazu, pořadí stahování terénu).
 *
 * Odkazy na věci, které viewer vlastní (podkladové vrstvy, Google a OSM dlaždice), drží tenhle
 * hook, protože musí zaniknout spolu s ním. Kdyby přežily, nový viewer (StrictMode, návrat do
 * scény) by dostal mrtvé objekty starého.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { CR_EXTENT, LIBEREC_EXTENT, MOVE_SETTLE_MS, SHARP_KEY } from './config'
import { effectiveIonToken } from './lib/ionKey'
import { ortofotoProvider, ortofotoPatchProvider, ORTO_CACHE_SHARE, ORTO_PATCH_MIN_TERRAIN, ztmProvider, katastrProvider, type OrtoDetail } from './imagery'
import { makeDmrTerrain, setDmrCacheMax, setTerrainFocus } from './terrain'
import { watchClipCollections } from './cesiumClipDebug'
import type { PerfSettings } from './perfProfile'
import type { ScenePersist } from './lib/scenePersist'

export type CesiumViewer = ReturnType<typeof useCesiumViewer>

export function useCesiumViewer(deps: {
  containerRef: React.RefObject<HTMLDivElement | null>
  sceneRef: React.RefObject<ScenePersist>
  perf: PerfSettings
  /** supersampling nad rozlišení displeje (1 = bez) */
  sharpness: number
  /** jak hluboko sahat do pyramidy ortofota (imagery.ts) — předvolba počítače */
  ortoDetail: OrtoDetail
  /** roviny ořezu modelu (řez) — hlídá je záchranná brzda vykreslování */
  clipCollections: () => Iterable<Cesium.ClippingPlaneCollection>
  /** vykreslování spadlo — vypnout, co ho nejspíš shodilo */
  onRenderError: () => void
}) {
  const { containerRef, sceneRef, perf, sharpness, ortoDetail } = deps
  // Čtou je cesty, které běží mimo render (start vieweru, načtení Google dlaždic).
  const perfRef = useRef(perf); perfRef.current = perf
  const ortoDetailRef = useRef(ortoDetail); ortoDetailRef.current = ortoDetail
  /** s jakým detailem je postavená současná vrstva ortofota — ať se při startu nestaví dvakrát */
  const ortoBuiltRef = useRef<OrtoDetail | null>(null)
  const clipRef = useRef(deps.clipCollections); clipRef.current = deps.clipCollections
  const renderErrRef = useRef(deps.onRenderError); renderErrRef.current = deps.onRenderError

  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const [viewerReady, setViewerReady] = useState(false)
  const ortoRef = useRef<Cesium.ImageryLayer | null>(null)
  const ortoPatchRef = useRef<Cesium.ImageryLayer | null>(null) // hrubší ortofoto pod ostrým, viz imagery.ts
  const ztmRef = useRef<Cesium.ImageryLayer | null>(null)
  const katastrRef = useRef<Cesium.ImageryLayer | null>(null)
  const googleRef = useRef<Cesium.Cesium3DTileset | null>(null)
  // rozpracované načítání Google dlaždic — než dojde ze sítě, je googleRef ještě null, takže
  // rychlé přepnutí tam a zpět by jinak spustilo druhé stahování a první tileset osiřel ve scéně
  const googlePendingRef = useRef<Promise<Cesium.Cesium3DTileset | null> | null>(null)
  const osmRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const osmPendingRef = useRef<Promise<Cesium.Cesium3DTileset | null> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    // vlastní klíč uživatele, jinak sdílený zkušební (lib/ionKey.ts)
    const ionToken = effectiveIonToken()
    if (ionToken) Cesium.Ion.defaultAccessToken = ionToken


    const viewer = new Cesium.Viewer(containerRef.current, {
      /**
       * Žádný světový podklad pod naše vrstvy.
       *
       * Cesium si jinak samo přidá celosvětové ortofoto (Bing přes Ion). Ortofoto ČÚZK vrací
       * za hranicemi ČR průhledné pixely — ověřeno, dlaždice v Německu má 2 kB a je celá
       * prázdná, ta nad Libercem 328 kB — takže tou dírou prosvítal cizí snímek a kolem
       * republiky se rýsoval pás zahraničí. Bez podkladu zůstane venku holý glóbus
       * v barvě pozadí a hranice si vykreslí samo ortofoto svojí průhledností, tedy přesně.
       *
       * Jako vedlejší efekt odpadá i stahování téhle vrstvy a závislost na tokenu Ionu.
       */
      baseLayer: false,
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
      /**
       * Kreslit jen na vyžádání, ne 60× za vteřinu.
       *
       * Stojící mapa dřív držela grafiku pořád naplno — na notebooku to je horký stroj a vybitá
       * baterie za nic. Cesium si snímek vyžádá samo při pohybu kamery, přeletu a načítání
       * dlaždic a modelů; zbytek (animace, entity, nástroje) to musí říct sám přes
       * `scene.requestRender()` — viz pojistky u `interacting` níž a na konci `MapView`.
       * `maximumRenderTimeChange: Infinity`: plynutí času scény samo o sobě kreslení nespouští.
       */
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      // MSAA podle profilu výkonu; přepnout jde i za běhu (efekt u `perf`)
      msaaSamples: perfRef.current.msaaSamples,
      // Bez `preserveDrawingBuffer`: snímky (náhledy pohledů, náhled scény) si vždycky nejdřív
      // vynutí vykreslení a plátno přečtou hned v témže kroku, kdy je obraz ještě v bufferu.
      // Držet buffer napořád by stálo kopii celého snímku na každý frame.
      // Renderovat ve SKUTEČNÝCH pixelech displeje. Cesium má `useBrowserRecommendedResolution`
      // defaultně true, což znamená, že `window.devicePixelRatio` ignoruje a kreslí do CSS pixelů.
      // Na displeji se škálováním (Windows běžně 125/150 %, retina 200 %) vznikne menší obraz,
      // který prohlížeč roztáhne na plnou velikost — a to přeškálování rozdrolí každou ostrou
      // hranu v ortofotu na jemný šum. Není to aliasing geometrie (MSAA i anizotropní filtrování
      // jedou v Cesiu ve výchozím stavu naplno), ale renderování pod rozlišením obrazovky.
      useBrowserRecommendedResolution: false,
    })
    viewerRef.current = viewer
    // Viewer má z výroby na dvojklik „sleduj entitu": na bod (měření, odečtený bod) kameru
    // připoutá, na plochu nebo čáru (parcela, výkres) k ní přeletí a celou ji zazoomuje — kamera
    // pak nečekaně odletí jinam. Nic v aplikaci to nepoužívá a dvojklik patří nástrojům.
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    // Entity přibývají i mimo React — mřížka po dojetí kamery, odečtené body, ztmavení okolí.
    // Přidání ani odebrání si snímek samo nevyžádá (`requestRenderMode`), tak se o něj řekne tady.
    // Hlídá se zničený viewer: entita, na kterou ještě někde drží odkaz, umí tuhle událost
    // vyvolat i po `destroy()` — a getter `scene` na zničeném vieweru spadne (černá obrazovka).
    const offEntities = viewer.entities.collectionChanged.addEventListener(() => {
      if (!viewer.isDestroyed()) viewer.scene.requestRender()
    })

    // Záchranná brzda: když vykreslování spadne, Cesium se zastaví a zbyde bílé okno. Ořez
    // modelu je nejpravděpodobnější příčina, tak ho shodíme a zkusíme kreslit dál — ať se dá
    // pracovat i s rozbitým řezem a chyba se dala nahlásit, místo aby scéna umřela.
    watchClipCollections(viewer.scene, () => clipRef.current())

    viewer.scene.renderError.addEventListener((_scene, err) => {
      console.error('Cesium přestalo vykreslovat:', err)
      renderErrRef.current()
    })
    setViewerReady(true)

    // Kolečko si bere naše plynulé přiblížení (viz `useCameraMotion`) — Cesium by na
    // každý zářez skočilo o kus a při rychlém rolování to nadskakuje. Pravé tažení a pinch
    // zůstávají Cesiu, tam je pohyb spojitý sám od sebe.
    viewer.scene.screenSpaceCameraController.zoomEventTypes = [Cesium.CameraEventType.RIGHT_DRAG, Cesium.CameraEventType.PINCH]

    // pořadí přidání = pořadí vykreslení zdola nahoru: záplata → podklady → katastr
    const patch = ortofotoPatchProvider()
    if (patch) {
      const patchLayer = new Cesium.ImageryLayer(patch, { minimumTerrainLevel: ORTO_PATCH_MIN_TERRAIN })
      viewer.imageryLayers.add(patchLayer)
      ortoPatchRef.current = patchLayer
    }
    const orto = viewer.imageryLayers.addImageryProvider(ortofotoProvider(ortoDetailRef.current))
    ortoRef.current = orto
    ortoBuiltRef.current = ortoDetailRef.current
    // Jediná ZTM vrstva: dlaždicová pyramida ČÚZK má kartografii zapečenou pro každou úroveň,
    // takže se nemusí přepínat pět vrstev podle výšky kamery jako u WMS.
    const ztm = viewer.imageryLayers.addImageryProvider(ztmProvider())
    ztm.show = false
    ztmRef.current = ztm
    const katastr = viewer.imageryLayers.addImageryProvider(katastrProvider())
    katastrRef.current = katastr

    // terén celé mapy = ČÚZK DMR 5G (ortofoto/ZTM se drapují na přesný terén)
    viewer.terrainProvider = makeDmrTerrain()

    // glóbus (ČÚZK podklad) renderuje jen výřez ČR — mimo ni se nic nekreslí
    viewer.scene.globe.cartographicLimitRectangle = CR_EXTENT
    // Barvu prázdna kolem republiky, oblohu i mlhu na obzoru nastavuje `applyBackground`
    // (`background.ts`) — všechno na jednom místě, ať si to dvě nastavení nepřebíjejí.

    // model se schová za kopce a zapadne pod povrch (nebude prosvítat) — platí pro ČÚZK terén;
    // v Google 3D zaclonění dělají samotné dlaždice
    viewer.scene.globe.depthTestAgainstTerrain = true
    // Větší cache dlaždic → míň „reload" bliknutí při návratu na místo (default 100).
    // Terén i imagery se cachují společně. Hodnota podle profilu výkonu (kvalitní 1000).
    viewer.scene.globe.tileCacheSize = Math.round(perfRef.current.tileCacheSize * ORTO_CACHE_SHARE[ortoDetailRef.current])
    /**
     * `preloadSiblings` = natáhni i dlaždice kousek za okrajem obrazovky.
     *
     * Přesně kvůli posouvání mapy: bez toho se při přejetí vedle ukáže nejdřív hrubší
     * dlaždice předka a teprve pak doostří, což vypadá jako přeskakování úrovní.
     *
     * Chvíli to vypnuté bylo, protože každá dlaždice mapy navíc znamenala i dlaždici TERÉNU
     * navíc po 66 kB z téhož hostitele. Od stropu úrovně (`DMR_MAX_LEVEL` v `terrain.ts`)
     * je ale terénu řádově míň a předstažení okolí se zaplatí samo.
     *
     * Úsporný profil ho přesto vypíná: na slabém stroji je každá dlaždice navíc znát.
     */
    viewer.scene.globe.preloadSiblings = perfRef.current.preloadSiblings
    viewer.scene.postProcessStages.fxaa.enabled = perfRef.current.fxaa

    // Kamera scény: kde jsi ji nechal. Nová scéna začíná nad Libercem.
    const saved = sceneRef.current.initial.camera
    if (saved) {
      viewer.camera.setView({
        destination: new Cesium.Cartesian3(saved.dest[0], saved.dest[1], saved.dest[2]),
        orientation: { heading: saved.h, pitch: saved.p, roll: saved.r },
      })
    } else {
      viewer.camera.setView({ destination: LIBEREC_EXTENT })
    }

    return () => {
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
      // Tilesety patřily viewru, který se za chvíli zničí. Kdyby reference přežily, `ensureGoogle`
      // by je považovala za načtené a vrátila mrtvé objekty místo aby si řekla o nové —
      // v novém viewru by se pak 3D dlaždice nezobrazily vůbec a nebylo by z čeho poznat proč.
      googleRef.current = null; googlePendingRef.current = null
      osmRef.current = null; osmPendingRef.current = null
      offEntities()
      if (!viewer.isDestroyed()) viewer.destroy()
    }
  }, [])

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
    /**
     * Mapa se kreslí jen na vyžádání (`requestRenderMode`). Pohyb kamery si Cesium pozná samo,
     * jenže nástroje si při tažení kameru vypínají a hýbou entitami — bod měření, odečtený bod,
     * malované dlaždice, posun modelu. To Cesium nevidí, takže se snímek vyžádá tady: při
     * stisku, puštění a tažení se stisknutým tlačítkem. Samotné přejetí myší nic nekreslí.
     */
    const kick = () => { if (!v.isDestroyed()) v.scene.requestRender() }
    const onMove = (e: PointerEvent) => { if (e.buttons) { busy(); kick() } }
    const onDown = () => kick()
    const onUp = () => { settle(); kick() }
    const onWheel = () => { busy(); settle() }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('pointerup', onUp) // puštění může padnout mimo plátno
    return () => {
      clearTimeout(t)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointerup', onUp)
    }
  }, [viewerReady])

  useEffect(() => {
    const v = viewerRef.current
    // Převzorkování nad rámec displeje je čistá práce navíc, tak za pohybu padá na nativní
    // rozlišení. Kdo má ostrost na 1, nepozná nic — jemu tohle nemá co ubrat.
    // Úsporný profil navíc strhne strop na CSS pixely (`pixelRatioCap`): na displeji se
    // škálováním 150 % to je méně než polovina pixelů.
    const dpr = window.devicePixelRatio || 1
    const cap = Math.min(1, perf.pixelRatioCap / dpr)
    if (v && !v.isDestroyed()) v.resolutionScale = cap * (interacting ? Math.min(sharpness, 1) : sharpness)
    if (googleRef.current) googleRef.current.maximumScreenSpaceError = interacting ? perf.googleSseMoving : perf.googleSseStill
    // Glóbus se takhle SCHVÁLNĚ nepřepíná. Zkusilo se to (`globe.maximumScreenSpaceError` 4 za
    // pohybu, 2 v klidu) kvůli rychlosti, ale na každé šťouchnutí do mapy to přehodilo celou
    // obrazovku o úroveň níž a po zastavení zase zpátky. To poskakování je horší než pomalejší
    // dotažení; rychlost se řeší tam, kde nic nebliká — stropem úrovně terénu (`DMR_MAX_LEVEL`)
    // a pořadím fronty od středu pohledu. `resolutionScale` výš mění jemnost vykreslení,
    // ne úroveň dlaždic, takže nic nepřeskakuje.

    try { localStorage.setItem(SHARP_KEY, String(sharpness)) } catch { /* */ }
  }, [sharpness, interacting, viewerReady, perf])

  // Zbytek profilu výkonu: vyhlazování, cache dlaždic a předstahování. Přepnout jde za běhu.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const scene = v.scene
    scene.msaaSamples = perf.msaaSamples
    // Bez MSAA by hrany zubatěly; FXAA je jeden průchod přes obraz, MSAA násobí celé vykreslení.
    scene.postProcessStages.fxaa.enabled = perf.fxaa
    scene.globe.tileCacheSize = Math.round(perf.tileCacheSize * ORTO_CACHE_SHARE[ortoDetail])
    scene.globe.preloadSiblings = perf.preloadSiblings
    const g = googleRef.current
    if (g) { g.cacheBytes = perf.googleCacheBytes; g.maximumCacheOverflowBytes = perf.googleCacheOverflowBytes }
    setDmrCacheMax(perf.dmrCacheTiles)
    scene.requestRender()
  }, [perf, viewerReady, ortoDetail])

  /**
   * Vrstva ortofota znovu: po napečení lokální mapy (dlaždice v téže mřížce, viz `orthoBakedKey`)
   * nebo po změně detailu. Cesium pak přepošle žádosti o dlaždice — napečené se vezmou z localu,
   * jiný detail z jiné úrovně pyramidy. Zachová pozici ve stacku i viditelnost.
   */
  function refreshOrtoLayer() {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !ortoRef.current) return
    const layers = v.scene.imageryLayers
    const idx = layers.indexOf(ortoRef.current)
    const show = ortoRef.current.show
    layers.remove(ortoRef.current, true)
    const layer = layers.addImageryProvider(ortofotoProvider(ortoDetailRef.current), idx >= 0 ? idx : undefined)
    layer.show = show
    ortoRef.current = layer
    ortoBuiltRef.current = ortoDetailRef.current
    v.scene.requestRender()
  }
  // změna detailu ortofota za běhu
  useEffect(() => {
    if (ortoBuiltRef.current && ortoBuiltRef.current !== ortoDetail) refreshOrtoLayer()
  }, [ortoDetail, viewerReady])

  /**
   * Terénu se průběžně hlásí, kam se člověk dívá.
   *
   * Fronta dlaždic DMR se podle toho řadí, takže se terén doplňuje od středu obrazovky ven —
   * a protože se dlaždice mapy kreslí až na hotový terén, jde stejným pořadím i ortofoto a topo.
   * Bez toho se stahovalo v pořadí, v jakém si Cesium řeklo, tedy i o místa, kam se uživatel
   * mezitím přestal dívat.
   *
   * Věší se to na `camera.changed`, ne na každý snímek: fronta nemusí být přesná na pixel,
   * stačí, aby věděla, kterým směrem se člověk vydal. `percentageChanged` říká, jak velká
   * změna pohledu už stojí za přepočet — výchozí polovina obrazovky je na tohle moc hrubá.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const mid = new Cesium.Cartesian2(), hit = new Cesium.Cartesian3()
    const tell = () => {
      if (v.isDestroyed()) return
      mid.x = v.canvas.clientWidth / 2
      mid.y = v.canvas.clientHeight / 2
      const p = v.camera.pickEllipsoid(mid, Cesium.Ellipsoid.WGS84, hit)
      // Míří-li střed obrazovky mimo zeměkouli (pohled k obzoru), vezme se místo pod kamerou.
      const c = p ? Cesium.Cartographic.fromCartesian(p) : v.camera.positionCartographic
      if (c) setTerrainFocus(Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude))
    }
    v.camera.percentageChanged = 0.05
    v.camera.changed.addEventListener(tell)
    v.camera.moveEnd.addEventListener(tell)
    tell()
    return () => {
      if (v.isDestroyed()) return
      v.camera.changed.removeEventListener(tell)
      v.camera.moveEnd.removeEventListener(tell)
    }
  }, [viewerReady])

  /**
   * Znovu rozjede vykreslování po pádu (renderError), když se viník odklidil. Cesium starou
   * smyčku po chybě ukončí až v dalším snímku — nová se proto rozjíždí o dva snímky později,
   * jinak by kreslily dvě naráz.
   *
   * Chybový panel Cesia se odklidí hned: Cesium ho vkládá ve stejném kroku, ve kterém hlásí
   * chybu (po této události), takže mikroúloha ho smaže dřív, než se vůbec ukáže. Čekat na dva
   * snímky by na pomalé grafice znamenalo vidět ho skoro půl vteřiny.
   */
  function resumeRendering() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const dropPanel = () => v.container.querySelectorAll('.cesium-widget-errorPanel').forEach(el => el.remove())
    queueMicrotask(() => { if (!v.isDestroyed()) dropPanel() })
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (v.isDestroyed()) return
      dropPanel()
      v.useDefaultRenderLoop = true
      v.scene.requestRender()
    }))
  }

  return {
    resumeRendering,
    viewerRef,
    viewerReady,
    perfRef,
    interacting,
    ortoRef,
    refreshOrtoLayer,
    ortoPatchRef,
    ztmRef,
    katastrRef,
    googleRef,
    googlePendingRef,
    osmRef,
    osmPendingRef,
  }
}
