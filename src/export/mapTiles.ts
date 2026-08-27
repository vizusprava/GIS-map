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
  o: { tileSize: number; res: number; layer: MapLayer; toDisk: boolean },
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

  let done = 0
  for (const t of tiles) {
    throwIfAborted(ctx.signal)
    const b = tileBounds(t)
    g.clearRect(0, 0, side, side)

    // dlaždice se skládá z bloků, protože ČÚZK víc než CHUNK_PX na požadavek nedá
    for (let r = 0; r < nSub; r++) {
      for (let c = 0; c < nSub; c++) {
        throwIfAborted(ctx.signal)
        const px0 = edge(nSub, c), px1 = edge(nSub, c + 1)
        const py0 = edge(nSub, r), py1 = edge(nSub, r + 1)
        // sever je horní okraj obrázku → Y se počítá odshora dolů
        const bx0 = b.x0 + (b.x1 - b.x0) * px0 / side, bx1 = b.x0 + (b.x1 - b.x0) * px1 / side
        const by1 = b.y1 - (b.y1 - b.y0) * py0 / side, by0 = b.y1 - (b.y1 - b.y0) * py1 / side
        const bmp = await loadMapChunk(mapBboxUrl(bx0, by0, bx1, by1, px1 - px0, py1 - py0, o.layer, tier), ctx.signal)
        g.drawImage(bmp, px0, py0)
        bmp.close?.()
      }
    }

    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.9))
    if (!blob) throw new Error('Zakódování dlaždice selhalo')
    const jf = new ZipPassThrough(`${tileName(t)}.jpg`) // JPEG už komprimovaný je
    zip.add(jf); jf.push(new Uint8Array(await blob.arrayBuffer()), true); check()

    // world file: velikost pixelu, nulové rotace, střed levého horního pixelu
    const wf = new ZipDeflate(`${tileName(t)}.jgw`, { level: 6 })
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
    'Ke každému JPEGu patří stejnojmenný .jgw (world file) — drží georeferenci.',
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
