/**
 * Řez modelem v mapě — všechen jeho stav, efekty a obsluha na jednom místě.
 *
 * `MapView` je jinak jedna komponenta pro dvacet nezávislých funkcí; řez z nich byl největší
 * (osmadvacet stavů) a nejčastěji se do něj sahá. Tady má vlastního vlastníka: nikdo jiný mu
 * nevidí do stavu a on nevidí do cizího, takže se nemůže opakovat chyba, kdy výběr modelu
 * v mapě rozbil řez přes sdílené pole závislostí.
 *
 * Vlastní geometrie tu není — ta žije v `viewer-core/` (`sectionCut`, `sectionView`,
 * `meshEdges`, `triBvh`) a je pokrytá testy. Tohle je jen most mezi ní a Cesiem.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import * as THREE from 'three'
import { toast } from 'sonner'
import { askText } from './dialog'
import { pickGround } from './sceneUtils'
import { getGltfLoader } from './model3d'
import { MODEL_GLOW } from './config'
import type { ModelEntry } from './types'
import type { SavedSection } from './lib/types'
import type { ScenePersist } from './lib/scenePersist'
import type { SectionResult } from './viewer-core/sectionCut'
import { sliceSlab, polysFromSegments, fmtLen } from './viewer-core/sectionCut'
import type { SectionView, SectionViewRect } from './viewer-core/sectionView'
import { renderSectionView, projectSlabEdges } from './viewer-core/sectionView'

export type SectionTool = ReturnType<typeof useSectionTool>

export function useSectionTool(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  modelsRef: React.RefObject<Map<string, ModelEntry>>
  selectedId: string | null
  selectedIdRef: React.RefObject<string | null>
  setSelectedId: (id: string | null) => void
  viewerReady: boolean
  /**
   * Vypnutý řez (config `ENABLE_MODEL_SECTION`): hook se volá dál (pravidla hooků), ale nic
   * nenaslouchá ani neukládá. Ostatní efekty čekají na zapnutý řez nebo zadávání, které bez
   * panelu nejde spustit.
   */
  enabled: boolean
  sceneRef: React.RefObject<ScenePersist>
  initialSections: SavedSection[]
}) {
  const { viewerRef, modelsRef, selectedId, selectedIdRef, setSelectedId, viewerReady, enabled, sceneRef } = deps

  // ── řez modelem přímo v mapě ──
  const [secOn, setSecOn] = useState(false)
  /** čím se řez zadává: `line` = dva kliky, `edge` = přichycení na hranu modelu, `drag` = tažení hotové čáry */
  const [secPick, setSecPick] = useState<'line' | 'edge' | 'drag' | null>(null)
  /**
   * Hloubka výřezu: o kolik metrů za rovinou řezu leží jeho druhá mez. 0 = bez druhé meze
   * (prostý řez jednou rovinou). Znaménko určuje, na kterou stranu se výřez rozprostírá.
   */
  const [secDepth, setSecDepth] = useState(0)
  const [secEdgeBusy, setSecEdgeBusy] = useState(false)
  const secSnapRef = useRef<{ world: Cesium.Cartesian3; a: Cesium.Cartesian3; b: Cesium.Cartesian3 } | null>(null)
  const [secLine, setSecLine] = useState<{ a: Cesium.Cartesian3; b: Cesium.Cartesian3 } | null>(null)
  const [secFlip, setSecFlip] = useState(false)
  const [secOffset, setSecOffset] = useState(0)                                   // posun po normále, m
  const [secStep, setSecStep] = useState(0.5)
  const [secLen, setSecLen] = useState(0)                                         // 0 = přes celý model
  const [secHeight, setSecHeight] = useState(0)
  const [secThick, setSecThick] = useState(0)                                     // tloušťka řezu, m
  /**
   * Ořezávat model i v mapě? 2D výkres se počítá v three z geometrie modelu, takže na Cesium
   * vůbec nezávisí — když ořez v mapě zlobí, tímhle se vypne a výkres funguje dál.
   */
  const [secClipMap, setSecClipMap] = useState(true)
  /** zbytek modelu mimo výřez nechat v mapě průsvitný, ať se neztratí kontext */
  const [secGhost, setSecGhost] = useState(true)
  /** hotové výkresy (hlavní, případně i kolmý) a které z nich jsou právě otevřené */
  const [secDrawings, setSecDrawings] = useState<{
    key: string
    label: string
    result: SectionResult
    bg: SectionView | null
    /** nadmořská výška počátku výkresu; `null`, když se nedá určit */
    originZ: number | null
  }[]>([])
  const [secShown, setSecShown] = useState<Set<string>>(new Set())
  const [secBoth, setSecBoth] = useState(false)
  /** k tomu ještě půdorys — řez vodorovnou rovinou a pohled shora dolů */
  const [secPlan, setSecPlan] = useState(false)
  /** výška vodorovné roviny nad středem čáry řezu (m) */
  const [secPlanZ, setSecPlanZ] = useState(0)
  /** k rastrovému pohledu i vektorové obrysy — dají se kótovat a jdou do DXF */
  const [secViewLines, setSecViewLines] = useState(true)
  /** rozdělit obrysy pohledu na viditelné a zakryté podle hloubky */
  const [secOcclusion, setSecOcclusion] = useState(true)
  /** od jakého úhlu se hrana bere jako zlomová — čím víc, tím míň čar ve výkrese */
  const [secEdgeAngle, setSecEdgeAngle] = useState(35)
  const [secBusy, setSecBusy] = useState(false)
  /** překreslovat otevřené výkresy hned, jak se řez pohne */
  const [secLive, setSecLive] = useState(true)
  /** pojmenované řezy; ukládají se se scénou, takže přežijí zavření i reload */
  const [secSaved, setSecSaved] = useState<SavedSection[]>(() => deps.initialSections)
  const [secActive, setSecActive] = useState<string | null>(null)
  /** roste jen při ručním „2D výkres řezu" — okna podle něj poznají nový výkres od překreslení */
  const [secEpoch, setSecEpoch] = useState(0)
  /** právě se táhne čára v mapě → živý přepočet jede v rychlém režimu */
  const [secDragging, setSecDragging] = useState(false)
  /** kopanec pro znovunaplánování živého přepočtu, když doběhl ten předchozí */
  const [secKick, setSecKick] = useState(0)
  const secRunRef = useRef(false)
  const secDirtyRef = useRef(false)
  const secHasWinRef = useRef(false)
  const secLastRunRef = useRef(0)
  /** další přepočet má okna znovu vystředit — nový řez, ne jen posun toho starého */
  const secRefitRef = useRef(false)
  const secLineRef = useRef<{ a: Cesium.Cartesian3; b: Cesium.Cartesian3 } | null>(null)
  const secPendRef = useRef<Cesium.Cartesian3 | null>(null)
  const secEntsRef = useRef<Cesium.Entity[]>([])
  /** Geometrie modelu načtená do three (jen pro počítání řezu) — drží se, ať se nenačítá pořád dokola. */
  const secGeomRef = useRef<Map<string, THREE.Object3D>>(new Map())
  // ── Řez modelem v mapě ─────────────────────────────────────────────────────────
  /**
   * Cesium natáčí glTF do vlastní soustavy (Y-nahoru → Z-nahoru, dopředu X). Ořezové roviny
   * ale bere v soustavě `modelMatrix` BEZ té korekce, takže geometrie načtená v three musí
   * projít stejným otočením — jinak by řez v mapě neseděl na to, co je vidět.
   */
  const SEC_AXIS = useMemo(() => {
    // konstanty existují za běhu, ale v .d.ts Cesia nejsou (Axis je tam jen enum X/Y/Z)
    const axis = Cesium.Axis as unknown as { Y_UP_TO_Z_UP: Cesium.Matrix4; Z_UP_TO_X_UP: Cesium.Matrix4 }
    return Cesium.Matrix4.multiplyTransformation(axis.Y_UP_TO_Z_UP, axis.Z_UP_TO_X_UP, new Cesium.Matrix4())
  }, [])

  /**
   * Řezová rovina v lokální soustavě modelu (X=východ, Y=sever, Z=nahoru, otočeno usazením).
   * Počítá se z čáry naklikané v mapě: rovina je svislá a prochází oběma body.
   */
  function sectionFrame(e: ModelEntry) {
    if (!secLine) return null
    const inv = Cesium.Matrix4.inverse(e.model.modelMatrix, new Cesium.Matrix4())
    const a = Cesium.Matrix4.multiplyByPoint(inv, secLine.a, new Cesium.Cartesian3())
    const b = Cesium.Matrix4.multiplyByPoint(inv, secLine.b, new Cesium.Cartesian3())
    return frameFromLocal(a, b)
  }

  /** Čára řezu otočená o 90° kolem svislé osy jejím středem — kolmý řez ve stejném místě. */
  function rotate90Local(a: Cesium.Cartesian3, b: Cesium.Cartesian3) {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const mz = (a.z + b.z) / 2
    const hx = -(b.y - a.y) / 2
    const hy = (b.x - a.x) / 2
    return [
      new Cesium.Cartesian3(mx - hx, my - hy, mz),
      new Cesium.Cartesian3(mx + hx, my + hy, mz),
    ] as const
  }

  /** Rovina řezu z čáry zadané v lokální soustavě modelu. */
  function frameFromLocal(a: Cesium.Cartesian3, b: Cesium.Cartesian3) {
    const dir = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3())
    dir.z = 0                                        // čára řezu je vodorovná, rovina svislá
    if (Cesium.Cartesian3.magnitude(dir) < 1e-6) return null
    Cesium.Cartesian3.normalize(dir, dir)
    const up = new Cesium.Cartesian3(0, 0, 1)
    const n = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(up, dir, new Cesium.Cartesian3()), new Cesium.Cartesian3())
    if (secFlip) Cesium.Cartesian3.negate(n, n)
    const mid = Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3())
    const point = Cesium.Cartesian3.add(mid, Cesium.Cartesian3.multiplyByScalar(n, secOffset, new Cesium.Cartesian3()), new Cesium.Cartesian3())
    return { a, b, dir, up, n, mid, point, lineLen: Cesium.Cartesian3.distance(a, b) }
  }

  /** Popis čáry řezu do panelu — panel nemá vědět, kde se berou modely. */
  function sectionSummary(): string {
    const e = selectedId ? modelsRef.current.get(selectedId) : null
    const f = e ? sectionFrame(e) : null
    if (!f) return 'Čára řezu zatím není.'
    const az = ((Math.atan2(f.n.x, f.n.y) * 180) / Math.PI + 360) % 360
    return `Čára ${f.lineLen.toFixed(1)} m, rovina má azimut ${az.toFixed(0)}°.`
  }

  /**
   * Otočí čáru řezu o 90° kolem svislé osy jejím středem — tedy z příčného řezu udělá
   * podélný a naopak, ve stejném místě. Délka zůstává, tu si případně nastavíš zvlášť.
   */
  function rotateSection90() {
    const sel = selectedId ? modelsRef.current.get(selectedId) : null
    if (!sel || !secLine) return
    const inv = Cesium.Matrix4.inverse(sel.model.modelMatrix, new Cesium.Matrix4())
    const a = Cesium.Matrix4.multiplyByPoint(inv, secLine.a, new Cesium.Cartesian3())
    const b = Cesium.Matrix4.multiplyByPoint(inv, secLine.b, new Cesium.Cartesian3())
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const mz = (a.z + b.z) / 2
    // otočení o 90° kolem svislé osy je v půdorysu prosté (x, y) → (−y, x)
    const hx = -(b.y - a.y) / 2
    const hy = (b.x - a.x) / 2
    const toWorld = (x: number, y: number) =>
      Cesium.Matrix4.multiplyByPoint(sel.model.modelMatrix, new Cesium.Cartesian3(x, y, mz), new Cesium.Cartesian3())
    setSecLine({ a: toWorld(mx - hx, my - hy), b: toWorld(mx + hx, my + hy) })
    setSecOffset(0)
    toast.info('Řez otočen o 90° — z příčného podélný a naopak')
  }

  /**
   * Ořezové roviny modelů. Kolekce vznikne pro každý model JEDNOU a pak se jí už jen mění
   * hodnoty rovin — nikdy se nevyměňuje za novou.
   *
   * Vyměnit ji nejde: Cesium si do uniformů shaderu uloží closure nad konkrétní kolekcí
   * (`model_clippingPlanes` vrací `clippingPlanes.texture`). Přiřazení nové kolekce tu starou
   * zničí, ale už vydané kreslicí příkazy na ni pořád ukazují — a další snímek spadne na
   * „Cannot read properties of undefined (reading '_target')" a Cesium přestane vykreslovat.
   *
   * Rovin je proto vždycky pět a vypnuté meze se jen odsunou daleko za model. Měnit jejich
   * POČET by znamenalo přestavbu shaderu, což je zbytečné riziko navíc.
   */
  const secClipRef = useRef<Map<string, Cesium.ClippingPlaneCollection>>(new Map())

  /**
   * Ořez modelu v mapě: ZOBRAZÍ SE JEN VÝŘEZ, všechno ostatní zmizí.
   *
   * Šest rovin normálami dovnitř a `unionClippingRegions` — Cesium zahodí fragment, který je
   * za kteroukoliv z nich, takže zbyde přesně kvádr: mezi rovinou řezu a její kopií posunutou
   * o „hloubku výřezu", omezený délkou a výškou. Bez hloubky (0) je druhá mez daleko za
   * modelem, takže se jako dřív jen odřízne jedna strana.
   */
  useEffect(() => {
    const v = viewerRef.current
    // vypnutý řez nedává modelu ani vypnuté roviny (jinak by se při výběru modelu přeložil shader)
    if (!v || v.isDestroyed() || !enabled) return
    const sel = selectedId ? modelsRef.current.get(selectedId) : null
    for (const [id, coll] of secClipRef.current) if (!sel || id !== sel.id) coll.enabled = false
    if (!sel) { v.scene.requestRender(); return }

    let coll = secClipRef.current.get(sel.id)
    if (!coll) {
      const FAR_INIT = 1e5
      coll = new Cesium.ClippingPlaneCollection({
        planes: Array.from({ length: 6 }, () => new Cesium.ClippingPlane(Cesium.Cartesian3.UNIT_Z, FAR_INIT)),
        unionClippingRegions: true, edgeColor: MODEL_GLOW, edgeWidth: 1,
      })
      coll.enabled = false
      sel.model.clippingPlanes = coll
      secClipRef.current.set(sel.id, coll)
    }

    const f = secOn && secClipMap ? sectionFrame(sel) : null
    if (!f) { coll.enabled = false; v.scene.requestRender(); return }

    const FAR = 1e5                                    // „bez omezení" = mez daleko za modelem
    const put = (i: number, normal: Cesium.Cartesian3, at: Cesium.Cartesian3) => {
      const p = coll.get(i)
      p.normal = normal                                // přes settery, ať se textura přepočítá
      p.distance = -Cesium.Cartesian3.dot(normal, at)
    }
    const shift = (base: Cesium.Cartesian3, axis: Cesium.Cartesian3, d: number) =>
      Cesium.Cartesian3.add(base, Cesium.Cartesian3.multiplyByScalar(axis, d, new Cesium.Cartesian3()), new Cesium.Cartesian3())
    const negN = Cesium.Cartesian3.negate(f.n, new Cesium.Cartesian3())
    const negDir = Cesium.Cartesian3.negate(f.dir, new Cesium.Cartesian3())
    const negUp = Cesium.Cartesian3.negate(f.up, new Cesium.Cartesian3())
    const hu = secLen > 0 ? secLen / 2 : FAR
    const hv = secHeight > 0 ? secHeight / 2 : FAR
    // hloubka 0 = bez druhé meze, tedy prostý řez jednou rovinou jako dřív
    const d0 = secDepth !== 0 ? Math.min(0, secDepth) : 0
    const d1 = secDepth !== 0 ? Math.max(0, secDepth) : FAR

    // normály dovnitř výřezu: co je za kteroukoliv rovinou, Cesium zahodí
    put(0, f.n, shift(f.point, f.n, d0))               // rovina řezu
    put(1, negN, shift(f.point, f.n, d1))              // její posunutá kopie
    put(2, negDir, shift(f.mid, f.dir, hu))            // meze délky
    put(3, f.dir, shift(f.mid, negDir, hu))
    put(4, negUp, shift(f.mid, f.up, hv))              // meze výšky
    put(5, f.up, shift(f.mid, negUp, hv))
    coll.enabled = true
    // Textura rovin vzniká až v `update()`. Model si o ni v uniformu říká BEZ pojistky, takže
    // kdyby ji shader chtěl dřív, vykreslování spadne — vyrobíme ji rovnou tady.
    try {
      // `frameState` ani parametr `update()` nejsou v .d.ts Cesia, za běhu ale existují
      const fs = (v.scene as unknown as { frameState?: { context?: unknown } }).frameState
      if (fs?.context) (coll as unknown as { update: (f: unknown) => void }).update(fs)
    } catch (err) {
      console.warn('Přípravu textury ořezu se nepodařilo vynutit:', err)
    }
    v.scene.requestRender()
  }, [selectedId, secOn, secClipMap, secLine, secFlip, secOffset, secLen, secHeight, secDepth, viewerReady, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * „Duch" modelu — průsvitná kopie bez ořezu.
   *
   * Výřez v mapě zahodí všechno mimo kvádr, takže po zapnutí hloubky zmizí zbytek stavby
   * a člověk ztratí kontext, kde ten výřez vlastně je. Tohle pod něj podloží tentýž model
   * ještě jednou, průsvitně a bez ořezu.
   *
   * Je to druhá primitiva, protože ořez a průsvitnost jsou vlastnosti CELÉ primitivy —
   * jedna nemůže být zároveň oříznutá i neoříznutá. Cesium ale glTF cachuje podle URL,
   * takže se soubor nestahuje ani neparsuje znovu; přibude jen vykreslení.
   */
  const secGhostRef = useRef<Map<string, Cesium.Model>>(new Map())

  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !viewerReady) return
    const sel = selectedId ? modelsRef.current.get(selectedId) : null
    const want = !!(sel && sel.visible && secOn && secClipMap && secGhost)

    for (const [id, g] of secGhostRef.current) if (!want || !sel || id !== sel.id) g.show = false
    if (!want || !sel) { v.scene.requestRender(); return }

    const had = secGhostRef.current.get(sel.id)
    if (had) {
      had.show = true
      had.modelMatrix = Cesium.Matrix4.clone(sel.model.modelMatrix, new Cesium.Matrix4())
      v.scene.requestRender()
      return
    }

    let alive = true
    void (async () => {
      try {
        const g = await Cesium.Model.fromGltfAsync({
          url: sel.url,
          modelMatrix: Cesium.Matrix4.clone(sel.model.modelMatrix, new Cesium.Matrix4()),
          // klikat se má na skutečný model, ne na ducha
          allowPicking: false,
        })
        if (!alive || v.isDestroyed()) return
        g.color = Cesium.Color.fromCssColorString('#8ab4ff').withAlpha(0.10)
        g.colorBlendMode = Cesium.ColorBlendMode.REPLACE
        g.silhouetteSize = 0
        v.scene.primitives.add(g)
        secGhostRef.current.set(sel.id, g)
        v.scene.requestRender()
      } catch (e) {
        console.error('Průsvitný model se nepodařilo vytvořit:', e)
      }
    })()
    return () => { alive = false }
  }, [selectedId, secOn, secClipMap, secGhost, viewerReady])

  // Duch musí sedět na modelu i při jeho posouvání — matice se sesynchronizuje před snímkem.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !viewerReady || !enabled) return
    const sync = () => {
      for (const [id, g] of secGhostRef.current) {
        if (!g.show) continue
        const e = modelsRef.current.get(id)
        if (e) g.modelMatrix = Cesium.Matrix4.clone(e.model.modelMatrix, g.modelMatrix)
      }
    }
    v.scene.preUpdate.addEventListener(sync)
    return () => { if (!v.isDestroyed()) v.scene.preUpdate.removeEventListener(sync) }
  }, [viewerReady, enabled])

  /** Čára řezu v mapě, ať je vidět, kudy rovina vede. */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    for (const ent of secEntsRef.current) v.entities.remove(ent)
    secEntsRef.current = []
    if (!secLine || !secOn) { v.scene.requestRender(); return }
    const mark = (p: Cesium.Cartesian3) => secEntsRef.current.push(v.entities.add({
      position: p,
      point: { pixelSize: secPick === 'drag' ? 16 : 10, color: MODEL_GLOW, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }))
    mark(secLine.a); mark(secLine.b)
    secEntsRef.current.push(v.entities.add({
      polyline: {
        positions: [secLine.a, secLine.b],
        width: secPick === 'drag' ? 6 : 3,
        arcType: Cesium.ArcType.NONE,
        material: MODEL_GLOW,
        depthFailMaterial: MODEL_GLOW,
      },
    }))
    v.scene.requestRender()
  }, [secLine, secOn, secPick, viewerReady])

  useEffect(() => { secLineRef.current = secLine }, [secLine])
  // živě se počítá, jen když je opravdu co překreslovat — zavřená okna nic počítat nemusí
  useEffect(() => { secHasWinRef.current = secDrawings.length > 0 && secShown.size > 0 }, [secDrawings, secShown])

  /**
   * Živý přepočet: jakmile se řez pohne, otevřené výkresy se překreslí samy.
   *
   * Mimo tažení se čeká, až se dění na chvíli zastaví. Při tažení to nestačí: plynulý pohyb
   * myší by odklad pořád obnovoval a výkres by se nehnul, dokud čáru nepustíš — proto se
   * během tažení překresluje i za pohybu, ale nejvýš jednou za `DRAG_MS` a jen nahrubo
   * (menší rastr, bez vektorových obrysů). Naostro se dopočítá, jakmile myš pustíš.
   */
  useEffect(() => {
    if (!secHasWinRef.current) return
    // nový řez z výkresu se přepočítá vždycky, i s vypnutým živým překreslováním
    if (!secLive && !secRefitRef.current) return
    if (secPick === 'line' || secPick === 'edge') return          // čára se právě teprve zadává
    const DRAG_MS = 400
    const wait = secDragging ? Math.max(0, DRAG_MS - (Date.now() - secLastRunRef.current)) : 320
    const t = setTimeout(() => { void runSectionLive(secDragging) }, wait)
    return () => clearTimeout(t)
  }, [secLive, secPick, secDragging, secKick, secShown, secLine, secFlip, secOffset, secLen, secHeight, secThick, secDepth, secBoth, secPlan, secPlanZ, secViewLines, secOcclusion, secEdgeAngle]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Tažení řezu přímo v mapě: za konec čáry se táhne ten konec, za čáru celý řez.
   * Se Shiftem se celá čára posouvá jen po své normále — tedy čistý posun řezu po trase.
   *
   * Poloha se bere z VODOROVNÉ roviny procházející čárou, ne z povrchu modelu. Kdyby se
   * odečítala z modelu, čára by při každém pohnutí skákala po výškách a řez by se pokaždé
   * usadil jinak; navíc by se přestala dát táhnout mimo model.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || secPick !== 'drag') return
    const scene = v.scene
    const canvas = scene.canvas
    const HANDLE_PX = 16
    const LINE_PX = 10

    const screen = (p: Cesium.Cartesian3) => Cesium.SceneTransforms.worldToWindowCoordinates(scene, p)
    const distTo = (m: Cesium.Cartesian2, p: Cesium.Cartesian3) => {
      const s = screen(p)
      return s ? Cesium.Cartesian2.distance(s, m) : Infinity
    }
    /** vzdálenost kurzoru od čáry v pixelech */
    const distToLine = (m: Cesium.Cartesian2, a: Cesium.Cartesian3, b: Cesium.Cartesian3) => {
      const sa = screen(a)
      const sb = screen(b)
      if (!sa || !sb) return Infinity
      const dx = sb.x - sa.x
      const dy = sb.y - sa.y
      const len2 = dx * dx + dy * dy
      if (len2 < 1e-6) return Cesium.Cartesian2.distance(sa, m)
      const t = Math.max(0, Math.min(1, ((m.x - sa.x) * dx + (m.y - sa.y) * dy) / len2))
      return Math.hypot(sa.x + t * dx - m.x, sa.y + t * dy - m.y)
    }
    const hitPlane = (pos: Cesium.Cartesian2, plane: Cesium.Plane) => {
      const ray = scene.camera.getPickRay(pos)
      return ray ? Cesium.IntersectionTests.rayPlane(ray, plane) ?? null : null
    }
    const grabWhat = (m: Cesium.Cartesian2) => {
      const line = secLineRef.current
      if (!line) return null
      const da = distTo(m, line.a)
      const db = distTo(m, line.b)
      if (da < HANDLE_PX && da <= db) return 'a' as const
      if (db < HANDLE_PX) return 'b' as const
      if (distToLine(m, line.a, line.b) < LINE_PX) return 'line' as const
      return null
    }

    let drag: {
      what: 'a' | 'b' | 'line'
      plane: Cesium.Plane
      from: Cesium.Cartesian3
      a0: Cesium.Cartesian3
      b0: Cesium.Cartesian3
      n: Cesium.Cartesian3
    } | null = null

    const onDown = (evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const line = secLineRef.current
      if (!line) return
      const what = grabWhat(evt.position)
      if (!what) return
      const mid = Cesium.Cartesian3.midpoint(line.a, line.b, new Cesium.Cartesian3())
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(mid, new Cesium.Cartesian3())
      const plane = Cesium.Plane.fromPointNormal(mid, up)
      const from = hitPlane(evt.position, plane)
      if (!from) return
      const dir = Cesium.Cartesian3.subtract(line.b, line.a, new Cesium.Cartesian3())
      const n = Cesium.Cartesian3.magnitude(dir) > 1e-6
        ? Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(up, Cesium.Cartesian3.normalize(dir, dir), new Cesium.Cartesian3()), new Cesium.Cartesian3())
        : up
      drag = { what, plane, from, a0: line.a.clone(), b0: line.b.clone(), n }
      scene.screenSpaceCameraController.enableInputs = false
      canvas.style.cursor = 'grabbing'
      setSecDragging(true)
    }

    const onMove = (m: Cesium.ScreenSpaceEventHandler.MotionEvent, shift: boolean) => {
      if (!drag) { canvas.style.cursor = grabWhat(m.endPosition) ? 'grab' : ''; return }
      const hit = hitPlane(m.endPosition, drag.plane)
      if (!hit) return
      let d = Cesium.Cartesian3.subtract(hit, drag.from, new Cesium.Cartesian3())
      // Shift u celé čáry = jen kolmý posun; podél sebe se řez posouvat nepotřebuje
      if (shift && drag.what === 'line') {
        d = Cesium.Cartesian3.multiplyByScalar(drag.n, Cesium.Cartesian3.dot(d, drag.n), new Cesium.Cartesian3())
      }
      const shifted = (p: Cesium.Cartesian3) => Cesium.Cartesian3.add(p, d, new Cesium.Cartesian3())
      const next = drag.what === 'line' ? { a: shifted(drag.a0), b: shifted(drag.b0) }
        : drag.what === 'a' ? { a: shifted(drag.a0), b: drag.b0 }
        : { a: drag.a0, b: shifted(drag.b0) }
      setSecLine(next)
      // Rozsah výkresu je „vše mezi body", takže tažením konce se mění i on.
      if (drag.what !== 'line') {
        const sel = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
        if (sel) {
          const inv = Cesium.Matrix4.inverse(sel.model.modelMatrix, new Cesium.Matrix4())
          const la = Cesium.Matrix4.multiplyByPoint(inv, next.a, new Cesium.Cartesian3())
          const lb = Cesium.Matrix4.multiplyByPoint(inv, next.b, new Cesium.Cartesian3())
          const span = Math.hypot(lb.x - la.x, lb.y - la.y)
          if (span > 0.02) setSecLen(Math.round(span * 100) / 100)
        }
      }
    }

    const onUp = () => {
      if (!drag) return
      drag = null
      scene.screenSpaceCameraController.enableInputs = true
      canvas.style.cursor = 'grab'
      setSecDragging(false)
    }

    const handler = new Cesium.ScreenSpaceEventHandler(canvas)
    // Cesium posílá události zvlášť pro každý modifikátor, takže se to registruje dvakrát —
    // jinak by tažení uprostřed zamrzlo, jakmile bys zmáčkl Shift.
    const mods = [undefined, Cesium.KeyboardEventModifier.SHIFT] as const
    for (const mod of mods) {
      const shift = mod !== undefined
      handler.setInputAction(onDown, Cesium.ScreenSpaceEventType.LEFT_DOWN, mod)
      handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.MotionEvent) => onMove(m, shift), Cesium.ScreenSpaceEventType.MOUSE_MOVE, mod)
      handler.setInputAction(onUp, Cesium.ScreenSpaceEventType.LEFT_UP, mod)
    }
    return () => {
      handler.destroy()
      scene.screenSpaceCameraController.enableInputs = true
      canvas.style.cursor = ''
      setSecDragging(false)
    }
  }, [secPick, viewerReady])

  /**
   * Naklikání čáry řezu dvěma body. Body určují ČÁRU: rovina jimi vede svisle a rozsah
   * výkresu se nastaví přesně na jejich vzdálenost, takže výkres je „vše mezi body".
   *
   * Co je do stran od roviny, řídí „Přibrat objekty z okolí" a „Tloušťka řezu" — tedy
   * číslo, které si nastavíš, ne druhá dvojice kliků.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || secPick !== 'line') return
    secPendRef.current = null
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) { toast.error('Miř na model nebo na terén'); return }
      const p = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      if (!secPendRef.current) { secPendRef.current = p; toast.info('Teď druhý bod čáry řezu'); return }
      if (Cesium.Cartesian3.distance(secPendRef.current, p) < 0.01) return
      const a = secPendRef.current
      secPendRef.current = null

      const sel = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
      if (!sel) { toast.error('Nejdřív vyber model'); setSecPick(null); return }
      // Délka se měří VODOROVNĚ v soustavě modelu: osa výkresu leží v jeho vodorovné
      // rovině, takže rozdíl výšek obou kliků do ní nepatří.
      const inv = Cesium.Matrix4.inverse(sel.model.modelMatrix, new Cesium.Matrix4())
      const la = Cesium.Matrix4.multiplyByPoint(inv, a, new Cesium.Cartesian3())
      const lb = Cesium.Matrix4.multiplyByPoint(inv, p, new Cesium.Cartesian3())
      const span = Math.hypot(lb.x - la.x, lb.y - la.y)
      if (span < 0.02) { toast.error('Body leží nad sebou — potřebuju vodorovný odstup'); return }

      setSecLine({ a, b: p })
      setSecLen(Math.round(span * 100) / 100)
      setSecOffset(0)
      setSecOn(true)
      setSecPick(null)
      toast.success(`Řez ${fmtLen(span)} — hloubku výřezu nastav posuvníkem`)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [secPick, viewerReady])

  /**
   * Hrany modelu pro přichycení řezu, v lokální soustavě modelu.
   *
   * Bereme jen ZLOMOVÉ hrany (`EdgesGeometry`), ne každou hranu trojúhelníku — na ty se chce
   * projektant chytat: obrubník, hrana vozovky, roh konstrukce. Kvůli rychlosti k nim vede
   * mřížka v půdorysu: bez ní by se při každém pohybu myší procházely statisíce úseček.
   */
  const secEdgeRef = useRef<Map<string, { segs: Float64Array; grid: Map<string, number[]>; cell: number }>>(new Map())

  async function sectionEdges(e: ModelEntry) {
    const hit = secEdgeRef.current.get(e.id)
    if (hit) return hit
    const root = await sectionGeometry(e)
    const pts: number[] = []
    const v3 = new THREE.Vector3()
    root.updateMatrixWorld(true)
    root.traverse(o => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      let eg: THREE.EdgesGeometry
      try { eg = new THREE.EdgesGeometry(mesh.geometry, 25) } catch { return }
      const pos = eg.getAttribute('position') as THREE.BufferAttribute | undefined
      if (pos) {
        for (let i = 0; i < pos.count; i++) {
          v3.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
          pts.push(v3.x, v3.y, v3.z)
        }
      }
      eg.dispose()
    })

    const segs = new Float64Array(pts)
    const box = new THREE.Box3().setFromObject(root)
    const diag = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length() || 100
    const cell = Math.max(1, diag / 250)
    const grid = new Map<string, number[]>()
    let inserted = 0
    // úsečku zapíšeme do všech buněk, kterými prochází — jinak by se dlouhý obrubník
    // našel jen u konců a uprostřed by se kurzor neměl čeho chytit
    for (let i = 0; i + 5 < segs.length; i += 6) {
      const dx = segs[i + 3] - segs[i]
      const dy = segs[i + 4] - segs[i + 1]
      const steps = Math.min(400, Math.max(1, Math.ceil(Math.hypot(dx, dy) / cell)))
      let last = ''
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        const key = Math.floor((segs[i] + dx * t) / cell) + ',' + Math.floor((segs[i + 1] + dy * t) / cell)
        if (key === last) continue
        last = key
        const bucket = grid.get(key)
        if (bucket) bucket.push(i)
        else grid.set(key, [i])
        if (++inserted > 3_000_000) break
      }
      if (inserted > 3_000_000) break
    }

    const idx = { segs, grid, cell }
    secEdgeRef.current.set(e.id, idx)
    return idx
  }

  /** Nejbližší hrana k bodu (lokální souřadnice) — vrací přichycený bod a směr hrany. */
  function snapToEdge(idx: { segs: Float64Array; grid: Map<string, number[]>; cell: number }, p: THREE.Vector3, tol: number) {
    const { segs, grid, cell } = idx
    const cx = Math.floor(p.x / cell)
    const cy = Math.floor(p.y / cell)
    const reach = Math.max(1, Math.ceil(tol / cell))
    let bestD = tol
    let best: { point: THREE.Vector3; dir: THREE.Vector3 } | null = null
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const ab = new THREE.Vector3()
    const ap = new THREE.Vector3()
    const seen = new Set<number>()
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      for (let gy = cy - reach; gy <= cy + reach; gy++) {
        const bucket = grid.get(gx + ',' + gy)
        if (!bucket) continue
        for (const i of bucket) {
          if (seen.has(i)) continue
          seen.add(i)
          a.set(segs[i], segs[i + 1], segs[i + 2])
          b.set(segs[i + 3], segs[i + 4], segs[i + 5])
          ab.subVectors(b, a)
          const len2 = ab.lengthSq()
          if (len2 < 1e-12) continue
          const t = Math.max(0, Math.min(1, ap.subVectors(p, a).dot(ab) / len2))
          const px = a.x + ab.x * t, py = a.y + ab.y * t, pz = a.z + ab.z * t
          const d = Math.hypot(px - p.x, py - p.y, pz - p.z)
          if (d < bestD) {
            bestD = d
            best = { point: new THREE.Vector3(px, py, pz), dir: ab.clone().normalize() }
          }
        }
      }
    }
    return best
  }

  /**
   * Přichycení řezu na hranu modelu.
   *
   * Kurzor se chytá na nejbližší zlomovou hranu a řez se založí KOLMO na ni — přesněji, než
   * když se dva body trefují od ruky. Náhled se kreslí přímo Cesiem přes `CallbackProperty`:
   * kdyby ho držel React, překresloval by se celý panel při každém pohybu myši.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || secPick !== 'edge') return
    const sel = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (!sel) { toast.error('Nejdřív vyber model'); setSecPick(null); return }

    let alive = true
    let idx: Awaited<ReturnType<typeof sectionEdges>> | null = null
    secSnapRef.current = null
    setSecEdgeBusy(true)
    sectionEdges(sel)
      .then(i => { if (alive) { idx = i; setSecEdgeBusy(false) } })
      .catch(err => {
        console.error('Hrany modelu se nepodařilo připravit:', err)
        if (alive) { setSecEdgeBusy(false); toast.error('Hrany modelu se nepodařilo připravit'); setSecPick(null) }
      })

    // náhled: přichycený bod + navržená čára řezu kolmo na hranu
    const ents = [
      v.entities.add({
        position: new Cesium.CallbackPositionProperty(() => secSnapRef.current?.world, false),
        point: { pixelSize: 11, color: MODEL_GLOW, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }),
      v.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            const s = secSnapRef.current
            return s ? [s.a, s.b] : []
          }, false),
          width: 3,
          arcType: Cesium.ArcType.NONE,
          material: MODEL_GLOW,
          depthFailMaterial: MODEL_GLOW,
        },
      }),
    ]

    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    let lastMove = 0

    /** Z přichycené hrany udělá čáru řezu: kolmice na hranu, dané šířky, vystředěná na bod. */
    const lineFromEdge = (localPoint: THREE.Vector3, localDir: THREE.Vector3) => {
      const dx = localDir.x, dy = localDir.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) return null                       // svislá hrana nemá vodorovný směr
      const half = (secLen > 0 ? secLen : 20) / 2
      const wx = (-dy / len) * half, wy = (dx / len) * half
      const m = sel.model.modelMatrix
      const toWorld = (x: number, y: number) =>
        Cesium.Matrix4.multiplyByPoint(m, new Cesium.Cartesian3(x, y, localPoint.z), new Cesium.Cartesian3())
      return {
        world: toWorld(localPoint.x, localPoint.y),
        a: toWorld(localPoint.x - wx, localPoint.y - wy),
        b: toWorld(localPoint.x + wx, localPoint.y + wy),
      }
    }

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!idx) return
      const now = performance.now()
      if (now - lastMove < 40) return                   // pickPosition je čtení z GPU, nemá cenu ho pálit každý pixel
      lastMove = now
      const g = pickGround(v, e.endPosition)
      if (!g) { secSnapRef.current = null; v.scene.requestRender(); return }
      const world = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      const inv = Cesium.Matrix4.inverse(sel.model.modelMatrix, new Cesium.Matrix4())
      const lp = Cesium.Matrix4.multiplyByPoint(inv, world, new Cesium.Cartesian3())
      const hit = snapToEdge(idx, new THREE.Vector3(lp.x, lp.y, lp.z), Math.max(0.5, idx.cell * 3))
      secSnapRef.current = hit ? lineFromEdge(hit.point, hit.dir) : null
      v.scene.requestRender()
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    handler.setInputAction(() => {
      const s = secSnapRef.current
      if (!s) { toast.error('Najeď na hranu modelu — čára se na ni sama chytne'); return }
      setSecLine({ a: s.a, b: s.b })
      setSecLen(secLen > 0 ? secLen : 20)
      setSecOffset(0)
      setSecOn(true)
      setSecPick(null)
      toast.success('Řez založen kolmo na hranu')
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      alive = false
      handler.destroy()
      for (const ent of ents) v.entities.remove(ent)
      secSnapRef.current = null
      setSecEdgeBusy(false)
      v.scene.requestRender()
    }
  }, [secPick, selectedId, secLen, viewerReady]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Model načtený do three ve stejné orientaci, jakou má v mapě — vstup pro výpočet obrysu. */
  async function sectionGeometry(e: ModelEntry): Promise<THREE.Object3D> {
    const hit = secGeomRef.current.get(e.id)
    if (hit) return hit
    const gltf = await getGltfLoader().loadAsync(e.url)
    const root = new THREE.Group()
    root.add(gltf.scene)
    root.matrix = new THREE.Matrix4().fromArray(Cesium.Matrix4.toArray(SEC_AXIS))
    root.matrixAutoUpdate = false
    root.updateMatrixWorld(true)
    // pojistka: geometrie musí sedět tam, kde ji vidí Cesium — jinak by řez tiše lhal
    const inv = Cesium.Matrix4.inverse(e.model.modelMatrix, new Cesium.Matrix4())
    const csLocal = Cesium.Matrix4.multiplyByPoint(inv, e.model.boundingSphere.center, new Cesium.Cartesian3())
    const c = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3())
    const off = Math.hypot(c.x - csLocal.x, c.y - csLocal.y, c.z - csLocal.z)
    if (off > Math.max(1, e.model.boundingSphere.radius * 0.25)) {
      console.warn(`Řez: geometrie v three se s Cesium modelem rozchází o ${off.toFixed(2)} m — obrys může být posunutý`)
    }
    secGeomRef.current.set(e.id, root)
    return root
  }

  /**
   * Spočítá 2D obrys a otevře plovoucí výkres. Se zapnutým `secBoth` udělá i řez kolmý
   * na ten hlavní ve stejném místě — každý má vlastní okno, protože jsou to dvě různé
   * průmětny a slévat je do jednoho výkresu by nedávalo smysl.
   */
  async function makeSectionDrawing(live = false, quick = false) {
    const sel = selectedId ? modelsRef.current.get(selectedId) : null
    if (!sel) { if (!live) toast.error('Není vybraný model — klikni na něj v mapě'); return }
    if (!secLine) { if (!live) toast.error('Nejdřív založ čáru řezu („Na hranu“ nebo „Dva body“)'); return }
    if (!live) setSecBusy(true)
    try {
      const root = await sectionGeometry(sel)
      const inv = Cesium.Matrix4.inverse(sel.model.modelMatrix, new Cesium.Matrix4())
      const la = Cesium.Matrix4.multiplyByPoint(inv, secLine.a, new Cesium.Cartesian3())
      const lb = Cesium.Matrix4.multiplyByPoint(inv, secLine.b, new Cesium.Cartesian3())

      /**
       * `limitLength` platí jen pro hlavní řez. Kolmý (typicky podélný) jde schválně přes
       * celý model: jeho smysl je pohled na celou konstrukci, a kdyby zdědil délku příčného
       * řezu, vyšel by z 27 m mostu čtyřmetrový útržek. Výšku omezují oba stejně.
       */
      const depth = secDepth !== 0 ? secDepth : null
      const band = depth !== null ? { from: Math.min(0, depth), to: Math.max(0, depth) } : null
      /**
       * Tloušťka jako souměrný pás kolem roviny — a hlavně jako ROZSAH, ne holé číslo.
       * Jako číslo ji dostal jen výpočet obrysu, kdežto pohled ji nedostal vůbec a kreslil
       * celou hloubku modelu; navenek to vypadalo, že tloušťka nedělá nic.
       */
      const thickBand = secThick > 0 ? { from: -secThick / 2, to: secThick / 2 } : null
      const UP = () => new THREE.Vector3(0, 0, 1)
      const vec = (c: Cesium.Cartesian3) => new THREE.Vector3(c.x, c.y, c.z)

      /**
       * Oba výkresy popisují TÝŽ kvádr, jen z kolmých stran, takže má každý jiné meze:
       *
       *   hlavní — do šířky délka čáry řezu, do hloubky výřez
       *   kolmý  — do šířky výřez (to je jeho vodorovná osa), do hloubky délka čáry řezu
       *
       * Kdyby kolmý zdědil délku od hlavního, vyjde z 27m mostu útržek; a bez meze vyjde
       * celý model místo vybrané části. Ani jedno se nechce.
       */
      /**
       * Postaví jeden výkres z hotové roviny.
       *
       * `viewSlab` je zvlášť od `slab`, protože u PŮDORYSU se řeže vodorovnou rovinou, ale
       * dívat se má DOLŮ — kdyby pohled zdědil tloušťku řezu, ukázal by jen ten milimetrový
       * plátek místo toho, co je pod ním.
       */
      const build = (
        plane: THREE.Plane,
        limit: { center: THREE.Vector3; halfU?: number; halfV?: number },
        slab: { from: number; to: number } | number,
        nearby: { radius?: number; from?: number; to?: number } | undefined,
        viewSlab?: { from: number; to: number },
      ) => {
        const clip = { center: limit.center, halfU: limit.halfU, halfV: limit.halfV }
        const hasClip = clip.halfU !== undefined || clip.halfV !== undefined

        const res = sliceSlab(root, slab, plane, { nearby, up: UP(), clip: hasClip ? clip : undefined })

        /**
         * Pohled dostane STEJNÉ okno jako řez, ne obálku spočítaného obrysu — ta sahá jen
         * tam, kam dosáhla řezná rovina, takže pohled usekávala v místě, kde obrys končí.
         */
        const viewOpts = {
          up: UP(),
          edgeAngle: secEdgeAngle,
          slab: viewSlab ?? (typeof slab === 'number' ? undefined : slab),
          clip: hasClip ? clip : undefined,
        }
        const bg = renderSectionView(root, plane, quick ? { ...viewOpts, size: 1024 } : viewOpts)

        /**
         * Vektorové obrysy pohledu: promítnuté hrany z výřezu. Se zapnutým zakrytím se
         * rovnou rozdělí na viditelné (plná čára) a zakryté (čárkovaná), takže z toho je
         * pohled tak, jak se kreslí v CADu — a jde kótovat, měřit i vyexportovat do DXF.
         */
        if (secViewLines && !quick) {
          const segs = projectSlabEdges(root, plane, { ...viewOpts, occlusion: secOcclusion })
          const total = segs.visible.segs.length + segs.hidden.segs.length
          if (total > 4 * 160_000) {
            toast.info('Pohled má moc hran na kótování — obrysy pohledu jsem vynechal')
          } else if (total) {
            const scale = Math.max(res.width, res.height, 10)
            // drobty pod ~0,2 mm na papíře nenesou informaci, jen zaplevelí výkres i DXF
            const minSize = scale * 6e-4
            const add = [
              ...polysFromSegments(segs.visible.segs, { scale, minSize, depths: segs.visible.depth }),
              ...polysFromSegments(segs.hidden.segs, {
                scale, minSize, depths: segs.hidden.depth,
                hidden: true, group: 'pohled (zakryté)', object: 'pohled (zakryté)',
              }),
            ]
            res.polys.push(...add)
            for (const p of add) for (const pt of p.pts) {
              if (pt[0] < res.minU) res.minU = pt[0]
              if (pt[0] > res.maxU) res.maxU = pt[0]
              if (pt[1] < res.minV) res.minV = pt[1]
              if (pt[1] > res.maxV) res.maxV = pt[1]
            }
            res.width = res.maxU - res.minU
            res.height = res.maxV - res.minV
          }
        }

        // Prázdno se nekreslí. Obrysy pohledu se počítají jako obsah — když rovina model
        // minula, ale ve výřezu něco stojí, výkres pořád dává smysl.
        if (!res.polys.length) return null

        /**
         * Výška počátku výkresu, aby šlo z bodu ve výkrese odečíst nadmořskou výšku.
         *
         * Bere se převodem přes Cesium zpátky na zeměpisné souřadnice, takže vyjde v TÉŽE
         * soustavě, ve které model přišel — u georeferencovaného S-JTSK modelu je to Bpv.
         * Zbytek dopočítá výkres sám z os roviny.
         */
        const originWorld = Cesium.Matrix4.multiplyByPoint(
          sel.model.modelMatrix,
          new Cesium.Cartesian3(res.origin.x, res.origin.y, res.origin.z),
          new Cesium.Cartesian3(),
        )
        const carto = Cesium.Cartographic.fromCartesian(originWorld)
        const originZ = carto ? carto.height : null

        return { res, bg, originZ }
      }

      type Drawing = { key: string; label: string; result: SectionResult; bg: SectionView | null; originZ: number | null }
      const out: Drawing[] = []

      /**
       * Při živém přepočtu se staví jen výkresy, na které se někdo dívá.
       *
       * Se zapnutým kolmým řezem i půdorysem to jsou tři renderování, tři čtení hloubkové
       * mapy a tři projekce hran — i když je otevřené jedno okno. Zavřený výkres si podrží
       * ten starý výsledek; jakmile ho otevřeš, `secShown` se změní a přepočítá se.
       */
      const want = (key: string) => !live || secShown.has(key) || !secDrawings.some(d => d.key === key)
      const keep = (key: string): Drawing | null => secDrawings.find(d => d.key === key) ?? null
      const mid = Cesium.Cartesian3.midpoint(la, lb, new Cesium.Cartesian3())
      const halfLen = secLen > 0 ? secLen / 2 : undefined

      const vertical = (a: Cesium.Cartesian3, b: Cesium.Cartesian3) => {
        const f = frameFromLocal(a, b)
        return f ? { f, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(vec(f.n), vec(f.point)) } : null
      }
      const halfV = secHeight > 0 ? secHeight / 2 : undefined

      const mainF = vertical(la, lb)
      const main = mainF && want('main') && build(
        mainF.plane,
        { center: vec(mid), halfU: halfLen, halfV },
        band ?? thickBand ?? 0,
        band ?? undefined,
      )
      if (main) out.push({ key: 'main', label: 'hlavní', result: main.res, bg: main.bg, originZ: main.originZ })
      else if (!want('main')) { const k = keep('main'); if (k) out.push(k) }

      if (secBoth) {
        const [ra, rb] = rotate90Local(la, lb)
        const fm = frameFromLocal(la, lb)
        // střed výřezu: od roviny hlavního řezu o půl hloubky po jeho normále
        const cc = fm && depth !== null
          ? Cesium.Cartesian3.add(mid, Cesium.Cartesian3.multiplyByScalar(fm.n, depth / 2, new Cesium.Cartesian3()), new Cesium.Cartesian3())
          : mid
        const crossF = vertical(ra, rb)
        const cross = crossF && want('cross') && build(
          crossF.plane,
          { center: vec(cc), halfU: depth !== null ? Math.abs(depth) / 2 : undefined, halfV },
          halfLen !== undefined ? { from: -halfLen, to: halfLen } : thickBand ?? 0,
          halfLen !== undefined ? { radius: halfLen } : undefined,
        )
        if (cross) out.push({ key: 'cross', label: 'kolmý', result: cross.res, bg: cross.bg, originZ: cross.originZ })
        else if (!want('cross')) { const k = keep('cross'); if (k) out.push(k) }
      }

      /**
       * Půdorys: řez VODOROVNOU rovinou a pohled shora dolů.
       *
       * Osy výkresu si dopočítá `planeBasis` sama — u roviny rovnoběžné se zemí nemá „nahoru"
       * smysl, tak jím udělá sever. Okno se omezí na obálku výřezu v půdorysu: výřez je
       * obdélník natočený podle čáry řezu, kdežto meze výkresu jdou po východu a severu.
       */
      if (secPlan && mainF) {
        const f = mainF.f
        const at = Cesium.Cartesian3.add(
          Cesium.Cartesian3.add(mid, Cesium.Cartesian3.multiplyByScalar(f.n, depth !== null ? depth / 2 : 0, new Cesium.Cartesian3()), new Cesium.Cartesian3()),
          Cesium.Cartesian3.multiplyByScalar(f.up, secPlanZ, new Cesium.Cartesian3()),
          new Cesium.Cartesian3(),
        )
        const planPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(vec(f.up), vec(at))
        const hl = halfLen ?? 0
        const hd = depth !== null ? Math.abs(depth) / 2 : 0
        const halfE = hl > 0 || hd > 0 ? Math.abs(f.dir.x) * hl + Math.abs(f.n.x) * hd : undefined
        const halfN = hl > 0 || hd > 0 ? Math.abs(f.dir.y) * hl + Math.abs(f.n.y) * hd : undefined
        // dolů se dívá tak hluboko, jak sahá výškové omezení; bez něj přes celý model
        const below = secHeight > 0 ? secHeight : 1e4
        const plan = want('plan') && build(
          planPlane,
          { center: vec(at), halfU: halfE, halfV: halfN },
          thickBand ?? 0,
          undefined,
          { from: -below, to: 0 },
        )
        if (plan) out.push({ key: 'plan', label: 'půdorys', result: plan.res, bg: plan.bg, originZ: plan.originZ })
        else if (!want('plan')) { const k = keep('plan'); if (k) out.push(k) }
        else if (!live) toast.info('Vodorovná rovina modelem neprochází — posuň ji výškou')
      }

      if (!out.length) {
        // Při živém přepočtu se nic nezavírá: rovina se za chvíli zase trefí a mizející
        // a znovu vyskakující okna by byla horší než chvilka starého obrázku.
        if (!live) toast.error('Rovina modelem neprochází — posuň řez nebo zvětši rozsah')
        return
      }
      setSecDrawings(out)
      if (live) {
        // okna nechá tak, jak si je uživatel nechal — jen nově vzniklý výkres otevře
        const had = new Set(secDrawings.map(o => o.key))
        setSecShown(sh => {
          const n = new Set(sh)
          for (const o of out) if (!had.has(o.key)) n.add(o.key)
          return n
        })
        if (secRefitRef.current) { secRefitRef.current = false; setSecEpoch(e => e + 1) }
      } else {
        setSecShown(new Set(out.map(o => o.key)))
        setSecEpoch(e => e + 1)
        if (secBoth && out.length === 1) toast.info('Kolmý řez modelem neprochází — je jen hlavní')
      }
    } catch (err) {
      console.error('Výpočet řezu selhal:', err)
      if (!live) toast.error(err instanceof Error ? err.message : 'Výpočet řezu selhal')
    } finally {
      if (!live) setSecBusy(false)
    }
  }

  /**
   * Nový řez z obdélníku vytaženého ve výkrese.
   *
   * Obdélník leží v rovině toho výkresu, takže z něj jde odvodit rovina KOLMÁ na něj —
   * přesně jako když se v CADu do podélného pohledu umístí značka příčného řezu:
   *
   *   levá hrana obdélníku  → kudy nová rovina prochází
   *   šířka obdélníku       → hloubka výřezu nového řezu (kam až se v něm dívá)
   *   výška obdélníku       → výškové omezení nového výkresu
   *
   * Nová čára řezu běží po normále původní roviny, takže nová rovina vyjde kolmá na starou.
   * Její délka (tedy šířka nového výkresu) zdědí hloubku výřezu toho původního — to je přesně
   * ten pás, který starý pohled ukazoval.
   */
  function sectionFromDrawing(key: string, rect: SectionViewRect) {
    const sel = selectedId ? modelsRef.current.get(selectedId) : null
    const d = secDrawings.find(x => x.key === key)
    if (!sel || !d) return
    const r = d.result
    const up = new THREE.Vector3(0, 0, 1)

    /**
     * Nová rovina je KOLMÁ na ten výkres a prochází levou hranou obdélníku.
     *
     * Ta hrana je ve výkrese svislá čára, v prostoru tedy míří po ose `v` výkresu; rovina,
     * která ji obsahuje a je kolmá na výkres, má normálu rovnou ose `u` výkresu. Odtud plyne
     * i směr nové čáry řezu: `frameFromLocal` z ní počítá normálu jako `cross(up, dir)`,
     * takže potřebujeme `dir = cross(u, up)`.
     *
     * Platí to pro každý výkres. Ze svislého řezu tak vyjde kolmý svislý řez, z PŮDORYSU
     * svislý řez jeho stopou — a přesně tak se v CADu značka řezu umisťuje.
     */
    const dir = new THREE.Vector3().crossVectors(r.u, up)
    dir.z = 0
    if (dir.lengthSq() < 1e-12) { toast.error('Z tohohle výkresu kolmý řez neodvodím'); return }
    dir.normalize()

    const vc = (rect.minV + rect.maxV) / 2
    const P = r.origin.clone().addScaledVector(r.u, rect.minU).addScaledVector(r.v, vc)

    /**
     * Šířka nového výkresu se měří po JEHO vodorovné ose, a ta je `cross(up, u)`.
     * U svislého řezu míří do hloubky původního pohledu (v obdélníku ji nevidíš, tak se
     * zdědí hloubka výřezu), u půdorysu leží v rovině výkresu — tam ji obdélník udává sám.
     */
    const uNew = new THREE.Vector3().crossVectors(up, r.u).normalize()
    const alongV = Math.abs(uNew.dot(r.v))
    const width = alongV > 0.5 ? rect.maxV - rect.minV : (secDepth !== 0 ? Math.abs(secDepth) : 0)
    // výšku obdélník udává jen tehdy, když je svislá osa výkresu opravdu svislá
    const height = Math.abs(r.v.dot(up)) > 0.5 ? rect.maxV - rect.minV : secHeight

    const half = (width > 0 ? width : 20) / 2
    const toWorld = (q: THREE.Vector3) =>
      Cesium.Matrix4.multiplyByPoint(sel.model.modelMatrix, new Cesium.Cartesian3(q.x, q.y, q.z), new Cesium.Cartesian3())

    secRefitRef.current = true
    setSecLine({
      a: toWorld(P.clone().addScaledVector(dir, -half)),
      b: toWorld(P.clone().addScaledVector(dir, half)),
    })
    setSecLen(width)
    setSecDepth(rect.maxU - rect.minU)
    setSecHeight(height)
    setSecOffset(0)
    setSecFlip(false)
    setSecOn(true)
    toast.success('Nový řez z výkresu — přepočítávám')
  }

  // uložené řezy putují do stavu scény, tedy i do databáze (vypnutý řez je nechá, jak jsou)
  useEffect(() => { if (enabled) sceneRef.current.patchState({ sections: secSaved }) }, [secSaved, enabled])

  /**
   * Uloží právě nastavený řez pod jménem.
   *
   * Čára se překlápí do LOKÁLNÍ soustavy modelu. Kdyby se model ve scéně posunul nebo
   * pootočil, světové souřadnice by ukazovaly vedle — takhle jde řez s ním. Model se
   * pamatuje podle jména, protože id souboru se při novém nahrání změní.
   */
  async function saveSection() {
    const sel = selectedId ? modelsRef.current.get(selectedId) : null
    if (!sel || !secLine) { toast.error('Nejdřív založ čáru řezu'); return }
    const name = await askText({ title: 'Název řezu', value: 'Řez ' + (secSaved.length + 1), okLabel: 'Uložit' })
    if (!name) return
    const inv = Cesium.Matrix4.inverse(sel.model.modelMatrix, new Cesium.Matrix4())
    const local = (w: Cesium.Cartesian3): [number, number, number] => {
      const l = Cesium.Matrix4.multiplyByPoint(inv, w, new Cesium.Cartesian3())
      return [l.x, l.y, l.z]
    }
    const item: SavedSection = {
      id: 's' + Date.now().toString(36),
      name,
      model: sel.name,
      a: local(secLine.a),
      b: local(secLine.b),
      flip: secFlip,
      offset: secOffset,
      len: secLen,
      height: secHeight,
      thick: secThick,
      depth: secDepth,
      both: secBoth,
      plan: secPlan,
      planZ: secPlanZ,
      viewLines: secViewLines,
      occlusion: secOcclusion,
      edgeAngle: secEdgeAngle,
      clipMap: secClipMap,
    }
    setSecSaved(list => [...list, item])
    setSecActive(item.id)
    toast.success('Řez „' + name + '" uložen')
  }

  /** Přepne na uložený řez — obnoví čáru i všechna nastavení. */
  function loadSection(item: SavedSection) {
    // řez patří ke konkrétnímu modelu; když je vybraný jiný, přepneme na ten správný
    let sel = selectedId ? modelsRef.current.get(selectedId) : null
    if (!sel || sel.name !== item.model) {
      const found = [...modelsRef.current.values()].find(m => m.name === item.model)
      if (!found) { toast.error('Model „' + item.model + '" ve scéně není'); return }
      sel = found
      setSelectedId(found.id)
    }
    const world = (l: [number, number, number]) =>
      Cesium.Matrix4.multiplyByPoint(sel.model.modelMatrix, new Cesium.Cartesian3(l[0], l[1], l[2]), new Cesium.Cartesian3())

    secRefitRef.current = true
    setSecLine({ a: world(item.a), b: world(item.b) })
    setSecFlip(item.flip)
    setSecOffset(item.offset)
    setSecLen(item.len)
    setSecHeight(item.height)
    setSecThick(item.thick)
    setSecDepth(item.depth)
    setSecBoth(item.both)
    setSecPlan(item.plan ?? false)
    setSecPlanZ(item.planZ ?? 0)
    setSecViewLines(item.viewLines)
    setSecOcclusion(item.occlusion)
    setSecEdgeAngle(item.edgeAngle)
    setSecClipMap(item.clipMap)
    setSecOn(true)
    setSecPick(null)
    setSecActive(item.id)
    toast.info('Řez „' + item.name + '"')
  }

  /** Přepíše uložený řez tím, co je právě nastavené. */
  function updateSection(item: SavedSection) {
    const sel = selectedId ? modelsRef.current.get(selectedId) : null
    if (!sel || !secLine) return
    const inv = Cesium.Matrix4.inverse(sel.model.modelMatrix, new Cesium.Matrix4())
    const local = (w: Cesium.Cartesian3): [number, number, number] => {
      const l = Cesium.Matrix4.multiplyByPoint(inv, w, new Cesium.Cartesian3())
      return [l.x, l.y, l.z]
    }
    setSecSaved(list => list.map(x => x.id !== item.id ? x : {
      ...x,
      model: sel.name,
      a: local(secLine.a),
      b: local(secLine.b),
      flip: secFlip, offset: secOffset, len: secLen, height: secHeight, thick: secThick,
      depth: secDepth, both: secBoth, plan: secPlan, planZ: secPlanZ,
      viewLines: secViewLines, occlusion: secOcclusion,
      edgeAngle: secEdgeAngle, clipMap: secClipMap,
    }))
    toast.success('Řez „' + item.name + '" přepsán')
  }

  /**
   * Živý přepočet otevřených výkresů.
   *
   * Běží vždy jen jeden — když se řez pohne během výpočtu, poznamená se to a další kolo se
   * naplánuje až po dopočítání. Bez toho by se u delšího modelu fronta požadavků nafoukla
   * a výkres by dobíhal několik sekund za myší.
   */
  async function runSectionLive(quick: boolean) {
    if (secRunRef.current) { secDirtyRef.current = true; return }
    secRunRef.current = true
    try {
      await makeSectionDrawing(true, quick)
    } finally {
      secRunRef.current = false
      secLastRunRef.current = Date.now()
      if (secDirtyRef.current) { secDirtyRef.current = false; setSecKick(k => k + 1) }
    }
  }

  /**
   * Vloží model do mapy. Bez `restore` je to ruční import (usadí se podle kotvy nebo do středu
   * a soubor se nahraje do scény), s `restore` je to obnova scény z úložiště: soubor projde
   * stejnou přípravou, ale usazení a přepínače se vezmou z uloženého nastavení a nikam se nelétá.
   */
  return {
    secOn, setSecOn, secPick, setSecPick, secDepth, setSecDepth, secEdgeBusy,
    secLine, secFlip, setSecFlip, secOffset, setSecOffset, secStep, setSecStep,
    secLen, setSecLen, secHeight, setSecHeight, secThick, setSecThick,
    secClipMap, setSecClipMap, secGhost, setSecGhost,
    secDrawings, secShown, setSecShown, secBoth, setSecBoth,
    secPlan, setSecPlan, secPlanZ, setSecPlanZ,
    secViewLines, setSecViewLines, secOcclusion, setSecOcclusion,
    secEdgeAngle, setSecEdgeAngle, secBusy, secLive, setSecLive,
    secSaved, setSecSaved, secActive, setSecActive, secEpoch, secDragging,
    secClipRef, secGhostRef, secGeomRef,
    sectionFrame, sectionSummary, rotateSection90, makeSectionDrawing, sectionFromDrawing,
    saveSection, loadSection, updateSection,
  }
}
