/**
 * Ruční měření: klikáním se sype lomená čára s délkami úseků, nebo uzavřená plocha s výměrou.
 *
 * Měření je 3D, ne půdorysné — body se berou z povrchu (terén, model i Google dlaždice) i s výškou
 * a úsek se počítá jako přímá spojnice v prostoru. Proto se čáry kreslí s `ArcType.NONE`: Cesium
 * by jinak vedlo polyline po geodetice a na svahu by čára viditelně nesouhlasila s číslem.
 * Výjimkou jsou hladké body (dvojklik na bod): úseky u nich vedou obloukem a měří se po něm
 * (rulerCurve.ts).
 *
 * Body, čáry i kóty jsou vidět i skrz terén (`disableDepthTestDistance` a `depthFailMaterial`) —
 * měřítko přes kopec je pořád měření, ne kresba, a schovaná půlka by z něj udělala hádanku.
 *
 * POZOR na dvojí metriku, je to schválně: DÉLKY jsou 3D (šikmá vzdálenost v prostoru), zatímco
 * VÝMĚRA plochy je půdorysná — průmět do vodorovné roviny, jak ji vede katastr. Obojí odpovídá
 * tomu, k čemu se to používá: úsek na svahu má reálnou délku, ale pozemek se prodává v m² půdorysu.
 * Na kopci proto obvod ze součtu stran nesouhlasí s obvodem odpovídajícím té výměře.
 *
 * Entity se skládají znovu jen když se změní STRUKTURA (přibyl bod, přibylo měření). Posun bodu
 * jen přepíše hodnoty kót a poloh (`refresh`); čára a plocha jsou v klidu statická geometrie
 * a dynamické jen po dobu tažení — v klidu tak měření nestojí v každém snímku nic.
 */
import * as Cesium from 'cesium'
import { measureRing, fmtArea } from './measure'
import { toolTheme } from './toolColors'
import { curvePath, curveSegments, segLength, segMid } from './rulerCurve'

/** bod měření: zeměpisná poloha + výška povrchu v místě kliknutí (m n.m.) */
export type RulerPoint = [number, number, number]
/**
 * `kind` chybí u měření uložených před zavedením ploch → bere se jako čára. `closed` = čára
 * uzavřená zpátky do prvního bodu (při měření klik na první bod) — délka pak počítá i úsek
 * z posledního bodu do prvního. `smooth` = indexy hladkých bodů (dvojklik na bod), kterými
 * čára vede obloukem místo rohem — viz rulerCurve.ts.
 */
export type Ruler = { id: string; name: string; pts: RulerPoint[]; kind?: 'line' | 'area'; closed?: boolean; smooth?: number[] }

/** barva měření v mapě — nastavuje se v toolColors.ts */
export const RULER_COLOR = toolTheme('ruler').map

/** „12,34 m" pod kilometr, jinak „1,234 km" — pod metrem má smysl i centimetr */
export function fmtLen(m: number): string {
  if (m >= 1000) return `${(m / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 3 })} km`
  return `${m.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`
}

const cart = (p: RulerPoint) => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2])
const smoothSet = (smooth?: readonly number[]) => new Set(smooth ?? [])

/**
 * Délka čáry (po obloucích, kde jsou hladké body) a její převýšení (rozdíl výšek prvního
 * a posledního bodu). Uzavřená čára (`closed`) počítá i úsek zpátky do prvního bodu
 * a převýšení nemá — končí tam, kde začala.
 */
export function rulerTotals(pts: RulerPoint[], closed = false, smooth?: readonly number[]): { len: number; rise: number } {
  const loop = closed && pts.length > 2
  const len = curveSegments(pts.map(cart), smoothSet(smooth), loop).reduce((s, g) => s + segLength(g), 0)
  return { len, rise: !loop && pts.length > 1 ? pts[pts.length - 1][2] - pts[0][2] : 0 }
}

/** Obrys uzavřeného měření včetně oblouků (bez opakovaného prvního bodu na konci). */
function loopOutline(pts: RulerPoint[], smooth?: readonly number[]): Cesium.Cartesian3[] {
  const path = curvePath(curveSegments(pts.map(cart), smoothSet(smooth), true))
  return path.slice(0, -1)
}

/** Uzavírá se měření zpátky do prvního bodu? Plocha vždy, čára jen uzavřená; obojí až od tří bodů. */
const isLoop = (r: Pick<Ruler, 'kind' | 'closed' | 'pts'>) => (r.kind === 'area' || !!r.closed) && r.pts.length > 2
/** Struktura měření — když se změní, entity se skládají znovu (jinak se jen přepíšou hodnoty). */
const sigOf = (r: Ruler) => `${r.kind ?? 'line'}/${r.pts.length}/${r.closed ? 'o' : '-'}`

/**
 * Výměra oklikané plochy a místo pro její popisek.
 *
 * Počítá to `measureRing` z měření parcel, schválně: dělá shoelace v S-JTSK (EPSG:5514), tedy
 * přesně v projekci, ve které vede výměry katastr. Ručně naklikaná plocha je tak přímo
 * porovnatelná s výměrou parcely pod ní a nevzniká rozdíl z jiné metody výpočtu.
 *
 * Je to tedy PŮDORYSNÁ výměra (průmět do vodorovné roviny), ne plocha svahu — stejně jako
 * v katastru. Na kopci je skutečný povrch větší, než co tu vyjde.
 */
export function rulerArea(pts: RulerPoint[], smooth?: readonly number[]): { area: number; label: [number, number] } | null {
  if (pts.length < 3) return null
  // s oblouky se výměra počítá z obrysu po křivce (navzorkovaného), jinak přímo z bodů
  const ring: [number, number][] = smooth?.length
    ? loopOutline(pts, smooth).map(c => {
        const g = Cesium.Cartographic.fromCartesian(c)
        return [Cesium.Math.toDegrees(g.longitude), Cesium.Math.toDegrees(g.latitude)]
      })
    : pts.map(p => [p[0], p[1]])
  const m = measureRing(ring)
  return m ? { area: m.area, label: m.label } : null
}
/** bod konkrétního měření: které měření a kolikátý bod */
export type RulerHit = { id: string; idx: number }
type Hit = RulerHit

/** Entity jednoho měření a vlastnosti, které se po posunu bodu přepisují. */
type Live = {
  ents: Cesium.Entity[]
  /** lomená čára a výplň plochy — CallbackProperty, který se přepíná mezi statickým a dynamickým */
  line?: Cesium.CallbackProperty
  fill?: Cesium.CallbackProperty
  lineFn?: Cesium.CallbackProperty.Callback
  fillFn?: Cesium.CallbackProperty.Callback
  /** právě se táhne bod → čára a plocha se počítají každý snímek */
  moving: boolean
  segs: Cesium.Entity[]      // kóty úseků
  dots: Cesium.Entity[]      // body; poslední nese i součet
  areaLabel?: Cesium.Entity  // výměra uprostřed plochy
}

const LABEL_BG = Cesium.Color.fromCssColorString('#111827')

/** Přepíše hodnotu konstantní vlastnosti na místě (událost změny jen když se hodnota opravdu liší). */
function setConst(p: Cesium.Property | undefined, value: unknown) {
  if (p instanceof Cesium.ConstantProperty || p instanceof Cesium.ConstantPositionProperty) p.setValue(value as never)
}

export class RulerLayer {
  private viewer: Cesium.Viewer
  private data = new Map<string, Ruler>()
  private live = new Map<string, Live>()
  private hits = new Map<Cesium.Entity, Hit>()
  private sig = new Map<string, string>()   // rulerId → struktura (druh + počet bodů) → kdy přestavět
  // Výměra se počítá přes proj4 — přepočítá se jen když se body opravdu změní (sync, tažení).
  private areaCache = new Map<string, ReturnType<typeof rulerArea>>()
  // bod, ke kterému se právě přichytí klik (zvětšený) — viz `setSnap`
  private snap: Hit | null = null
  // bod, který se právě táhne (kreslí se průhledně) — viz `setDragging`
  private dragging: Hit | null = null
  private scratchWin = new Cesium.Cartesian2()

  constructor(viewer: Cesium.Viewer) { this.viewer = viewer }

  /**
   * Nejbližší bod měření k místu na obrazovce, nanejvýš `maxPx` daleko (CSS pixely), nebo null.
   * Počítá se z promítnutí bodů, ne z `scene.pick` — je to levné i při každém pohybu myši
   * a chytá to i kousek vedle desetipixelové tečky.
   */
  nearest(screen: Cesium.Cartesian2, maxPx: number): Hit | null {
    const v = this.viewer
    if (v.isDestroyed()) return null
    let best: Hit | null = null
    let bestD = maxPx
    for (const [id, r] of this.data) {
      for (let idx = 0; idx < r.pts.length; idx++) {
        const w = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, cart(r.pts[idx]), this.scratchWin)
        if (!w) continue
        const d = Math.hypot(w.x - screen.x, w.y - screen.y)
        if (d <= bestD) { bestD = d; best = { id, idx } }
      }
    }
    return best
  }

  /** Zvětší bod, ke kterému se přichytí klik (null = žádný) — ať je vidět, kam to skočí. */
  setSnap(h: Hit | null) {
    const same = (a: Hit | null, b: Hit | null) => a?.id === b?.id && a?.idx === b?.idx
    if (same(h, this.snap)) return
    const dot = (x: Hit | null) => (x ? this.live.get(x.id)?.dots[x.idx] : undefined)
    setConst(dot(this.snap)?.point?.pixelSize, 10)
    this.snap = h
    setConst(dot(h)?.point?.pixelSize, 16)
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender()
  }

  /**
   * Tažený bod (null = nic se netáhne) se kreslí průhledně (alfa 0,99 — okem stejný).
   *
   * Body jsou vidět skrz terén (`disableDepthTestDistance`) a Cesium jim do hloubky zapíše
   * hloubku terénu, a to ještě bez modelů. `pickPosition` pod bodem proto vidí jen terén —
   * a tažený bod je pořád pod kurzorem, takže by se chytal na terén i přes model. Průhledné
   * body do hloubky nezapisují, pod kurzorem tak zůstane model.
   */
  setDragging(h: Hit | null) {
    const prev = this.dragging
    this.dragging = h
    if (prev) this.styleDot(prev.id, prev.idx)
    if (h) this.styleDot(h.id, h.idx)
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender()
  }

  /**
   * Barvy bodu: rohový je plný v barvě měření s bílým obrysem, hladký (oblouk) naopak bílý
   * s barevným obrysem. Tažený je průhledný (viz `setDragging`).
   */
  private styleDot(id: string, idx: number) {
    const p = this.live.get(id)?.dots[idx]?.point
    if (!p) return
    const alpha = this.dragging?.id === id && this.dragging.idx === idx ? 0.99 : 1
    const color = Cesium.Color.fromCssColorString(RULER_COLOR).withAlpha(alpha)
    const white = Cesium.Color.WHITE.withAlpha(alpha)
    const smooth = !!this.data.get(id)?.smooth?.includes(idx)
    setConst(p.color, smooth ? white : color)
    setConst(p.outlineColor, smooth ? color : white)
  }

  /** Body daného měření — vždy živé, tažení je mutuje rovnou tady. */
  private pts(id: string): RulerPoint[] { return this.data.get(id)?.pts ?? [] }
  private isArea(id: string): boolean { return this.data.get(id)?.kind === 'area' }
  private recalcArea(id: string) { this.areaCache.set(id, this.isArea(id) ? rulerArea(this.pts(id), this.data.get(id)?.smooth) : null) }
  /** úseky měření i s oblouky — z nich se kreslí čára a počítají délky */
  private segments(id: string, loop: boolean) { return curveSegments(this.pts(id).map(cart), smoothSet(this.data.get(id)?.smooth), loop) }

  sync(rulers: Ruler[], selectedId: string | null) {
    const alive = new Set(rulers.map(r => r.id))
    for (const id of [...this.live.keys()]) if (!alive.has(id)) this.drop(id)
    for (const r of rulers) {
      const prev = this.data.get(r.id)
      const sig = sigOf(r)
      this.data.set(r.id, r)
      if (this.sig.get(r.id) !== sig) { this.recalcArea(r.id); this.drop(r.id, true); this.build(r) }
      // Body se změnily (dotažený posun) → přepsat čísla a srovnat čáru zpátky na statickou.
      // Jen při skutečné změně: sync chodí i při najetí myší na měření v panelu, a přestavět
      // kvůli tomu geometrii všech měření by bliklo.
      else if (prev?.pts !== r.pts || prev?.smooth !== r.smooth) { this.recalcArea(r.id); this.refresh(r.id, false, true) }
    }
    // zvýraznění vybraného měření řeší šířka čáry; `setConst` mění jen když se šířka liší
    for (const [id, L] of this.live) {
      const w = id === selectedId ? 4 : 2
      for (const e of L.ents) if (e.polyline) setConst(e.polyline.width, w)
    }
  }

  /** posun bodu při tažení — zapisuje do živých dat; čára a plocha jedou do puštění dynamicky */
  liveMove(id: string, idx: number, p: RulerPoint) {
    const pts = this.pts(id)
    if (idx >= 0 && idx < pts.length) pts[idx] = p
    this.recalcArea(id)
    this.refresh(id, true)
    // mapa kreslí jen na vyžádání
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender()
  }

  /** výsledek `scene.pick` → které měření a který bod, nebo null */
  hit(picked: unknown): Hit | null {
    const ent = (picked as { id?: unknown } | undefined)?.id
    return ent instanceof Cesium.Entity ? this.hits.get(ent) ?? null : null
  }

  private drop(id: string, keepData = false) {
    const v = this.viewer
    for (const e of this.live.get(id)?.ents ?? []) { this.hits.delete(e); if (!v.isDestroyed()) v.entities.remove(e) }
    this.live.delete(id)
    this.sig.delete(id)
    if (!keepData) { this.data.delete(id); this.areaCache.delete(id) }
  }

  /**
   * Přepíše polohy a čísla podle aktuálních bodů.
   *
   * Kóty a body jsou konstantní vlastnosti a přepisují se tady — dřív to byly CallbackProperty,
   * které Cesium vyhodnocovalo v každém tiku (i když se nic nehýbalo), u každé kóty zvlášť.
   * Čára a výplň plochy zůstávají CallbackProperty, jen se jim přepíná „konstantnost": v klidu
   * jsou statické (geometrie se spočítá jednou), za tažení dynamické, ať bod jede plynule.
   */
  private refresh(id: string, moving: boolean, dataChanged = false) {
    const L = this.live.get(id)
    if (!L) return
    const ps = this.pts(id)
    const c = ps.map(cart)
    const r = this.data.get(id)
    const area = this.isArea(id)
    const loop = !!r && isLoop(r)
    const segs = this.segments(id, loop)

    if (moving !== L.moving || !moving) {
      // setCallback vyvolá změnu → statická geometrie se přepočítá z aktuálních bodů. Jenže jen
      // při přechodu mezi tažením a klidem: se stejnou funkcí i konstantností změnu neohlásí.
      // Změna v klidu (přepnutý oblouk) se proto ohlásí ručně, jinak by zůstala stará čára.
      const rebuild = dataChanged && !moving && !L.moving
      if (L.line && L.lineFn) L.line.setCallback(L.lineFn, !moving)
      if (L.fill && L.fillFn) L.fill.setCallback(L.fillFn, !moving)
      if (rebuild) {
        L.line?.definitionChanged.raiseEvent(L.line)
        L.fill?.definitionChanged.raiseEvent(L.fill)
      }
      L.moving = moving
    }

    // kóta sedí v polovině úseku — na oblouku na křivce, ne na tětivě — a píše délku po křivce
    L.segs.forEach((e, i) => {
      const g = segs[i]
      if (!g) return
      setConst(e.position, segMid(g))
      setConst(e.label?.text, fmtLen(segLength(g)))
    })
    L.dots.forEach((e, i) => { if (c[i]) setConst(e.position, c[i]); this.styleDot(id, i) })

    const last = L.dots[L.dots.length - 1]
    if (last?.label && ps.length > 1) {
      // U plochy je hlavní číslo výměra uprostřed, tady se hodí spíš obvod (i s uzavíracím
      // úsekem). U čáry naopak celková délka a převýšení mezi prvním a posledním bodem
      // (uzavřená čára převýšení nemá — končí tam, kde začala).
      const len = segs.reduce((s, g) => s + segLength(g), 0)
      const riseM = loop ? 0 : ps[ps.length - 1][2] - ps[0][2]
      const rise = Math.abs(riseM) >= 0.5 ? ` (${riseM > 0 ? '+' : '−'}${Math.abs(riseM).toFixed(1)} m)` : ''
      const txt = area && ps.length > 2 ? `o ${fmtLen(len)}` : `Σ ${fmtLen(len)}${rise}`
      setConst(last.label.text, txt)
    }

    if (L.areaLabel && ps.length) {
      const a = this.areaCache.get(id)
      const p = a ? a.label : [ps[0][0], ps[0][1]]
      setConst(L.areaLabel.position, Cesium.Cartesian3.fromDegrees(p[0], p[1], ps[0][2]))
      setConst(L.areaLabel.label?.text, a ? fmtArea(a.area) : '')
    }
  }

  private build(r: Ruler) {
    const v = this.viewer
    if (v.isDestroyed()) return
    const color = Cesium.Color.fromCssColorString(RULER_COLOR)
    const area = r.kind === 'area'
    const loop = isLoop(r)
    const L: Live = { ents: [], moving: false, segs: [], dots: [] }
    const add = (o: Cesium.Entity.ConstructorOptions) => { const e = v.entities.add(o); L.ents.push(e); return e }
    const zero = () => new Cesium.ConstantPositionProperty(Cesium.Cartesian3.ZERO)

    // lomená čára — jeden entity přes všechny body; ArcType.NONE = rovná spojnice v prostoru
    // (oblouky u hladkých bodů jsou navzorkované, viz rulerCurve.ts)
    if (r.pts.length > 1) {
      // plocha i uzavřená čára se vrací k prvnímu bodu (poslední úsek končí v něm)
      L.lineFn = () => curvePath(this.segments(r.id, loop))
      L.line = new Cesium.CallbackProperty(L.lineFn, true)
      add({
        polyline: {
          positions: L.line,
          width: new Cesium.ConstantProperty(2),
          material: color,
          depthFailMaterial: new Cesium.PolylineDashMaterialProperty({ color: color.withAlpha(0.75) }),
          arcType: Cesium.ArcType.NONE,
        },
      })
    }

    // Výplň plochy. Drapuje se na terén (bez `perPositionHeight`, s klasifikací), protože výměra
    // je půdorysná — plochý průmět na zem je přesně to, co to číslo znamená.
    if (area && r.pts.length > 2) {
      L.fillFn = () => new Cesium.PolygonHierarchy(loopOutline(this.pts(r.id), this.data.get(r.id)?.smooth))
      L.fill = new Cesium.CallbackProperty(L.fillFn, true)
      add({
        polygon: { hierarchy: L.fill, material: color.withAlpha(0.18), classificationType: Cesium.ClassificationType.BOTH },
      })
      // popisek výměry doprostřed plochy (u nekonvexních tvarů dovnitř, ne na těžiště)
      L.areaLabel = add({
        position: zero(),
        label: {
          text: new Cesium.ConstantProperty(''),
          font: 'bold 16px monospace',
          fillColor: color,
          showBackground: true,
          backgroundColor: LABEL_BG.withAlpha(0.85),
          backgroundPadding: new Cesium.Cartesian2(8, 5),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }

    // Kóta na každém úseku. U plochy i uzavřené čáry se přidává i uzavírací úsek (poslední →
    // první), aby měla okótovanou celou hranici a ne o jednu stranu míň.
    const segs = loop ? r.pts.length : r.pts.length - 1
    for (let i = 0; i < segs; i++) {
      L.segs.push(add({
        position: zero(),
        label: {
          text: new Cesium.ConstantProperty(''),
          font: 'bold 14px monospace',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: LABEL_BG.withAlpha(0.75),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }))
    }

    // body — poslední dostane součet, ať je celková délka u konce čáry a ne někde v prostoru
    for (let i = 0; i < r.pts.length; i++) {
      const isLast = i === r.pts.length - 1
      const ent = add({
        position: zero(),
        point: {
          pixelSize: 10,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: isLast && r.pts.length > 1 ? {
          text: new Cesium.ConstantProperty(''),
          font: 'bold 15px monospace',
          fillColor: color,
          showBackground: true,
          backgroundColor: LABEL_BG.withAlpha(0.85),
          backgroundPadding: new Cesium.Cartesian2(7, 5),
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 10),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        } : undefined,
      })
      this.hits.set(ent, { id: r.id, idx: i })
      L.dots.push(ent)
    }

    this.live.set(r.id, L)
    this.sig.set(r.id, sigOf(r))
    // přestavěné měření: zvětšený bod přichycení patří novým entitám
    if (this.snap?.id === r.id) setConst(L.dots[this.snap.idx]?.point?.pixelSize, 16)
    this.refresh(r.id, false)
  }

  destroy() {
    for (const id of [...this.live.keys()]) this.drop(id)
    this.data.clear()
  }
}
