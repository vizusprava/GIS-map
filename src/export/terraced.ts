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
export function buildTerracedObj(m: TerracedMesh): string[] {
  const { q, inside, nx, ny, minQ, dx, dy, shift } = m
  const [sx, sy, sz] = shift
  const bottom = minQ - m.baseDepth + sz
  const topOf = (k: number) => minQ + (q[k] - minQ) * m.zScale + sz // převýšení jen na reliéfu
  const ex = (i: number) => m.x0 + i * dx + sx
  const ey = (j: number) => m.y0 + j * dy + sy

  const out: string[] = ['# Vrstevnicovy model terenu (GIS Map)', 'o teren_terasy']
  let v = 1
  const quad = (a: number[], bq: number[], c: number[], d: number[]) => {
    for (const p of [a, bq, c, d]) out.push(`v ${p[0].toFixed(3)} ${p[1].toFixed(3)} ${p[2].toFixed(3)}`)
    out.push(`f ${v} ${v + 1} ${v + 2} ${v + 3}`)
    v += 4
  }

  for (let j = 0; j < ny; j++) {
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

  const out = buildTerracedObj({
    q, inside, nx, ny, minQ,
    x0: b.minX, y0: b.minY, dx: (b.maxX - b.minX) / nx, dy: (b.maxY - b.minY) / ny,
    baseDepth: o.baseDepth, zScale: o.zScale, shift: o.shift,
  })

  ctx.report(-1, 'balím…')
  const chunks: Uint8Array[] = []
  let zipErr: unknown = null
  const zip = new Zip((err, dat) => { if (err) zipErr = err; else if (dat) chunks.push(dat) })
  const add = (name: string, text: string) => {
    const d = new ZipDeflate(name, { level: 6 })
    zip.add(d); d.push(strToU8(text), true)
    if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr))
  }
  add('teren_terasy.obj', out.join('\n') + '\n')
  add('info.txt', [
    'Vrstevnicovy model terenu k 3D tisku (DMR 5G, CUZK)',
    '',
    `Terasa: ${o.step} m`,
    `Bunka: ${o.cell} m  (${nx} x ${ny})`,
    `Prevyseni: ${o.zScale}x`,
    `Masiv pod nejnizsi terasou: ${o.baseDepth} m`,
    (o.shift[0] || o.shift[1] || o.shift[2])
      ? `Posunuto o ${o.shift.join(' ')}`
      : 'Bez posunu — realne S-JTSK souradnice (statisice metru od pocatku).',
    '',
    'Souradnice: S-JTSK (EPSG:5514), vysky Bpv, jednotky METRY.',
    'Ve sliceru model zmensi na pozadovanou velikost — 1 m = 1 mm dela',
    `z tohohle vyberu zhruba ${Math.round((b.maxX - b.minX))} x ${Math.round((b.maxY - b.minY))} mm.`,
    '',
    'Model je uzavrene teleso: terasy + svisle stupne + bocni steny + dno.',
    'U schodu jsou T-vrcholy (hrana vedena vcelku proti dvema kratsim). Diru to',
    'nedela a slicery si s tim poradi samy -- v CAD exportech je to bezne.',
  ].join('\n'))
  zip.end()
  if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr))

  download(concatBytes(chunks), `teren_terasy_${o.step}m.zip`, 'application/zip')
  return `Hotovo: ${nx}×${ny} buněk, terasa ${o.step} m`
}
