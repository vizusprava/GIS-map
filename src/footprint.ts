/**
 * Půdorys modelu pro skrytí mapy pod modelem (ořez glóbu a Google 3D v Cesiu).
 *
 * Trojúhelníky modelu se promítnou do jemné mřížky (asi 20 cm) a z ní se vytáhne obrys
 * i s dírami — mapa tak zmizí přesně pod modelem, a ne v celém konkávním obalu (ten
 * zaléval i celé bloky mezi větvemi silnic, kde žádný model není).
 *
 * Postup:
 * 1. obsazené buňky (každý trojúhelník, i úzký nebo svislý — hrany se vzorkují),
 * 2. zavření mezer užších než 2 × CLOSE_M (mezi díly modelu by jinak prosvítala mapa),
 * 3. zúžení dovnitř o INSET_M: Cesium počítá polohu terénu pro ořez v 32bitové přesnosti,
 *    okraj ořezu je proto zubatý o pár desítek centimetrů — zúžený okraj leží pod modelem,
 *    takže zuby nejsou vidět (jinak mezi modelem a mapou zel černý pruh),
 * 4. obrys z pole vzdáleností (marching squares s interpolací — hladký, ne schody mřížky),
 * 5. rozřezání na kusy bez děr (Cesium díry v ořezu neumí) a s nejvýš PIECE_PTS body.
 *
 * Proč kusy: Cesium pro ořez počítá do textury 4096×4096 vzdálenost od obrysu, a to přes
 * všechny hrany polygonu, do jehož obdélníku bod textury padne. Jeden polygon s tisíci body
 * by slabou grafiku zadusil; kusy s pár desítkami bodů stojí méně než dřív jeden hrubý obrys.
 *
 * Čistá geometrie nad (east, north) v metrech — žádné Cesium ani three.
 */
import polygonClipping, { type Polygon, type Ring } from 'polygon-clipping'
import { pointInRing, simplifyRDP } from './rings'

const CELL_MIN_M = 0.2       // nejjemnější buňka mřížky
const MAX_CELLS = 8_000_000  // strop buněk (paměť a čas ve workeru) — velký model dostane hrubší buňku
const CLOSE_M = 0.6          // mezery užší než 2× tohle se zavřou
const INSET_M = 0.5          // zúžení dovnitř modelu (schová zubatý okraj ořezu v Cesiu)
const SIMPLIFY_M = 0.1       // tolerance zjednodušení obrysu (Douglas–Peucker)
const PIECE_PTS = 120        // nejvíc bodů v jednom kusu ořezu
const PIECE_OVERLAP_M = 0.3  // kusy se překrývají — na řezu mezi nimi nesmí zůstat proužek mapy
const MAX_TOTAL_PTS = 3500   // strop bodů všech kusů dohromady (výkon ořezu v Cesiu)
const MAX_PIECES = 60        // strop kusů — každý stojí v shaderu pár čtení textury navíc
const MAX_HOLES = 24         // nejvíc děr (větší díry mají přednost; menší se zakryjí)
const MIN_AREA_M2 = 1        // menší ostrůvky a díry se zahodí

export type Pt = [number, number]

/** Mřížka obsazených buněk; trojúhelníky se přidávají postupně (model jich má miliony). */
export class FootprintRaster {
  readonly cell: number
  readonly W: number
  readonly H: number
  private readonly e0: number
  private readonly n0: number
  private readonly occ: Uint8Array

  constructor(minE: number, minN: number, maxE: number, maxN: number) {
    const w = Math.max(maxE - minE, 1), h = Math.max(maxN - minN, 1)
    this.cell = Math.max(CELL_MIN_M, Math.sqrt((w * h) / MAX_CELLS))
    // okraj, kam zavírání mezer nedosáhne — obrys pak nikdy nesahá na kraj mřížky
    const pad = Math.ceil(CLOSE_M / this.cell) + 3
    this.W = Math.ceil(w / this.cell) + 2 * pad + 1
    this.H = Math.ceil(h / this.cell) + 2 * pad + 1
    this.e0 = minE - pad * this.cell
    this.n0 = minN - pad * this.cell
    this.occ = new Uint8Array(this.W * this.H)
  }

  /**
   * Trojúhelník (east, north): buňky, jejichž střed leží uvnitř (okraj tak nesedí na žádnou
   * stranu víc). Úzký nebo svislý trojúhelník, který žádný střed nezasáhne, se započte
   * podél hran — jinak by tenké díly (obrubníky, zábradlí) z půdorysu vypadly.
   */
  addTriangle(ae: number, an: number, be: number, bn: number, ce: number, cn: number) {
    const k = 1 / this.cell
    const ax = (ae - this.e0) * k, ay = (an - this.n0) * k
    const bx = (be - this.e0) * k, by = (bn - this.n0) * k
    const cx = (ce - this.e0) * k, cy = (cn - this.n0) * k
    if (!this.fill(ax, ay, bx, by, cx, cy)) { this.edge(ax, ay, bx, by); this.edge(bx, by, cx, cy); this.edge(cx, cy, ax, ay) }
  }

  /** Vnitřek po řádcích (středy buněk); vrací, jestli zasáhl aspoň jednu buňku. */
  private fill(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
    const { W, H, occ } = this
    let any = false
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), j1 = Math.min(H - 1, Math.floor(Math.max(ay, by, cy) - 0.5))
    for (let j = j0; j <= j1; j++) {
      const yc = j + 0.5
      let xs = Infinity, xe = -Infinity
      if ((ay <= yc) !== (by <= yc)) { const x = ax + ((yc - ay) * (bx - ax)) / (by - ay); if (x < xs) xs = x; if (x > xe) xe = x }
      if ((by <= yc) !== (cy <= yc)) { const x = bx + ((yc - by) * (cx - bx)) / (cy - by); if (x < xs) xs = x; if (x > xe) xe = x }
      if ((cy <= yc) !== (ay <= yc)) { const x = cx + ((yc - cy) * (ax - cx)) / (ay - cy); if (x < xs) xs = x; if (x > xe) xe = x }
      if (xs > xe) continue
      const i0 = Math.max(0, Math.ceil(xs - 0.5)), i1 = Math.min(W - 1, Math.floor(xe - 0.5))
      if (i0 <= i1) { occ.fill(1, j * W + i0, j * W + i1 + 1); any = true }
    }
    return any
  }

  private edge(x0: number, y0: number, x1: number, y1: number) {
    const { W, H, occ } = this
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1
    for (let s = 0; s <= n; s++) {
      const t = s / n
      const i = Math.floor(x0 + (x1 - x0) * t), j = Math.floor(y0 + (y1 - y0) * t)
      if (i >= 0 && j >= 0 && i < W && j < H) occ[j * W + i] = 1
    }
  }

  /** Kusy ořezu: prstence (east, north) bez děr, bez opakovaného posledního bodu. */
  pieces(): Pt[][] {
    const { W, H, cell } = this
    // zavření mezer: buňky blíž než CLOSE_M k modelu (+ půl buňky: vzdálenost je mezi středy)
    const dist = new Float32Array(W * H)
    chamfer(this.occ, W, H, dist)
    const closeC = CLOSE_M / cell + 0.5
    const free = this.occ // obsazenost už není potřeba — místo ní volné buňky (šetří paměť)
    for (let i = 0; i < free.length; i++) free[i] = dist[i] <= closeC ? 0 : 1
    // vzdálenost dovnitř od okraje zavřené plochy; obrys = zavření + zúžení
    chamfer(free, W, H, dist)
    const lvl = (CLOSE_M + INSET_M) / cell + 0.5
    for (let i = 0; i < dist.length; i++) dist[i] -= lvl
    const raw = contours(dist, W, H).map(r => r.map(([x, y]) => [this.e0 + (x + 0.5) * cell, this.n0 + (y + 0.5) * cell] as Pt))
    return toPieces(raw)
  }
}

/**
 * Vzdálenost (v buňkách) k nejbližší buňce se `src = 1` — dvouprůchodová chamfer metrika
 * (sousedé 1 a √2). Na pár buněk je chyba pod desetinu buňky, a je to rychlé i na milionech.
 */
function chamfer(src: Uint8Array, W: number, H: number, d: Float32Array) {
  const D = Math.SQRT2, INF = 1e9
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF
  for (let j = 0; j < H; j++) {
    for (let i = 0, k = j * W; i < W; i++, k++) {
      let v = d[k]
      if (v === 0) continue
      if (i > 0 && d[k - 1] + 1 < v) v = d[k - 1] + 1
      if (j > 0) {
        if (d[k - W] + 1 < v) v = d[k - W] + 1
        if (i > 0 && d[k - W - 1] + D < v) v = d[k - W - 1] + D
        if (i < W - 1 && d[k - W + 1] + D < v) v = d[k - W + 1] + D
      }
      d[k] = v
    }
  }
  for (let j = H - 1; j >= 0; j--) {
    for (let i = W - 1, k = j * W + W - 1; i >= 0; i--, k--) {
      let v = d[k]
      if (v === 0) continue
      if (i < W - 1 && d[k + 1] + 1 < v) v = d[k + 1] + 1
      if (j < H - 1) {
        if (d[k + W] + 1 < v) v = d[k + W] + 1
        if (i < W - 1 && d[k + W + 1] + D < v) v = d[k + W + 1] + D
        if (i > 0 && d[k + W - 1] + D < v) v = d[k + W - 1] + D
      }
      d[k] = v
    }
  }
}

/**
 * Obrysy hladiny f = 0 (uvnitř f > 0) — marching squares s lineární interpolací. Úsečky jsou
 * orientované tak, že vnitřek je vlevo: vnější obrysy jdou proti směru hodinek (kladná
 * plocha), díry po směru. Vrací souřadnice v buňkách (střed buňky i,j = i,j).
 */
export function contours(f: Float32Array, W: number, H: number): Pt[][] {
  const N = W * H
  // hrana mřížky → id: vodorovná (i,j)–(i+1,j) = j·W+i, svislá (i,j)–(i,j+1) = N + j·W+i
  const next = new Map<number, number>()
  const ids = [0, 0, 0, 0], exits = [false, false, false, false]
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const k = j * W + i
      const fa = f[k], fb = f[k + 1], fc = f[k + W + 1], fd = f[k + W]
      const a = fa > 0, b = fb > 0, c = fc > 0, d = fd > 0
      if (a === b && b === c && c === d) continue
      // průsečíky po obvodu čtverce proti směru hodinek: dolní a→b, pravá b→c, horní c→d, levá d→a;
      // „výstup" = z vnitřku ven
      let n = 0
      if (a !== b) { ids[n] = k; exits[n] = a; n++ }
      if (b !== c) { ids[n] = N + k + 1; exits[n] = b; n++ }
      if (c !== d) { ids[n] = k + W; exits[n] = c; n++ }
      if (d !== a) { ids[n] = N + k; exits[n] = d; n++ }
      // výstup se spojí se vstupem před sebou (odřízne vnitřní roh), u sedla se středem
      // uvnitř se vstupem za sebou (vnitřek se propojí přes střed)
      const centerIn = fa + fb + fc + fd > 0
      for (let q = 0; q < n; q++) if (exits[q]) next.set(ids[q], ids[centerIn ? (q + 1) % n : (q + n - 1) % n])
    }
  }
  const pt = (id: number): Pt => {
    if (id < N) { const i = id % W, j = (id - i) / W, f0 = f[id], f1 = f[id + 1]; return [i + f0 / (f0 - f1), j] }
    const k = id - N, i = k % W, j = (k - i) / W, f0 = f[k], f1 = f[k + W]
    return [i, j + f0 / (f0 - f1)]
  }
  const rings: Pt[][] = []
  for (const start of next.keys()) {
    if (!next.has(start)) continue // už je v jiném obrysu
    const ring: Pt[] = []
    let id: number | undefined = start
    while (id !== undefined) {
      ring.push(pt(id))
      const nx: number | undefined = next.get(id)
      next.delete(id)
      if (nx === start) break
      id = nx
    }
    if (id !== undefined && ring.length >= 3) rings.push(ring)
  }
  return rings
}

const area = (r: Pt[]) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s / 2 }
const bbox = (r: Pt[] | Ring): [number, number, number, number] => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of r) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y }
  return [x0, y0, x1, y1]
}
const closed = (r: Pt[]): Ring => [...r, r[0]]
const open = (r: Ring): Pt[] => {
  const a = r[0], b = r[r.length - 1]
  return (a[0] === b[0] && a[1] === b[1] ? r.slice(0, -1) : r.slice()) as Pt[]
}
const simplifyClosed = (r: Pt[], eps: number): Pt[] => simplifyRDP(closed(r), eps).slice(0, -1)

/**
 * Obrysy (vnější proti směru hodinek, díry po směru) → kusy bez děr s nejvýš PIECE_PTS body.
 * Když by kusů nebo bodů bylo moc, zjednoduší víc a nechá méně děr (zakryté díry jen skryjí
 * mapu i tam, kde model není — nic se neztratí).
 */
export function toPieces(raw: Pt[][]): Pt[][] {
  let pieces: Pt[][] = []
  for (let attempt = 0; attempt < 6; attempt++) {
    const eps = SIMPLIFY_M * 1.6 ** attempt
    const maxHoles = Math.floor(MAX_HOLES / 1.6 ** attempt)
    const outers: { ring: Pt[]; area: number; box: [number, number, number, number]; holes: Pt[][] }[] = []
    const holes: { ring: Pt[]; area: number }[] = []
    let total = 0
    for (const r of raw) {
      const s = simplifyClosed(r, eps)
      if (s.length < 3) continue
      const a = area(s)
      if (Math.abs(a) < MIN_AREA_M2) continue
      if (a > 0) { outers.push({ ring: s, area: a, box: bbox(s), holes: [] }); total += s.length }
      else holes.push({ ring: s, area: -a })
    }
    holes.sort((p, q) => q.area - p.area)
    // díra patří do nejmenšího vnějšího obrysu, který ji obsahuje
    outers.sort((p, q) => p.area - q.area)
    for (const h of holes.slice(0, maxHoles)) {
      const [x, y] = h.ring[0]
      const o = outers.find(o => x >= o.box[0] && x <= o.box[2] && y >= o.box[1] && y <= o.box[3] && pointInRing(x, y, o.ring))
      if (o) { o.holes.push(h.ring); total += h.ring.length }
    }
    if (total > MAX_TOTAL_PTS && attempt < 5) continue
    pieces = []
    for (const o of outers) splitPiece([closed(o.ring), ...o.holes.map(closed)], pieces, 0)
    if (pieces.length <= MAX_PIECES) break
  }
  return pieces
}

/** Polygon (vnější + díry) → kusy bez děr: řez svislicí přes díru, jinak napůl podél delší strany. */
function splitPiece(poly: Polygon, out: Pt[][], depth: number) {
  const pts = poly.reduce((s, r) => s + r.length, 0)
  if ((poly.length === 1 && pts <= PIECE_PTS + 1) || depth > 18) {
    const r = open(poly[0])
    if (r.length >= 3) out.push(r)
    return
  }
  const [x0, y0, x1, y1] = bbox(poly[0])
  const ov = PIECE_OVERLAP_M
  let cuts: [number, number, number, number][]
  if (poly.length > 1) {
    // svislice mezi levým a pravým krajem díry ji vždycky protne — díra se otevře do řezu
    const [hx0, , hx1] = bbox(poly[1]), x = (hx0 + hx1) / 2
    cuts = [[x0 - 1, y0 - 1, x + ov, y1 + 1], [x - ov, y0 - 1, x1 + 1, y1 + 1]]
  } else if (x1 - x0 >= y1 - y0) {
    const x = (x0 + x1) / 2
    cuts = [[x0 - 1, y0 - 1, x + ov, y1 + 1], [x - ov, y0 - 1, x1 + 1, y1 + 1]]
  } else {
    const y = (y0 + y1) / 2
    cuts = [[x0 - 1, y0 - 1, x1 + 1, y + ov], [x0 - 1, y - ov, x1 + 1, y1 + 1]]
  }
  for (const [a, b, c, d] of cuts) {
    let parts: Polygon[]
    try { parts = polygonClipping.intersection(poly, [[[a, b], [c, b], [c, d], [a, d], [a, b]]]) } catch (e) {
      console.error('Rozřezání obrysu selhalo:', e)
      continue
    }
    for (const p of parts) splitPiece(p, out, depth + 1)
  }
}
