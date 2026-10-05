/**
 * DXF (a přes WASM převodník i DWG) → mezireprezentace kresby: polylinie + body + texty,
 * každý s barvou a hladinou. Oblouky/kružnice/elipsy/spliny i „bulge" oblouky se rozteselují;
 * bloky (INSERT) se rekurzivně rozbalí i s transformací.
 *
 * Vlastní TOLERANTNÍ parser group codů — na nečekané hodnoty (např. flag „12") NEPADÁ, jen je
 * ignoruje. (Hotové knihovny na takových souborech vyhazují výjimku a zabijí celý import.)
 *
 * Souřadnice se převedou na METRY podle `$INSUNITS` z hlavičky (kresba v milimetrech by jinak
 * vyšla tisíckrát větší) — leda by hlavička nesouhlasila se souřadnicemi v S-JTSK, pak vyhrají
 * souřadnice (`pickUnit`). Georeferenci (S-JTSK vs lokální) řeší až renderer.
 * Modul je bez Cesia/DOMu, aby šel testovat i mimo prohlížeč.
 */

export type DrawPrim =
  | { kind: 'poly'; pts: [number, number][]; layer: string; color: number }
  | { kind: 'point'; pt: [number, number]; layer: string; color: number }
  | { kind: 'text'; pt: [number, number]; text: string; height: number; rot: number; hAlign: HAlign; vAlign: VAlign; layer: string; color: number }

/** ukotvení textu k bodu `pt` — 0 vlevo/1 střed/2 vpravo, 0 účaří/1 střed/2 nahoře */
export type HAlign = 0 | 1 | 2
export type VAlign = 0 | 1 | 2

export type DrawParse = {
  prims: DrawPrim[]; minX: number; minY: number; maxX: number; maxY: number
  /**
   * Kde kresba doopravdy leží — MEDIÁN souřadnic prvků, ne střed obálky.
   *
   * Střed obálky rozhodí jediná zatoulaná entita: stačí jeden bod v počátku nebo blok odložený
   * stranou a obálka se roztáhne přes půl kontinentu (měřeno na reálném výkresu: 2 386 × 2 293 km
   * u stavby široké pár set metrů). Renderer podle toho středu pozná, jestli je výkres v Křováku —
   * a s rozhozeným středem to pozná špatně a položí správně georeferencovaný výkres „lokálně"
   * doprostřed pohledu. Medián je proti tomu odolný: ať jsou odlehlé prvky jednotky, nebo pětina,
   * pořád ukazuje tam, kde je kresba.
   */
  midX: number
  midY: number
  /**
   * Jádro kresby — 2. a 98. percentil souřadnic prvků.
   *
   * Slouží k přeletu po importu. Obálka (`minX`…`maxY`) se k tomu nehodí ze stejného důvodu
   * jako její střed: pár zatoulaných prvků z ní udělá půl kontinentu a kamera pak skončí tak
   * vysoko, že z výkresu není vidět nic. Percentil je odolný a přitom NEomezuje velikost:
   * stokilometrová trasa koridoru zůstane stokilometrová, jen bez těch pár úletů.
   */
  coreMinX: number
  coreMinY: number
  coreMaxX: number
  coreMaxY: number
  /** kolik METRŮ je jedna jednotka výkresu (1 = soubor je rovnou v metrech) — viz `pickUnit` */
  unit: number
  /** jak se ta jednotka jmenuje — do hlášky, ať je vidět, podle čeho se to rozhodlo */
  unitName: string
  /** jednotky se rozhodly jinak, než tvrdí hlavička (proč) — appka to řekne v hlášce */
  unitNote?: string
}

/**
 * Leží bod v S-JTSK (Křovák, metry), a v jakém zápisu?
 *  - `neg`: jak ho píše proj4 / CAD — obě souřadnice záporné (x = −Y, y = −X),
 *  - `pos`: „civilní" kladné (x = Y, y = X),
 *  - `swap`: kladné s prohozenými osami (x = X, y = Y) — data z GIS, kde je X první.
 * Rozsahy pokrývají celou republiku s rezervou; jinde (lokální výkres) vrací null.
 */
export type Krovak = 'neg' | 'pos' | 'swap'
export function krovakForm(x: number, y: number): Krovak | null {
  if (x > -950000 && x < -380000 && y > -1260000 && y < -890000) return 'neg'
  if (x > 380000 && x < 950000 && y > 890000 && y < 1260000) return 'pos'
  if (x > 890000 && x < 1260000 && y > 380000 && y < 950000) return 'swap'
  return null
}
/** Souřadnice výkresu v S-JTSK tak, jak je čeká proj4 (záporné, x = −Y, y = −X). */
export function toKrovakNeg(form: Krovak, x: number, y: number): [number, number] {
  return form === 'neg' ? [x, y] : form === 'pos' ? [-x, -y] : [-y, -x]
}

const UNIT_NAMES: Record<number, string> = { 1: 'metry', 0.001: 'milimetry', 0.01: 'centimetry' }

/**
 * Jednotky výkresu: hlavička (`$INSUNITS`), ale ne naslepo.
 *
 * České výkresy v S-JTSK mají souřadnice v metrech, jenže hlavička z výchozí šablony AutoCADu
 * často tvrdí milimetry. Přepočet podle ní by souřadnice vydělil tisícem: z −745 000 by bylo
 * −745, výkres by vypadl z Křováku, skončil uprostřed pohledu a byl by tisíckrát menší. Proto:
 *  1. dají-li jednotky z hlavičky souřadnice v Křováku, platí hlavička,
 *  2. jinak se zkusí metry, milimetry a centimetry — která z nich Křovák trefí, ta platí
 *     (souřadnice nelžou, hlavička ano),
 *  3. lokální výkres (nikde v Křováku) jede podle hlavičky — tam o velikosti rozhoduje jen ona.
 * Rozhoduje se podle mediánu prvků (`midX`), ne obálky — ta se rozpadne kvůli jedinému úletu.
 */
export function pickUnit(rawX: number, rawY: number, header: { m: number; name: string } | undefined): { unit: number; unitName: string; unitNote?: string } {
  const declared = header?.m ?? 1
  const declaredName = header?.name ?? 'bez jednotek (bere se jako metry)'
  if (krovakForm(rawX * declared, rawY * declared)) return { unit: declared, unitName: declaredName }
  for (const m of [1, 0.001, 0.01]) {
    if (m === declared || !krovakForm(rawX * m, rawY * m)) continue
    return {
      unit: m,
      unitName: UNIT_NAMES[m],
      unitNote: `Hlavička výkresu uvádí ${header ? header.name : 'žádné jednotky'}, ale souřadnice leží v S-JTSK v jednotkách „${UNIT_NAMES[m]}" — beru ${UNIT_NAMES[m]}.`,
    }
  }
  return { unit: declared, unitName: declaredName }
}

/**
 * `$INSUNITS` z hlavičky → metry na jednotku.
 *
 * Bez toho se kresba v milimetrech bere jako kresba v metrech a výkres vyjde tisíckrát větší,
 * než je — typicky se pak ani netrefí do Křováku a skončí „někde ve středu pohledu". Chybějící
 * nebo nulová hodnota znamená „bez jednotek": tam se schválně NEPŘEPOČÍTÁVÁ nic, protože
 * geodetické výkresy v S-JTSK bývají právě takhle a jsou v metrech.
 */
const INSUNITS: Record<number, { m: number; name: string }> = {
  1: { m: 0.0254, name: 'palce' },
  2: { m: 0.3048, name: 'stopy' },
  4: { m: 0.001, name: 'milimetry' },
  5: { m: 0.01, name: 'centimetry' },
  6: { m: 1, name: 'metry' },
  7: { m: 1000, name: 'kilometry' },
}

// AutoCAD Color Index (běžné 1–9); vyšší indexy padnou na barvu hladiny nebo bílou.
const ACI: Record<number, number> = { 1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff, 6: 0xff00ff, 7: 0xffffff, 8: 0x808080, 9: 0xc0c0c0 }

type Pt = [number, number]
type Affine = { a: number; b: number; c: number; d: number; e: number; f: number }
const ID: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
const apply = (t: Affine, x: number, y: number): Pt => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f]
function compose(o: Affine, i: Affine): Affine {
  return {
    a: o.a * i.a + o.c * i.b, b: o.b * i.a + o.d * i.b,
    c: o.a * i.c + o.c * i.d, d: o.b * i.c + o.d * i.d,
    e: o.a * i.e + o.c * i.f + o.e, f: o.b * i.e + o.d * i.f + o.f,
  }
}

/**
 * Jak jemně dělit oblouk: úhel úseku tak, aby se tětiva od oblouku odchýlila nanejvýš o `ARC_TOL`
 * (v jednotkách výkresu — viz `setArcTol`), ale vždy mezi 1° a 5°. Dřív to bylo pevných 7,5°,
 * a na velkém poloměru (oblouk silnice, R 500 m) byly úseky dlouhé desítky metrů a v mapě
 * byly vidět rohy.
 */
let ARC_TOL = 0.005
const segAngle = (r: number) => {
  const a = r > ARC_TOL ? 2 * Math.acos(1 - ARC_TOL / Math.abs(r)) : Math.PI / 36
  return Math.min(Math.PI / 36, Math.max(Math.PI / 180, a))
}

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  let sweep = a1 - a0
  while (sweep <= 0) sweep += 2 * Math.PI
  const n = Math.max(2, Math.ceil(sweep / segAngle(r))), out: Pt[] = []
  for (let i = 0; i <= n; i++) { const t = a0 + sweep * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]) }
  return out
}
function circlePts(cx: number, cy: number, r: number): Pt[] {
  const n = Math.max(24, Math.ceil(2 * Math.PI / segAngle(r))), out: Pt[] = []
  for (let i = 0; i <= n; i++) { const t = 2 * Math.PI * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]) }
  return out
}

// ── spliny ────────────────────────────────────────────────────────────────────────
// Spline se NESMÍ kreslit jako lomená čára přes své body: řídicí body na křivce neleží (je to
// jen „rám", který ji táhne), a i přes body proložení by vyšly rohy. Křivka se proto počítá.

/** kolik vzorků na jeden úsek mezi uzly (a strop na celou křivku) */
const SPLINE_SPAN = 16
const SPLINE_MAX = 4000

/**
 * NURBS křivka (de Boor) — stupeň `p`, řídicí body, uzlový vektor a váhy, jak je píše DXF.
 * Racionální váhy počítá v homogenních souřadnicích, takže sedí i kružnice a oblouky
 * zapsané jako spline. Chybný uzlový vektor nahradí rovnoměrným „sevřeným".
 */
export function nurbsPts(ctrl: Pt[], knotsIn: number[], weightsIn: number[] | null, pIn: number): Pt[] {
  const n = ctrl.length
  if (n < 2) return ctrl.slice()
  const p = Math.max(1, Math.min(pIn || 3, n - 1))
  const knots = knotsIn.length === n + p + 1 && knotsIn.every((k, i) => i === 0 || k >= knotsIn[i - 1]) ? knotsIn : clampedKnots(n, p)
  const w = weightsIn && weightsIn.length === n && weightsIn.every(x => x > 0) ? weightsIn : null
  const P = ctrl.map((c, i) => { const wi = w ? w[i] : 1; return [c[0] * wi, c[1] * wi, wi] })
  const lo = knots[p], hi = knots[n]
  if (!(hi > lo)) return ctrl.slice()
  const evalAt = (u: number): Pt => {
    let k = p
    while (k < n - 1 && u >= knots[k + 1]) k++
    const d = Array.from({ length: p + 1 }, (_, j) => P[j + k - p].slice())
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const a0 = knots[j + k - p], den = knots[j + 1 + k - r] - a0
        const a = den > 0 ? (u - a0) / den : 0
        for (let c = 0; c < 3; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c]
      }
    }
    const q = d[p]
    return q[2] !== 0 ? [q[0] / q[2], q[1] / q[2]] : [q[0], q[1]]
  }
  // Vzorky po úsecích mezi různými uzly. Hustota podle toho, jak moc se v úseku stáčí řídicí
  // rám (~5° na vzorek): rovný kus 2 vzorky, ostrý oblouk až SPLINE_SPAN. Vrstevnice uložené
  // jako spline mají stovky řídicích bodů — s pevnou hustotou by výkres zbytečně ztěžkl.
  const spans: [number, number, number][] = []
  for (let i = p; i < n; i++) if (knots[i + 1] > knots[i]) spans.push([knots[i], knots[i + 1], i])
  const cap = Math.max(2, Math.floor(SPLINE_MAX / Math.max(1, spans.length)))
  const out: Pt[] = [evalAt(lo)]
  for (const [a, b, i] of spans) {
    let turn = 0
    for (let j = Math.max(1, i - p + 1); j <= i && j + 1 < n; j++) turn += turnAngle(ctrl[j - 1], ctrl[j], ctrl[j + 1])
    const per = Math.max(2, Math.min(SPLINE_SPAN, cap, Math.ceil(turn / (Math.PI / 36)) + 1))
    for (let s = 1; s <= per; s++) out.push(evalAt(a + (b - a) * (s / per)))
  }
  return out
}

/** o kolik se lomená čára a → b → c stáčí v bodě b (0 = rovně, π = obrat) */
function turnAngle(a: Pt, b: Pt, c: Pt): number {
  const u = Math.atan2(b[1] - a[1], b[0] - a[0]), v = Math.atan2(c[1] - b[1], c[0] - b[0])
  let d = Math.abs(v - u)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d
}

/** rovnoměrný uzlový vektor, který křivku přitáhne k prvnímu a poslednímu bodu */
function clampedKnots(n: number, p: number): number[] {
  const k: number[] = []
  for (let i = 0; i <= n + p; i++) k.push(i <= p ? 0 : i >= n ? n - p : i - p)
  return k
}

/**
 * Hladká křivka PŘES body (spline zadaný jen body proložení, bez řídicích bodů).
 * Centripetální Catmull-Rom: prochází přesně body a na nerovnoměrně rozložených bodech
 * nedělá smyčky ani hroty (na rozdíl od obyčejného Catmull-Rom).
 */
export function fitCurvePts(fit: Pt[], closed: boolean): Pt[] {
  const n = fit.length
  if (n < 3) return fit.slice()
  const at = (i: number): Pt => closed ? fit[(i + n) % n] : fit[Math.max(0, Math.min(n - 1, i))]
  const out: Pt[] = [fit[0]]
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
    const tj = (a: Pt, b: Pt) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-9
    const t1 = tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3)
    // hustota podle stočení v okolí úseku (jako u NURBS): rovný kus pár bodů, oblouk víc
    const turn = turnAngle(p0, p1, p2) + turnAngle(p1, p2, p3)
    const per = Math.max(2, Math.min(SPLINE_SPAN, Math.ceil(turn / (Math.PI / 36)) + 1))
    for (let s = 1; s <= per; s++) {
      const t = t1 + (t2 - t1) * (s / per)
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
        const f = tb - ta > 1e-12 ? (t - ta) / (tb - ta) : 0
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
      }
      const a1 = lerp(p0, p1, 0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3)
      const b1 = lerp(a1, a2, 0, t2), b2 = lerp(a2, a3, t1, t3)
      out.push(lerp(b1, b2, t1, t2))
    }
  }
  return out
}
function bulgePts(p0: Pt, p1: Pt, bulge: number): Pt[] {
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  if (chord < 1e-9 || Math.abs(bulge) < 1e-9) return []
  const theta = 4 * Math.atan(bulge)
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2))
  const chordAng = Math.atan2(p1[1] - p0[1], p1[0] - p0[0])
  const mid: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2]
  const apo = r * Math.cos(Math.abs(theta) / 2)
  const side = bulge > 0 ? -1 : 1
  const cx = mid[0] + Math.cos(chordAng - Math.PI / 2) * apo * side
  const cy = mid[1] + Math.sin(chordAng - Math.PI / 2) * apo * side
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx)
  const n = Math.max(2, Math.ceil(Math.abs(theta) / segAngle(r))), out: Pt[] = []
  for (let i = 1; i < n; i++) { const t = a0 + theta * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]) }
  return out
}
function polyWithBulges(verts: { x: number; y: number; bulge?: number }[], closed: boolean): Pt[] {
  const pts: Pt[] = [], n = verts.length
  for (let i = 0; i < n; i++) {
    const v = verts[i]
    pts.push([v.x, v.y])
    const next = i + 1 < n ? verts[i + 1] : (closed ? verts[0] : null)
    if (next && v.bulge) pts.push(...bulgePts([v.x, v.y], [next.x, next.y], v.bulge))
  }
  if (closed && n > 1) pts.push([verts[0].x, verts[0].y])
  return pts
}
function ellipsePts(cx: number, cy: number, mx: number, my: number, ratio: number, a0: number, a1: number): Pt[] {
  const major = Math.hypot(mx, my), minor = major * ratio, rot = Math.atan2(my, mx)
  let sweep = a1 - a0
  if (Math.abs(sweep) < 1e-9) sweep = 2 * Math.PI
  while (sweep <= 0) sweep += 2 * Math.PI
  const n = Math.max(8, Math.ceil(sweep / segAngle(major))), out: Pt[] = [], cr = Math.cos(rot), sr = Math.sin(rot)
  for (let i = 0; i <= n; i++) {
    const t = a0 + sweep * (i / n), ex = major * Math.cos(t), ey = minor * Math.sin(t)
    out.push([cx + ex * cr - ey * sr, cy + ex * sr + ey * cr])
  }
  return out
}

// ── tolerantní čtení group codů ──────────────────────────────────────────────────────
type Prop = { code: number; value: string }
type RawEnt = { type: string; props: Prop[]; vertices: RawEnt[] } // vertices = VERTEX u starého POLYLINE

function tokenize(text: string): Prop[] {
  const lines = text.split(/\r\n|\r|\n/)
  const out: Prop[] = []
  const n = lines.length
  let i = 0
  while (i < n) {
    const codeStr = lines[i].trim()
    // Platný group code je celé číslo. Když řádek ve slotu pro kód celé číslo NENÍ, jde o
    // pokračování předchozí hodnoty: některé řetězce (MTEXT/TEXT/XDATA) obsahují vložený znak
    // nového řádku, který split rozseká na víc řádků a rozhodí párování kód/hodnota. Slepíme zpět.
    if (!/^-?\d+$/.test(codeStr)) {
      if (out.length) out[out.length - 1].value += '\n' + lines[i]
      i++
      continue
    }
    if (i + 1 >= n) break
    out.push({ code: parseInt(codeStr, 10), value: lines[i + 1] })
    i += 2
  }
  return out
}
const num = (props: Prop[], code: number, dflt = 0): number => {
  for (const p of props) if (p.code === code) { const n = parseFloat(p.value); return Number.isFinite(n) ? n : dflt }
  return dflt
}
const str = (props: Prop[], code: number): string | undefined => { for (const p of props) if (p.code === code) return p.value.trim(); return undefined }
const flag = (props: Prop[], code: number): number => { const v = num(props, code, 0); return Number.isFinite(v) ? v : 0 }

type Anchor = { x: number; y: number; hAlign: HAlign; vAlign: VAlign; rot: number }

/**
 * TEXT/ATTRIB: kotva a zarovnání.
 *
 * PAST: bod 10/20 je „první bod zarovnání" a je použitelný JEN u textu zarovnaného vlevo na účaří.
 * Jakmile je 72 (vodorovně: 1 střed, 2 vpravo, 4 middle) nebo 73 (svisle) nenulové, skutečná
 * pozice je v 11/21 a v 10/20 bývá nesmysl (často 0,0) — proto texty létaly mimo výkres a rozbíjely
 * i bounding box celé kresby. U 72=3 (aligned) a 72=5 (fit) je text roztažený MEZI 10/20 a 11/21,
 * takže kotvou zůstává 10/20.
 */
function textAnchor(props: Prop[]): Anchor {
  const h = flag(props, 72), v = flag(props, 73)
  const stretched = h === 3 || h === 5
  const useSecond = !stretched && (h !== 0 || v !== 0)
  return {
    x: useSecond ? num(props, 11) : num(props, 10),
    y: useSecond ? num(props, 21) : num(props, 20),
    hAlign: stretched ? 0 : h === 1 || h === 4 ? 1 : h === 2 ? 2 : 0,
    vAlign: stretched ? 0 : h === 4 || v === 2 ? 1 : v === 3 ? 2 : 0, // 72=4 (middle) = svisle na střed
    rot: num(props, 50) * Math.PI / 180,
  }
}

/**
 * MTEXT: kotva je vždy 10/20, zarovnání dává 71 (1=vlevo nahoře … 9=vpravo dole).
 *
 * PAST: 11/21/31 u MTEXTu NENÍ druhý bod zarovnání jako u TEXTu, ale směrový vektor osy X — a má
 * PŘEDNOST před úhlem v 50. Kreslení podle 50 proto u otočených MTEXTů dávalo špatný sklon.
 * (Specifikace DXF navíc u MTEXT/50 chybně uvádí radiány; AutoCAD píše stupně.)
 */
function mtextAnchor(props: Prop[]): Anchor {
  const ap = flag(props, 71) || 1
  const dx = num(props, 11), dy = num(props, 21)
  return {
    x: num(props, 10),
    y: num(props, 20),
    hAlign: ((ap - 1) % 3) as HAlign,
    vAlign: ap <= 3 ? 2 : ap <= 6 ? 1 : 0,
    rot: dx || dy ? Math.atan2(dy, dx) : num(props, 50) * Math.PI / 180,
  }
}

/** rozparsuje DXF na hladiny + bloky + entity model space; nikdy nevyhazuje na nečekané hodnoty */
function parseStructure(toks: Prop[]) {
  const layers: Record<string, number> = {}
  const blocks: Record<string, { entities: RawEnt[] }> = {}
  const entities: RawEnt[] = []
  /** proměnné z HEADERu: `9` nese jméno, hodnota je v tokenu hned za ním */
  const header: Record<string, string> = {}

  const readEnt = (i: number): { ent: RawEnt; next: number } => {
    const type = toks[i].value.trim()
    const props: Prop[] = []
    let j = i + 1
    for (; j < toks.length && toks[j].code !== 0; j++) props.push(toks[j])
    return { ent: { type, props, vertices: [] }, next: j }
  }

  let section = ''
  let i = 0
  while (i < toks.length) {
    const t = toks[i]
    if (section === 'HEADER' && t.code === 9) {
      const name = t.value.trim()
      const val = toks[i + 1]
      if (val && val.code !== 9 && val.code !== 0) header[name] = val.value.trim()
      i += 2
      continue
    }
    if (t.code !== 0) { i++; continue }
    const marker = t.value.trim()
    if (marker === 'SECTION') { section = i + 1 < toks.length && toks[i + 1].code === 2 ? toks[i + 1].value.trim() : ''; i += 2; continue }
    if (marker === 'ENDSEC') { section = ''; i++; continue }
    if (marker === 'EOF') break

    if (section === 'TABLES') {
      const { ent, next } = readEnt(i)
      if (ent.type === 'LAYER') { const nm = str(ent.props, 2); if (nm) layers[nm] = layerColor(ent.props) }
      i = next; continue
    }
    if (section === 'BLOCKS') {
      if (marker === 'BLOCK') {
        const { ent, next } = readEnt(i)
        const name = str(ent.props, 2) ?? ''
        const blk = { entities: [] as RawEnt[] }
        let k = next
        while (k < toks.length && !(toks[k].code === 0 && toks[k].value.trim() === 'ENDBLK')) {
          if (toks[k].code === 0) { k = readEntityInto(toks, k, blk.entities, readEnt); continue }
          k++
        }
        if (name) blocks[name] = blk
        // přeskoč ENDBLK
        i = k < toks.length ? k + 1 : k
        continue
      }
      const { next } = readEnt(i); i = next; continue
    }
    if (section === 'ENTITIES') { i = readEntityInto(toks, i, entities, readEnt); continue }

    const { next } = readEnt(i); i = next // jiná sekce → přeskoč
  }
  return { layers, blocks, entities, header }
}

// přečte entitu do pole; starý POLYLINE spolkne následující VERTEX až po SEQEND
function readEntityInto(toks: Prop[], i: number, into: RawEnt[], readEnt: (i: number) => { ent: RawEnt; next: number }): number {
  const { ent, next } = readEnt(i)
  if (ent.type === 'POLYLINE') {
    let k = next
    while (k < toks.length && toks[k].code === 0) {
      const m = toks[k].value.trim()
      if (m === 'VERTEX') { const r = readEnt(k); ent.vertices.push(r.ent); k = r.next; continue }
      if (m === 'SEQEND') { const r = readEnt(k); k = r.next; break }
      break
    }
    into.push(ent)
    return k
  }
  if (ent.type === 'INSERT') {
    // atributy bloku (ATTRIB) mohou následovat za INSERT až po SEQEND (jako VERTEX u POLYLINE)
    let k = next
    while (k < toks.length && toks[k].code === 0) {
      const m = toks[k].value.trim()
      if (m === 'ATTRIB') { const r = readEnt(k); ent.vertices.push(r.ent); k = r.next; continue }
      if (m === 'SEQEND') { const r = readEnt(k); k = r.next; break }
      break
    }
    into.push(ent)
    return k
  }
  into.push(ent)
  return next
}

function layerColor(props: Prop[]): number {
  const tc = str(props, 420)
  if (tc !== undefined) { const n = parseInt(tc, 10); if (Number.isFinite(n)) return n & 0xffffff }
  const ci = Math.abs(flag(props, 62))
  return ACI[ci] ?? 0xffffff
}

/**
 * Vyčistí MTEXT/TEXT řetězec z DXF: dekóduje `\U+XXXX` unicode, stacking `\S…^…;`, odstraní
 * formátovací kódy (`\A;`, `\C;`, `\f…;`, `\H;`, `\P`…), TEXT `%%` kódy a řídící `^X` znaky.
 * Bez tohohle vyjdou popisky zprzněné (např. „…U+2030203020…") nebo prázdné.
 */
export function cleanDxfText(raw: string): string {
  let s = raw
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))) // unicode
  s = s.replace(/\\S([^;]*?)[\^/#]([^;]*?);/g, (_m, a: string, b: string) => b.trim() ? `${a.trim()}/${b.trim()}` : a.trim()) // stacking „nad/pod"
  s = s.replace(/\\P/g, ' ').replace(/\\~/g, ' ')                 // odstavec / nezlom. mezera
  s = s.replace(/\\[A-Za-z][^;\\]*;/g, '')                        // formátovací kódy s ; (font/barva/výška…)
  s = s.replace(/\\[LlOoKk]/g, '')                                // pod/nad/přeškrt on/off
  s = s.replace(/[{}]/g, '')                                      // seskupovací závorky
  s = s.replace(/%%[dD]/g, '°').replace(/%%[cC]/g, '⌀').replace(/%%[pP]/g, '±').replace(/%%%/g, '%').replace(/%%[uUoO]/g, '') // TEXT %% kódy
  s = s.replace(/\^[IJM]/g, ' ')                                  // řídící ^I/^J/^M
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * DXF přečtený s ohledem na kódování.
 *
 * AutoCAD u nás ukládá DXF ve WINDOWS-1250, ne v UTF-8 — `file.text()` z toho udělá
 * otazníky v každé diakritice. Pozná se to spolehlivě: dekodér UTF-8 vloží U+FFFD všude,
 * kde bajty nedávají smysl. Když se takový znak objeví, přečte se soubor znovu jako 1250.
 */
export function decodeDxf(buf: ArrayBuffer): string {
  const utf = new TextDecoder('utf-8').decode(buf)
  return utf.includes('�') ? new TextDecoder('windows-1250').decode(buf) : utf
}

export function dxfToPrims(text: string): DrawParse {
  const toks = tokenize(text)
  if (!toks.length) throw new Error('DXF je prázdný nebo není textový (binární DXF nepodporujeme)')
  const { layers, blocks, entities, header } = parseStructure(toks)
  const headerUnit = INSUNITS[parseInt(header.$INSUNITS ?? '', 10)]
  // dělení oblouků: odchylka tětivy nanejvýš 5 mm (v jednotkách výkresu podle hlavičky;
  // když hlavička lže, aspoň ten úhlový strop 1–5° drží oblouk hladký)
  ARC_TOL = 0.005 / (headerUnit?.m ?? 1)

  const prims: DrawPrim[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const track = (x: number, y: number) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }

  const colorOf = (e: RawEnt, inherit: number): number => {
    const tc = str(e.props, 420)
    if (tc !== undefined) { const n = parseInt(tc, 10); if (Number.isFinite(n)) return n & 0xffffff }
    const ci = flag(e.props, 62)
    if (ci > 0 && ci !== 256) return ACI[ci] ?? 0xffffff
    const ly = str(e.props, 8)
    if (ly && layers[ly] != null) return layers[ly]
    return inherit
  }
  const pushPoly = (raw: Pt[], tf: Affine, layer: string, color: number) => {
    if (raw.length < 2) return
    const pts = raw.map(([x, y]) => { const p = apply(tf, x, y); track(p[0], p[1]); return p })
    prims.push({ kind: 'poly', pts, layer, color })
  }
  // Text musí sledovat transformaci bloku: INSERT může být otočený i vnořený, takže sklon i výšku
  // bereme z výsledné matice, ne jen z group codů entity.
  const pushText = (props: Prop[], a: Anchor, txt: string, tf: Affine, layer: string, color: number) => {
    const p = apply(tf, a.x, a.y); track(p[0], p[1])
    const scaleY = Math.hypot(tf.c, tf.d) || 1
    prims.push({
      kind: 'text', pt: p, text: txt, layer, color,
      height: num(props, 40, 2) * scaleY,
      rot: a.rot + Math.atan2(tf.b, tf.a),
      hAlign: a.hAlign, vAlign: a.vAlign,
    })
  }

  const emit = (e: RawEnt, tf: Affine, inherit: number, depth: number) => {
    const layer = str(e.props, 8) ?? '0'
    const color = colorOf(e, inherit)
    switch (e.type) {
      case 'LINE':
        pushPoly([[num(e.props, 10), num(e.props, 20)], [num(e.props, 11), num(e.props, 21)]], tf, layer, color)
        break
      case 'LWPOLYLINE': {
        const vs: { x: number; y: number; bulge?: number }[] = []
        for (const p of e.props) {
          if (p.code === 10) vs.push({ x: parseFloat(p.value) || 0, y: 0 })
          else if (p.code === 20 && vs.length) vs[vs.length - 1].y = parseFloat(p.value) || 0
          else if (p.code === 42 && vs.length) vs[vs.length - 1].bulge = parseFloat(p.value) || 0
        }
        if (vs.length) pushPoly(polyWithBulges(vs, (flag(e.props, 70) & 1) === 1), tf, layer, color)
        break
      }
      case 'POLYLINE': {
        const pf = flag(e.props, 70)
        const closed = (pf & 1) === 1
        const vflag = (vx: RawEnt) => flag(vx.props, 70)
        const xy = (vx: RawEnt): Pt => [num(vx.props, 10), num(vx.props, 20)]
        /**
         * Polylinie vyhlazená na spline (PEDIT → Spline, 70 & 4) nese DVĚ sady vrcholů: řídicí
         * rám (VERTEX 70 & 16) a body spočítané křivky (70 & 8). Rám na křivce neleží — kreslit
         * ho s ní dávalo zuby a rohy. Kreslí se jen spočítané body; když v souboru chybí,
         * křivka se dopočítá z rámu (kvadratická / kubická podle 75).
         */
        if (pf & 4) {
          const fitted = e.vertices.filter(vx => vflag(vx) & 8).map(xy)
          if (fitted.length >= 2) { pushPoly(closed ? [...fitted, fitted[0]] : fitted, tf, layer, color); break }
          const frame = e.vertices.filter(vx => vflag(vx) & 16).map(xy)
          const pts = frame.length >= 2 ? frame : e.vertices.map(xy)
          const deg = flag(e.props, 75) === 5 ? 2 : 3
          pushPoly(nurbsPts(closed ? [...pts, pts[0]] : pts, [], null, deg), tf, layer, color)
          break
        }
        // jinak běžná polylinie (i „curve fit", 70 & 2: přidané vrcholy leží na křivce)
        const vs = e.vertices.filter(vx => !(vflag(vx) & 16)).map(vx => ({ x: num(vx.props, 10), y: num(vx.props, 20), bulge: num(vx.props, 42) || undefined }))
        if (vs.length) pushPoly(polyWithBulges(vs, closed), tf, layer, color)
        break
      }
      case 'CIRCLE':
        pushPoly(circlePts(num(e.props, 10), num(e.props, 20), num(e.props, 40)), tf, layer, color)
        break
      case 'ARC':
        pushPoly(arcPts(num(e.props, 10), num(e.props, 20), num(e.props, 40), num(e.props, 50) * Math.PI / 180, num(e.props, 51) * Math.PI / 180), tf, layer, color)
        break
      case 'ELLIPSE':
        pushPoly(ellipsePts(num(e.props, 10), num(e.props, 20), num(e.props, 11), num(e.props, 21), num(e.props, 40, 1), num(e.props, 41, 0), num(e.props, 42, 2 * Math.PI)), tf, layer, color)
        break
      case 'SPLINE': {
        // řídicí body (10/20) s uzly (40) a váhami (41), případně jen body proložení (11/21)
        const fit: Pt[] = [], ctrl: Pt[] = [], knots: number[] = [], weights: number[] = []
        for (let k = 0; k < e.props.length; k++) {
          const p = e.props[k], v = parseFloat(p.value) || 0
          if (p.code === 11) fit.push([v, 0])
          else if (p.code === 21 && fit.length) fit[fit.length - 1][1] = v
          else if (p.code === 10) ctrl.push([v, 0])
          else if (p.code === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = v
          else if (p.code === 40) knots.push(v)
          else if (p.code === 41) weights.push(v)
        }
        const closed = (flag(e.props, 70) & 1) === 1
        // Křivka se počítá z řídicích bodů — ty ji definují přesně. Body proložení jsou až
        // druhá volba (AutoCAD je píše jen pro úpravy); bez řídicích se jimi křivka proloží.
        if (ctrl.length >= 2) pushPoly(nurbsPts(ctrl, knots, weights.length ? weights : null, flag(e.props, 71) || 3), tf, layer, color)
        else if (fit.length >= 2) pushPoly(fitCurvePts(fit, closed), tf, layer, color)
        break
      }
      case 'SOLID':
      case '3DFACE': {
        const c: Pt[] = [[num(e.props, 10), num(e.props, 20)], [num(e.props, 11), num(e.props, 21)], [num(e.props, 12), num(e.props, 22)]]
        const has4 = e.props.some(p => p.code === 13)
        if (has4) c.push([num(e.props, 13), num(e.props, 23)])
        c.push(c[0])
        pushPoly(c, tf, layer, color)
        break
      }
      case 'POINT': {
        const p = apply(tf, num(e.props, 10), num(e.props, 20)); track(p[0], p[1])
        prims.push({ kind: 'point', pt: p, layer, color })
        break
      }
      case 'TEXT':
      case 'MTEXT': {
        const raw = e.props.filter(p => p.code === 1 || p.code === 3).map(p => p.value).join('')
        const clean = cleanDxfText(raw)
        // TEXT a MTEXT vypadají podobně, ale kotvu i rotaci kódují jinak — viz textAnchor/mtextAnchor
        if (clean) pushText(e.props, e.type === 'MTEXT' ? mtextAnchor(e.props) : textAnchor(e.props), clean, tf, layer, color)
        break
      }
      case 'INSERT': {
        if (depth > 8) break
        const sx = num(e.props, 41, 1), sy = num(e.props, 42, 1), rot = num(e.props, 50) * Math.PI / 180
        const cr = Math.cos(rot), sr = Math.sin(rot)
        const local: Affine = { a: cr * sx, b: sr * sx, c: -sr * sy, d: cr * sy, e: num(e.props, 10), f: num(e.props, 20) }
        const blk = blocks[str(e.props, 2) ?? '']
        if (blk?.entities.length) { const t2 = compose(tf, local); for (const be of blk.entities) emit(be, t2, color, depth + 1) }
        // ATTRIB (hodnoty atributů) — pozice už je v prostoru INSERTu, kreslíme přes `tf`.
        // Zarovnání se čte stejně jako u TEXTu (ATTRIB má tytéž group cody).
        for (const at of e.vertices) {
          if (at.type !== 'ATTRIB') continue
          const clean = cleanDxfText(at.props.filter(pp => pp.code === 1 || pp.code === 3).map(pp => pp.value).join(''))
          if (!clean) continue
          pushText(at.props, textAnchor(at.props), clean, tf, str(at.props, 8) ?? layer, colorOf(at, color))
        }
        break
      }
    }
  }

  for (const e of entities) emit(e, ID, 0xffffff, 0)
  if (!prims.length) throw new Error('DXF neobsahuje žádnou kresbu (podporované: čáry, polylinie, kružnice, oblouky, texty, bloky)')

  // jeden reprezentativní bod na prvek → medián a percentily (viz `midX` u DrawParse);
  // počítá se ze souřadnic, jak jsou v souboru — podle mediánu se rozhodují i jednotky
  const xs: number[] = [], ys: number[] = []
  for (const p of prims) {
    const q = p.kind === 'poly' ? p.pts[0] : p.pt
    xs.push(q[0]); ys.push(q[1])
  }
  xs.sort((m, n) => m - n); ys.sort((m, n) => m - n)
  const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * f)))]
  const { unit, unitName, unitNote } = pickUnit(q(xs, 0.5), q(ys, 0.5), headerUnit)

  /**
   * Přepočet na metry se dělá až tady, jedním průchodem přes hotové prvky.
   *
   * Škálovat průběžně v `emit` by znamenalo nepřehodit ani jedno z mnoha míst, kde souřadnice
   * vznikají (bulge oblouky, rozbalené bloky, kotvy textů) — a to je přesně ten druh úpravy,
   * u které se na jedno místo zapomene. Takhle je to jedno místo a platí pro všechno.
   */
  if (unit !== 1) {
    for (const p of prims) {
      if (p.kind === 'poly') for (const pt of p.pts) { pt[0] *= unit; pt[1] *= unit }
      else { p.pt[0] *= unit; p.pt[1] *= unit; if (p.kind === 'text') p.height *= unit }
    }
    minX *= unit; minY *= unit; maxX *= unit; maxY *= unit
  }
  // kladné násobení pořadí nemění — medián a percentily stačí přepočítat
  const s = (a: number[], f: number) => q(a, f) * unit
  return {
    prims, minX, minY, maxX, maxY, unit, unitName, unitNote,
    midX: s(xs, 0.5), midY: s(ys, 0.5),
    coreMinX: s(xs, 0.02), coreMinY: s(ys, 0.02),
    coreMaxX: s(xs, 0.98), coreMaxY: s(ys, 0.98),
  }
}
