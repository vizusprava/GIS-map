/**
 * Počty kolem dlaždic terénu: v jakém pořadí je stahovat a jak z jedné vyříznout hlubší.
 *
 * Vlastní soubor proto, že je to čistá matematika bez Cesia a bez sítě — dá se na ni napsat
 * test (`scripts/test-terrain.mjs`), což u obojího stojí za to: chyba o jeden index se na mapě
 * pozná, až když modelu ujede terén pod nohama. Kdo řeší, odkud se výšky berou, hledá
 * v `terrain.ts`.
 *
 * Uspořádání hodnot v mřížce je stejné jako v Cesiu (`HeightmapTerrainData`): od SEVEROZÁPADNÍHO
 * rohu na východ, pak o řádek na jih. Index vzorku (i, j) je tedy `j * w + i`.
 */

/**
 * Která z čekajících dlaždic je nejblíž tomu, na co se člověk dívá. Prázdná fronta dá −1.
 *
 * Vzdálenost se počítá ve stupních a poledníky se stahují podle rovnoběžky, ať u nás
 * odpovídá poměr stran skutečnosti. Odmocnina se nedělá — jde jen o porovnání.
 */
export function nearestToFocus(queue: readonly { lon: number; lat: number }[], focusLon: number, focusLat: number): number {
  let best = -1, bestD = Infinity
  for (let i = 0; i < queue.length; i++) {
    const dLat = queue[i].lat - focusLat
    const dLon = (queue[i].lon - focusLon) * Math.cos(((queue[i].lat + focusLat) / 2) * Math.PI / 180)
    const d = dLat * dLat + dLon * dLon
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/**
 * Vyřízne z bloku rodiče jednu ze čtyř dětských dlaždic — bez interpolace.
 *
 * Blok má `n = 2·(w−1) + 1` vzorků na stranu a je napnutý mezi okraje RODIČE, takže dítě
 * (`sx`, `sy` = 0 nebo 1, `sy` od severu) je v něm přesně podmřížka od indexu `sx·(w−1)`.
 * Sourozenci si tak sdílejí prostřední řadu vzorků bit po bitu a na švu mezi nimi není schod.
 * Proč blok: jeden dotaz na ČÚZK místo čtyř, viz `terrain.ts`.
 */
export function sliceBlock(block: Float32Array, n: number, w: number, h: number, sx: number, sy: number): Float32Array {
  const out = new Float32Array(w * h)
  const ox = sx * (w - 1), oy = sy * (h - 1)
  for (let j = 0; j < h; j++) {
    const row = (oy + j) * n + ox
    out.set(block.subarray(row, row + w), j * w)
  }
  return out
}

/**
 * Vyřízne z mřížky její podčtverec a navzorkuje ho zpátky na stejný rozměr.
 *
 * Používá se k dopočtu hlubších dlaždic terénu z té, kterou už máme: `n` říká, kolikrát je
 * předek na každou stranu větší (2^rozdíl úrovní), `sx`/`sy` je pozice hledané dlaždice
 * uvnitř předka (0…n-1, `sy` počítáno od severu, stejně jako dlaždicové y v Cesiu).
 *
 * Vzorek (i, j) výsledku leží v předkovi na souřadnici `(sx*(w-1) + i) / n` — mřížka je totiž
 * napnutá mezi okraje dlaždice, ne mezi středy buněk, takže krajní vzorky obou dlaždic
 * na společné hraně padnou přesně na sebe a sousední dlaždice na sebe navazují bez schodu.
 * Mezi vzorky se interpoluje bilineárně.
 */
export function resampleTile(src: Float32Array, w: number, h: number, sx: number, sy: number, n: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let j = 0; j < h; j++) {
    const gv = (sy * (h - 1) + j) / n
    const j0 = Math.min(Math.floor(gv), h - 1), j1 = Math.min(j0 + 1, h - 1), fv = gv - j0
    for (let i = 0; i < w; i++) {
      const gu = (sx * (w - 1) + i) / n
      const i0 = Math.min(Math.floor(gu), w - 1), i1 = Math.min(i0 + 1, w - 1), fu = gu - i0
      const top = src[j0 * w + i0] * (1 - fu) + src[j0 * w + i1] * fu
      const bot = src[j1 * w + i0] * (1 - fu) + src[j1 * w + i1] * fu
      out[j * w + i] = top * (1 - fv) + bot * fv
    }
  }
  return out
}
