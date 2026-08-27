/**
 * Jeden spojený GeoTIFF — mapa, kterou otevře Photoshop i After Effects a nese georeferenci.
 *
 * Proč ne přes canvas: prohlížeč má maximální rozměr plátna 16 384 px, a právě proto „Spojená
 * mapa (2D)" u velkého území tiše zmenší měřítko. Photoshop přitom zvládne 300 000 px na stranu.
 * Ten strop tedy není jejich, ale náš — a jde obejít tím, že se obrázek nikdy neskládá celý
 * v paměti: TIFF se zapisuje PO PRUZÍCH rovnou do souboru.
 *
 * Nekomprimovaně schválně. Offsety v klasickém TIFFu jsou 32bitové (strop 4 GB), takže velikost
 * je předem spočitatelná a všechny offsety jdou zapsat do hlavičky dřív, než se stáhne první
 * pixel. S kompresí by se musely počítat až zpětně — a tím by padla celá myšlenka streamu.
 *
 * Georeference: ModelPixelScale + ModelTiepoint + EPSG:5514 (S-JTSK). QGIS i ArcGIS si ji přečtou,
 * Photoshopu a AE nevadí (ignorují neznámé tagy).
 */
import { type MapLayer, pickTopoTier, mapBboxUrl, concatBytes } from '../tiles'
import { download } from '../exportUtils'
import { type ExportCtx, throwIfAborted } from './ctx'
import { loadMapChunk } from './maps'
import { openPng, worldFile } from './pngStream'

/** Strop ČÚZK REST na jeden požadavek. */
const CHUNK_PX = 4096
/** Klasický TIFF má 32bitové offsety. Nad to by se musel psát BigTIFF, který čte míň programů. */
const TIFF_MAX_BYTES = 3.9e9
/** Kolik paměti si dovolíme na jeden pruh. Určuje, kolik řádků se zpracuje najednou. */
const STRIP_BUDGET = 32e6

export type TiffPlan = {
  W: number; H: number; samples: number; bytes: number
  photoshopOk: boolean; afterEffectsOk: boolean; tiffOk: boolean
}

/** Rozměry a limity pro danou obálku a rozlišení — pro odhad v UI i pro kontrolu před exportem. */
export function planGeoTiff(spanX: number, spanY: number, res: number, clipped: boolean): TiffPlan {
  const W = Math.max(1, Math.round(spanX / res)), H = Math.max(1, Math.round(spanY / res))
  const samples = clipped ? 4 : 3
  return {
    W, H, samples,
    bytes: W * H * samples + 4096, // + hlavička; ta je proti datům zanedbatelná
    photoshopOk: W <= 300000 && H <= 300000,   // strop formátu PSB/TIFF v Photoshopu
    afterEffectsOk: W <= 30000 && H <= 30000,  // strop kompozice v After Effects
    tiffOk: W * H * samples < TIFF_MAX_BYTES,
  }
}

// ── zápis TIFF hlavičky ─────────────────────────────────────────────────────────
const T_SHORT = 3, T_LONG = 4, T_DOUBLE = 12

type Entry = { tag: number; type: number; count: number; data: number[] }

/**
 * Sestaví hlavičku i adresář tagů. Vrací i offsety pruhů, protože se počítají tady — data pruhů
 * začínají hned za hlavičkou a jejich velikost je u nekomprimovaného TIFFu známá dopředu.
 */
export function buildHeader(p: TiffPlan, res: number, originX: number, originY: number, rowsPerStrip: number) {
  const { W, H, samples } = p
  const nStrips = Math.ceil(H / rowsPerStrip)
  const stripBytes = Array.from({ length: nStrips }, (_, i) =>
    W * samples * Math.min(rowsPerStrip, H - i * rowsPerStrip))

  const e: Entry[] = [
    { tag: 256, type: T_LONG, count: 1, data: [W] },
    { tag: 257, type: T_LONG, count: 1, data: [H] },
    { tag: 258, type: T_SHORT, count: samples, data: Array(samples).fill(8) },
    { tag: 259, type: T_SHORT, count: 1, data: [1] },        // bez komprese
    { tag: 262, type: T_SHORT, count: 1, data: [2] },        // RGB
    { tag: 273, type: T_LONG, count: nStrips, data: [] },    // StripOffsets — doplní se níž
    { tag: 277, type: T_SHORT, count: 1, data: [samples] },
    { tag: 278, type: T_LONG, count: 1, data: [rowsPerStrip] },
    { tag: 279, type: T_LONG, count: nStrips, data: stripBytes },
    { tag: 284, type: T_SHORT, count: 1, data: [1] },        // chunky (RGBRGB…)
  ]
  if (samples === 4) e.push({ tag: 338, type: T_SHORT, count: 1, data: [2] }) // nenásobená alfa
  // GeoTIFF: velikost pixelu, ukotvení levého horního rohu, kód soustavy
  e.push({ tag: 33550, type: T_DOUBLE, count: 3, data: [res, res, 0] })
  e.push({ tag: 33922, type: T_DOUBLE, count: 6, data: [0, 0, 0, originX, originY, 0] })
  e.push({ tag: 34735, type: T_SHORT, count: 12, data: [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 5514] })
  e.sort((a, b) => a.tag - b.tag) // TIFF vyžaduje adresář seřazený podle tagu

  const sizeOf = (t: number) => (t === T_SHORT ? 2 : t === T_LONG ? 4 : 8)
  const ifdOff = 8
  const ifdLen = 2 + e.length * 12 + 4
  // hodnoty, které se do 4 bajtů v položce nevejdou, leží za adresářem
  let extra = ifdOff + ifdLen
  const extraOff = new Map<number, number>()
  for (const en of e) {
    const len = en.count * sizeOf(en.type)
    if (len > 4) { extraOff.set(en.tag, extra); extra += len + (len % 2) }
  }
  const dataStart = extra
  const offsets: number[] = []
  let o = dataStart
  for (const b of stripBytes) { offsets.push(o); o += b }
  const strip = e.find(x => x.tag === 273)!
  strip.data = offsets
  if (nStrips === 1) extraOff.delete(273) // jediný offset se do položky vejde

  const head = new Uint8Array(dataStart)
  const dv = new DataView(head.buffer)
  dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true)
  dv.setUint16(ifdOff, e.length, true)

  const writeVals = (at: number, en: Entry) => {
    en.data.forEach((v, i) => {
      if (en.type === T_SHORT) dv.setUint16(at + i * 2, v, true)
      else if (en.type === T_LONG) dv.setUint32(at + i * 4, v, true)
      else dv.setFloat64(at + i * 8, v, true)
    })
  }
  e.forEach((en, i) => {
    const at = ifdOff + 2 + i * 12
    dv.setUint16(at, en.tag, true); dv.setUint16(at + 2, en.type, true); dv.setUint32(at + 4, en.count, true)
    const off = extraOff.get(en.tag)
    if (off !== undefined) { dv.setUint32(at + 8, off, true); writeVals(off, en) }
    else writeVals(at + 8, en)
  })
  dv.setUint32(ifdOff + 2 + e.length * 12, 0, true) // žádný další adresář

  return { head, rowsPerStrip, nStrips }
}

export type Writable = { write: (d: Uint8Array) => Promise<void>; close: () => Promise<void> }
type SaveFilePicker = (o: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] })
  => Promise<{ createWritable: () => Promise<Writable> }>

/**
 * Složka na disku. Dávkový export do ní zapisuje přímo — jinak by se prohlížeč u čtrnácti krajů
 * ptal čtrnáctkrát, kam soubor uložit, a stahování by nešlo nechat běžet bez dozoru.
 */
export type OutDir = {
  getDirectoryHandle: (name: string, o?: { create?: boolean }) => Promise<OutDir>
  getFileHandle: (name: string, o?: { create?: boolean }) => Promise<{ createWritable: () => Promise<Writable> }>
}

/** Uloží drobný textový soubor (world file) — do složky, když je, jinak jako stažení. */
async function putText(dir: OutDir | undefined, name: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text)
  if (!dir) { download(bytes, name, 'text/plain'); return }
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable()
  await w.write(bytes)
  await w.close()
}

/** Největší rozměr plátna v prohlížeči. JPEG přes canvas jinak nejde zakódovat. */
const CANVAS_MAX = 16384

/**
 * Jeden spojený JPEG.
 *
 * Na rozdíl od PNG a TIFFu se NEDÁ streamovat: JPEG umí zakódovat jen `canvas.toBlob`, a ten
 * potřebuje celý obrázek na plátně naráz. Platí tedy strop plátna 16 384 px — na velké území je
 * potřeba PNG (bez ztráty, streamovaně) nebo export po dlaždicích.
 *
 * Průhlednost JPEG neumí, takže při ořezu na území se okolí vyplní bílou. Kdo chce mapu ve tvaru
 * kraje, potřebuje PNG nebo dlaždice — tam okrajové dlaždice nesou alfu.
 */
async function exportOneJpeg(
  b: { x0: number; y0: number; x1: number; y1: number },
  o: { res: number; layer: MapLayer; clip?: number[][][]; name: string; dir?: OutDir },
  plan: TiffPlan,
  ctx: ExportCtx,
): Promise<string> {
  const { W, H } = plan
  if (W > CANVAS_MAX || H > CANVAS_MAX) {
    throw new Error(`${W}×${H} px se do JPEGu nevejde (plátno prohlížeče končí na ${CANVAS_MAX} px). Zvol hrubší detail, PNG, nebo export po dlaždicích.`)
  }
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const g = cv.getContext('2d')
  if (!g) throw new Error('Canvas 2D kontext se nepodařilo získat')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, W, H) // podklad — mimo výkroj zůstane bílá, alfu JPEG nemá

  if (o.clip) {
    const path = new Path2D()
    for (const r of o.clip) {
      r.forEach(([x, y], i) => {
        const px = (x - b.x0) / (b.x1 - b.x0) * W
        const py = (b.y1 - y) / (b.y1 - b.y0) * H
        if (i === 0) path.moveTo(px, py); else path.lineTo(px, py)
      })
      path.closePath()
    }
    g.save(); g.clip(path, 'evenodd')
  }

  const tier = pickTopoTier(Math.max(b.x1 - b.x0, b.y1 - b.y0))
  const nCols = Math.ceil(W / CHUNK_PX), nRows = Math.ceil(H / CHUNK_PX)
  const edge = (len: number, n: number, i: number) => Math.round(i * len / n)
  let done = 0, blanks = 0
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      throwIfAborted(ctx.signal)
      const x0 = edge(W, nCols, c), x1 = edge(W, nCols, c + 1)
      const y0 = edge(H, nRows, r), y1 = edge(H, nRows, r + 1)
      const bx0 = b.x0 + (b.x1 - b.x0) * x0 / W, bx1 = b.x0 + (b.x1 - b.x0) * x1 / W
      const by1 = b.y1 - (b.y1 - b.y0) * y0 / H, by0 = b.y1 - (b.y1 - b.y0) * y1 / H
      const { bmp, blank } = await loadMapChunk(mapBboxUrl(bx0, by0, bx1, by1, x1 - x0, y1 - y0, o.layer, tier), ctx.signal, true)
      if (blank) blanks++
      g.drawImage(bmp, x0, y0)
      bmp.close?.()
      done++
      ctx.report(done / (nCols * nRows), `${done}/${nCols * nRows} bloků`)
    }
  }
  if (o.clip) g.restore()

  ctx.report(-1, 'kóduji JPEG…')
  const blob = await new Promise<Blob | null>(res => cv.toBlob(res, 'image/jpeg', 0.9))
  if (!blob) throw new Error('Zakódování JPEGu selhalo (nejspíš málo paměti)')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (o.dir) {
    const w = await (await o.dir.getFileHandle(o.name, { create: true })).createWritable()
    await w.write(bytes); await w.close()
  } else {
    download(bytes, o.name, 'image/jpeg')
  }
  await putText(o.dir, o.name.replace(/\.jpg$/i, '') + '.jgw', worldFile(o.res, b.x0, b.y1))

  const note = blanks ? ` · ${blanks} bloků mimo pokrytí ČÚZK` : ''
  return `Hotovo: ${W}×${H} px, ${(blob.size / 1e6).toFixed(0)} MB${note} · world file .jgw stažen zvlášť`
}

export async function exportGeoTiff(
  b: { x0: number; y0: number; x1: number; y1: number },
  o: { res: number; layer: MapLayer; toDisk: boolean; clip?: number[][][]; name: string; format: 'tiff' | 'png' | 'jpeg'; dir?: OutDir },
  ctx: ExportCtx,
): Promise<string> {
  const plan = planGeoTiff(b.x1 - b.x0, b.y1 - b.y0, o.res, o.format !== 'jpeg' && !!o.clip)
  if (o.format === 'jpeg') return exportOneJpeg(b, o, plan, ctx)
  const png = o.format === 'png'
  // Strop 4 GB je vlastnost klasického TIFFu (32bitové offsety), PNG ho nemá.
  if (!png && !plan.tiffOk) throw new Error(`Vyšlo by ${(plan.bytes / 1e9).toFixed(1)} GB, klasický TIFF má strop 4 GB. Zvol hrubší detail nebo PNG.`)
  const { W, H, samples } = plan

  const rowsPerStrip = Math.max(1, Math.min(H, Math.floor(STRIP_BUDGET / (W * samples))))
  const pngOut = png ? openPng(W, H, samples) : null
  const nStrips = Math.ceil(H / rowsPerStrip)
  const head = pngOut ? pngOut.head : buildHeader(plan, o.res, b.x0, b.y1, rowsPerStrip).head

  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  const chunks: Uint8Array[] = []
  let write: (d: Uint8Array) => Promise<void>
  let finish: () => Promise<void>
  let where: string
  if (o.dir) {
    // dávkový režim: složka je vybraná jednou předem, tady se jen zakládá soubor
    const w = await (await o.dir.getFileHandle(o.name, { create: true })).createWritable()
    write = d => w.write(d); finish = () => w.close(); where = 'do složky'
  } else if (o.toDisk && picker) {
    const h = await picker({
      suggestedName: o.name,
      types: png
        ? [{ description: 'PNG', accept: { 'image/png': ['.png'] } }]
        : [{ description: 'GeoTIFF', accept: { 'image/tiff': ['.tif'] } }],
    })
    const w = await h.createWritable()
    write = d => w.write(d); finish = () => w.close(); where = 'na disk'
  } else {
    // KOPIE, ne pohled: `strip` je jeden buffer dokola přepisovaný dalším pruhem. Zápis na disk
    // se stihne dřív (čeká se na něj), tady by se ale do pole uložil odkaz a všechny pruhy by
    // nakonec nesly obsah toho posledního.
    write = async d => { chunks.push(new Uint8Array(d)) }
    finish = async () => { download(concatBytes(chunks), o.name, png ? 'image/png' : 'image/tiff') }
    where = 'ke stažení'
  }

  await write(head)

  // Pruh se skládá po vodorovných blocích: ČÚZK víc než CHUNK_PX nedá a canvas by stejně neunesl
  // šířku přes 16 384. Do souboru jde až složený pruh, takže na rozměr obrázku žádný strop není.
  // PNG chce před každým řádkem bajt s číslem filtru; TIFF ne. Odtud ten rozdílný krok řádku.
  const rowPad = o.format === 'png' ? 1 : 0
  const rowStride = W * samples + rowPad
  const strip = new Uint8Array(rowStride * rowsPerStrip)
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d', { willReadFrequently: true })
  if (!g) throw new Error('Canvas 2D kontext se nepodařilo získat')
  const tier = pickTopoTier(Math.max(b.x1 - b.x0, b.y1 - b.y0))
  const nCols = Math.ceil(W / CHUNK_PX)
  let blanks = 0

  for (let s = 0; s < nStrips; s++) {
    throwIfAborted(ctx.signal)
    const y0 = s * rowsPerStrip
    const rows = Math.min(rowsPerStrip, H - y0)
    strip.fill(0)

    for (let c = 0; c < nCols; c++) {
      throwIfAborted(ctx.signal)
      const x0 = Math.round(c * W / nCols), x1 = Math.round((c + 1) * W / nCols)
      const cw = x1 - x0
      cv.width = cw; cv.height = rows
      g.clearRect(0, 0, cw, rows)

      // pixelové hranice → poměrná část obálky; sever je horní okraj, takže Y jde odshora
      const bx0 = b.x0 + (b.x1 - b.x0) * x0 / W, bx1 = b.x0 + (b.x1 - b.x0) * x1 / W
      const by1 = b.y1 - (b.y1 - b.y0) * y0 / H, by0 = b.y1 - (b.y1 - b.y0) * (y0 + rows) / H

      if (o.clip) {
        const path = new Path2D()
        for (const r of o.clip) {
          r.forEach(([x, y], i) => {
            const px = (x - bx0) / (bx1 - bx0) * cw
            const py = (by1 - y) / (by1 - by0) * rows
            if (i === 0) path.moveTo(px, py); else path.lineTo(px, py)
          })
          path.closePath()
        }
        g.save(); g.clip(path, 'evenodd') // evenodd → enklávy uvnitř území zůstanou průhledné
      }
      // tolerujeme prázdno: obálka území u hranic zasahuje mimo pokrytí ČÚZK a shodit kvůli tomu
      // několikahodinový export by bylo nesmyslné — vyjde tam bílá/průhledná plocha
      const { bmp, blank } = await loadMapChunk(mapBboxUrl(bx0, by0, bx1, by1, cw, rows, o.layer, tier), ctx.signal, true)
      if (blank) blanks++
      g.drawImage(bmp, 0, 0)
      bmp.close?.()
      if (o.clip) g.restore()

      const px = g.getImageData(0, 0, cw, rows).data
      for (let y = 0; y < rows; y++) {
        let src = y * cw * 4
        let dst = y * rowStride + rowPad + x0 * samples
        for (let x = 0; x < cw; x++) {
          strip[dst] = px[src]; strip[dst + 1] = px[src + 1]; strip[dst + 2] = px[src + 2]
          if (samples === 4) strip[dst + 3] = px[src + 3]
          src += 4; dst += samples
        }
      }
    }

    const body = rows === rowsPerStrip ? strip : strip.subarray(0, rowStride * rows)
    if (pngOut) { for (const c of pngOut.stream.push(body)) await write(c) }
    else await write(body)
    ctx.report((s + 1) / nStrips, `${s + 1}/${nStrips} pruhů`)
  }

  if (pngOut) for (const c of pngOut.stream.end()) await write(c)
  await finish()

  // Georeference u PNG nejde dovnitř (na rozdíl od GeoTIFFu) → jde vedle jako world file. Je to
  // tentýž formát, jaký appka čte u vlastního ortofota, jen s příponou podle obrázku.
  if (png) await putText(o.dir, o.name.replace(/\.png$/i, '') + '.pgw', worldFile(o.res, b.x0, b.y1))

  const note = blanks ? ` · ${blanks} bloků mimo pokrytí ČÚZK (bílá plocha)` : ''
  return `Hotovo: ${W}×${H} px ${where}${note}${png ? ' · world file .pgw stažen zvlášť' : ''}`
}
