/**
 * Vyhledávání v liště nahoře uprostřed — území z RÚIAN i místa z geokodéru naráz (mapSearch.tsx).
 *
 * Stav je tady, protože do téže rozbalovací nabídky píše i výběr území klikem do mapy.
 */
import { useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { ruianQuery, type AdminUnit } from './katastr'
import type { PlaceHit } from './mapSearch'

export type MapSearchTool = ReturnType<typeof useMapSearch>

export function useMapSearch(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  /** nalezená území do nabídky */
  showAdmin: (units: AdminUnit[], parts: AdminUnit[]) => void
  /** právě jedno nalezené území se rovnou zvýrazní */
  pickSingleUnit: (u: AdminUnit) => Promise<void>
}) {
  const { viewerRef, showAdmin, pickSingleUnit } = deps

  const [searching, setSearching] = useState(false)
  const [placeHits, setPlaceHits] = useState<PlaceHit[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  async function searchAdminUnits(q: string): Promise<{ units: AdminUnit[]; parts: AdminUnit[] }> {
    const like = `UPPER(nazev) LIKE UPPER('%${q.replace(/'/g, "''")}%')`
    const layers: [number, string][] = [[17, 'Kraj'], [15, 'Okres'], [12, 'Obec'], [7, 'k.ú.']]
    // Vrstvy se ptají souběžně (dřív za sebou — čtyřnásobek čekání) a nezávisle: když jedna
    // vypadne, zbytek výsledků má pořád cenu ukázat. Pořadí výsledků zůstává od kraje po k.ú.
    const perLayer = await Promise.all(layers.map(async ([layer, level]) => {
      try { return (await ruianQuery(layer, like, false)).slice(0, 12).map(r => ({ level, name: r.nazev, kod: r.kod, layer })) }
      catch { return [] as AdminUnit[] }
    }))
    const found: AdminUnit[] = perLayer.flat()
    return { units: found.filter(u => u.level !== 'k.ú.'), parts: found.filter(u => u.level === 'k.ú.') }
  }

  /** Název → místa z geokodéru (jen ČR). Slouží čistě k přeletu, nic se tím nevybírá. */
  async function searchPlaces(q: string): Promise<PlaceHit[]> {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=cz&limit=5&q=${encodeURIComponent(q)}`
      const data = await (await fetch(url, { headers: { 'Accept-Language': 'cs' } })).json() as
        Array<{ display_name: string; lat: string; lon: string; boundingbox?: [string, string, string, string] }>
      return data.map(h => ({
        name: h.display_name,
        lon: Number(h.lon),
        lat: Number(h.lat),
        bbox: h.boundingbox ? (h.boundingbox.map(Number) as [number, number, number, number]) : undefined,
      }))
    } catch { return [] } // geokodér je doplněk; když neodpoví, RÚIAN výsledky stačí
  }

  // Jedno hledání pro obojí. Dřív se uživatel musel dopředu rozhodnout, jestli chce „najít místo"
  // (přelet) nebo „vybrat území" (výběr) — a psal do obou stejný název. Teď se ptáme jednou a
  // obě sady výsledků nabídneme vedle sebe; co je co, rozliší skupina v nabídce.
  async function runSearch() {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchOpen(true)
    try {
      // souběžně: RÚIAN je pomalejší (čtyři vrstvy), ať na něj geokodér nečeká
      const [admin, places] = await Promise.all([searchAdminUnits(q), searchPlaces(q)])
      showAdmin(admin.units, admin.parts)
      setPlaceHits(places)
      // právě jedna možnost → rovnou ji zobraz, ať se nekliká do nabídky o jedné položce
      if (admin.units.length === 1 && !admin.parts.length && !places.length) {
        setSearchOpen(false)
        await pickSingleUnit(admin.units[0])
      }
    } catch (err) {
      console.error('Vyhledávání selhalo:', err)
      toast.error('Vyhledávání selhalo')
    } finally {
      setSearching(false)
    }
  }

  /** Přelet na místo z geokodéru — na obálku, když ji nabídne, jinak na bod z 10 km. */
  function flyToPlace(h: PlaceHit) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    setSearchOpen(false)
    if (h.bbox) {
      const [s, n, w, e] = h.bbox
      v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w, s, e, n) })
    } else {
      v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, 10000) })
    }
  }

  return {
    flyToPlace,
    placeHits,
    query,
    runSearch,
    searchOpen,
    searching,
    setPlaceHits,
    setQuery,
    setSearchOpen,
  }
}
