/**
 * Ruční měření: klikáním se sype lomená čára s délkami úseků, nebo uzavřená plocha s výměrou.
 *
 * Měření je 3D, ne půdorysné — body se berou z povrchu (terén, model i Google dlaždice) i s výškou
 * a úsek se počítá jako přímá spojnice v prostoru. Proto se čáry kreslí s `ArcType.NONE`: Cesium
 * by jinak vedlo polyline po geodetice a na svahu by čára viditelně nesouhlasila s číslem.
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

/** bod měření: zeměpisná poloha + výška povrchu v místě kliknutí (m n.m.) */
export type RulerPoint = [number, number, number]
/**
 * `kind` chybí u měření uložených před zavedením ploch → bere se jako čára. `closed` = čára
 * uzavřená zpátky do prvního bodu (při měření klik na první bod) — délka pak počítá i úsek
 * z posledního bodu do prvního.
 */
export type Ruler = { id: string; name: string; pts: RulerPoint[]; kind?: 'line' | 'area'; closed?: boolean }

/** barva měření v mapě — nastavuje se v toolColors.ts */
export const RULER_COLOR = toolTheme('ruler').map

/** „12,34 m" pod kilometr, jinak „1,234 km" — pod metrem má smysl i centimetr */
export function fmtLen(m: number): string {
  if (m >= 1000) return `${(m / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 3 })} km`
  return `${m.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`
}

const cart = (p: RulerPoint) => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2])

/**
 * Délka lomené čáry a její převýšení (rozdíl výšek prvního a posledního bodu). Uzavřená čára
 * (`closed`) počítá i úsek zpátky do prvního bodu a převýšení nemá — končí tam, kde začala.
 */
export function rulerTotals(pts: RulerPoint[], closed = false): { len: number; rise: number } {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Cesium.Cartesian3.distance(cart(pts[i - 1]), cart(pts[i]))
  if (closed && pts.length > 2) return { len: len + Cesium.Cartesian3.distance(cart(pts[pts.length - 1]), cart(pts[0])), rise: 0 }
  return { len, rise: pts.length > 1 ? pts[pts.length - 1][2] - pts[0][2] : 0 }
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
export function rulerArea(pts: RulerPoint[]): { area: number; label: [number, number] } | null {
  if (pts.length < 3) return null
  const m = measureRing(pts.map(p => [p[0], p[1]]))
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
    const dot = (x: Hit | null) => (x ? this.live.get(x.id)?.dots[x.idx] : undefined)
    const color = Cesium.Color.fromCssColorString(RULER_COLOR)
    const style = (x: Hit | null, alpha: number) => {
      const p = dot(x)?.point
      setConst(p?.color, color.withAlpha(alpha))
      setConst(p?.outlineColor, Cesium.Color.WHITE.withAlpha(alpha))
    }
    style(this.dragging, 1)
    this.dragging = h
    style(h, 0.99)
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender()
  }

  /** Body daného měření — vždy živé, tažení je mutuje rovnou tady. */
  private pts(id: string): RulerPoint[] { return this.data.get(id)?.pts ?? [] }
  private isArea(id: string): boolean { return this.data.get(id)?.kind === 'area' }
  private recalcArea(id: string) { this.areaCache.set(id, this.isArea(id) ? rulerArea(this.pts(id)) : null) }

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
      else if (prev?.pts !== r.pts) { this.recalcArea(r.id); this.refresh(r.id, false) }
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
  private refresh(id: string, moving: boolean) {
    const L = this.live.get(id)
    if (!L) return
    const ps = this.pts(id)
    const c = ps.map(cart)
    const area = this.isArea(id)
    const closed = !area && !!this.data.get(id)?.closed

    if (moving !== L.moving || !moving) {
      // setCallback vyvolá změnu → statická geometrie se přepočítá z aktuálních bodů
      if (L.line && L.lineFn) L.line.setCallback(L.lineFn, !moving)
      if (L.fill && L.fillFn) L.fill.setCallback(L.fillFn, !moving)
      L.moving = moving
    }

    L.segs.forEach((e, i) => {
      const a = c[i], b = c[(i + 1) % c.length]
      if (!a || !b) return
      setConst(e.position, Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3()))
      setConst(e.label?.text, fmtLen(Cesium.Cartesian3.distance(a, b)))
    })
    L.dots.forEach((e, i) => { if (c[i]) setConst(e.position, c[i]) })

    const last = L.dots[L.dots.length - 1]
    if (last?.label && ps.length > 1) {
      const t = rulerTotals(ps, closed)
      // U plochy je hlavní číslo výměra uprostřed, tady se hodí spíš obvod (i s uzavíracím
      // úsekem). U čáry naopak celková délka a převýšení mezi prvním a posledním bodem
      // (uzavřená čára převýšení nemá — `rulerTotals` ho vrací nulové).
      const rise = Math.abs(t.rise) >= 0.5 ? ` (${t.rise > 0 ? '+' : '−'}${Math.abs(t.rise).toFixed(1)} m)` : ''
      const txt = area && ps.length > 2
        ? `o ${fmtLen(t.len + Cesium.Cartesian3.distance(c[c.length - 1], c[0]))}`
        : `Σ ${fmtLen(t.len)}${rise}`
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
    if (r.pts.length > 1) {
      L.lineFn = () => {
        const ps = this.pts(r.id).map(cart)
        return loop ? [...ps, ps[0]] : ps   // plocha i uzavřená čára se vrací k prvnímu bodu
      }
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
      L.fillFn = () => new Cesium.PolygonHierarchy(this.pts(r.id).map(cart))
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
