/**
 * Vrstevnicový model terénu k 3D tisku — schodovité terasy jako u architektonických maket.
 *
 * Proti ostatním exportům je to jiná úloha: ty dělají POVRCH (plochu drapovanou na terén),
 * tohle musí být TĚLESO. Tiskárna potřebuje uzavřený objem, takže kromě teras přibývají svislé
 * stupně mezi nimi, boční stěny po obvodu a dno.
 *
 * Stavíme z BLOKŮ, ne z trojúhelníkové sítě s kvantovanými vrcholy. Kvantovaná síť by dala
 * šikmé přechody mezi terasami; blok na buňku dá ostrou hranu, což je přesně ten vzhled.
 *
 * Vnitřní plochy se NEGENERUJÍ. Stěna mezi dvěma buňkami vzniká jen tam, kde soused chybí nebo
 * je níž — pod jeho hladinou je materiál na obou stranách a plocha by ležela uvnitř tělesa.
 *
 * Výsledek je UZAVŘENÝ, ale ne kombinatoricky manifold: u schodů vznikají T-vrcholy, protože
 * stěna vedená vcelku sousedí s dvěma kratšími na druhé straně. Ověřeno rozborem (viz commit):
 * nespárované hrany jsou vždy přesně pokryté kratšími úseky na téže přímce, takže díra s plochou
 * nikde nevzniká — a T-vrcholy jsou v exportech z CADu běžné, slicery je řeší samy.
 *
 * Půdorys kopíruje VYBRANÉ DLAŽDICE, ne jejich obálku: buňka se bere, jen když její střed padne
 * do některé z nich. Nepravidelný výběr tím dá nepravidelnou maketu zadarmo.
 */
import { Zip, ZipDeflate, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { type Tile, tilesBounds, tileKey, concatBytes } from '../tiles'
import { fetchElevSamplerSJTSK } from '../elevation'
import { download } from '../exportUtils'
import { throwIfAborted, type ExportCtx } from './ctx'

export type TerracedOpts = {
  /** hrana buňky v metrech — jemnější = víc trojúhelníků */
  cell: number
  /** výška jedné terasy v metrech (vrstevnicový interval) */
  step: number
  /** kolik metrů masivu pod nejnižší terasou */
  baseDepth: number
  /** převýšení — makety se skoro vždy nadsazují, jinak je krajina placatá */
  zScale: number
  /** posun modelu, stejný jako u ostatních exportů */
  shift: [number, number, number]
  /** OBJ do Maxu, nebo STL rovnou do sliceru */
  format: 'obj' | 'stl'
}

/** Nad tímhle už OBJ neúnosně roste a prohlížeč to skládá minuty. */
const MAX_CELLS = 400_000

export function planTerraced(tiles: Tile[], cell: number) {
  const b = tilesBounds(tiles)
  const nx = Math.max(1, Math.round((b.maxX - b.minX) / cell))
  const ny = Math.max(1, Math.round((b.maxY - b.minY) / cell))
  return { nx, ny, cells: nx * ny, ok: nx * ny <= MAX_CELLS }
}

export type TerracedMesh = {
  /** kvantované výšky buněk (jen tam, kde `inside`) */
  q: Float64Array
  inside: Uint8Array
  nx: number; ny: number
  /** nejnižší terasa — od ní se počítá převýšení i hloubka podstavce */
  minQ: number
  x0: number; y0: number; dx: number; dy: number
  baseDepth: number; zScale: number
  shift: [number, number, number]
}

/**
 * Stavba tělesa. Čistá funkce bez sítě a bez DOMu — dá se ověřit, že výsledek je UZAVŘENÝ,
 * což je u modelu na tisk to jediné, na čem doopravdy záleží.
 *
 * Uzavřenost stojí na tom, že stěna vzniká jen mezi buňkou a NIŽŠÍM sousedem (nebo prázdnem).
 * Pod hladinou souseda je materiál na obou stranách, takže tam plocha nemá co dělat — kdyby se
 * generovala, ležela by uvnitř tělesa a hrana by byla použitá čtyřikrát místo dvakrát.
 */
export function buildTerracedQuads(m: TerracedMesh, jFrom = 0, jTo = m.ny, out: number[] = []): number[] {
  const { q, inside, nx, minQ, dx, dy, shift } = m
  const ny = m.ny
  const [sx, sy, sz] = shift
  const bottom = minQ - m.baseDepth + sz
  const topOf = (k: number) => minQ + (q[k] - minQ) * m.zScale + sz // převýšení jen na reliéfu
  const ex = (i: number) => m.x0 + i * dx + sx
  const ey = (j: number) => m.y0 + j * dy + sy

  const quad = (a: number[], bq: number[], c: number[], d: number[]) => {
    out.push(a[0], a[1], a[2], bq[0], bq[1], bq[2], c[0], c[1], c[2], d[0], d[1], d[2])
  }

  for (let j = jFrom; j < jTo; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      if (!inside[k]) continue
      const t = topOf(k)
      const x0 = ex(i), x1 = ex(i + 1), y0 = ey(j), y1 = ey(j + 1)

      quad([x0, y0, t], [x1, y0, t], [x1, y1, t], [x0, y1, t])                 // terasa
      quad([x0, y1, bottom], [x1, y1, bottom], [x1, y0, bottom], [x0, y0, bottom]) // dno

      const wall = (di: number, dj: number, p0: number[], p1: number[]) => {
        const ni = i + di, nj = j + dj
        const outside = ni < 0 || ni >= nx || nj < 0 || nj >= ny || !inside[nj * nx + ni]
        const from = outside ? bottom : topOf(nj * nx + ni)
        if (from >= t) return
        quad([p0[0], p0[1], from], [p1[0], p1[1], from], [p1[0], p1[1], t], [p0[0], p0[1], t])
      }
      wall(0, -1, [x0, y0], [x1, y0])
      wall(1, 0, [x1, y0], [x1, y1])
      wall(0, 1, [x1, y1], [x0, y1])
      wall(-1, 0, [x0, y1], [x0, y0])
    }
  }
  return out
}

/**
 * Čtyřúhelníky → OBJ se SDÍLENÝMI vrcholy.
 *
 * Bez sdílení má každý čtyřúhelník vlastní čtyři vrcholy, takže model o 356 tisících stěnách
 * nese 1,42 milionu vrcholů, z toho jen 0,36 milionu různých. Importér ve 3ds Maxu pak soubor
 * rychle přečte a teprve potom začne duplicity SVAŘOVAT — a právě to je ten zásek po dojetí
 * importu. Se sdílenými vrcholy nemá co svařovat.
 */
export function quadsToObj(q: number[]): string {
  const [ox, oy, oz] = originOf(q)
  const idx = new Map<string, number>()
  const verts: string[] = []
  const faces: string[] = []
  const at = (o: number) => {
    const key = `${(q[o] - ox).toFixed(3)} ${(q[o + 1] - oy).toFixed(3)} ${(q[o + 2] - oz).toFixed(3)}`
    let i = idx.get(key)
    if (i === undefined) { verts.push(`v ${key}`); i = verts.length; idx.set(key, i) }
    return i
  }
  for (let o = 0; o < q.length; o += 12) {
    faces.push(`f ${at(o)} ${at(o + 3)} ${at(o + 6)} ${at(o + 9)}`)
  }
  return ['# Vrstevnicovy model terenu (GIS Map)', 'o teren_terasy', ...verts, ...faces].join('\n') + '\n'
}

/**
 * Levý dolní roh modelu. Maketa se od něj posouvá k počátku — je to fyzický objekt, ne podklad
 * do GIS, takže absolutní poloha nemá význam. Zato škodí:
 *
 *  - 3ds Max si vnitřně drží vrcholy v jednoduché přesnosti a na souřadnicích kolem 700 000
 *    (S-JTSK má počátek u Helsinek) se mu rozjede stavba scény i práce ve výřezu,
 *  - STL má float32 napevno, takže by přesnost spadla na ~6 cm.
 *
 * U počátku je přesnost setiny milimetru a oba problémy mizí.
 */
function originOf(q: number[]): [number, number, number] {
  let mnx = Infinity, mny = Infinity, mnz = Infinity
  for (let o = 0; o < q.length; o += 3) {
    if (q[o] < mnx) mnx = q[o]
    if (q[o + 1] < mny) mny = q[o + 1]
    if (q[o + 2] < mnz) mnz = q[o + 2]
  }
  return [mnx, mny, mnz]
}

/** Čtyřúhelníky → binární STL. Formát, který chtějí slicery — do Maxu se pro tisk chodit nemusí. */
export function quadsToStl(q: number[]): Uint8Array {
  const [mnx, mny, mnz] = originOf(q)
  const tris = (q.length / 12) * 2
  const dv = new DataView(new ArrayBuffer(84 + tris * 50))
  dv.setUint32(80, tris, true)
  let p = 84
  const tri = (o0: number, o1: number, o2: number) => {
    const ax = q[o0] - mnx, ay = q[o0 + 1] - mny, az = q[o0 + 2] - mnz
    const bx = q[o1] - mnx, by = q[o1 + 1] - mny, bz = q[o1 + 2] - mnz
    const cx = q[o2] - mnx, cy = q[o2 + 1] - mny, cz = q[o2 + 2] - mnz
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) { dv.setFloat32(p, v, true); p += 4 }
    dv.setUint16(p, 0, true); p += 2
  }
  for (let o = 0; o < q.length; o += 12) {
    tri(o, o + 3, o + 6)
    tri(o, o + 6, o + 9)
  }
  return new Uint8Array(dv.buffer)
}

export async function exportTerraced(tiles: Tile[], o: TerracedOpts, ctx: ExportCtx): Promise<string> {
  if (!tiles.length) throw new Error('Nejsou vybrané žádné dlaždice')
  const plan = planTerraced(tiles, o.cell)
  if (!plan.ok) throw new Error(`${plan.cells.toLocaleString('cs')} buněk je moc — zvětši hranu buňky.`)

  const b = tilesBounds(tiles)
  const { nx, ny } = plan
  const size = tiles[0].size
  const has = new Set(tiles.map(tileKey))

  ctx.report(-1, 'stahuji výšky z ČÚZK…')
  // Vzorkuje se v S-JTSK, tedy bez reprojekce — mřížka dlaždic je na Křovák zarovnaná.
  const sample = await fetchElevSamplerSJTSK('dmr5g', b.minX, b.minY, b.maxX, b.maxY,
    Math.min(2048, nx * 2), Math.min(2048, ny * 2), ctx.signal)
  throwIfAborted(ctx.signal)

  // ── kvantizace na terasy ──────────────────────────────────────────────────────
  const cx = (i: number) => b.minX + (i + 0.5) * (b.maxX - b.minX) / nx
  const cy = (j: number) => b.minY + (j + 0.5) * (b.maxY - b.minY) / ny
  const q = new Float64Array(nx * ny)
  const inside = new Uint8Array(nx * ny)
  let minQ = Infinity
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = cx(i), y = cy(j)
      // půdorys = vybrané dlaždice, ne jejich obálka
      if (!has.has(`${size}/${Math.floor(x / size)}/${Math.floor(y / size)}`)) continue
      const h = sample(x, y)
      if (h == null) continue
      const v = Math.round(h / o.step) * o.step
      q[j * nx + i] = v
      inside[j * nx + i] = 1
      if (v < minQ) minQ = v
    }
  }
  if (!isFinite(minQ)) throw new Error('Pro výběr nejsou výšková data')

  // Po pásech, ať se mezi nimi stihne překreslit UI. Při refaktoru do čisté funkce se tohle
  // ztratilo a celá stavba běžela v jednom bloku — appka pak u velkého výběru na desítky sekund
  // ztuhla a vypadalo to jako zásek.
  ctx.report(0, 'stavím těleso…')
  const mesh = {
    q, inside, nx, ny, minQ,
    x0: b.minX, y0: b.minY, dx: (b.maxX - b.minX) / nx, dy: (b.maxY - b.minY) / ny,
    baseDepth: o.baseDepth, zScale: o.zScale, shift: o.shift,
  }
  const quads: number[] = []
  const band = Math.max(1, Math.ceil(20000 / nx)) // ~20 tisíc buněk na dávku
  for (let j0 = 0; j0 < ny; j0 += band) {
    throwIfAborted(ctx.signal)
    buildTerracedQuads(mesh, j0, Math.min(ny, j0 + band), quads)
    ctx.report(j0 / ny, `stavím těleso… ${Math.round(j0 / ny * 100)} %`)
    await new Promise(r => setTimeout(r, 0))
  }
  const nQuads = quads.length / 12

  ctx.report(-1, 'balím…')
  const chunks: Uint8Array[] = []
  let zipErr: unknown = null
  const zip = new Zip((err, dat) => { if (err) zipErr = err; else if (dat) chunks.push(dat) })
  const addBytes = (name: string, bytes: Uint8Array) => {
    const d = new ZipDeflate(name, { level: 6 })
    zip.add(d); d.push(bytes, true)
    if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr))
  }
  const add = (name: string, text: string) => addBytes(name, strToU8(text))

  let objVerts = 0
  if (o.format === 'stl') {
    addBytes('teren_terasy.stl', quadsToStl(quads))
  } else {
    const obj = quadsToObj(quads)
    objVerts = (obj.match(/^v /gm) ?? []).length
    add('teren_terasy.obj', obj)
  }

  add('info.txt', [
    'Vrstevnicovy model terenu k 3D tisku (DMR 5G, CUZK)',
    '',
    `Terasa: ${o.step} m`,
    `Bunka: ${o.cell} m  (${nx} x ${ny})`,
    `Prevyseni: ${o.zScale}x`,
    `Masiv pod nejnizsi terasou: ${o.baseDepth} m`,
    `Sten: ${nQuads}` + (objVerts ? `, vrcholu: ${objVerts} (sdilene)` : ''),
    '',
    'MODEL JE POSUNUTY K POCATKU (levy dolni roh v nule), jednotky METRY.',
    'Je to fyzicky objekt, ne podklad do GIS -- absolutni poloha nema vyznam.',
    'Realne S-JTSK souradnice (statisice metru) skodi: 3ds Max si vrcholy drzi',
    'v jednoduche presnosti a stavba sceny se mu na nich zadrhava, STL by melo',
    'presnost jen ~6 cm. U pocatku jsou to setiny milimetru.',
    'Kdyz potrebujes model na skutecnem miste, pouzij export Teren + ortofoto.',
    '',
    'Ve sliceru model zmensi na pozadovanou velikost -- 1 m = 1 mm dela',
    `z tohohle vyberu zhruba ${Math.round((b.maxX - b.minX))} x ${Math.round((b.maxY - b.minY))} mm.`,
    '',
    'Model je uzavrene teleso: terasy + svisle stupne + bocni steny + dno.',
    'U schodu jsou T-vrcholy (hrana vedena vcelku proti dvema kratsim). Diru to',
    'nedela a slicery si s tim poradi samy -- v CAD exportech je to bezne.',
  ].join('\n'))
  zip.end()
  if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr))

  download(concatBytes(chunks), `teren_terasy_${o.step}m_${o.format}.zip`, 'application/zip')
  return `Hotovo: ${nQuads.toLocaleString('cs')} stěn, terasa ${o.step} m (${o.format.toUpperCase()})`
}
