/**
 * Geometrie nad obrysem republiky (crBorder.ts): je místo uvnitř, kam ho přitáhnout, když je
 * moc daleko za hranicí, a jak je republika velká. Čistá matematika (km v lokální rovině kolem
 * 49,8° s. š. — na vzdálenost stovek km to stačí s rezervou), bez Cesia, ať jde testovat.
 */
import { CR_BORDER } from './crBorder'

/** jak daleko za hranicí smí ležet místo, na které se kamera dívá */
export const MARGIN_KM = 15

const LAT0 = 49.8
const KX = 111.32 * Math.cos((LAT0 * Math.PI) / 180), KY = 110.57
const PTS: [number, number][] = []
for (let i = 0; i < CR_BORDER.length; i += 2) PTS.push([CR_BORDER[i] * KX, CR_BORDER[i + 1] * KY])
const BOX = PTS.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity])
/** rozměr republiky (km): šířka a výška obdélníku kolem obrysu */
export const CR_W = BOX[2] - BOX[0], CR_H = BOX[3] - BOX[1]

function inside(x: number, y: number) {
  let r = false
  for (let i = 0, j = PTS.length - 1; i < PTS.length; j = i++) {
    const [xi, yi] = PTS[i], [xj, yj] = PTS[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r
  }
  return r
}
function nearestOnBorder(x: number, y: number): [number, number, number] {
  let best: [number, number, number] = [x, y, Infinity]
  for (let i = 0, j = PTS.length - 1; i < PTS.length; j = i++) {
    const [ax, ay] = PTS[j], [bx, by] = PTS[i]
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
    const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(x - qx, y - qy)
    if (d < best[2]) best = [qx, qy, d]
  }
  return best
}

/** Vzdálenost místa (stupně) za hranicí republiky v km; 0 = uvnitř. */
export function kmOutsideCr(lon: number, lat: number): number {
  const x = lon * KX, y = lat * KY
  return inside(x, y) ? 0 : nearestOnBorder(x, y)[2]
}

/**
 * Místo (stupně) přitažené do dosahu republiky: uvnitř nebo nanejvýš `MARGIN_KM` za hranicí.
 * null = v pořádku, nic se nemění.
 */
export function clampToCr(lon: number, lat: number): [number, number] | null {
  const x = lon * KX, y = lat * KY
  if (inside(x, y)) return null
  const [qx, qy, d] = nearestOnBorder(x, y)
  if (d <= MARGIN_KM) return null
  return [(qx + ((x - qx) / d) * MARGIN_KM) / KX, (qy + ((y - qy) / d) * MARGIN_KM) / KY]
}
