/**
 * Převod výšky Bpv ↔ výška nad elipsoidem, podle místa.
 *
 * ČÚZK dává výšky v Bpv (DMR 5G, výkresy, export do Maxu), Cesium kreslí nad elipsoidem WGS84
 * a Google 3D dlaždice jsou v elipsoidických výškách taky. Rozdíl mezi nimi — kvazigeoid — není
 * konstanta: v ČR jde od 42,6 m na Ostravsku po 47,5 m na Šumavě. Dřív se všude přičítalo 44 m,
 * takže terén byl podle místa až o 3,5 m výš nebo níž a Google dlaždice nad ním „plavaly"
 * (v Liberci o 0,7 m níž, v Praze o metr výš, na Plzeňsku skoro o tři).
 *
 * Model je oficiální CR-2005 ČÚZK (viz `geoidData.ts`), bilineárně z mřížky po 0,1° × 4′.
 * Proti plné mřížce to dělá nejvýš ~10 cm, v průměru pod centimetr — o řád míň, než je výšková
 * přesnost samotných Google dlaždic.
 */
import { GEOID_GRID } from './geoidData'

const G = GEOID_GRID

/** Výška kvazigeoidu nad elipsoidem (m) v daném místě: elipsoid = Bpv + `geoidN`. */
export function geoidN(lon: number, lat: number): number {
  // mimo mřížku (za hranicí ČR) se drží okrajová hodnota — Cesium tam stejně nic z ČÚZK nekreslí
  const fx = Math.min(G.cols - 1, Math.max(0, (lon - G.lon0) / G.dLon))
  const fy = Math.min(G.rows - 1, Math.max(0, (G.lat0 - lat) / G.dLat))
  const x0 = Math.min(G.cols - 2, Math.floor(fx)), y0 = Math.min(G.rows - 2, Math.floor(fy))
  const tx = fx - x0, ty = fy - y0
  const at = (x: number, y: number) => G.cm[y * G.cols + x]
  const cm = at(x0, y0) * (1 - tx) * (1 - ty) + at(x0 + 1, y0) * tx * (1 - ty)
    + at(x0, y0 + 1) * (1 - tx) * ty + at(x0 + 1, y0 + 1) * tx * ty
  return G.base + cm / 100
}
