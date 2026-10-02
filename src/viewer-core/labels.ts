/**
 * Rozmisťování popisků, aby se nepřekrývaly.
 *
 * Kót je na hustém výkrese víc než místa. Dřív se prostě posadila každá doprostřed svého
 * úseku a při nahuštění z toho byla nečitelná změť přes sebe. Tady se popisky berou v pořadí
 * důležitosti (volající si je seřadí — obvykle od nejdelšího úseku) a každý se posadí jen
 * tehdy, když je na něj místo; když ne, zkusí se odsadit kolmo, a teprve pak se vzdá.
 *
 * Obsazené místo se drží v pravidelné mřížce, takže se každý popisek porovnává jen se
 * sousedy, ne se všemi předchozími.
 */

export interface LabelSpot {
  /** střed popisku */
  x: number
  y: number
  /** rozměry textu */
  w: number
  h: number
  /** natočení textu ve stupních */
  angle: number
}

export interface PlaceOptions {
  /** mezera kolem popisku, aby se texty nedotýkaly */
  pad?: number
  /** kolikrát se zkusí popisek odsadit kolmo, než se vzdá */
  tries?: number
  /** nejvýš tolik popisků; 0 = bez omezení */
  max?: number
}

type Box = { x0: number; y0: number; x1: number; y1: number }

/** obálka otočeného obdélníku — konzervativní, ale na rozhodnutí „vejde se" to stačí */
function aabb(s: LabelSpot, pad: number): Box {
  const a = (s.angle * Math.PI) / 180
  const c = Math.abs(Math.cos(a))
  const n = Math.abs(Math.sin(a))
  const hw = (c * s.w + n * s.h) / 2 + pad
  const hh = (n * s.w + c * s.h) / 2 + pad
  return { x0: s.x - hw, y0: s.y - hh, x1: s.x + hw, y1: s.y + hh }
}

/**
 * Vybere z nabídnutých popisků ty, které se vejdou bez překryvu.
 * Vrací je ve stejném pořadí, v jakém přišly, ale s upravenou polohou.
 */
export function placeLabels<T extends LabelSpot>(cands: T[], opts: PlaceOptions = {}): T[] {
  const pad = opts.pad ?? 1
  const tries = opts.tries ?? 2
  const max = opts.max ?? 0
  if (!cands.length) return []

  // buňka podle průměrné velikosti popisku: dost hrubá, aby jich v ní bylo pár
  let avg = 0
  for (const c of cands) avg += Math.max(c.w, c.h)
  const cell = Math.max(avg / cands.length, 1e-6)
  const grid = new Map<string, Box[]>()
  const key = (ix: number, iy: number) => ix + ':' + iy

  const free = (b: Box): boolean => {
    for (let ix = Math.floor(b.x0 / cell); ix <= Math.floor(b.x1 / cell); ix++) {
      for (let iy = Math.floor(b.y0 / cell); iy <= Math.floor(b.y1 / cell); iy++) {
        for (const o of grid.get(key(ix, iy)) ?? []) {
          if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return false
        }
      }
    }
    return true
  }
  const occupy = (b: Box) => {
    for (let ix = Math.floor(b.x0 / cell); ix <= Math.floor(b.x1 / cell); ix++) {
      for (let iy = Math.floor(b.y0 / cell); iy <= Math.floor(b.y1 / cell); iy++) {
        const k = key(ix, iy)
        const list = grid.get(k)
        if (list) list.push(b); else grid.set(k, [b])
      }
    }
  }

  const out: T[] = []
  for (const c of cands) {
    if (max && out.length >= max) break
    const a = ((c.angle + 90) * Math.PI) / 180        // kolmo na text
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    let placed: T | null = null
    for (let t = 0; t <= tries && !placed; t++) {
      // zkouší se střed, pak nad, pak pod — ať popisek neuteče dál, než je nutné
      for (const sign of t === 0 ? [0] : [1, -1]) {
        const off = sign * t * c.h * 1.4
        const spot = { ...c, x: c.x + dx * off, y: c.y + dy * off }
        const b = aabb(spot, pad)
        if (!free(b)) continue
        occupy(b)
        placed = spot
        break
      }
    }
    if (placed) out.push(placed)
  }
  return out
}
