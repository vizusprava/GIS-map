/**
 * Stahování mapových bloků z ČÚZK pro exporty (s rozpoznáním prázdných odpovědí) a ortofoto
 * textura pro výřez terénu.
 *
 * Spojená mapa přes jeden canvas tu dřív byla taky; nahradil ji zápis po pruzích (geotiff.ts),
 * který drží zvolené rozlišení i u velkého území a umí dokreslit výkresy stejně.
 */
import { mapBboxUrl, fetchJpegRetry } from '../tiles'
import { isAbortError } from '../config'

/** Velikost výřezu, na kterém se poznává prázdná mapa. */
const PROBE = 48

/**
 * Je blok jednolitý (= chybová odpověď ČÚZK), nebo jen klidná krajina?
 *
 * Původně se zmenšoval CELÝ blok do 16×16. To fungovalo, dokud byly bloky zhruba čtvercové —
 * jenže u dlouhého úzkého pruhu se do jednoho pixelu náhledu zprůměrují desetitisíce zdrojových
 * a i obyčejné pole nebo les vyjdou jako jednolitá plocha. Export pak hlásil výpadek ČÚZK nad
 * úplně platnými daty.
 *
 * Proto se čtou dva VÝŘEZY V NATIVNÍM rozlišení. Skutečný letecký snímek má i na klidné ploše
 * zrno, chybový obrázek je matematicky plochý. Prázdno hlásíme jen když jsou ploché OBA — jeden
 * výřez může padnout na střechu haly nebo na vodní hladinu.
 */
function looksBlank(bmp: ImageBitmap, pctx: CanvasRenderingContext2D): boolean {
  const w = Math.min(PROBE, bmp.width), h = Math.min(PROBE, bmp.height)
  const spots: [number, number][] = [
    [Math.floor((bmp.width - w) / 2), Math.floor((bmp.height - h) / 2)],
    [0, 0],
  ]
  return spots.every(([sx, sy]) => {
    pctx.clearRect(0, 0, PROBE, PROBE)
    pctx.drawImage(bmp, sx, sy, w, h, 0, 0, w, h) // 1:1, žádné zmenšování
    const d = pctx.getImageData(0, 0, w, h).data
    let mn = 255, mx = 0
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    return mx - mn < 6
  })
}

/**
 * `tolerateBlank` — u velkých exportů je prázdný blok obvykle území MIMO pokrytí ČÚZK (obálka
 * kraje u hranic zasahuje do Polska nebo Německa). Shodit kvůli němu celý několikahodinový
 * export by bylo nesmyslné, takže se vrátí tak, jak je, a volající si spočítá kolik jich bylo.
 */
/**
 * Stáhne jeden blok mapy jako ImageBitmap — s ověřením a opakováním. ČÚZK ArcGIS (hlavně ZTM)
 * u větších/paralelních požadavků občas vrátí 200 s prázdným (bílým) obrázkem. Velikost je na
 * detekci nepoužitelná (chyba mívá i 3 MB, reálný list i 10 kB), spolehlivé je jen to, že prázdná
 * mapa je jednolitá — viz `looksBlank`.
 */
export async function loadMapChunk(url: string, signal?: AbortSignal, tolerateBlank = false): Promise<{ bmp: ImageBitmap; blank: boolean }> {
  const probe = document.createElement('canvas'); probe.width = PROBE; probe.height = PROBE
  const pctx = probe.getContext('2d', { willReadFrequently: true })
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (signal?.aborted) throw new DOMException('Zrušeno', 'AbortError')
    try {
      const res = await fetch(url, { signal })
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.startsWith('image/')) throw new Error(`HTTP ${res.status} (${ct || 'bez typu'})`)
      const bmp = await createImageBitmap(await res.blob())
      if (pctx && looksBlank(bmp, pctx)) {
        // poslední pokus a smíme to strávit → nejspíš mimo pokrytí, ne výpadek
        if (attempt === 4 && tolerateBlank) return { bmp, blank: true }
        bmp.close?.()
        throw new Error('prázdný/jednolitý obrázek (výpadek ČÚZK)')
      }
      return { bmp, blank: false }
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw e // uživatel zrušil → nezkoušet znovu
      lastErr = e
      if (attempt < 4) await new Promise(r => setTimeout(r, 500 * attempt)) // narůstající pauza
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Blok překryvné vrstvy (katastr) jako průhledný PNG. Na rozdíl od podkladu se tu prázdný
 * obrázek nehlídá: blok bez parcel (pole, les, vodní plocha) je průhledný oprávněně a opakovat
 * kvůli němu dotaz by export jen zdrželo. Chyba služby (WMS posílá XML) se opakuje jako jinde.
 */
export async function loadOverlayChunk(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (signal?.aborted) throw new DOMException('Zrušeno', 'AbortError')
    try {
      const res = await fetch(url, { signal })
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.startsWith('image/')) throw new Error(`Katastr: HTTP ${res.status} (${ct || 'bez typu'})`)
      return await createImageBitmap(await res.blob())
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw e
      lastErr = e
      if (attempt < 4) await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Ortofoto pro obálku jako JPEG. Nad 4096 px se skládá po blocích — ČÚZK víc naráz nedá. */
export async function fetchOrthoTexture(minX: number, minY: number, maxX: number, maxY: number, longPx: number, signal: AbortSignal, report: (msg: string) => void): Promise<Uint8Array> {
  const spanX = maxX - minX, spanY = maxY - minY, longSpan = Math.max(spanX, spanY)
  const W = Math.max(1, Math.round(longPx * spanX / longSpan)), H = Math.max(1, Math.round(longPx * spanY / longSpan))
  if (W <= 4096 && H <= 4096) return await fetchJpegRetry(mapBboxUrl(minX, minY, maxX, maxY, W, H, 'ortofoto', 'ZTM250'), signal, 'Ortofoto')
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('canvas 2D nedostupný')
  const nCols = Math.ceil(W / 4096), nRows = Math.ceil(H / 4096)
  const bx = Array.from({ length: nCols + 1 }, (_, i) => Math.round(i * W / nCols))
  const by = Array.from({ length: nRows + 1 }, (_, i) => Math.round(i * H / nRows))
  const total = nCols * nRows; let done = 0
  for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) {
    if (signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
    const pxW = bx[c + 1] - bx[c], pxH = by[r + 1] - by[r]
    const x0 = minX + spanX * bx[c] / W, x1 = minX + spanX * bx[c + 1] / W
    const yTop = maxY - spanY * by[r] / H, yBot = maxY - spanY * by[r + 1] / H
    const { bmp } = await loadMapChunk(mapBboxUrl(x0, yBot, x1, yTop, pxW, pxH, 'ortofoto', 'ZTM250'), signal)
    ctx.drawImage(bmp, bx[c], by[r], pxW, pxH); bmp.close?.()
    report(`stahuji ortofoto ${++done}/${total}…`)
  }
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.92))
  if (!blob) throw new Error('Textura ortofota selhala')
  return new Uint8Array(await blob.arrayBuffer())
}
