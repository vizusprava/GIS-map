/**
 * Krajina pro pozadí přihlášení a přehledu scén — jeden vymyšlený výřez (údolí s potokem,
 * vesnice Horní Lhota, kopec Na Vrších), ze kterého se kreslí čtyři vrstvy: 3D terén jako
 * vrstevnicový model z překližky, katastr, topografická mapa a ortofoto.
 *
 * Všechno je generované a deterministické (pevné semínko) — stejná krajina pokaždé, nic se
 * nestahuje. Běží ve workeru (landscapeWorker.ts) na OffscreenCanvas; kde worker nejde,
 * stejný kód poběží na hlavním vlákně s obyčejným <canvas>.
 *
 * Svět má mřížku N×N (výšky, třídy povrchu, parcely); textury map jsou N×N, terén jde
 * nakreslit i ve vyšším rozlišení (přehled scén ho přibližuje přes celou obrazovku) —
 * výšky se mezi body mřížky dopočítávají bilineárně.
 */

export const N = 512
/** počet vrstevnic modelu terénu */
export const K = 14

export type Surface = OffscreenCanvas | HTMLCanvasElement
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
type Pt = [number, number]

function surface(R: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(R, R)
  const c = document.createElement('canvas')
  c.width = c.height = R
  return c
}
// Kreslí se na procesoru (willReadFrequently): textury se dělají jednou, pixely se pak čtou
// a posílají z workeru — přes grafiku by na Linuxu se softwarovým vykreslováním (CI, slabé PC
// s vypnutou grafikou v prohlížeči) přišly prázdné.
const ctx2d = (c: Surface) => c.getContext('2d', { willReadFrequently: true }) as Ctx

/** Pixely plochy — tak se textury posílají z workeru (ArrayBuffer jde předat bez kopie). */
export type Pixels = { w: number; h: number; data: ArrayBuffer }
export function toPixels(c: Surface): Pixels {
  const img = ctx2d(c).getImageData(0, 0, c.width, c.height)
  return { w: c.width, h: c.height, data: img.data.buffer as ArrayBuffer }
}

// ── šum ──────────────────────────────────────────────────────────────────────────
function mulberry32(a: number) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}

type House = { c: Pt; w: number; d: number; a: number; roof: number }
type Road = { pts: Pt[]; major?: boolean }

export type World = {
  H: Float32Array      // výška 0..1
  CLS: Uint8Array      // 0 pole, 1 louka, 2 les, 3 zahrady, 4 voda
  PAR: Int32Array      // parcela (katastr)
  SHADE: Float32Array  // osvětlení svahu 0..1
  seeds: { x: number; y: number; crop: number; a: number; w: number }[]
  CELL: Uint8Array
  houses: House[]
  roads: Road[]
  river: Pt[]
  village: Pt
  vnoise: (x: number, y: number) => number
  fbm: (x: number, y: number, oct: number) => number
  ry: (u: number) => number
  ryd: (u: number) => number
  dRiver: (u: number, v: number) => number
  levels: number[]
}

export function makeWorld(): World {
  const rnd = mulberry32(5141)
  const G = new Float32Array(256 * 256)
  for (let i = 0; i < G.length; i++) G[i] = rnd()
  const vnoise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
    const g = (i: number, j: number) => G[((j & 255) << 8) | (i & 255)]
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
  const fbm = (x: number, y: number, oct: number) => {
    let s = 0, amp = 0.5, f = 1, n = 0
    for (let o = 0; o < oct; o++) { s += amp * vnoise(x * f, y * f); n += amp; amp *= 0.5; f *= 2.03 }
    return s / n
  }

  // potok meandruje údolím zleva doprava, hlavní silnice vede souběžně nad ním
  const ry = (u: number) => 0.6 + 0.075 * Math.sin(u * 5.3 + 0.4) + 0.028 * Math.sin(u * 12.7 + 1.9)
  const ryd = (u: number) => (ry(u + 0.001) - ry(u - 0.001)) / 0.002
  const dRiver = (u: number, v: number) => Math.abs(v - ry(u)) / Math.sqrt(1 + ryd(u) ** 2)
  const rm = (u: number) => ry(u) - 0.095
  const village: Pt = [0.43, rm(0.43)]
  const inVillage = (u: number, v: number) => ((u - village[0]) / 0.17) ** 2 + ((v - village[1] - 0.004) / 0.092) ** 2 < 1

  // výšky
  const H = new Float32Array(N * N)
  let hmin = Infinity, hmax = -Infinity
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N, v = (y + 0.5) / N
    let h = fbm(u * 3.2 + 10, v * 3.2 + 3, 5)
    h += 0.5 * Math.exp(-((u - 0.76) ** 2 + (v - 0.22) ** 2) / 0.03)
    h += 0.28 * Math.exp(-((u - 0.16) ** 2 + (v - 0.88) ** 2) / 0.022)
    h -= 0.42 * Math.exp(-((dRiver(u, v) / 0.17) ** 2))
    H[y * N + x] = h
    if (h < hmin) hmin = h
    if (h > hmax) hmax = h
  }
  for (let i = 0; i < H.length; i++) H[i] = (H[i] - hmin) / (hmax - hmin)

  // silnice: hlavní údolím, okresní do kopce, polní přes most na jih
  const catmull = (pts: Pt[], seg = 8): Pt[] => {
    const out: Pt[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
      for (let s = 0; s < seg; s++) {
        const t = s / seg, t2 = t * t, t3 = t2 * t
        const f = (k: 0 | 1) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
        out.push([f(0), f(1)])
      }
    }
    out.push(pts[pts.length - 1])
    return out
  }
  const mainRoad: Pt[] = []
  for (let u = -0.05; u <= 1.06; u += 0.025) mainRoad.push([u, rm(u)])
  const roads: Road[] = [
    { pts: mainRoad, major: true },
    { pts: catmull([[0.47, rm(0.47)], [0.505, 0.41], [0.488, 0.35], [0.56, 0.305], [0.538, 0.235], [0.61, 0.18], [0.64, 0.1], [0.7, -0.05]]) },
    { pts: catmull([[0.36, rm(0.36)], [0.365, ry(0.365)], [0.34, 0.76], [0.29, 0.86], [0.27, 1.06]]) },
  ]
  const river: Pt[] = []
  for (let u = -0.05; u <= 1.06; u += 0.01) river.push([u, ry(u)])

  const distToPolyline = (p: Pt, pts: Pt[]) => {
    let best = Infinity
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy
      const t = L ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L)) : 0
      best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy))
    }
    return best
  }
  // body po polyline v pravidelných rozestupech (i přes zlomy), s jednotkovou tečnou
  const along = (pts: Pt[], step: number) => {
    const out: [number, number, number, number][] = []
    let carry = 0
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
      const len = Math.hypot(bx - ax, by - ay)
      let s = carry
      while (s < len) { const t = s / len; out.push([ax + (bx - ax) * t, ay + (by - ay) * t, (bx - ax) / len, (by - ay) / len]); s += step }
      carry = s - len
    }
    return out
  }

  // domy podél silnic na návsi
  const houses: House[] = []
  for (const r of roads) {
    for (const [px, py, tx, ty] of along(r.pts, 0.026)) {
      for (const side of [-1, 1]) {
        if (!inVillage(px, py) || rnd() > 0.86) continue
        const off = 0.024 + rnd() * 0.006
        const c: Pt = [px - ty * side * off, py + tx * side * off]
        if (!inVillage(c[0], c[1]) || dRiver(c[0], c[1]) < 0.03) continue
        if (roads.some(o => distToPolyline(c, o.pts) < 0.015)) continue
        if (houses.some(h => Math.hypot(h.c[0] - c[0], h.c[1] - c[1]) < 0.02)) continue
        houses.push({ c, w: 0.014 + rnd() * 0.008, d: 0.01 + rnd() * 0.005, a: Math.atan2(ty, tx), roof: rnd() })
      }
    }
  }

  // pole: Voronoi bloky s plodinou, směrem orby a šířkou pruhů (pruhové parcely)
  const seeds: World['seeds'] = []
  for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 7; gx++) {
    seeds.push({ x: (gx + 0.15 + 0.7 * rnd()) / 7, y: (gy + 0.15 + 0.7 * rnd()) / 7, crop: Math.floor(rnd() * 6), a: rnd() * Math.PI, w: 0.02 + rnd() * 0.016 })
  }
  const CLS = new Uint8Array(N * N), CELL = new Uint8Array(N * N), PAR = new Int32Array(N * N)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N, v = (y + 0.5) / N, i = y * N + x, h = H[i]
    const dR = dRiver(u, v)
    let best = 0, bd = Infinity
    for (let s = 0; s < seeds.length; s++) { const d = (seeds[s].x - u) ** 2 + (seeds[s].y - v) ** 2; if (d < bd) { bd = d; best = s } }
    CELL[i] = best
    const fn = fbm(u * 5 + 31, v * 5 + 17, 4)
    let c = 0
    if (dR < 0.0105 + 0.003 * vnoise(u * 40, v * 40)) c = 4
    else if (inVillage(u, v)) c = 3
    else if (((h > 0.6 && fn > 0.44) || fn > 0.64) && dR > 0.06) c = 2
    else if (dR < 0.065 || (fn < 0.3 && h < 0.35)) c = 1
    CLS[i] = c
    const sd = seeds[best]
    PAR[i] = c === 4 ? 1 : c === 2 ? 2000 + best : c === 1 ? 3000 + best
      : c === 0 ? 4000 + best * 64 + (Math.floor((u * Math.cos(sd.a) + v * Math.sin(sd.a)) / sd.w) & 63) : 0
  }
  // zahrady: každý dům má svůj pozemek (nejbližší dům)
  for (let i = 0; i < N * N; i++) if (CLS[i] === 3) {
    const u = (i % N + 0.5) / N, v = (Math.floor(i / N) + 0.5) / N
    let best = 0, bd = Infinity
    for (let k = 0; k < houses.length; k++) { const d = (houses[k].c[0] - u) ** 2 + (houses[k].c[1] - v) ** 2; if (d < bd) { bd = d; best = k } }
    PAR[i] = 100000 + best
  }

  // stínování svahů (světlo od severozápadu)
  const hAt = (x: number, y: number) => H[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))]
  const SHADE = new Float32Array(N * N)
  const L = [-0.55, -0.62, 0.56], Ln = Math.hypot(L[0], L[1], L[2])
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * 42, dy = (hAt(x, y + 1) - hAt(x, y - 1)) * 42
    SHADE[y * N + x] = Math.max(0, (-dx * L[0] - dy * L[1] + L[2]) / (Math.hypot(dx, dy, 1) * Ln))
  }

  const levels = Array.from({ length: K }, (_, k) => 0.05 + k * (0.9 / K))
  return { H, CLS, PAR, SHADE, seeds, CELL, houses, roads, river, village, vnoise, fbm, ry, ryd, dRiver, levels }
}

// ── společné kreslení ─────────────────────────────────────────────────────────────
const P = (p: Pt): Pt => [p[0] * N, p[1] * N]
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

function strokePath(ctx: Ctx, pts: Pt[], width: number, color: string) {
  ctx.beginPath()
  pts.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
  ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.stroke()
}
function eachHouse(w: World, ctx: Ctx, fn: (h: House, wd: number, dd: number) => void) {
  for (const h of w.houses) {
    const [x, y] = P(h.c)
    ctx.save(); ctx.translate(x, y); ctx.rotate(h.a)
    fn(h, h.w * N, h.d * N)
    ctx.restore()
  }
}
const hAtW = (w: World, x: number, y: number) => w.H[Math.min(N - 1, Math.max(0, Math.round(y))) * N + Math.min(N - 1, Math.max(0, Math.round(x)))]
const levelOf = (w: World, h: number) => { let k = -1; while (k + 1 < K && h > w.levels[k + 1]) k++; return k }

// ── ortofoto ─────────────────────────────────────────────────────────────────────
export function drawOrtho(w: World): Surface {
  const c = surface(N), ctx = ctx2d(c), img = ctx.createImageData(N, N), d = img.data
  const { CLS, SHADE, CELL, seeds, fbm, vnoise, dRiver } = w
  const crops = [[184, 170, 108], [122, 150, 82], [143, 120, 88], [166, 178, 104], [202, 188, 142], [106, 138, 70]]
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, u = (x + 0.5) / N, v = (y + 0.5) / N
    const cls = CLS[i], sd = seeds[CELL[i]]
    let col: number[], sh = 0.6 + 0.58 * SHADE[i]
    if (cls === 4) { col = [50, 80, 76]; sh = 0.95 + 0.1 * vnoise(u * 90, v * 90) }
    else if (cls === 2) {
      const k = smooth(0.4, 0.74, fbm(u * 70 + 5, v * 70 + 9, 3))
      col = [38 + 40 * k, 58 + 46 * k, 34 + 24 * k]; sh = 0.5 + 0.75 * SHADE[i]
    } else if (cls === 3) {
      col = fbm(u * 55 + 2, v * 55 + 4, 3) > 0.6 ? [58, 84, 46] : [104, 134, 74]
    } else if (cls === 1) {
      const n = 0.88 + 0.22 * fbm(u * 30, v * 30, 2)
      col = [116 * n, 150 * n, 82 * n]
    } else {
      const base = crops[sd.crop]
      const stripe = 0.93 + 0.07 * Math.sin((u * Math.cos(sd.a) + v * Math.sin(sd.a)) * N * 1.7)
      const n = (0.9 + 0.18 * fbm(u * 38, v * 38, 2)) * stripe
      col = [base[0] * n, base[1] * n, base[2] * n]
    }
    // stromy podél potoka
    if (cls !== 4 && dRiver(u, v) < 0.03 && fbm(u * 60 + 7, v * 60 + 1, 3) > 0.5) col = [50, 76, 44]
    d[i * 4] = Math.min(255, col[0] * sh); d[i * 4 + 1] = Math.min(255, col[1] * sh); d[i * 4 + 2] = Math.min(255, col[2] * sh); d[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  ctx.globalAlpha = 0.18
  for (const r of w.roads) strokePath(ctx, r.pts, r.major ? 7 : 5, '#2d3b22')
  ctx.globalAlpha = 1
  for (const r of w.roads) strokePath(ctx, r.pts, r.major ? 3.4 : 2.3, r.major ? '#8e8c86' : '#a39b8d')
  const roofs = ['#a65a43', '#b3684c', '#8f8f8c', '#6f6a66', '#9b4f3c', '#b9b3a6']
  eachHouse(w, ctx, (_h, wd, dd) => { ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.fillRect(-wd / 2 + 2, -dd / 2 + 2, wd, dd) })
  eachHouse(w, ctx, (h, wd, dd) => {
    ctx.fillStyle = roofs[Math.floor(h.roof * roofs.length)]; ctx.fillRect(-wd / 2, -dd / 2, wd, dd)
    ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(-wd / 2, -dd / 2, wd, dd / 2)   // osvětlená strana střechy
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(-wd / 2, -0.5, wd, 1)                 // hřeben
  })
  return c
}

// ── topografická mapa (styl ZM 10) ───────────────────────────────────────────────
export function drawTopo(w: World): Surface {
  const c = surface(N), ctx = ctx2d(c), img = ctx.createImageData(N, N), d = img.data
  const { H, CLS, SHADE } = w
  const fill = [[248, 245, 236], [232, 241, 214], [207, 227, 184], [228, 236, 208], [169, 211, 238]]
  for (let i = 0; i < N * N; i++) {
    const col = fill[CLS[i]], sh = CLS[i] === 4 ? 1 : 0.93 + 0.09 * SHADE[i]
    d[i * 4] = Math.min(255, col[0] * sh); d[i * 4 + 1] = Math.min(255, col[1] * sh); d[i * 4 + 2] = Math.min(255, col[2] * sh); d[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  // značky lesa
  ctx.strokeStyle = '#6f9d57'; ctx.lineWidth = 0.9
  for (let y = 6; y < N; y += 13) for (let x = 6 + ((y / 13) % 2) * 6; x < N; x += 13) {
    if (CLS[y * N + x] !== 2) continue
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.stroke()
  }
  // vrstevnice po 5 m, zesílené po 25 m (marching squares); výšky 384–552 m n. m.
  const step = 2
  for (let lv = 385; lv < 552; lv += 5) {
    const Lh = (lv - 384) / 168, index = lv % 25 === 0
    ctx.beginPath()
    for (let y = 0; y < N - step; y += step) for (let x = 0; x < N - step; x += step) {
      const a = H[y * N + x], b = H[y * N + x + step], cc = H[(y + step) * N + x + step], dd = H[(y + step) * N + x]
      const idx = (a > Lh ? 8 : 0) | (b > Lh ? 4 : 0) | (cc > Lh ? 2 : 0) | (dd > Lh ? 1 : 0)
      if (idx === 0 || idx === 15) continue
      const T: Pt = [x + step * (Lh - a) / (b - a), y], R: Pt = [x + step, y + step * (Lh - b) / (cc - b)]
      const B: Pt = [x + step * (Lh - dd) / (cc - dd), y + step], Le: Pt = [x, y + step * (Lh - a) / (dd - a)]
      const seg = (p: Pt, q: Pt) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]) }
      switch (idx) {
        case 1: case 14: seg(Le, B); break
        case 2: case 13: seg(B, R); break
        case 3: case 12: seg(Le, R); break
        case 4: case 11: seg(T, R); break
        case 5: seg(Le, T); seg(B, R); break
        case 6: case 9: seg(T, B); break
        case 7: case 8: seg(Le, T); break
        case 10: seg(T, R); seg(Le, B); break
      }
    }
    ctx.strokeStyle = index ? 'rgba(150,98,52,.85)' : 'rgba(170,120,70,.55)'
    ctx.lineWidth = index ? 1.1 : 0.6
    ctx.stroke()
  }
  strokePath(ctx, w.river, 6.5, '#3b8fd1'); strokePath(ctx, w.river, 4.2, '#a9d3ee')
  for (const r of w.roads) strokePath(ctx, r.pts, r.major ? 5.6 : 3.8, r.major ? '#6b4e3a' : '#7d7368')
  for (const r of w.roads) strokePath(ctx, r.pts, r.major ? 3.4 : 2.1, r.major ? '#f3b35f' : '#ffffff')
  eachHouse(w, ctx, (_h, wd, dd) => { ctx.fillStyle = '#6f625b'; ctx.fillRect(-wd / 2, -dd / 2, wd, dd) })
  // popisy: sídlo, vodní tok (kurzívou modře), kóta vrcholu
  ctx.font = '700 15px system-ui, sans-serif'; ctx.textAlign = 'center'
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(248,245,236,.9)'; ctx.fillStyle = '#1f2937'
  const [vx, vy] = P([w.village[0] + 0.02, w.village[1] - 0.075])
  ctx.strokeText('Horní Lhota', vx, vy); ctx.fillText('Horní Lhota', vx, vy)
  const u = 0.8, [rx, ry] = P([u, w.ry(u)])
  ctx.save(); ctx.translate(rx, ry + 15); ctx.rotate(Math.atan(w.ryd(u)))
  ctx.font = 'italic 12px Georgia, serif'; ctx.fillStyle = '#2f7fc4'; ctx.textBaseline = 'middle'
  ctx.fillText('Lomnický potok', 0, 0); ctx.restore()
  let pi = 0
  for (let i = 0; i < H.length; i++) if (H[i] > H[pi]) pi = i
  const px = pi % N, py = Math.floor(pi / N)
  ctx.fillStyle = '#3f2f22'; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic'
  ctx.fillText('▲', px, py + 4)
  ctx.textAlign = 'left'; ctx.fillText('552', px + 7, py + 4)
  ctx.font = 'italic 11px system-ui, sans-serif'; ctx.fillText('Na Vrších', px + 7, py - 9)
  return c
}

// ── katastrální mapa ─────────────────────────────────────────────────────────────
export function drawKatastr(w: World): Surface {
  const c = surface(N), ctx = ctx2d(c), img = ctx.createImageData(N, N), d = img.data
  const { PAR, CLS } = w
  const stats = new Map<number, { x: number; y: number; n: number }>()
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, id = PAR[i]
    const edge = (x < N - 1 && PAR[i + 1] !== id) || (y < N - 1 && PAR[i + N] !== id)
    const col = edge ? [30, 41, 59] : CLS[i] === 4 ? [214, 233, 247] : [250, 250, 246]
    d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255
    let s = stats.get(id)
    if (!s) stats.set(id, s = { x: 0, y: 0, n: 0 })
    s.x += x; s.y += y; s.n++
  }
  ctx.putImageData(img, 0, 0)
  // silnice jako samostatné parcely: dvě hranice a šedá výplň
  for (const r of w.roads) strokePath(ctx, r.pts, r.major ? 6.5 : 5, '#1e293b')
  for (const r of w.roads) strokePath(ctx, r.pts, r.major ? 4.6 : 3.2, '#e7e5df')
  eachHouse(w, ctx, (_h, wd, dd) => {
    ctx.fillStyle = '#f2cfc4'; ctx.fillRect(-wd / 2, -dd / 2, wd, dd)
    ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 0.9; ctx.strokeRect(-wd / 2, -dd / 2, wd, dd)
  })
  // parcelní čísla: pozemky „1284/3", stavební parcely „st. 41"
  ctx.fillStyle = '#111827'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.font = '8px system-ui, sans-serif'
  for (const [id, s] of stats) {
    if (s.n < 700 || id === 1) continue
    const x = s.x / s.n, y = s.y / s.n
    if (CLS[Math.round(y) * N + Math.round(x)] === 4) continue
    const label = id >= 100000 ? String(312 + (id - 100000) * 3)
      : id >= 4000 ? `${1140 + Math.floor((id - 4000) / 64) * 13}/${((id - 4000) % 64) % 9 + 1}`
      : id >= 3000 ? `${905 + id - 3000}/1` : String(820 + id - 2000)
    ctx.fillText(label, x, y)
  }
  ctx.font = '7px system-ui, sans-serif'
  w.houses.forEach((h, k) => { const [x, y] = P(h.c); ctx.fillText(`st. ${41 + k}`, x, y) })
  ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = '#475569'
  ctx.fillText('k. ú. Horní Lhota', N - 12, N - 14)
  return c
}

// ── 3D terén: vrstevnicový model z překližky s bílými hmotami domů ───────────────
function hF(w: World, X: number, Y: number) {
  X = Math.min(N - 1.001, Math.max(0, X)); Y = Math.min(N - 1.001, Math.max(0, Y))
  const x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0, i = y0 * N + x0, H = w.H
  const a = H[i], b = H[i + 1], c = H[i + N], d = H[i + N + 1]
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}
const clsAt = (w: World, X: number, Y: number) => w.CLS[Math.min(N - 1, Math.max(0, Math.round(Y))) * N + Math.min(N - 1, Math.max(0, Math.round(X)))]
/** maska „nad vrstevnicí a není to potok" v rozlišení R */
function maskAt(w: World, R: number, l: number) {
  const m = new Uint8Array(R * R), s = N / R
  if (l > 1) return m
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const X = (x + 0.5) * s - 0.5, Y = (y + 0.5) * s - 0.5
    m[y * R + x] = hF(w, X, Y) > l && clsAt(w, X, Y) !== 4 ? 1 : 0
  }
  return m
}

/** Spodní deska terénu: překližka s potokem jako modrým kanálem. */
export function drawTerrainBase(w: World, R = N): Surface {
  const c = surface(R), ctx = ctx2d(c), img = ctx.createImageData(R, R), d = img.data, s = N / R
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const i = y * R + x, u = x / R, v = y / R
    const g = 0.95 + 0.05 * Math.sin(u * 420 + w.vnoise(u * 9, v * 9) * 7)
    const col = clsAt(w, (x + 0.5) * s - 0.5, (y + 0.5) * s - 0.5) === 4 ? [118, 150, 168] : [196, 164, 118]
    d[i * 4] = col[0] * g; d[i * 4 + 1] = col[1] * g; d[i * 4 + 2] = col[2] * g; d[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  // domy pod nejnižší vrstevnicí stojí rovnou na desce (kreslí se v souřadnicích N)
  ctx.save(); ctx.scale(R / N, R / N)
  eachHouse(w, ctx, (h, wd, dd) => {
    const [x, y] = P(h.c)
    if (levelOf(w, hAtW(w, x, y)) !== -1) return
    ctx.fillStyle = 'rgba(40,30,20,.35)'; ctx.fillRect(-wd / 2 + 2.5, -dd / 2 + 2.5, wd, dd)
    ctx.fillStyle = '#f5f2ea'; ctx.fillRect(-wd / 2, -dd / 2, wd, dd)
  })
  ctx.restore()
  return c
}

/** Jedna vrstevnice modelu: plocha nad výškou `levels[k]`, propálená hrana, stín vyšší vrstvy. */
export function drawSlice(w: World, k: number, R = N): Surface {
  const c = surface(R), ctx = ctx2d(c), img = ctx.createImageData(R, R), d = img.data
  const mk = maskAt(w, R, w.levels[k]), mu = maskAt(w, R, k + 1 < K ? w.levels[k + 1] : 2)
  const e = Math.max(1, Math.round(R / N))                       // šířka propálené hrany
  const o1 = Math.round(3 * R / N), o2 = Math.round(5 * R / N)    // vržený stín vyšší vrstvy
  const at = (m: Uint8Array, x: number, y: number) => x >= 0 && y >= 0 && x < R && y < R && m[y * R + x] === 1
  const tone = k % 2 ? [214, 183, 136] : [224, 196, 152]
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const i = y * R + x
    if (!mk[i]) continue
    const u = x / R
    const edge = !at(mk, x - e, y) || !at(mk, x + e, y) || !at(mk, x, y - e) || !at(mk, x, y + e)
    let g = 0.96 + 0.04 * Math.sin(u * 380 + w.vnoise(u * 8 + k, y / R * 8) * 6)
    // vržený stín vyšší vrstvy (světlo zleva shora)
    if (!mu[i]) { if (at(mu, x - o1, y - o1)) g *= 0.78; else if (at(mu, x - o2, y - o2)) g *= 0.9 }
    const col = edge ? [104, 72, 44] : tone
    d[i * 4] = col[0] * g; d[i * 4 + 1] = col[1] * g; d[i * 4 + 2] = col[2] * g; d[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  ctx.save(); ctx.scale(R / N, R / N)
  // stromy (zelené kuličky) a domy (bílé hmoty) na vrstvě, na které stojí
  for (let y = 5; y < N; y += 9) for (let x = 5 + ((y / 9) % 2) * 4; x < N; x += 9) {
    const jx = x + (w.vnoise(x * 0.7, y * 0.3) - 0.5) * 6, jy = y + (w.vnoise(x * 0.3, y * 0.7) - 0.5) * 6
    const i = Math.round(jy) * N + Math.round(jx)
    if (w.CLS[i] !== 2 || levelOf(w, w.H[i]) !== k) continue
    ctx.fillStyle = 'rgba(40,30,20,.25)'; ctx.beginPath(); ctx.arc(jx + 1.4, jy + 1.4, 2.6, 0, 7); ctx.fill()
    ctx.fillStyle = '#8fa676'; ctx.beginPath(); ctx.arc(jx, jy, 2.6, 0, 7); ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.beginPath(); ctx.arc(jx - 0.8, jy - 0.8, 1.1, 0, 7); ctx.fill()
  }
  eachHouse(w, ctx, (h, wd, dd) => {
    const [x, y] = P(h.c)
    if (levelOf(w, hAtW(w, x, y)) !== k) return
    ctx.fillStyle = 'rgba(40,30,20,.35)'; ctx.fillRect(-wd / 2 + 2.5, -dd / 2 + 2.5, wd, dd)
    ctx.fillStyle = '#f5f2ea'; ctx.fillRect(-wd / 2, -dd / 2, wd, dd)
    ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillRect(-wd / 2, 0, wd, dd / 2)
  })
  ctx.restore()
  return c
}

/** Pořadí ploch, jak je posílá worker a skládá Backdrop: 3 mapy, deska terénu, K vrstevnic. */
export type LayerSet = 'maps' | 'terrain'
export function drawSet(w: World, set: LayerSet, R = N): Surface[] {
  if (set === 'maps') return [drawKatastr(w), drawTopo(w), drawOrtho(w)]
  return [drawTerrainBase(w, R), ...Array.from({ length: K }, (_, k) => drawSlice(w, k, R))]
}
