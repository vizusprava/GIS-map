/**
 * Stažení ortofoto dlaždic ČÚZK pro lokální mapu („Načíst 2D lokálně").
 *
 * Bere se tatáž hotová cache, ze které jede zobrazení (`ORTOFOTO_WM`, viz imagery.ts), a bajty se
 * ukládají beze změny — napečená dlaždice je tedy bit po bitu ta, kterou by mapa jinak stáhla.
 * Dřív se peklo přes WMS export (render na dotaz, ~1 s na kus); z cache je to ~0,1 s.
 *
 * Bez Cesia/DOMu (jen fetch), ať je to lehké.
 */

// ── semafor: kolik dlaždic se stahuje naráz ──
// Cache jsou statické soubory, takže ČÚZK víc souběhu snese než u WMS. Zbytek spojení
// k hostiteli (HTTP/1.1 = šest) nechává mapě, která jede vedle.
let active = 0
const queue: (() => void)[] = []
const MAX_CONC = 4
function acquire(): Promise<void> {
  if (active < MAX_CONC) { active++; return Promise.resolve() }
  return new Promise<void>(res => queue.push(() => res())).then(() => { active++ })
}
function release() { active--; const next = queue.shift(); if (next) next() }

/**
 * Stáhne jednu dlaždici z cache (semafor + opakování + kontrola typu).
 *
 * `'missing'` = cache dlaždici nemá (404 — za hranicí republiky); to není chyba, jen není co
 * uložit. `null` = stažení selhalo i po opakování (výpadek), a má smysl to pustit znovu.
 */
export async function fetchCacheTile(url: string, signal?: AbortSignal): Promise<Uint8Array | 'missing' | null> {
  await acquire()
  try {
    for (let a = 1; a <= 4; a++) {
      if (signal?.aborted) return null
      try {
        const r = await fetch(url, { signal })
        if (r.status === 404) return 'missing'
        const ct = r.headers.get('content-type') || ''
        // formát cache je „MIXED": JPEG uvnitř republiky, PNG s průhledností u hranic
        if (r.ok && (ct.includes('image/jpeg') || ct.includes('image/png'))) {
          const buf = new Uint8Array(await r.arrayBuffer())
          if (buf.length > 0) return buf
        }
      } catch { if (signal?.aborted) return null /* jinak opakovat */ }
      await new Promise(res => setTimeout(res, 300 * a)) // narůstající pauza
    }
    return null
  } finally { release() }
}
