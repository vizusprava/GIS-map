/**
 * Výkresy DXF/DWG v mapě: vykreslení po hladinách, výška a průhlednost celého výkresu,
 * zapínání hladin a ukládání nastavení k souboru ve scéně.
 */
import { useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { geoidN } from './geoid'
import { wgsOf, sjtskOf } from './tiles'
import { fetchElevSampler } from './elevation'
import { nextFrame, viewCenterGround } from './sceneUtils'
import { buildTextPrims } from './dxfText'
import { parseDrawingFile } from './drawingClient'
import { krovakForm, toKrovakNeg, type DrawParse, type DrawPrim } from './dxf'
import type { DrawOverlay } from './export/drawOverlay'
import type { DrawLayer, DrawingEntry, SceneObj } from './types'
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

    // Jedna plochá výška blízko terénu (vzorek DMR ve středu výkresu). Výkres se ZÁMĚRNĚ nedrapuje
    // na terén — leží v jedné rovině a vykresluje se s vypnutým depth testem, aby byl vidět vždy,
    // i když je místy pod terénem.
    const [clon, clat] = toLL(cx, cy)
    let h0 = 300 + geoidN(clon, clat)
    try {
      const dd = 0.001
      const es = await fetchElevSampler('dmr5g', clon - dd, clat - dd, clon + dd, clat + dd, 4)
      const bpv = es(clon, clat)
      if (bpv != null) h0 = bpv + geoidN(clon, clat)
    } catch { /* nech výchozí */ }
    if (v.isDestroyed()) return null

    // svislý směr ve středu (pro posun výšky) + sběr odkazů na prvky (pro živou průhlednost)
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(Cesium.Cartesian3.fromDegrees(clon, clat, h0), new Cesium.Cartesian3())
    const textMats: DrawingEntry['textMats'] = []
    const pointRefs: DrawingEntry['pointRefs'] = []
    const polyRefs: DrawingEntry['polyRefs'] = []

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
    // Uložený stav dostane každá hladina hned při stavbě (vypnutá se ani neukáže, posunutá
    // neposkočí), protože výkres teď naskakuje po hladinách — viz `breathe`.
    const hidden0 = new Set(restore?.config?.hiddenLayers ?? [])
    const off0 = restore?.config?.heightOffset ?? 0
    const m0 = off0 ? Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(up, off0, new Cesium.Cartesian3())) : null
    /**
     * Stavba po kouscích: velký výkres má stovky hladin a desetitisíce čar a postavit je
     * najednou znamenalo vteřiny zamrzlé mapy (při otevření scény i celého počítače).
     * Po ~12 ms práce dostane mapa snímek — překreslí se a chytí myš — a staví se dál.
     * false = viewer mezitím zanikl (odchod ze scény), stavba končí.
     */
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
        const deg: number[] = []
        for (const [x, y] of p.pts) { const [lon, lat] = toLL(x, y); deg.push(lon, lat, h0); seen(lon, lat) }
        if (deg.length < 6) continue
        const col = dwgColor(p.color)
        const iid = `${lname}#${polyMeta.length}`
        instances.push(new Cesium.GeometryInstance({
          id: iid,
          geometry: new Cesium.PolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(deg), width: 2, arcType: Cesium.ArcType.NONE, vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col.withAlpha(alpha0)) },
        }))
        polyMeta.push({ id: iid, c: col })   // základní (neprůhledná) barva — z ní počítá slider
      }
      // depthTest vypnutý → čáry se kreslí přes vše, takže výkres je vidět i pod terénem.
      // Geometrie čar se staví ve workerech Cesia (asynchronous): u výkresu s desetitisíci
      // polyliniemi to na hlavním vlákně znamenalo několik sekund zamrzlé mapy. Texty zůstávají
      // synchronní — vlastní geometrie písmen se do workeru poslat nedá.
      const prim = instances.length
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
        for (const pt of pts) { const [lon, lat] = toLL(pt.pt[0], pt.pt[1]); seen(lon, lat); const pc = dwgColor(pt.color); const pp = points.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, h0), pixelSize: 5, color: pc.withAlpha(alpha0), disableDepthTestDistance: Number.POSITIVE_INFINITY }); pointRefs.push({ p: pp, c: pc }) }
        v.scene.primitives.add(points)
      }

      if (prim || labels.length || points) {
        const ly: DrawLayer = { name: lname || '0', color: lprims[0].color, visible: true, prim, labels, points }
        if (hidden0.has(ly.name)) { ly.visible = false; setLayerShow(ly, false) }
        if (m0) setLayerMatrix(ly, m0)
        layers.push(ly)
      }
    }
    // materiály textů se dají nastavit kdykoliv (nejsou to atributy primitiva), takže až tady
    if (alpha0 !== 1) for (const mt of textMats) mt.uniforms.opacity = alpha0
    layers.sort((a, b) => a.name.localeCompare(b.name, 'cs'))

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
    const cLL = [toLL(parse.coreMinX, parse.coreMinY), toLL(parse.coreMaxX, parse.coreMaxY)]
    const cw = Math.min(cLL[0][0], cLL[1][0]), ce = Math.max(cLL[0][0], cLL[1][0])
    const cs = Math.min(cLL[0][1], cLL[1][1]), cn = Math.max(cLL[0][1], cLL[1][1])
    const bw = Math.max(wlon, cw), be = Math.min(elon, ce), bs = Math.max(slat, cs), bn = Math.min(nlat, cn)
    const ok = be > bw && bn > bs
    const [fw, fe, fs2, fn] = ok ? [bw, be, bs, bn] : [wlon, elon, slat, nlat]
    const bounds = (fe > fw && fn > fs2) ? Cesium.Rectangle.fromDegrees(fw - pad, fs2 - pad, fe + pad, fn + pad) : null
    const entry: DrawingEntry = { layers, bounds, up, textMats, pointRefs, polyRefs, prims: parse.prims, toSjtsk, assetId: restore?.assetId }
    drawingsRef.current.set(id, entry)

    // uložený stav výkresu: vypnuté hladiny, výška nad terénem a průhlednost
    const cfg = restore?.config
    if (cfg) {
      const hidden = new Set(cfg.hiddenLayers ?? [])
      for (const ly of layers) if (hidden.has(ly.name)) { ly.visible = false; setLayerShow(ly, false) }
      const off = cfg.heightOffset ?? 0
      if (off) { applyDrawH(entry, off); setDrawH(s => ({ ...s, [id]: off })) }
      // barvy už mají `alpha0` zapečenou ze stavby primitiv — tady zbývá jen srovnat slider
      if (alpha0 !== 1) setDrawA(s => ({ ...s, [id]: alpha0 }))
    }

    /**
     * Srovnání po dostavění čar. Dokud se geometrie staví ve workeru, atributy barev neexistují
     * (`applyDrawAlpha` je přeskočí) a Cesium na konci stavby přepíše `modelMatrix` hodnotou
     * z jejího začátku. Kdo stihl mezitím pohnout průhledností nebo výškou, měl by v mapě
     * něco jiného, než ukazuje posuvník — tak se aktuální stav po dokončení použije znovu.
     */
    const building = layers.flatMap(l => l.prim ? [l.prim] : [])
    if (building.length) {
      const scene = v.scene
      const off = scene.postRender.addEventListener(() => {
        if (drawingsRef.current.get(id) !== entry) { off(); return } // výkres mezitím odebraný
        if (!building.every(p => p.ready)) return
        off()
        // záloha na uložené hodnoty pro případ, že React ještě nepropsal stav do refů
        applyDrawH(entry, drawHRef.current[id] ?? cfg?.heightOffset ?? 0)
        const a = drawARef.current[id] ?? alpha0
        if (a !== alpha0) applyDrawAlpha(entry, a)
        scene.requestRender()
      })
    }

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
    })
  }

  // ── posun výšky + průhlednost celého výkresu (živě, bez překreslení) ──
  function setLayerMatrix(ly: DrawLayer, m: Cesium.Matrix4) {
    if (ly.prim) ly.prim.modelMatrix = m
    for (const lp of ly.labels) lp.modelMatrix = m
    if (ly.points) ly.points.modelMatrix = m
  }
  function applyDrawH(e: DrawingEntry, off: number) {
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
    drawH,
    drawingLoading,
    drawingOverlays,
    drawingsRef,
    dwgRef,
    loadDrawing,
    removeDrawing,
    renderDrawing,
    setDrawingAlpha,
    setDrawingHeight,
    setDrawingVisible,
    setLayersVisibility,
    toggleLayer,
  }
}
