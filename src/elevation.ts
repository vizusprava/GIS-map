/**
 * Výškové vzorkovače z ČÚZK ImageServeru (DMR5G = terén, DMP1G = povrch).
 *
 * Stáhne se jeden float32 TIFF pro obdélník a vrátí se funkce „souřadnice → výška". Bez Cesia
 * a bez DOMu (jen fetch + geotiff), takže to jde volat i z exportních modulů a testovat v Node.
 */
import { fromArrayBuffer } from 'geotiff'
import { fetchRetry } from './tiles'
import { cacheGet, cachePut } from './cache'

/** Výškový rastr z ČÚZK ImageServeru (dmr5g/dmp1g) → vzorkovací funkce lon/lat → výška (Bpv). */
export async function fetchElevSampler(service: 'dmr5g' | 'dmp1g', minLon: number, minLat: number, maxLon: number, maxLat: number, size: number): Promise<(lon: number, lat: number) => number | null> {
  const url = `https://ags.cuzk.gov.cz/arcgis2/rest/services/${service}/ImageServer/exportImage?bbox=${minLon},${minLat},${maxLon},${maxLat}&bboxSR=4326&imageSR=4326&size=${size},${size}&format=tiff&pixelType=F32&f=image`
  return fetchRetry(url, { parse: async res => {
    if (!res.ok) throw new Error(`${service}: HTTP ${res.status}`)
    const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage()
    const w = img.getWidth(), h = img.getHeight()
    if (!w || !h) throw new Error(`${service}: prázdný rastr`)
    const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
    return (lon, lat) => {
      const x = Math.max(0, Math.min(w - 1, Math.round(((lon - minLon) / (maxLon - minLon)) * w - 0.5)))
      const y = Math.max(0, Math.min(h - 1, Math.round(((maxLat - lat) / (maxLat - minLat)) * h - 0.5)))
      const e = r[y * w + x] as number
      return Number.isFinite(e) && e > -500 && e < 3000 ? e : null
    }
  } })
}

/**
 * Totéž, ale rovnou v S-JTSK (EPSG:5514) → vzorkovač (X,Y)→výška Bpv. Používá výřez katastru,
 * který trianguluje v S-JTSK rovině (stejně jako dlaždice), takže výšky vzorkuje bez reprojekce.
 * Výšky jsou syrové Bpv (BEZ geoidu) — shodně s dlaždicemi (fetchTileHeights), ať export lícuje.
 */
export async function fetchElevSamplerSJTSK(service: 'dmr5g' | 'dmp1g', minX: number, minY: number, maxX: number, maxY: number, sw: number, sh: number, signal?: AbortSignal): Promise<(x: number, y: number) => number | null> {
  const url = `https://ags.cuzk.gov.cz/arcgis2/rest/services/${service}/ImageServer/exportImage?bbox=${minX},${minY},${maxX},${maxY}&bboxSR=5514&imageSR=5514&size=${sw},${sh}&format=tiff&pixelType=F32&f=image`
  return fetchRetry(url, { signal, parse: async res => {
    if (!res.ok) throw new Error(`${service}: HTTP ${res.status}`)
    const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage()
    const w = img.getWidth(), h = img.getHeight()
    if (!w || !h) throw new Error(`${service}: prázdný rastr`)
    const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
    return (x, y) => {
      const px = Math.max(0, Math.min(w - 1, Math.round(((x - minX) / (maxX - minX)) * w - 0.5)))
      const py = Math.max(0, Math.min(h - 1, Math.round(((maxY - y) / (maxY - minY)) * h - 0.5)))
      const e = r[py * w + px] as number
      return Number.isFinite(e) && e > -500 && e < 3000 ? e : null
    }
  } })
}

/**
 * Výšková mřížka terénu (DMR 5G, Bpv) přes obdélník lon/lat → vzorkovač s bilineární
 * interpolací, ať čára posazená na terén nedělá schody po pixelech. Pro přilepení výkresu.
 *
 * Pixely jsou čtvercové ve stupních a obdélník se na ně zarovná (roztáhne o zlomek pixelu):
 * ImageServer by jinak při jiném poměru stran sám posunul výřez a výšky by seděly vedle.
 * Rozlišení ~1,5 m, u velkého výkresu hrubší (nejvýš 2048 px na stranu).
 *
 * Mřížka se uloží do cache prohlížeče (stejně jako dlaždice terénu), takže příští přilepení
 * téhož výkresu — i po zavření scény — už nic nestahuje.
 */
export async function fetchElevGrid(minLon: number, minLat: number, maxLon: number, maxLat: number): Promise<{ sample: (lon: number, lat: number) => number | null; stepM: number }> {
  const p = Math.max(1.5 / 110_574, (maxLon - minLon) / 2048, (maxLat - minLat) / 2048)
  const w = Math.max(2, Math.ceil((maxLon - minLon) / p)), h = Math.max(2, Math.ceil((maxLat - minLat) / p))
  const x1 = minLon + w * p, y1 = minLat + h * p
  const key = `dmrll/${minLon.toFixed(6)},${minLat.toFixed(6)}/${p.toExponential(6)}/${w}x${h}`
  let grid: Float32Array
  const cached = await cacheGet(key)
  if (cached && cached.byteLength === w * h * 4) grid = new Float32Array(cached.slice().buffer)
  else {
    // značka pro kouřový test: stáhlo se doopravdy, ne z cache
    performance.mark('geo:dmr-grid-fetch')
    const url = `https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage?bbox=${minLon},${minLat},${x1},${y1}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=tiff&pixelType=F32&f=image`
    grid = await fetchRetry(url, { parse: async res => {
      if (!res.ok) throw new Error(`dmr5g: HTTP ${res.status}`)
      const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage()
      if (img.getWidth() !== w || img.getHeight() !== h) throw new Error(`dmr5g vrátil ${img.getWidth()}×${img.getHeight()}, čekal ${w}×${h}`)
      const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
      const out = new Float32Array(w * h)
      for (let i = 0; i < w * h; i++) { const e = r[i] as number; out[i] = Number.isFinite(e) && e > -500 && e < 3000 ? e : NaN }
      return out
    } })
    await cachePut(key, new Uint8Array(grid.buffer.slice(0)))
  }
  const sample = (lon: number, lat: number): number | null => {
    // střed pixelu (i, j) leží na minLon + (i + ½)·p, řádky jdou od severu
    const fx = Math.max(0, Math.min(w - 1, (lon - minLon) / p - 0.5))
    const fy = Math.max(0, Math.min(h - 1, (y1 - lat) / p - 0.5))
    const i = Math.min(w - 2, Math.floor(fx)), j = Math.min(h - 2, Math.floor(fy))
    const tx = fx - i, ty = fy - j
    const a = grid[j * w + i], b = grid[j * w + i + 1], c = grid[(j + 1) * w + i], d = grid[(j + 1) * w + i + 1]
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)) {
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    }
    // u díry v datech (vodní plochy, okraj) aspoň nejbližší platný soused
    const near = [[a, tx + ty], [b, 1 - tx + ty], [c, tx + 1 - ty], [d, 2 - tx - ty]].filter(([v]) => Number.isFinite(v)).sort((u, v) => u[1] - v[1])
    return near.length ? near[0][0] : null
  }
  return { sample, stepM: p * 110_574 }
}
