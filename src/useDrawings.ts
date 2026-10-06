/**
 * Výkresy DXF/DWG v mapě: vykreslení po hladinách, výška a průhlednost celého výkresu,
 * zapínání hladin a ukládání nastavení k souboru ve scéně.
 */
import { useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { geoidN } from './geoid'
import { wgsOf, sjtskOf } from './tiles'
import { fetchElevGrid, fetchElevSampler } from './elevation'
import { nextFrame, viewCenterGround } from './sceneUtils'
import { buildTextPrims } from './dxfText'
import { parseDrawingFile } from './drawingClient'
import { krovakForm, toKrovakNeg, type DrawParse, type DrawPrim } from './dxf'
import type { DrawOverlay } from './export/drawOverlay'
import type { DrawGeo, DrawLayer, DrawLinePrim, DrawingEntry, SceneObj } from './types'
import type { AssetConfig } from './lib/types'
import type { ScenePersist } from './lib/scenePersist'

export type DrawingsTool = ReturnType<typeof useDrawings>

export function useDrawings(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  sceneRef: React.RefObject<ScenePersist>
  /** seznam v panelu Scéna — drží i hlavní vypínač každého výkresu */
  objects: SceneObj[]
  upsertObj: (o: SceneObj) => void
  removeObj: (id: string) => void
  setObjects: React.Dispatch<React.SetStateAction<SceneObj[]>>
}) {
  const { viewerRef, sceneRef, objects, upsertObj, removeObj, setObjects } = deps

  // nahrané výkresy (DXF/DWG): čáry/popisky/body po hladinách + obalové bounds
  const drawingsRef = useRef<Map<string, DrawingEntry>>(new Map())
  const [drawH, setDrawH] = useState<Record<string, number>>({})   // svislý posun výkresu (m)
  const [drawA, setDrawA] = useState<Record<string, number>>({})   // průhlednost výkresu (0..1)
  const [drawDrape, setDrawDrape] = useState<Record<string, boolean>>({}) // přilepený na terén
  // Zrcadla pro ukládání: `saveDrawingCfg` se volá i z asynchronního uploadu, kde by closure
  // viděla hodnoty staré několik sekund — a přepsala by tím, co mezitím uživatel nastavil.
  const drawHRef = useRef(drawH); drawHRef.current = drawH
  const drawARef = useRef(drawA); drawARef.current = drawA
  const dwgRef = useRef<HTMLInputElement>(null)
  const [drawingLoading, setDrawingLoading] = useState(false)

  /**
   * Výkresy pro dokreslení do exportu mapy — jen to, co je v mapě opravdu vidět.
   *
   * Vypnutá hladina ani vypnutý celý výkres se do rastru nedostanou: co je na obrazovce,
   * to vyjede. Průhlednost se bere ze stejného posuvníku jako v mapě, takže se podklad
   * prolne úplně stejně.
   */
  function drawingOverlays(): DrawOverlay[] {
    const out: DrawOverlay[] = []
    for (const [id, d] of drawingsRef.current) {
      if (objects.find(o => o.id === `drawing-${id}`)?.visible === false) continue
      const hidden = new Set(d.layers.filter(l => !l.visible).map(l => l.name))
      if (hidden.size === d.layers.length) continue // všechny hladiny vypnuté = výkres není vidět
      out.push({ prims: d.prims, toSjtsk: d.toSjtsk, hidden, alpha: drawARef.current[id] ?? 1 })
    }
    return out
  }

  // ── Výkresy (DXF/DWG) ──────────────────────────────────────────────────────────────
  const dwgColor = (rgb: number) => Cesium.Color.fromBytes((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255)

  // nastaví viditelnost všech Cesium primitivů jedné hladiny (čáry + popisky + body)
  const setLayerShow = (ly: DrawLayer, show: boolean) => { if (ly.prim) ly.prim.show = show; for (const lp of ly.labels) lp.show = show; if (ly.points) ly.points.show = show }

  function removeDrawing(id: string) {
    const v = viewerRef.current
    const d = drawingsRef.current.get(id)
    if (d && v && !v.isDestroyed()) removeLayers(v, d.layers)
    drawingsRef.current.delete(id)
    removeObj(`drawing-${id}`)
    if (d?.assetId) void sceneRef.current.deleteAsset(d.assetId).catch(err => {
      console.error('Smazání výkresu z úložiště selhalo:', err)
      toast.error('Výkres zmizel z mapy, ale v úložišti zůstal — zkus to znovu po refreshi')
    })
  }

  // Strop zahušťování přilepeného výkresu: dlouhý úsek se rozdělí nejvýš na tolik kusů a celý
  // výkres dostane nejvýš tolik bodů navíc — obří výkres pak terén kopíruje hruběji, ale vejde se.
  const DRAPE_MAX_SPLIT = 400, DRAPE_MAX_VERTS = 3_000_000
  const M_PER_LAT = 110_574

  /** vymaže primitivy hladin z mapy (odebraný výkres, přestavba po přilepení na terén) */
  function removeLayers(v: Cesium.Viewer, layers: DrawLayer[]) {
    for (const ly of layers) {
      if (ly.prim) v.scene.primitives.remove(ly.prim)
      for (const lp of ly.labels) v.scene.primitives.remove(lp)
      if (ly.points) v.scene.primitives.remove(ly.points)
    }
  }

  /**
   * Výška terénu pod výkresem (elipsoid) — jedna mřížka DMR 5G přes jádro kresby, tedy stejný
   * terén, ze kterého je mapa (viz `fetchElevGrid`: ~1,5 m, interpolovaná, v cache prohlížeče).
   * Stáhne se jednou na výkres; null = nejde (výkres pak zůstane v rovině).
   */
  async function groundOf(geo: DrawGeo) {
    if (geo.ground !== undefined) return geo.ground
    const [w, s, e, n] = geo.core
    const pad = 0.002
    try {
      const g = await fetchElevGrid(w - pad, s - pad, e + pad, n + pad)
      geo.ground = (lon, lat) => { const b = g.sample(lon, lat); return b == null ? null : b + geoidN(lon, lat) }
      geo.groundStep = g.stepM
    } catch (err) {
      console.warn('Výšky terénu pod výkresem se nepodařilo stáhnout:', err)
      geo.ground = null
    }
    return geo.ground
  }

  /**
   * Hladiny výkresu jako primitivy Cesia (každá hladina vlastní, aby šla samostatně vypínat).
   *
   * V rovině (`drape` vypnuté): všechno v jedné výšce `h0` blízko terénu a kreslí se přes
   * všechno (vypnutý depth test), takže je výkres vidět i tam, kde je místy pod terénem.
   *
   * Přilepený = „druhá verze" výkresu napečená na terén JEDNOU při stavbě: každá čára se
   * zahustí body po kroku mřížky terénu (~1,5 m) a každý bod dostane výšku terénu; texty
   * a body taky. Kreslí se pak úplně stejně levně jako v rovině. (Dřív to byly čáry
   * GroundPolylinePrimitive, které Cesium promítá na terén v KAŽDÉM snímku — u velkého
   * výkresu se pak mapa při posouvání sekala.) Výškový posun tu nemá smysl, nepoužije se.
   *
   * Stavba po kouscích: velký výkres má stovky hladin a desetitisíce čar a postavit je
   * najednou znamenalo vteřiny zamrzlé mapy (při otevření scény i celého počítače).
   * Po ~12 ms práce dostane mapa snímek — překreslí se a chytí myš — a staví se dál.
   * null = viewer mezitím zanikl (odchod ze scény), stavba končí.
   */
  async function buildLayers(
    v: Cesium.Viewer, prims: DrawPrim[], geo: DrawGeo,
    opts: { drape: boolean; alpha: number; hidden: Set<string>; offset: number },
  ) {
    const { toLL, h0, up, east, north, conv } = geo
    const ground = opts.drape ? await groundOf(geo) : null
    if (v.isDestroyed()) return null
    // přilepený výkres kousek nad terénem, ať jím neprobleskuje
    const at = (lon: number, lat: number) => (ground ? (ground(lon, lat) ?? h0) + 0.3 : h0)
    // zahušťování čar: krok mřížky terénu (aspoň 1 m), v metrech přes místní měřítko
    const step = Math.max(1, geo.groundStep ?? 1.5)
    const mPerLon = M_PER_LAT * Math.cos((geo.core[1] + geo.core[3]) / 2 * Math.PI / 180)
    let dense = 0
    const toXYZ = (x: number, y: number) => { const [lo, la] = toLL(x, y); return Cesium.Cartesian3.fromDegrees(lo, la, at(lo, la)) }
    const alpha0 = opts.alpha
    const textMats: DrawingEntry['textMats'] = []
    const pointRefs: DrawingEntry['pointRefs'] = []
    const polyRefs: DrawingEntry['polyRefs'] = []

    let wlon = Infinity, elon = -Infinity, slat = Infinity, nlat = -Infinity
    const seen = (lon: number, lat: number) => { if (lon < wlon) wlon = lon; if (lon > elon) elon = lon; if (lat < slat) slat = lat; if (lat > nlat) nlat = lat }

    // seskup prvky podle hladiny → každá hladina má vlastní čáry/popisky/body, aby šla samostatně vypínat
    const byLayer = new Map<string, DrawPrim[]>()
    for (const p of prims) { const arr = byLayer.get(p.layer); if (arr) arr.push(p); else byLayer.set(p.layer, [p]) }

    const layers: DrawLayer[] = []
    // Uložený stav dostane každá hladina hned při stavbě (vypnutá se ani neukáže, posunutá
    // neposkočí), protože výkres naskakuje po hladinách.
    const m0 = !opts.drape && opts.offset
      ? Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(up, opts.offset, new Cesium.Cartesian3()))
      : null
    let slice = performance.now()
    const breathe = async () => {
      if (performance.now() - slice < 12) return true
      await nextFrame()
      slice = performance.now()
      return !v.isDestroyed()
    }
    // Velké výkresy mají desetitisíce textů → strop na počet. Vzdálenostní LOD už není potřeba:
    // texty jsou teď v metrech, takže se při oddálení samy zmenší do neviditelna.
    let labelBudget = 30000
    for (const [lname, lprims] of byLayer) {
      if (!(await breathe())) return null
      const instances: Cesium.GeometryInstance[] = []
      const polyMeta: { id: string; c: Cesium.Color }[] = []
      for (let k = 0; k < lprims.length; k++) {
        const p = lprims[k]
        if ((k & 1023) === 1023 && !(await breathe())) return null
        if (p.kind !== 'poly') continue
        const col = dwgColor(p.color)
        const iid = `${lname}#${polyMeta.length}`
        const attributes = { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col.withAlpha(alpha0)) }
        if (ground) {
          // po terénu: úseky delší než krok mřížky se zahustí, ať čára kopíruje terén mezi body
          const deg: number[] = []
          let pl = NaN, pb = NaN
          for (const [x, y] of p.pts) {
            const [lon, lat] = toLL(x, y); seen(lon, lat)
            if (deg.length && dense < DRAPE_MAX_VERTS) {
              const len = Math.hypot((lon - pl) * mPerLon, (lat - pb) * M_PER_LAT)
              const n = Math.min(DRAPE_MAX_SPLIT, Math.floor(len / step))
              for (let i = 1; i <= n; i++) {
                const t = i / (n + 1), ilon = pl + (lon - pl) * t, ilat = pb + (lat - pb) * t
                deg.push(ilon, ilat, at(ilon, ilat))
              }
              dense += n
            }
            deg.push(lon, lat, at(lon, lat))
            pl = lon; pb = lat
          }
          if (deg.length < 6) continue
          instances.push(new Cesium.GeometryInstance({
            id: iid, attributes,
            geometry: new Cesium.PolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(deg), width: 2, arcType: Cesium.ArcType.NONE, vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT }),
          }))
        } else {
          const deg: number[] = []
          for (const [x, y] of p.pts) { const [lon, lat] = toLL(x, y); deg.push(lon, lat, h0); seen(lon, lat) }
          if (deg.length < 6) continue
          instances.push(new Cesium.GeometryInstance({
            id: iid, attributes,
            geometry: new Cesium.PolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(deg), width: 2, arcType: Cesium.ArcType.NONE, vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT }),
          }))
        }
        polyMeta.push({ id: iid, c: col })   // základní (neprůhledná) barva — z ní počítá slider
      }
      // Geometrie čar se staví ve workerech Cesia (asynchronous): u výkresu s desetitisíci
      // polyliniemi to na hlavním vlákně znamenalo několik sekund zamrzlé mapy. Texty zůstávají
      // synchronní — vlastní geometrie písmen se do workeru poslat nedá.
      // depthTest vypnutý → čáry se kreslí přes vše, takže výkres je vidět i pod terénem
      // (u přilepeného tam, kde je terén v mapě hrubší než DMR, ze kterého jsou výšky)
      const prim: DrawLinePrim | null = instances.length
        ? v.scene.primitives.add(new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PolylineColorAppearance({ renderState: { lineWidth: 1, depthTest: { enabled: false }, depthMask: false, blending: Cesium.BlendingState.ALPHA_BLEND } }),
            asynchronous: true,
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
          texts: take, anchor: toXYZ, east, north, up, conv,
          colorCss: rgb => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`,
        })
        for (const tp of built.prims) { v.scene.primitives.add(tp); labels.push(tp) }
        textMats.push(...built.mats)
      }

      let points: Cesium.PointPrimitiveCollection | null = null
      const pts = lprims.filter((p): p is Extract<DrawPrim, { kind: 'point' }> => p.kind === 'point')
      if (pts.length) {
        points = new Cesium.PointPrimitiveCollection()
        for (const pt of pts) {
          const [lon, lat] = toLL(pt.pt[0], pt.pt[1]); seen(lon, lat)
          const pc = dwgColor(pt.color)
          const pp = points.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, at(lon, lat)), pixelSize: 5, color: pc.withAlpha(alpha0), disableDepthTestDistance: Number.POSITIVE_INFINITY })
          pointRefs.push({ p: pp, c: pc })
        }
        v.scene.primitives.add(points)
      }

      if (prim || labels.length || points) {
        const ly: DrawLayer = { name: lname || '0', color: lprims[0].color, visible: true, prim, labels, points }
        if (opts.hidden.has(ly.name)) { ly.visible = false; setLayerShow(ly, false) }
        if (m0) setLayerMatrix(ly, m0)
        layers.push(ly)
      }
    }
    // materiály textů se dají nastavit kdykoliv (nejsou to atributy primitiva), takže až tady
    if (alpha0 !== 1) for (const mt of textMats) mt.uniforms.opacity = alpha0
    layers.sort((a, b) => a.name.localeCompare(b.name, 'cs'))
    return { layers, textMats, pointRefs, polyRefs, ext: [wlon, elon, slat, nlat] as [number, number, number, number] }
  }

  /**
   * Srovnání po dostavění čar. Dokud se geometrie staví ve workeru, atributy barev neexistují
   * (`applyDrawAlpha` je přeskočí) a Cesium na konci stavby přepíše `modelMatrix` hodnotou
   * z jejího začátku. Kdo stihl mezitím pohnout průhledností nebo výškou, měl by v mapě
   * něco jiného, než ukazuje posuvník — tak se aktuální stav po dokončení použije znovu.
   */
  function watchBuilt(v: Cesium.Viewer, id: string, entry: DrawingEntry, offFallback: number, alphaBuilt: number) {
    const layersNow = entry.layers
    const building = layersNow.flatMap(l => l.prim ? [l.prim] : [])
    if (!building.length) return
    const scene = v.scene
    const off = scene.postRender.addEventListener(() => {
      // výkres mezitím odebraný nebo přestavěný (přilepení na terén)
      if (drawingsRef.current.get(id) !== entry || entry.layers !== layersNow) { off(); return }
      if (!building.every(p => p.ready)) return
      off()
      // záloha na uložené hodnoty pro případ, že React ještě nepropsal stav do refů
      applyDrawH(entry, drawHRef.current[id] ?? offFallback)
      const a = drawARef.current[id] ?? alphaBuilt
      if (a !== alphaBuilt) applyDrawAlpha(entry, a)
      scene.requestRender()
    })
  }

  /**
   * Přilepit výkres na terén, nebo ho vrátit do roviny. Výkres se přestaví z kresby, kterou
   * si drží (`prims`), bez nového parsování; vypnuté hladiny, průhlednost i posun zůstanou.
   * Nové prvky se do mapy přidají dřív, než zmizí staré, ať výkres mezitím neproblikne.
   * Rychlé přepnutí tam a zpátky: platí poslední volba, rozestavěná přestavba se zahodí.
   */
  const drapeSeq = useRef(new Map<string, number>())
  async function setDrawingDrape(did: string, on: boolean) {
    const v = viewerRef.current
    const e = drawingsRef.current.get(did)
    if (!v || v.isDestroyed() || !e) return
    const seq = (drapeSeq.current.get(did) ?? 0) + 1
    drapeSeq.current.set(did, seq)
    setDrawDrape(s => ({ ...s, [did]: on }))
    if (e.drape === on) return // zpátky na to, co v mapě už je — rozestavěné se zahodí
    const alpha = drawARef.current[did] ?? 1
    const built = await buildLayers(v, e.prims, e.geo, {
      drape: on, alpha, hidden: new Set(e.layers.filter(l => !l.visible).map(l => l.name)), offset: drawHRef.current[did] ?? 0,
    })
    if (!built || v.isDestroyed()) return
    if (drapeSeq.current.get(did) !== seq || drawingsRef.current.get(did) !== e) { removeLayers(v, built.layers); return }
    // co se mezitím přepnulo v panelu, platí i pro nové hladiny
    const master = objects.find(o => o.id === `drawing-${did}`)?.visible ?? true
    for (const ly of built.layers) {
      ly.visible = e.layers.find(o => o.name === ly.name)?.visible ?? ly.visible
      setLayerShow(ly, master && ly.visible)
    }
    removeLayers(v, e.layers)
    e.layers = built.layers; e.textMats = built.textMats; e.pointRefs = built.pointRefs; e.polyRefs = built.polyRefs
    e.drape = on
    watchBuilt(v, did, e, drawHRef.current[did] ?? 0, alpha)
    saveDrawingCfg(did)
    setObjects(list => [...list])
    v.scene.requestRender()
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
    // Schválně medián, ne střed obálky — proč, stojí u `midX` v `dxf.ts`.
    const cx = parse.midX, cy = parse.midY
    let toLL: (x: number, y: number) => [number, number]
    // Tentýž převod, ale do S-JTSK — potřebuje ho export mapy do rastru (viz `DrawingEntry`).
    // U výkresu v Křováku je to identita (případně otočení znamének), takže se nic nedopočítává
    // a kresba sedne do mapy přesně; lokálně umístěný výkres se musí protáhnout přes zeměpis.
    let toSjtsk: (x: number, y: number) => [number, number]
    let mode: string
    // zápis S-JTSK podle mediánu kresby (záporný z CADu, kladný, kladný s prohozenými osami)
    const form = krovakForm(cx, cy)
    if (form) {
      toSjtsk = (x, y) => toKrovakNeg(form, x, y)
      toLL = (x, y) => wgsOf(...toKrovakNeg(form, x, y)) as [number, number]
      mode = form === 'neg' ? 'S-JTSK' : form === 'pos' ? 'S-JTSK (kladné)' : 'S-JTSK (kladné, prohozené osy X/Y)'
    } else {
      const g = viewCenterGround(v)
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height))
      const tmp = new Cesium.Cartesian3(), out = new Cesium.Cartesian3()
      toLL = (x, y) => {
        tmp.x = x - cx; tmp.y = y - cy; tmp.z = 0
        Cesium.Matrix4.multiplyByPoint(enu, tmp, out)
        const c = Cesium.Cartographic.fromCartesian(out)
        return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)]
      }
      toSjtsk = (x, y) => sjtskOf(...toLL(x, y)) as [number, number]
      mode = 'lokální (umístěno do středu pohledu)'
    }

    // Jedna plochá výška blízko terénu (vzorek DMR ve středu výkresu). Výchozí výkres leží v jedné
    // rovině a vykresluje se s vypnutým depth testem, aby byl vidět vždy, i když je místy pod
    // terénem; přilepit na terén jde na přání (`AssetConfig.drape`, viz `buildLayers`).
    const [clon, clat] = toLL(cx, cy)
    let h0 = 300 + geoidN(clon, clat)
    try {
      const dd = 0.001
      const es = await fetchElevSampler('dmr5g', clon - dd, clat - dd, clon + dd, clat + dd, 4)
      const bpv = es(clon, clat)
      if (bpv != null) h0 = bpv + geoidN(clon, clat)
    } catch { /* nech výchozí */ }
    if (v.isDestroyed()) return null

    // svislý směr ve středu (pro posun výšky)
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(Cesium.Cartesian3.fromDegrees(clon, clat, h0), new Cesium.Cartesian3())

    // Uloženou průhlednost ZAPÉKÁME rovnou do barev při stavbě primitiv. Dodatečné doobarvení
    // tady nejde: Cesium vyrábí atributy primitiva až v prvním `update()` ve scéně, takže
    // `getGeometryInstanceAttributes` hned po vytvoření hodí DeveloperError a obnova výkresu spadne.
    const alpha0 = restore?.config?.alpha ?? 1

    // Báze pro texty: kotva každého textu jde přes toLL (přesně jako čáry), ale rohy písmen se
    // odsazují o metry v této sdílené ENU bázi — na vzdálenost pár km je odchylka směru < 0,05°.
    const enuC = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(clon, clat, h0))
    const east = Cesium.Matrix4.getColumn(enuC, 0, new Cesium.Cartesian4())
    const north = Cesium.Matrix4.getColumn(enuC, 1, new Cesium.Cartesian4())
    const eastC = new Cesium.Cartesian3(east.x, east.y, east.z)
    const northC = new Cesium.Cartesian3(north.x, north.y, north.z)
    const flatXYZ = (x: number, y: number) => { const [lo, la] = toLL(x, y); return Cesium.Cartesian3.fromDegrees(lo, la, h0) }
    // Konvergence poledníků: osa +X výkresu v S-JTSK NENÍ východ (Křovák je šikmá kuželová
    // projekce), takže bez téhle korekce by byly všechny texty stočené o několik stupňů.
    const dv = Cesium.Cartesian3.subtract(flatXYZ(cx + 1, cy), flatXYZ(cx, cy), new Cesium.Cartesian3())
    const conv = Math.atan2(Cesium.Cartesian3.dot(dv, northC), Cesium.Cartesian3.dot(dv, eastC))
    // jádro kresby (2.–98. percentil) v lon/lat — pro přelet i pro výšky terénu pod výkresem
    const cLL = [toLL(parse.coreMinX, parse.coreMinY), toLL(parse.coreMaxX, parse.coreMaxY)]
    const cw = Math.min(cLL[0][0], cLL[1][0]), ce = Math.max(cLL[0][0], cLL[1][0])
    const cs = Math.min(cLL[0][1], cLL[1][1]), cn = Math.max(cLL[0][1], cLL[1][1])
    const geo: DrawGeo = { toLL, h0, up, east: eastC, north: northC, conv, core: [cw, cs, ce, cn] }

    // uložený stav výkresu dostane každá hladina hned při stavbě (viz `buildLayers`)
    const cfg = restore?.config
    const drape = !!cfg?.drape
    const built = await buildLayers(v, parse.prims, geo, {
      drape, alpha: alpha0, hidden: new Set(cfg?.hiddenLayers ?? []), offset: cfg?.heightOffset ?? 0,
    })
    if (!built) return null
    const { layers, textMats, pointRefs, polyRefs } = built
    const [wlon, elon, slat, nlat] = built.ext

    const id = `${Date.now()}`
    const pad = 0.0004
    /**
     * Přelet míří na JÁDRO kresby, ne na celou obálku.
     *
     * Obálka jde přes všechno včetně úletů, takže by kamera u výkresu se zatoulanými prvky
     * vylétla stovky kilometrů vysoko a nebylo by vidět nic. Jádro (2.–98. percentil) drží
     * skutečnou velikost kresby — dlouhá trasa zůstane dlouhá — jen ignoruje ty výstřelky.
     * Průnik s obálkou je tu pro jistotu: kdyby percentily kvůli divné kresbě vyšly mimo,
     * vrátí se to k původnímu chování místo prázdného obdélníku.
     */
    const bw = Math.max(wlon, cw), be = Math.min(elon, ce), bs = Math.max(slat, cs), bn = Math.min(nlat, cn)
    const ok = be > bw && bn > bs
    const [fw, fe, fs2, fn] = ok ? [bw, be, bs, bn] : [wlon, elon, slat, nlat]
    const bounds = (fe > fw && fn > fs2) ? Cesium.Rectangle.fromDegrees(fw - pad, fs2 - pad, fe + pad, fn + pad) : null
    const entry: DrawingEntry = { layers, bounds, up, textMats, pointRefs, polyRefs, prims: parse.prims, toSjtsk, assetId: restore?.assetId, geo, drape }
    drawingsRef.current.set(id, entry)

    // uložený stav do posuvníků a přepínače (prvky samotné ho mají už ze stavby)
    if (cfg) {
      const off = cfg.heightOffset ?? 0
      if (off) setDrawH(s => ({ ...s, [id]: off }))
      if (alpha0 !== 1) setDrawA(s => ({ ...s, [id]: alpha0 }))
      if (drape) setDrawDrape(s => ({ ...s, [id]: true }))
    }
    watchBuilt(v, id, entry, cfg?.heightOffset ?? 0, alpha0)

    upsertObj({ id: `drawing-${id}`, kind: 'drawing', name: `Výkres ${name}`, visible: true })
    const spanX = maxX - minX, spanY = maxY - minY
    console.log(
      `Výkres „${name}": ${parse.prims.length} prvků, jednotky ${parse.unitName}, `
      + `rozsah ${spanX.toFixed(1)} × ${spanY.toFixed(1)} m, střed ${cx.toFixed(1)}, ${cy.toFixed(1)}, umístění ${mode}`,
    )
    /**
     * Výkres bez souřadnic v S-JTSK je nejčastější příčina „naimportovalo se to rozbité":
     * skončí uprostřed pohledu v nesmyslné velikosti a vypadá to jako chyba programu.
     * Tohle o tom řekne rovnou, i s čísly, podle kterých se to pozná.
     */
    // hlavička tvrdila jiné jednotky, než ve kterých souřadnice sedí do S-JTSK (typicky
    // „milimetry" ze šablony u výkresu v metrech) — říct to, ať je vidět, proč to sedí
    if (parse.unitNote && !restore) toast.info(`Výkres „${name}": ${parse.unitNote}`, { duration: 10000 })
    if (mode.startsWith('lokální')) {
      toast.warning(
        `Výkres „${name}" nemá souřadnice v S-JTSK — střed je ${cx.toFixed(0)}, ${cy.toFixed(0)}. `
        + 'Položil jsem ho doprostřed pohledu; pokud má ležet na svém místě, ulož ho z CADu se souřadnicemi Křováku.',
        { duration: 12000 },
      )
    }
    if (spanX > 50000 || spanY > 50000) {
      /**
       * Obálka přes desítky kilometrů znamená jednu ze dvou věcí a obě stojí za řeč:
       * buď sedí špatně jednotky (celý výkres je o řád mimo), nebo — mnohem častěji —
       * jsou v souboru zatoulané prvky daleko od zbytku kresby. Umístění už kvůli nim
       * neselže (rozhoduje medián), ale v mapě je uvidíš jako čáry mizící za obzor.
       */
      toast.warning(
        `Výkres „${name}" má obálku ${(spanX / 1000).toFixed(0)} × ${(spanY / 1000).toFixed(0)} km, `
        + `ale kresba leží kolem ${cx.toFixed(0)}, ${cy.toFixed(0)} — v souboru jsou zatoulané prvky daleko od zbytku. `
        + `Umístění se podle nich neřídí; v mapě ale budou vidět. (Jednotky podle hlavičky: ${parse.unitName}.)`,
        { duration: 14000 },
      )
    }
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
      drape: d.drape,
    })
  }

  // ── posun výšky + průhlednost celého výkresu (živě, bez překreslení) ──
  function setLayerMatrix(ly: DrawLayer, m: Cesium.Matrix4) {
    // čáry přilepené na terén matici nemají — leží na terénu, posouvat je nejde
    if (ly.prim instanceof Cesium.Primitive) ly.prim.modelMatrix = m
    for (const lp of ly.labels) lp.modelMatrix = m
    if (ly.points) ly.points.modelMatrix = m
  }
  function applyDrawH(e: DrawingEntry, off: number) {
    if (e.drape) return // přilepený výkres leží na terénu, výškový posun se nepoužívá
    const m = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(e.up, off, new Cesium.Cartesian3()))
    for (const ly of e.layers) setLayerMatrix(ly, m)
  }
  function applyDrawAlpha(e: DrawingEntry, a: number) {
    for (const mt of e.textMats) mt.uniforms.opacity = a
    for (const r of e.pointRefs) r.p.color = r.c.withAlpha(a)
    for (const r of e.polyRefs) {
      // Atributy vzniknou až v prvním `update()` primitiva. Na nehotovém (třeba na vypnuté
      // hladině, která se nikdy nekreslila) by `getGeometryInstanceAttributes` vyhodilo
      // DeveloperError a shodilo celý slider — proto se takové jen přeskočí.
      if (!r.prim.ready) continue
      const at = r.prim.getGeometryInstanceAttributes(r.id)
      if (at) at.color = Cesium.ColorGeometryInstanceAttribute.toValue(r.c.withAlpha(a), at.color)
    }
    viewerRef.current?.scene.requestRender()
  }
  function setDrawingHeight(did: string, off: number) { const e = drawingsRef.current.get(did); if (e) { applyDrawH(e, off); setDrawH(s => ({ ...s, [did]: off })); saveDrawingCfg(did, { heightOffset: off }) } }
  function setDrawingAlpha(did: string, a: number) { const e = drawingsRef.current.get(did); if (e) { applyDrawAlpha(e, a); setDrawA(s => ({ ...s, [did]: a })); saveDrawingCfg(did, { alpha: a }) } }

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

  /** Hlavní vypínač výkresu z panelu Scéna — hladiny si nechají vlastní stav. */
  function setDrawingVisible(drawingId: string, vis: boolean) {
    const d = drawingsRef.current.get(drawingId)
    if (d) for (const ly of d.layers) setLayerShow(ly, vis && ly.visible)
  }

  return {
    drawA,
    drawDrape,
    drawH,
    drawingLoading,
    drawingOverlays,
    drawingsRef,
    dwgRef,
    loadDrawing,
    removeDrawing,
    renderDrawing,
    setDrawingAlpha,
    setDrawingDrape,
    setDrawingHeight,
    setDrawingVisible,
    setLayersVisibility,
    toggleLayer,
  }
}
