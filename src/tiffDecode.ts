/**
 * Dekódování GeoTIFFu na pixely RGBA + georeference z tagů. Bez Cesia a DOMu: běží ve workeru
 * (tiffWorker.ts) — rozbalení velkého ortofota (LZW/Deflate) trvá vteřiny a na hlavním vlákně
 * by po tu dobu stála celá mapa.
 */
import { fromBlob } from 'geotiff'
import type { CrsId, WorldAffine } from './worldRaster'

// Strop dekódování. Kvalita má přednost, tak je nastavený vysoko — jde jen o to, aby se
// prohlížeč nesložil (snímek se v paměti rozbalí na 4 B/px) a aby šel pak vůbec vykreslit.
export const MAX_DIM = 16_384
export const MAX_PIXELS = 150_000_000

/** EPSG kód z GeoTIFF geokeys → naše id (co neznáme, se doodhadne podle rozsahu souřadnic). */
function crsFromEpsg(epsg: number | undefined): CrsId | null {
  if (epsg === 5514 || epsg === 5513 || epsg === 2065) return 'sjtsk'
  if (epsg === 3857 || epsg === 900913 || epsg === 3785) return 'webmerc'
  if (epsg === 32633) return 'utm33n'
  if (epsg === 4326) return 'wgs84'
  return null
}

export type TiffPixels = {
  rgba: Uint8ClampedArray
  w: number
  h: number
  /** kolik původních pixelů připadá na jeden dekódovaný (zmenšení kvůli paměti) */
  sx: number
  sy: number
  native: { w: number; h: number }
  world: WorldAffine | null
  crsId: CrsId | null
}

/**
 * GeoTIFF: dekóduje rovnou na cílové rozlišení (geotiff.js umí převzorkovat při čtení, takže
 * obří listy neprojdou pamětí v plné velikosti) a zároveň vytáhne georeferenci z tagů.
 */
export async function decodeTiffPixels(file: Blob): Promise<TiffPixels> {
  const img = await (await fromBlob(file)).getImage()
  const W = img.getWidth(), H = img.getHeight()
  const s = Math.min(1, MAX_DIM / Math.max(W, H), Math.sqrt(MAX_PIXELS / (W * H)))
  const tw = Math.max(1, Math.round(W * s)), th = Math.max(1, Math.round(H * s))
  const spp = img.getSamplesPerPixel()
  const raw = await img.readRasters({ width: tw, height: th, interleave: true }) as unknown as ArrayLike<number>

  // 8bitové ortofoto je pravidlo, ale 16bit se občas objeví → podle maxima to srovnáme do 0..255
  let max = 0
  const step = Math.max(1, Math.floor(raw.length / 100_000))
  for (let i = 0; i < raw.length; i += step) if (raw[i] > max) max = raw[i]
  const k = max > 255 ? 255 / max : 1

  const rgba = new Uint8ClampedArray(tw * th * 4)
  for (let p = 0, o = 0; p < tw * th; p++, o += 4) {
    const b = p * spp
    if (spp >= 3) {
      rgba[o] = raw[b] * k; rgba[o + 1] = raw[b + 1] * k; rgba[o + 2] = raw[b + 2] * k
      rgba[o + 3] = spp >= 4 ? raw[b + 3] * k : 255
    } else {
      const g = raw[b] * k
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255
    }
  }

  // georeference z tagů: origin je ROH rastru, world file chce STŘED prvního pixelu
  let world: WorldAffine | null = null
  let crsId: CrsId | null = null
  try {
    const res = img.getResolution() as number[]
    const org = img.getOrigin() as number[]
    if (Number.isFinite(res?.[0]) && Number.isFinite(org?.[0])) {
      const rx = res[0] * (W / tw), ry = res[1] * (H / th)
      world = { ax: rx, ay: 0, bx: 0, by: ry, x0: org[0] + rx / 2, y0: org[1] + ry / 2 }
    }
    const keys = (img.getGeoKeys?.() ?? {}) as { ProjectedCSTypeGeoKey?: number; GeographicTypeGeoKey?: number }
    crsId = crsFromEpsg(keys.ProjectedCSTypeGeoKey) ?? crsFromEpsg(keys.GeographicTypeGeoKey)
  } catch { /* tagy chybí → dojede se na world file */ }

  return { rgba, w: tw, h: th, sx: W / tw, sy: H / th, native: { w: W, h: H }, world, crsId }
}
