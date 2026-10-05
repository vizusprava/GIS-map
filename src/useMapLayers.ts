/**
 * Co je v mapě vidět: podklad (ortofoto / topo / Google 3D), katastr, OSM budovy, pozadí scény
 * — a ořez, který z nich vykrajuje vybrané parcely nebo místo pod modelem.
 *
 * Obojí žije v jednom hooku schválně. Ořez sahá na tytéž vrstvy (glóbus, Google dlaždice)
 * a „Google jen ve výběru" je zároveň podklad i ořez — rozdělené by si navzájem přepisovaly stav.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import polygonClipping from 'polygon-clipping'
import { CR_EXTENT, GOOGLE_3D_ION_ASSET, OSM_LIFT_M } from './config'
import { applyBackground, BG_MODES, type BgMode } from './background'
import { simplifyRingCapped } from './rings'
import { sjtskOf, wgsOf } from './tiles'
import { userIonToken } from './lib/ionKey'
import type { Base, ModelEntry, ParcelEntry, SceneObj } from './types'
import type { PerfSettings } from './perfProfile'
import type { ScenePersist } from './lib/scenePersist'
import type { CesiumViewer } from './useCesiumViewer'

export type MapLayers = ReturnType<typeof useMapLayers>

export function useMapLayers(deps: {
  viewer: CesiumViewer
  sceneRef: React.RefObject<ScenePersist>
  perf: PerfSettings
  parcelsRef: React.RefObject<Map<string, ParcelEntry>>
  modelsRef: React.RefObject<Map<string, ModelEntry>>
  /** překreslení panelu Scéna (přepínače masek modelů čte z refů) */
  setObjects: React.Dispatch<React.SetStateAction<SceneObj[]>>
}) {
  const { sceneRef, perf, parcelsRef, modelsRef, setObjects } = deps
  const { viewerRef, viewerReady, perfRef, ortoRef, ortoPatchRef, ztmRef, katastrRef, googleRef, googlePendingRef, osmRef, osmPendingRef } = deps.viewer
  const scene = sceneRef.current // jen počáteční hodnoty stavu

  const [base, setBase] = useState<Base>(() => scene.initial.base ?? 'ortofoto')
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
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleErr, setGoogleErr] = useState<string | null>(null)
  // zvedne se po změně klíče Cesium ion → efekt podkladu připojí Google 3D znovu
  const [ionVer, setIonVer] = useState(0)
  const [googleAlpha, setGoogleAlpha] = useState(1)               // průhlednost 3D reality (1 = plná, 0 = jen mapa pod ní)
  const [googleUnder, setGoogleUnder] = useState<'ortofoto' | 'zm' | 'none'>('none') // plochá mapa pod 3D; default 'none' = čistě 3D

  /**
   * Pozadí scény (kolem glóbu / pod 3D dlaždicemi) — viz `background.ts`. Drží se zvlášť
   * pro plochou mapu a zvlášť pro 3D realitu.
   *
   * Nad ortofotem a topem je obloha k ničemu: mapa se kreslí shora a hvězdy kolem republiky
   * jen ruší, takže je tam černo. Jakmile se ale kamera dostane mezi domy ve 3D realitě,
   * obloha k pohledu patří. Jedno společné nastavení by muselo být špatně v jednom z těch
   * dvou režimů — takhle si každý drží svoje a panel edituje ten, který je zrovna vidět.
   */
  const [bgMap, setBgMap] = useState<BgMode>(() => {
    const v = scene.initial.bgMode
    // `vesmir` bývalo společné výchozí nastavení, tedy „nikdo nic nevybral" — pro mapu je z něj černá
    if (!BG_MODES.some(m => m.id === v) || v === 'vesmir') return 'cerna'
    return v as BgMode
  })
  const [bg3d, setBg3d] = useState<BgMode>(() => {
    const v = scene.initial.bgMode3d
    return (BG_MODES.some(m => m.id === v) ? v : 'vesmir') as BgMode
  })
  const bgMode = base === 'google' ? bg3d : bgMap
  const setBgMode = (m: BgMode) => (base === 'google' ? setBg3d(m) : setBgMap(m))
  const [bgCustom, setBgCustom] = useState<string>(() => scene.initial.bgCustom || '#121820')
  const bgStageRef = useRef<Cesium.PostProcessStage | null>(null)
  // OSM budovy (globální šedé bloky přes ion) — spolehlivé pokrytí
  const [osmOn, setOsmOn] = useState(false)
  const [osmLoading, setOsmLoading] = useState(false)

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
    // Za pohybu se zvedne na GOOGLE_SSE_MOVING (viz efekt u `interacting` v `useCesiumViewer`) — tady je klidová hodnota.
    ts.maximumScreenSpaceError = perfRef.current.googleSseStill
    ts.cacheBytes = perfRef.current.googleCacheBytes                  // podle profilu výkonu a paměti
    ts.maximumCacheOverflowBytes = perfRef.current.googleCacheOverflowBytes // dočasný přetok při špičce
    ts.preloadFlightDestinations = true                  // při flyTo natáhni cíl předem (default true, explicitně)
    ts.preloadWhenHidden = true                          // drž načtené i když je dočasně schované (míň reloadů)
    ts.foveatedScreenSpaceError = true                   // priorita na střed obrazovky (default true)
    // Bez výškového posunu: dlaždice jsou v elipsoidických výškách a terén ČÚZK se na elipsoid
    // převádí kvazigeoidem podle místa (geoid.ts), takže na sebe sedí samy. Dřívější zvednutí
    // o 0,5 m jen maskovalo chybu konstantního geoidu v Liberci a jinde ji naopak zvětšovalo.
    viewer.scene.primitives.add(ts)
    googleRef.current = ts
    updateExcavation() // kdyby byl model naimportovaný dřív, než se Google načetl
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
      // alfa jde přes CallbackProperty — její změnu Cesium samo nepozná a nepřekreslí
      viewerRef.current?.scene.requestRender()
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
    if (ortoPatchRef.current) ortoPatchRef.current.show = showOrto // záplata jde s ortofotem
    if (ztmRef.current) ztmRef.current.show = showZtm
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
          const own = !!userIonToken()
          if (code === 401 || code === 403 || code === 429 || /401|403|429|unauthor|forbidden|token|quota/i.test(msg))
            setGoogleErr(own
              ? 'Cesium ion tvůj klíč odmítl — je platný a má přístup ke Google 3D? Zkontroluj ho v okně Klíč Cesium ion.'
              : 'Sdílený zkušební klíč Cesium ion nefunguje — nejspíš má vyčerpanou kvótu. Nastav si vlastní klíč (zdarma).')
          else if (code === 404)
            setGoogleErr('Účet klíče nemá přidané „Google Photorealistic 3D Tiles" — přidej je v Cesium ion v Asset Depot.')
          else
            setGoogleErr(`Google 3D se nenačetlo${code ? ` (HTTP ${code})` : ''}: ${msg}`)
        })
        .finally(() => setGoogleLoading(false))
    } else if (googleRef.current) {
      googleRef.current.show = false
      googleRef.current.style = undefined
    }

    return () => { alive = false }
  }, [base, katastrOn, googleUnder, parcelClip, ionVer])

  /**
   * Klíč Cesium ion se změnil (vlastní místo sdíleného nebo naopak): už načtené Google 3D
   * patří ke starému klíči, tak se zahodí a efekt podkladu ho s novým klíčem připojí znovu.
   */
  function reloadGoogle() {
    const v = viewerRef.current
    const ts = googleRef.current
    if (ts && v && !v.isDestroyed()) v.scene.primitives.remove(ts) // remove ho i zničí
    googleRef.current = null
    googlePendingRef.current = null
    setGoogleErr(null)
    setIonVer(n => n + 1)
  }

  // Jak jemně dělit glóbus, se řídí podkladem: u topa je dlaždice levná a předěl mezi úrovněmi
  // je vidět jako hrana, u ortofota je drahá a předěl znamená jen měkčí dálku. Úsporný profil
  // jde u obojího o stupeň hruběji. Zvlášť od přepínání podkladu, ať změna profilu nesahá
  // na načítání Google dlaždic.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const showZtm = base === 'google' ? googleUnder === 'zm' : base === 'zm'
    v.scene.globe.maximumScreenSpaceError = showZtm ? perf.globeSseTopo : perf.globeSsePhoto
  }, [base, googleUnder, perf, viewerReady])

  // pozadí scény: hvězdy / přechod / plná barva. Řeší i barvu glóbu MIMO dostupná data
  // (ČÚZK končí na hranicích ČR) — jinak by kolem republiky svítil obdélník.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    applyBackground(v, bgMode, bgCustom, bgStageRef)
    sceneRef.current.patchState({ bgMode: bgMap, bgMode3d: bg3d, bgCustom })
  }, [viewerReady, bgMode, bgMap, bg3d, bgCustom])

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

  // Vrstvu ortofota staví hook vieweru (zná detail ortofota); tady jen projde dál pro napečení.
  const refreshOrtoLayer = deps.viewer.refreshOrtoLayer

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

  /** Výběr parcel se změnil — ořez i ztlumení sledují jeho tvar. */
  function parcelsChanged() {
    if (parcelClip !== 'off') { updateExcavation(); syncDim(true) }
  }

  /** Výběr parcel je pryč — bez něj nemá ořez co ořezávat (efekt pak přepočítá ořez i ztlumení). */
  function clipOff() {
    if (parcelClip !== 'off') setParcelClip('off')
  }

  return {
    base,
    bg3d,
    bgCustom,
    bgMap,
    bgMode,
    clipOff,
    googleAlpha,
    googleErr,
    reloadGoogle,
    googleLoading,
    googleUnder,
    katastrOn,
    keep3DAround,
    okoliVis,
    osmLoading,
    osmOn,
    parcelBuffer,
    parcelClip,
    parcelsChanged,
    refreshOrtoLayer,
    resetClipping,
    setBase,
    setBgCustom,
    setBgMode,
    setGoogleAlpha,
    setGoogleUnder,
    setKatastrOn,
    setKeep3DAround,
    setOkoliVis,
    setOsmOn,
    setParcelBuffer,
    setParcelClip,
    syncDim,
    updateExcavation,
  }
}
