/**
 * Pomocníci pro export do souborů: stažení blobu, jméno podle kotvy a zápis DXF.
 *
 * Pozor na jména: `dxf.ts` DXF ČTE (import výkresu), tenhle modul ho PÍŠE (export parcel a území).
 */
import type { Anchor } from './types'

/**
 * Geo-kotva v názvu jako CELÁ ČÍSLA bez teček (lon/lat v mikrostupních, výška v cm) —
 * tečky některé programy (3ds Max) usekávají u prvního „.". Formát: geo_<lonE6>_<latE6>_<hCm>.
 */
export function parseAnchor(name: string): Anchor | null {
  const m = name.match(/geo_(-?\d+)_(-?\d+)_(-?\d+)/)
  return m ? { lon: +m[1] / 1e6, lat: +m[2] / 1e6, h: +m[3] / 100 } : null
}

export function download(data: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Uzavřené 3D polyliny do DXF (R12) — importuje se do 3ds Max/CAD jako editovatelné splajny/tvary.
 * Souřadnice se zapisují tak, jak přijdou; appka sem posílá vždy S-JTSK (EPSG:5514) a výšku Bpv,
 * tedy stejný rámec jako OBJ export terénu.
 */
export function buildDxf(polylines: [number, number, number][][], layer = 'PARCELY'): string {
  return buildDxfLayers([{ layer, polylines }])
}

/** Jako buildDxf, ale víc pojmenovaných hladin v jednom výkresu (např. parcely + obrys území). */
export function buildDxfLayers(groups: { layer: string; polylines: [number, number, number][][] }[]): string {
  const L: (string | number)[] = []
  const g = (code: number, val: string | number) => { L.push(code, val) }
  g(0, 'SECTION'); g(2, 'ENTITIES')
  for (const grp of groups) for (const pl of grp.polylines) {
    g(0, 'POLYLINE'); g(8, grp.layer); g(66, 1); g(70, 9) // 1=uzavřená + 8=3D polylinie
    for (const [x, y, z] of pl) {
      g(0, 'VERTEX'); g(8, grp.layer)
      g(10, x.toFixed(4)); g(20, y.toFixed(4)); g(30, z.toFixed(4)); g(70, 32) // 32=vrchol 3D polylinie
    }
    g(0, 'SEQEND')
  }
  g(0, 'ENDSEC'); g(0, 'EOF')
  return L.join('\n')
}
