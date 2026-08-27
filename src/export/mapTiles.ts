/**
 * 2D mapa vybraných dlaždic — každá dlaždice jako samostatný georeferencovaný obrázek.
 *
 * Proč ne jeden velký obrázek: kraj v nativních 20 cm/px má 79 miliard pixelů. Do canvasu se
 * nevejde (strop je ~268 Mpx) a `stitchMapsCore` proto u velkých území TIŠE zmenší měřítko —
 * z 20 cm se stane 3,4 m a nikdo se to nedozví. Dlaždicový výstup drží zvolené rozlišení
 * bez ohledu na velikost území; QGIS i ArcGIS si z takové sady složí mozaiku.
 *
 * Paměť je plochá: v jednu chvíli se drží jedna dlaždice (canvas + JPEG). Zip se skládá
 * streamovaně a chunky odcházejí rovnou do cíle — na disk, kde to prohlížeč umí, jinak do
 * paměti ke stažení. Proto projde i výstup, který se do RAM nevejde.
 */
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { type Tile, type MapLayer, tileBounds, tileName, pickTopoTier, mapBboxUrl, concatBytes } from '../tiles'
import { download } from '../exportUtils'
import { pointInRing } from '../rings'
import { type ExportCtx, throwIfAborted } from './ctx'
import { loadMapChunk } from './maps'

/** Nabízená rozlišení v metrech na pixel. 20 cm je nativní ortofoto ČÚZK — pod tím už jen zvětšuje. */
export const MAP_RES = [0.2, 0.5, 1, 2, 5] as const
export type MapRes = (typeof MAP_RES)[number]

/** Strop ČÚZK REST na jeden požadavek — větší dlaždice se skládá z bloků. */
const CHUNK_PX = 4096
/** Nad tímhle by jedna dlaždice žrala přes ~1 GB v canvasu (side² × 4 B). */
const SIDE_MAX = 16384
/** Odhad JPEG q0.9 na leteckém snímku. Měřeno na ortofotu ČÚZK; textura města je hustší, les řidší. */
const BYTES_PER_PX = 0.3

export function estimateMapTiles(count: number, tileSize: number, res: number) {
  const side = Math.max(1, Math.round(tileSize / res))
  const px = count * side * side
  return { side, px, bytes: px * BYTES_PER_PX, blocks: Math.ceil(side / CHUNK_PX) ** 2 * count }
}

export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`
  return `${Math.round(b / 1e3)} kB`
}

type Rect = { x0: number; y0: number; x1: number; y1: number }

/** Protíná úsečka obdélník? Rychlé zamítnutí obálkou, pak průsečík se čtyřmi stranami. */
function segHitsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  if (Math.max(ax, bx) < r.x0 || Math.min(ax, bx) > r.x1) return false
  if (Math.max(ay, by) < r.y0 || Math.min(ay, by) > r.y1) return false
  const side = (px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  const s = [side(r.x0, r.y0), side(r.x1, r.y0), side(r.x1, r.y1), side(r.x0, r.y1)]
  // všechny rohy na téže straně přímky → úsečka obdélníkem neprochází
  return !(s.every(v => v > 0) || s.every(v => v < 0))
}

/**
 * Leží dlaždice CELÁ uvnitř tvaru?
 *
 * Rozhoduje o formátu: vnitřní dlaždice jde jako JPEG (nemá co ořezávat), okrajová musí být PNG
 * s alfou. Většina dlaždic je vnitřní, takže se tím ušetří ta čtyřnásobná velikost PNG všude tam,
 * kde by k ničemu nebyla.
 *
 * Nestačí otestovat rohy: hranice může dlaždici přeťít, aniž by v ní ležel vrchol. Proto se navíc
 * hledá průsečík s libovolnou hranou tvaru.
 */
function tileFullyInside(b: Rect, rings: number[][][]): boolean {
  const corners: [number, number][] = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]
  if (!corners.every(([x, y]) => rings.some(r => pointInRing(x, y, r)))) return false
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length]
      if (segHitsRect(ax, ay, bx, by, b)) return false
    }
  }
  return true
}

/**
 * Dlaždice, které tvar pokrývá. Dva režimy, protože se ptáme na dvě různé věci:
 *
 *  - `center` — dlaždice se počítá, když v ní leží STŘED. Na výběr do scény: hranice sedí zhruba
 *    na obrysu a nepřeteče na všechny strany o celou dlaždici.
 *  - `touch` — stačí, že se dlaždice tvaru dotkne. Na OŘEZANÝ export: okrajové dlaždice musí být
 *    v sadě, jinak by z nich zbyly díry a mapa by na krajích končila schodovitě.
 */
export function tilesInShape(
  rings: number[][][], size: number, mode: 'center' | 'touch', max: number,
): Tile[] | 'too-many' {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rings) for (const [x, y] of r) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  if (!isFinite(minX)) return []
  const hits: Tile[] = []
  for (let ix = Math.floor(minX / size); ix <= Math.floor(maxX / size); ix++) {
    for (let iy = Math.floor(minY / size); iy <= Math.floor(maxY / size); iy++) {
      const b: Rect = { x0: ix * size, y0: iy * size, x1: (ix + 1) * size, y1: (iy + 1) * size }
      const inside = mode === 'center'
        ? rings.some(r => pointInRing(b.x0 + size / 2, b.y0 + size / 2, r))
        : tileTouches(b, rings)
      if (inside) hits.push({ ix, iy, size })
    }
    if (hits.length > max) return 'too-many'
  }
  return hits
}

/** Dotýká se dlaždice tvaru? Roh uvnitř, vrchol tvaru uvnitř dlaždice, nebo protnutá hrana. */
function tileTouches(b: Rect, rings: number[][][]): boolean {
  const corners: [number, number][] = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]
  if (corners.some(([x, y]) => rings.some(r => pointInRing(x, y, r)))) return true
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i]
      if (ax >= b.x0 && ax <= b.x1 && ay >= b.y0 && ay <= b.y1) return true
      const [bx, by] = r[(i + 1) % r.length]
      if (segHitsRect(ax, ay, bx, by, b)) return true
    }
  }
  return false
}

/** Kam odcházejí chunky zipu. Disk drží paměť plochou, paměťová varianta je záložní. */
type Sink = { write: (d: Uint8Array) => void; finish: () => Promise<void>; where: string }

type SaveFilePicker = (o: {
  suggestedName?: string
  types?: { description: string; accept: Record<string, string[]> }[]
}) => Promise<{ createWritable: () => Promise<{ write: (d: Uint8Array) => Promise<void>; close: () => Promise<void> }> }>

/** Zapisuje rovnou do souboru na disku — jediná cesta, jak pustit výstup větší než pár GB. */
async function diskSink(name: string): Promise<Sink | null> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  if (!picker) return null
  const handle = await picker({ suggestedName: name, types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] })
  const w = await handle.createWritable()
  // fflate volá zpátky synchronně, zápis na disk je async → řetězíme, ať pořadí sedí
  let chain: Promise<void> = Promise.resolve()
  return {
    write: d => { chain = chain.then(() => w.write(d)) },
    finish: async () => { await chain; await w.close() },
    where: 'na disk',
  }
}

function memSink(name: string): Sink {
  const chunks: Uint8Array[] = []
  return {
    write: d => chunks.push(d),
    finish: async () => { download(concatBytes(chunks), name, 'application/zip') },
    where: 'ke stažení',
  }
}

export async function exportMapTiles(
  tiles: Tile[],
  o: { tileSize: number; res: number; layer: MapLayer; toDisk: boolean; clip?: number[][][] },
  ctx: ExportCtx,
): Promise<string> {
  if (!tiles.length) throw new Error('Nejsou vybrané žádné dlaždice')
  const { side } = estimateMapTiles(tiles.length, o.tileSize, o.res)
  if (side > SIDE_MAX) throw new Error(`Dlaždice by měla ${side} px na stranu. Zvol hrubší rozlišení nebo menší dlaždici.`)

  const name = `mapa_${o.layer}_${String(o.res).replace('.', '_')}m.zip`
  const sink = (o.toDisk ? await diskSink(name) : null) ?? memSink(name)

  let zipErr: unknown = null
  const zip = new Zip((err, dat, final) => {
    if (err) { zipErr = err; return }
    if (dat && dat.length) sink.write(dat)
    if (final) { /* uzavře se ve finish() */ }
  })
  const check = () => { if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr)) }

  const canvas = document.createElement('canvas')
  canvas.width = side; canvas.height = side
  const g = canvas.getContext('2d')
  if (!g) throw new Error('Canvas 2D kontext se nepodařilo získat')

  const nSub = Math.ceil(side / CHUNK_PX)
  const tier = pickTopoTier(o.tileSize)
  const edge = (n: number, i: number) => Math.round(i * side / n)

  let done = 0, clipped = 0
  for (const t of tiles) {
    throwIfAborted(ctx.signal)
    const b = tileBounds(t)
    g.clearRect(0, 0, side, side)

    // Okrajová dlaždice se ořízne na tvar území — mapa pak nekončí schodovitým obdélníkem, ale
    // skutečným obrysem. Vnitřní dlaždice ořez nepotřebuje, a proto může zůstat úsporný JPEG.
    const edgeTile = !!o.clip && !tileFullyInside(b, o.clip)
    if (edgeTile && o.clip) {
      const path = new Path2D()
      for (const r of o.clip) {
        r.forEach(([x, y], i) => {
          const px = (x - b.x0) / (b.x1 - b.x0) * side
          const py = (b.y1 - y) / (b.y1 - b.y0) * side // sever nahoře → Y obráceně
          if (i === 0) path.moveTo(px, py); else path.lineTo(px, py)
        })
        path.closePath()
      }
      g.save()
      g.clip(path, 'evenodd') // evenodd → díry uvnitř území zůstanou průhledné
      clipped++
    }

    // dlaždice se skládá z bloků, protože ČÚZK víc než CHUNK_PX na požadavek nedá
    for (let r = 0; r < nSub; r++) {
      for (let c = 0; c < nSub; c++) {
        throwIfAborted(ctx.signal)
        const px0 = edge(nSub, c), px1 = edge(nSub, c + 1)
        const py0 = edge(nSub, r), py1 = edge(nSub, r + 1)
        // sever je horní okraj obrázku → Y se počítá odshora dolů
        const bx0 = b.x0 + (b.x1 - b.x0) * px0 / side, bx1 = b.x0 + (b.x1 - b.x0) * px1 / side
        const by1 = b.y1 - (b.y1 - b.y0) * py0 / side, by0 = b.y1 - (b.y1 - b.y0) * py1 / side
        // stejně jako u GeoTIFFu: prázdný blok u hranic je mimo pokrytí, ne výpadek
        const { bmp } = await loadMapChunk(mapBboxUrl(bx0, by0, bx1, by1, px1 - px0, py1 - py0, o.layer, tier), ctx.signal, true)
        g.drawImage(bmp, px0, py0)
        bmp.close?.()
      }
    }

    if (edgeTile) g.restore()

    // JPEG průhlednost neumí → oříznutá dlaždice musí do PNG (a s ním i jiná přípona world filu)
    const [ext, wext, mime, q] = edgeTile
      ? ['png', 'pgw', 'image/png', undefined] as const
      : ['jpg', 'jgw', 'image/jpeg', 0.9] as const
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, mime, q))
    if (!blob) throw new Error('Zakódování dlaždice selhalo')
    const jf = new ZipPassThrough(`${tileName(t)}.${ext}`) // JPEG i PNG jsou komprimované už teď
    zip.add(jf); jf.push(new Uint8Array(await blob.arrayBuffer()), true); check()

    // world file: velikost pixelu, nulové rotace, střed levého horního pixelu
    const wf = new ZipDeflate(`${tileName(t)}.${wext}`, { level: 6 })
    zip.add(wf)
    wf.push(strToU8([o.res, 0, 0, -o.res, b.x0 + o.res / 2, b.y1 - o.res / 2].join('\n') + '\n'), true)
    check()

    done++
    ctx.report(done / tiles.length, `${done}/${tiles.length} dlaždic`)
  }

  const readme = new ZipDeflate('README.txt', { level: 6 })
  zip.add(readme)
  readme.push(strToU8([
    `2D mapa — ${tiles.length} dlaždic po ${o.tileSize} m, ${o.res} m/px (${side}×${side} px na dlaždici)`,
    `Vrstva: ${o.layer === 'ortofoto' ? 'ortofoto ČÚZK' : 'topografická mapa ČÚZK'}`,
    '',
    'Souřadnicový systém: S-JTSK / Krovak East North (EPSG:5514).',
    'Ke každému obrázku patří stejnojmenný world file — drží georeferenci.',
    ...(o.clip ? [
      '',
      `Ořezáno na obrys území. ${clipped} okrajových dlaždic je PNG s průhledným okolím`,
      `(.pgw), zbylých ${tiles.length - clipped} vnitřních je JPEG (.jgw) — ořez tam nemá co dělat.`,
    ] : []),
    '',
    'V QGIS: Layer > Add Raster Layer a označ všechny JPEGy najednou; poskládají se',
    'na správná místa. Pro jednu souvislou vrstvu udělej Raster > Miscellaneous > Build',
    'Virtual Raster (VRT) nad celou složkou.',
    '',
    o.res < 0.2
      ? 'POZOR: zvolené rozlišení je jemnější než nativních 20 cm/px ortofota ČÚZK — obrázek je zvětšený, další detail v něm není.'
      : `Ortofoto ČÚZK má nativně 20 cm/px${o.res > 0.2 ? ` — tenhle export je ${(o.res / 0.2).toFixed(0)}× hrubší` : ''}.`,
  ].join('\n')), true)
  check()

  zip.end()
  check()
  await sink.finish()
  return `Hotovo: ${tiles.length} dlaždic ${sink.where}`
}
