/**
 * Řez vysázený na papír — normovaný formát, pevné měřítko, rámeček a rohové razítko.
 *
 * Na obrazovce se výkres kreslí „na okno": měřítko je jen zoom a jednotky jsou pixely
 * viewBoxu. Na papíře to takhle nejde. Tady je celý list v MILIMETRECH, měřítko je pevné
 * (1:50, 1:100…) a metr modelu je na papíře přesně `1000 / měřítko` mm — takže se z výtisku
 * dá měřit pravítkem a výkres se dá odevzdat.
 *
 * Tloušťky čar jsou taky v mm podle toho, co která čára znamená: řezná hrana nejsilnější,
 * pohled slabší, zakrytá čára nejslabší a čárkovaně. To je celý rozdíl mezi „obrázek modelu"
 * a „výkres".
 */
import type { Pt2, SectionPoly, SectionResult } from './sectionCut'
import { fmtLen, polySegments } from './sectionCut'
import { placeLabels } from './labels'

export type SheetFormat = 'A4' | 'A3' | 'A2'

/** rozměry na výšku v mm; na šířku se prohodí */
const PAPER: Record<SheetFormat, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
}

/** normovaná měřítka, od největšího výkresu k nejmenšímu */
export const SCALES = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000]

/** rámeček: vlevo místo na sešití, jinde jen odsazení */
const MARGIN = { left: 20, right: 10, top: 10, bottom: 10 }
const BLOCK_W = 180
const BLOCK_H = 45

/**
 * Pera výkresu — jediná definice pro papír i pro obrazovku.
 *
 * Tloušťky jsou v milimetrech, protože autoritou je papír: normovaná řada per a čárkování
 * v mm je to, co se opravdu vytiskne. Okno si z nich odvodí své jednotky (`penScreen`),
 * takže co vidíš, je co dostaneš — dřív to byly dvě nezávislé tabulky a rozcházely se.
 */
export const PENS: Record<string, { mm: number; dash?: [number, number] }> = {
  cut: { mm: 0.5 },                        // řezná hrana, uzavřený obrys
  cutOpen: { mm: 0.35, dash: [2.4, 1.6] }, // řezná čára bez uzavřeného obrysu
  nearby: { mm: 0.35 },                    // objekt přibraný z okolí roviny
  context: { mm: 0.18, dash: [2.4, 1.6] }, // řez z tloušťky, mimo hlavní rovinu
  view: { mm: 0.18 },                      // viditelná hrana pohledu
  viewHidden: { mm: 0.13, dash: [1.6, 1.2] }, // zakrytá hrana pohledu
  thin: { mm: 0.13 },                      // kóty a rámeček uvnitř
  frame: { mm: 0.7 },                      // vnější rámeček a razítko
}

/**
 * Pero přepočtené na jednotky viewBoxu okna.
 *
 * Spodní mez je schválně: 0,13mm čára by na obrazovce vyšla na půl jednotky a na tmavém
 * podkladu by zmizela. Pořadí tlouštěk zůstává, jen se nejtenčí pera srovnají na čitelné
 * minimum — na papíře se pak vytisknou tak, jak mají.
 */
export function penScreen(kind: keyof typeof PENS | string): { width: number; dash?: string } {
  const pen = PENS[kind] ?? PENS.view
  const UNITS_PER_MM = 4
  const MIN = 0.9
  return {
    width: Math.max(pen.mm * UNITS_PER_MM, MIN),
    dash: pen.dash ? pen.dash.map(d => (d * UNITS_PER_MM).toFixed(1)).join(' ') : undefined,
  }
}

/** tloušťky čar v mm — odvozené z per, ať se to nepíše dvakrát */
const LW = {
  cut: PENS.cut.mm,
  cutOpen: PENS.cutOpen.mm,
  nearby: PENS.nearby.mm,
  context: PENS.context.mm,
  view: PENS.view.mm,
  viewHidden: PENS.viewHidden.mm,
  thin: PENS.thin.mm,
  frame: PENS.frame.mm,
}

/**
 * Co je na papíře menší než tohle (mm), se nekreslí.
 *
 * V měřítku 1:1000 je sloupek zábradlí široký 8 SETIN milimetru, ale čára, kterou by se
 * kreslil, má 0,18 mm — dvakrát tolik. Sto takových sloupků vedle sebe nedá výkres, ale
 * šedý flek, ve kterém nejde nic přečíst. Detail jemnější než pero se prostě nerýsuje; na
 * ten je podrobnější měřítko nebo výřez.
 */
const MIN_PAPER_MM = 0.3

/**
 * Na obrysy POHLEDU je práh přísnější.
 *
 * Řez nese rozměry, ten se kreslí, dokud jde. Pohled je jen doplněk — a zábradlí, jehož
 * sloupky jsou v 1:1000 od sebe půldruhého milimetru, z něj nedělá informaci, ale mřížku
 * přes celý výkres. Rýsuje se to stejně: v přehledovém měřítku se zábradlí naznačí čarou,
 * ne sloupek po sloupku. V 1:200 je týž sloupek přes 5 mm vysoký a nakreslí se.
 */
const MIN_VIEW_MM = 1.2

export interface TitleBlock {
  stavba: string
  objekt: string
  vykres: string
  vypracoval: string
  datum: string
  cislo: string
}

export interface SheetOptions {
  format: SheetFormat
  landscape: boolean
  /** 1:`scale`; 0 = dopočítat nejbližší normované, aby se výkres vešel */
  scale: number
  title: TitleBlock
  color: (key: string) => string
  keyOf: (p: SectionPoly) => string
  /** kóty jednotlivých úseků obrysu */
  dims: boolean
  /** obrysy pohledu: vše / jen viditelné / vypnuto */
  lines: 'all' | 'visible' | 'off'
  /** šrafovat řezné plochy podle materiálu */
  hatch: boolean
  measures: { a: Pt2; b: Pt2 }[]
  /** výškové body: místo ve výkrese a nadmořská výška v soustavě modelu */
  levels?: { p: Pt2; z: number }[]
}

export interface Sheet {
  svg: string
  /** použité měřítko (1:`scale`) */
  scale: number
  /** vešel se výkres do kreslicí plochy? */
  fits: boolean
  widthMm: number
  heightMm: number
}

const esc = (s: string) => s.replace(/[<>&"]/g, c => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;'))
const f = (n: number) => (Math.round(n * 1000) / 1000).toString()

/** kreslicí plocha uvnitř rámečku, bez místa zabraného razítkem */
function contentArea(format: SheetFormat, landscape: boolean) {
  const [pw, ph] = PAPER[format]
  const W = landscape ? ph : pw
  const H = landscape ? pw : ph
  const x = MARGIN.left
  const y = MARGIN.top
  const w = W - MARGIN.left - MARGIN.right
  const h = H - MARGIN.top - MARGIN.bottom - BLOCK_H
  return { W, H, x, y, w, h }
}

/** nejmenší normované měřítko, do kterého se výkres ještě vejde */
export function fitScale(r: SectionResult, format: SheetFormat, landscape: boolean): number {
  const a = contentArea(format, landscape)
  // kolem výkresu se nechá místo na kóty a popisy
  const w = Math.max(a.w - 24, 10)
  const h = Math.max(a.h - 24, 10)
  for (const s of SCALES) {
    const k = 1000 / s
    if (r.width * k <= w && r.height * k <= h) return s
  }
  return SCALES[SCALES.length - 1]
}

/**
 * Rozměry listu a použité měřítko — bez sestavování SVG.
 *
 * Panel potřebuje jen ukázat „vyjde na 1:100"; skládat kvůli tomu celý list (u velkého
 * pohledu statisíce čísel) při každém kliknutí myší by okno zbytečně brzdilo.
 */
export function sheetInfo(r: SectionResult, format: SheetFormat, landscape: boolean, scale: number) {
  const area = contentArea(format, landscape)
  const used = scale > 0 ? scale : fitScale(r, format, landscape)
  const k = 1000 / used
  return {
    scale: used,
    fits: r.width * k <= area.w && r.height * k <= area.h,
    widthMm: area.W,
    heightMm: area.H,
  }
}

/** Vysází řez na list papíru. Vrací hotové SVG v milimetrech. */
export function sectionSheet(r: SectionResult, opts: SheetOptions): Sheet {
  const area = contentArea(opts.format, opts.landscape)
  const { scale, fits } = sheetInfo(r, opts.format, opts.landscape, opts.scale)
  const k = 1000 / scale                                  // mm na metr

  // výkres na střed kreslicí plochy
  const cx = (r.minU + r.maxU) / 2
  const cy = (r.minV + r.maxV) / 2
  const ox = area.x + area.w / 2
  const oy = area.y + area.h / 2
  const X = (u: number) => ox + (u - cx) * k
  const Y = (v: number) => oy - (v - cy) * k
  const P = (p: Pt2) => f(X(p[0])) + ',' + f(Y(p[1]))

  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${area.W}mm" height="${area.H}mm" ` +
    `viewBox="0 0 ${area.W} ${area.H}" font-family="Arial, Helvetica, sans-serif">`,
  )
  out.push(`<rect width="${area.W}" height="${area.H}" fill="#ffffff"/>`)

  // ── šrafovací vzory podle skupin ────────────────────────────────────────────
  const keys: string[] = []
  for (const p of r.polys) {
    if (p.projected || p.nearby || p.depth !== 0) continue
    const key = opts.keyOf(p)
    if (!keys.includes(key)) keys.push(key)
  }
  if (opts.hatch && keys.length) {
    out.push('<defs>')
    keys.forEach((key, i) => {
      // střídavý sklon, ať sousední materiály nesplývají — jako v CADu
      const rot = i % 2 ? -45 : 45
      const gap = 1.6 + (i % 3) * 0.9
      out.push(
        `<pattern id="h${i}" patternUnits="userSpaceOnUse" width="${f(gap)}" height="${f(gap)}" patternTransform="rotate(${rot})">` +
        `<line x1="0" y1="0" x2="0" y2="${f(gap)}" stroke="${opts.color(key)}" stroke-width="0.13"/></pattern>`,
      )
    })
    out.push('</defs>')
  }

  // ── výplně řezných ploch ────────────────────────────────────────────────────
  /** nejmenší prvek, který se na papíře dá nakreslit, přepočtený do metrů modelu */
  const minDraw = MIN_PAPER_MM / k
  const minView = MIN_VIEW_MM / k
  const drawable = (p: SectionPoly) => {
    if (p.projected && (opts.lines === 'off' || (p.hidden && opts.lines === 'visible'))) return false
    return Math.max(p.width, p.height) >= (p.projected ? minView : minDraw)
  }

  if (opts.hatch) {
    for (const p of r.polys) {
      if (!p.closed || p.hole || p.projected || p.nearby || p.depth !== 0) continue
      if (Math.max(p.width, p.height) < minDraw) continue
      const i = keys.indexOf(opts.keyOf(p))
      out.push(`<polygon points="${p.pts.map(P).join(' ')}" fill="url(#h${i < 0 ? 0 : i})" stroke="none"/>`)
    }
    // díry se vybílí až po šrafách — jinak by se šrafovaly i ony
    for (const p of r.polys) {
      if (!p.closed || !p.hole || p.projected) continue
      out.push(`<polygon points="${p.pts.map(P).join(' ')}" fill="#ffffff" stroke="none"/>`)
    }
  }

  // ── čáry ────────────────────────────────────────────────────────────────────
  for (const p of r.polys) {
    if (!drawable(p)) continue
    const pts = p.pts.map(P).join(' ')
    const ctxLine = p.depth !== 0 && !p.nearby
    const width = p.projected ? (p.hidden ? LW.viewHidden : LW.view)
      : ctxLine ? LW.context
      : p.nearby ? LW.nearby
      : p.closed ? LW.cut : LW.cutOpen
    // řez je barevný i mimo hlavní rovinu; šedý je jen pohled
    const stroke = p.projected ? '#4b5563' : opts.color(opts.keyOf(p))
    const pen = p.projected ? (p.hidden ? PENS.viewHidden : PENS.view)
      : ctxLine ? PENS.context
      : p.closed ? PENS.cut : PENS.cutOpen
    const dash = pen.dash ? ` stroke-dasharray="${pen.dash[0]} ${pen.dash[1]}"` : ''
    out.push(`<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"${dash}/>`)
  }

  // ── kóty úseků ──────────────────────────────────────────────────────────────
  if (opts.dims) {
    const cand: { x: number; y: number; w: number; h: number; angle: number; text: string; len: number }[] = []
    for (const p of r.polys) {
      if (p.hidden || (p.depth !== 0 && !p.nearby && !p.projected)) continue
      if (p.projected && opts.lines === 'off') continue
      if (Math.max(p.width, p.height) < minDraw) continue
      for (const s of polySegments(p)) {
        // na papíře rozhoduje délka v mm: pod 12 mm se text nevejde
        if (s.length * k < 12) continue
        const x1 = X(s.a[0]), y1 = Y(s.a[1]), x2 = X(s.b[0]), y2 = Y(s.b[1])
        let deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
        if (deg > 90) deg -= 180
        if (deg < -90) deg += 180
        const text = fmtLen(s.length) + ' · ' + s.angle.toFixed(1) + '°'
        cand.push({
          x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 1,
          w: text.length * 1.25, h: 2.6, angle: deg, text, len: s.length * k,
        })
      }
    }
    // nejdřív dlouhé úseky, ty nesou nejvíc informace; co se nevejde, vypadne
    cand.sort((a, b) => b.len - a.len)
    for (const c of placeLabels(cand, { pad: 0.4, max: 200 })) {
      out.push(
        `<text x="${f(c.x)}" y="${f(c.y)}" transform="rotate(${c.angle.toFixed(1)} ${f(c.x)} ${f(c.y)})" ` +
        `text-anchor="middle" font-size="2.2" fill="#374151">${esc(c.text)}</text>`,
      )
    }
  }

  // ── celkové kóty pod a vlevo od výkresu ─────────────────────────────────────
  if (r.polys.length) {
    const off = 7
    const tick = 1.6
    const x1 = X(r.minU), x2 = X(r.maxU)
    const yb = Y(r.minV) + off
    out.push(`<g stroke="#b45309" fill="#b45309" stroke-width="${LW.thin}">`)
    out.push(`<line x1="${f(x1)}" y1="${f(yb)}" x2="${f(x2)}" y2="${f(yb)}"/>`)
    out.push(`<line x1="${f(x1)}" y1="${f(yb - tick)}" x2="${f(x1)}" y2="${f(yb + tick)}"/>`)
    out.push(`<line x1="${f(x2)}" y1="${f(yb - tick)}" x2="${f(x2)}" y2="${f(yb + tick)}"/>`)
    out.push(`<text x="${f((x1 + x2) / 2)}" y="${f(yb - 1.4)}" text-anchor="middle" font-size="2.8" stroke="none">${esc(fmtLen(r.width))}</text>`)
    const yv1 = Y(r.minV), yv2 = Y(r.maxV)
    const xl = X(r.minU) - off
    out.push(`<line x1="${f(xl)}" y1="${f(yv1)}" x2="${f(xl)}" y2="${f(yv2)}"/>`)
    out.push(`<line x1="${f(xl - tick)}" y1="${f(yv1)}" x2="${f(xl + tick)}" y2="${f(yv1)}"/>`)
    out.push(`<line x1="${f(xl - tick)}" y1="${f(yv2)}" x2="${f(xl + tick)}" y2="${f(yv2)}"/>`)
    const my = (yv1 + yv2) / 2
    out.push(
      `<text x="${f(xl - 1.4)}" y="${f(my)}" text-anchor="middle" font-size="2.8" stroke="none" ` +
      `transform="rotate(-90 ${f(xl - 1.4)} ${f(my)})">${esc(fmtLen(r.height))}</text>`,
    )
    out.push('</g>')
  }

  // ── ruční měření ────────────────────────────────────────────────────────────
  for (const m of opts.measures) {
    const x1 = X(m.a[0]), y1 = Y(m.a[1]), x2 = X(m.b[0]), y2 = Y(m.b[1])
    const dist = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1])
    out.push(`<g stroke="#0369a1" fill="#0369a1" stroke-width="${LW.thin}">`)
    out.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`)
    out.push(`<circle cx="${f(x1)}" cy="${f(y1)}" r="0.6" stroke="none"/><circle cx="${f(x2)}" cy="${f(y2)}" r="0.6" stroke="none"/>`)
    out.push(`<text x="${f((x1 + x2) / 2)}" y="${f((y1 + y2) / 2 - 1.4)}" text-anchor="middle" font-size="2.5" stroke="none">${esc(fmtLen(dist))}</text></g>`)
  }

  // ── výškové body ────────────────────────────────────────────────────────────
  for (const lv of opts.levels ?? []) {
    const x = X(lv.p[0])
    const y = Y(lv.p[1])
    // trojúhelníček špičkou do bodu a nad ním výška — jak se výškové kóty kreslí
    out.push(
      `<g stroke="#111827" fill="#111827" stroke-width="${LW.thin}">` +
      `<path d="M${f(x)} ${f(y)} L${f(x - 1.6)} ${f(y - 2.8)} L${f(x + 1.6)} ${f(y - 2.8)} Z" fill="none"/>` +
      `<line x1="${f(x - 3.2)}" y1="${f(y - 2.8)}" x2="${f(x + 3.2)}" y2="${f(y - 2.8)}"/>` +
      `<text x="${f(x)}" y="${f(y - 3.6)}" text-anchor="middle" font-size="2.6" stroke="none">` +
      `${esc(lv.z.toFixed(3))}</text></g>`,
    )
  }

  // ── rámeček ─────────────────────────────────────────────────────────────────
  out.push(
    `<rect x="${MARGIN.left}" y="${MARGIN.top}" width="${f(area.W - MARGIN.left - MARGIN.right)}" ` +
    `height="${f(area.H - MARGIN.top - MARGIN.bottom)}" fill="none" stroke="#111827" stroke-width="${LW.frame}"/>`,
  )

  // ── rohové razítko ──────────────────────────────────────────────────────────
  const bx = area.W - MARGIN.right - BLOCK_W
  const by = area.H - MARGIN.bottom - BLOCK_H
  const t = opts.title
  out.push(`<g transform="translate(${f(bx)} ${f(by)})">`)
  out.push(`<rect width="${BLOCK_W}" height="${BLOCK_H}" fill="#ffffff" stroke="#111827" stroke-width="${LW.frame}"/>`)
  out.push(`<line x1="110" y1="0" x2="110" y2="${BLOCK_H}" stroke="#111827" stroke-width="${LW.thin}"/>`)
  for (const y of [11, 22, 33]) {
    out.push(`<line x1="0" y1="${y}" x2="${BLOCK_W}" y2="${y}" stroke="#111827" stroke-width="${LW.thin}"/>`)
  }
  const cell = (x: number, y: number, label: string, value: string, big = false) => {
    out.push(`<text x="${f(x + 2)}" y="${f(y + 3.4)}" font-size="2" fill="#6b7280">${esc(label)}</text>`)
    out.push(`<text x="${f(x + 2)}" y="${f(y + 8.6)}" font-size="${big ? 4 : 3}" fill="#111827"${big ? ' font-weight="bold"' : ''}>${esc(value)}</text>`)
  }
  cell(0, 0, 'STAVBA', t.stavba)
  cell(0, 11, 'OBJEKT', t.objekt)
  cell(0, 22, 'NÁZEV VÝKRESU', t.vykres, true)
  cell(0, 33, 'VYPRACOVAL', t.vypracoval)
  cell(110, 0, 'MĚŘÍTKO', '1 : ' + scale)
  cell(110, 11, 'FORMÁT', opts.format + (opts.landscape ? ' na šířku' : ' na výšku'))
  cell(110, 22, 'DATUM', t.datum)
  cell(110, 33, 'ČÍSLO VÝKRESU', t.cislo, true)
  out.push('</g>')

  // ── údaje o řezu vlevo od razítka ───────────────────────────────────────────
  const az = ((Math.atan2(r.normal.x, -r.normal.z) * 180) / Math.PI + 360) % 360
  const info = [
    'Rozměry ' + fmtLen(r.width) + ' × ' + fmtLen(r.height),
    'Plocha řezu ' + (r.area < 1 ? (r.area * 10000).toFixed(0) + ' cm²' : r.area.toFixed(3) + ' m²') + ', délka řezných čar ' + fmtLen(r.cutLength),
    'Rovina ' + r.origin.x.toFixed(2) + ' ; ' + r.origin.y.toFixed(2) + ' ; ' + r.origin.z.toFixed(2) + ', azimut ' + az.toFixed(1) + '°',
  ]
  info.forEach((l, i) => {
    out.push(`<text x="${MARGIN.left + 2}" y="${f(by + 8 + i * 4)}" font-size="2.4" fill="#6b7280">${esc(l)}</text>`)
  })

  if (!fits) {
    out.push(
      `<text x="${MARGIN.left + 2}" y="${f(by - 2)}" font-size="3" fill="#b91c1c">` +
      `Výkres se do měřítka 1 : ${scale} na ${opts.format} nevejde — přesahuje rámeček.</text>`,
    )
  }

  out.push('</svg>')
  return { svg: out.join('\n'), scale, fits, widthMm: area.W, heightMm: area.H }
}
