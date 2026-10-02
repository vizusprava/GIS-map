/**
 * Vyhledávání v liště nahoře uprostřed — území z RÚIAN i místa z geokodéru naráz (mapSearch.tsx),
 * a když dotaz vypadá jako číslo parcely („95/1 České Budějovice 1", „st. 866 Mrač", samotné
 * „1234" = v k.ú. uprostřed obrazovky), i parcely.
 *
 * Stav je tady, protože do téže rozbalovací nabídky píše i výběr území klikem do mapy.
 */
import { useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { findParcels, parseParcelQuery, ruianAtPoint, ruianQuery, type AdminUnit, type ParcelHit } from './katastr'
import type { PlaceHit } from './mapSearch'

export type MapSearchTool = ReturnType<typeof useMapSearch>

export function useMapSearch(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  /** nalezená území do nabídky */
  showAdmin: (units: AdminUnit[], parts: AdminUnit[]) => void
  /** právě jedno nalezené území se rovnou zvýrazní */
  pickSingleUnit: (u: AdminUnit) => Promise<void>
  /** nalezená parcela → do výběru a přelet nad ni */
  pickParcel: (h: ParcelHit) => void
}) {
  const { viewerRef, showAdmin, pickSingleUnit, pickParcel } = deps

  const [searching, setSearching] = useState(false)
  const [placeHits, setPlaceHits] = useState<PlaceHit[]>([])
  const [parcelHits, setParcelHits] = useState<ParcelHit[]>([])
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

  /**
   * Parcely podle čísla. Bez názvu k.ú. se hledá v tom, které je uprostřed obrazovky — kdo se
   * dívá na obec a píše jen číslo, myslí parcelu tady. Chyba služby se neohlásí: parcely jsou
   * jen jedna ze skupin výsledků.
   */
  async function searchParcels(pq: NonNullable<ReturnType<typeof parseParcelQuery>>): Promise<ParcelHit[]> {
    try {
      if (pq.ku) return await findParcels(pq.num, { name: pq.ku }, pq.explicitKind)
      const v = viewerRef.current
      if (!v || v.isDestroyed()) return []
      const c = v.scene.canvas
      const p = v.scene.globe.pick(v.camera.getPickRay(new Cesium.Cartesian2(c.clientWidth / 2, c.clientHeight / 2))!, v.scene)
      if (!p) return []
      const cc = Cesium.Cartographic.fromCartesian(p)
      const ku = await ruianAtPoint(7, Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude))
      return ku ? await findParcels(pq.num, { kod: ku.kod, name: ku.nazev }, pq.explicitKind) : []
    } catch (e) {
      console.warn('Hledání parcely selhalo:', e)
      return []
    }
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
      // Samotné číslo je jen parcela — území ani místo podle čísla hledat nemá smysl.
      const pq = parseParcelQuery(q)
      const onlyParcel = !!pq && !pq.ku
      // souběžně: RÚIAN je pomalejší (čtyři vrstvy), ať na něj geokodér nečeká
      const [admin, places, parcelsFound] = await Promise.all([
        onlyParcel ? { units: [], parts: [] } : searchAdminUnits(q),
        onlyParcel ? [] : searchPlaces(q),
        pq ? searchParcels(pq) : [],
      ])
      showAdmin(admin.units, admin.parts)
      setPlaceHits(places)
      setParcelHits(parcelsFound)
      // právě jedna možnost → rovnou ji zobraz, ať se nekliká do nabídky o jedné položce
      if (parcelsFound.length === 1 && !admin.units.length && !admin.parts.length) {
        setSearchOpen(false)
        pickParcel(parcelsFound[0])
      } else if (admin.units.length === 1 && !admin.parts.length && !places.length && !parcelsFound.length) {
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
    parcelHits,
    placeHits,
    query,
    runSearch,
    searchOpen,
    searching,
    setParcelHits,
    setPlaceHits,
    setQuery,
    setSearchOpen,
  }
}
