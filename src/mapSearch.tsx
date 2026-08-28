/**
 * Vyhledávací lišta nahoře uprostřed mapy — jedno místo pro „kam se podívat" i „co vybrat".
 *
 * Dřív to byly dvě oddělené věci: „Najít místo" v hlavičce panelu (jen přelet kamery) a druhé
 * pole schované v sekci Výběr v mapě (hledání správního území). Uživatel musel dopředu vědět,
 * které z nich chce — přitom v obou psal totéž, jen název. Teď se ptáme jednou a nabídneme obojí:
 * území z RÚIAN (kraj/okres/obec/k.ú.) a místa z Nominatimu, každé ve své skupině.
 *
 * Komponenta je čistě zobrazovací. Veškeré hledání i práce s Cesiem zůstává v MapView — sem
 * chodí hotové výsledky a zpátky jde jen „na tohle klikl". Díky tomu se dá lišta překreslovat
 * při psaní bez ohledu na to, co dělá scéna.
 *
 * Umístění nahoře uprostřed je schválně: takhle to má Mapy.cz, Google Maps i ČÚZK, takže se
 * po tom ruka natáhne sama. Levý panel zůstává na nastavení, ne na hledání.
 */
import { Search, Loader2, Landmark, MapPin, X, ChevronDown, Crosshair } from 'lucide-react'
import type { AdminUnit } from './katastr'

/** Místo z geokodéru (Nominatim). `bbox` je [jih, sever, západ, východ] jako v jejich odpovědi. */
export type PlaceHit = {
  name: string
  lon: number
  lat: number
  bbox?: [number, number, number, number]
}

type Props = {
  query: string
  onQuery: (q: string) => void
  /** Enter nebo klik na lupu — spustí hledání. */
  onSubmit: () => void
  busy: boolean
  /** Správní jednotky obsahující bod / odpovídající názvu (kraj, okres, obec). */
  units: AdminUnit[]
  /** Katastrální území rozbalené obce — vlastní skupina, bývá jich i pár desítek. */
  parts: AdminUnit[]
  places: PlaceHit[]
  open: boolean
  onClose: () => void
  /** Vrátí nabídku po výběru — v jednom hledání jich bývá k vyzkoušení víc (obec × k.ú. × kraj). */
  onOpen: () => void
  onPickUnit: (u: AdminUnit) => void
  onPickPlace: (p: PlaceHit) => void
  onExpandParts: (obecKod: number) => void
  /** Režim „vyber klikem do mapy" — tentýž stav, jaký zapíná tlačítko v panelu. */
  pickMode: boolean
  onTogglePickMode: () => void
  /** Název právě zvýrazněného území, ať je vidět, co je aktivní, i se zavřenou nabídkou. */
  activeName: string | null
  onClearActive: () => void
}

export function MapSearch(p: Props) {
  const obec = p.units.find(u => u.level === 'Obec')
  const hasResults = p.units.length > 0 || p.parts.length > 0 || p.places.length > 0

  return (
    // `pointer-events-none` na obalu, `auto` na vnitřcích: mimo lištu a nabídku musí klik projít
    // do mapy, jinak by neviditelný pruh přes celou šířku bral otáčení scény.
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
      <div className="pointer-events-auto w-[min(92vw,440px)]">
        <form
          onSubmit={e => { e.preventDefault(); p.onSubmit() }}
          className="flex items-center gap-1.5 rounded-xl border border-gray-700 bg-gray-900/95 p-1.5 shadow-lg backdrop-blur"
        >
          <Search size={16} className="ml-1.5 shrink-0 text-gray-500" />
          <input
            value={p.query}
            onChange={e => p.onQuery(e.target.value)}
            onFocus={() => { if (hasResults) p.onOpen() }}
            // Esc v poli si musí poradit sám: globální posluchač vstupní pole přeskakuje,
            // aby nebral Escape rozepsanému textu jinde v appce.
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); p.onClose() } }}
            placeholder="Najít obec, kraj, k.ú. nebo místo…"
            className="min-w-0 flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none"
          />
          {p.query && (
            <button
              type="button"
              onClick={() => { p.onQuery(''); p.onClose() }}
              title="Vymazat"
              className="shrink-0 rounded p-1 text-gray-500 hover:text-gray-200"
            >
              <X size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={p.onTogglePickMode}
            title={p.pickMode ? 'Klikni do mapy na území (znovu klikni pro vypnutí)' : 'Vybrat území klikem do mapy'}
            className={`shrink-0 rounded-lg p-1.5 transition-colors ${
              p.pickMode ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <Crosshair size={15} />
          </button>
          <button
            type="submit"
            disabled={p.busy}
            title="Hledat"
            className="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {p.busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
          </button>
        </form>

        {p.pickMode && !p.open && (
          <div className="mt-1.5 rounded-lg border border-cyan-700/50 bg-cyan-950/80 px-3 py-1.5 text-center text-[11px] text-cyan-200 backdrop-blur">
            Klikni do mapy na místo, jehož území chceš vybrat
          </div>
        )}

        {p.activeName && !p.open && (
          <div className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900/90 px-2.5 py-1.5 text-xs backdrop-blur">
            <Landmark size={13} className="shrink-0 text-cyan-400" />
            <span className="min-w-0 flex-1 truncate text-gray-200">{p.activeName}</span>
            <button onClick={p.onClearActive} title="Zrušit zvýraznění území" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300">
              <X size={13} />
            </button>
          </div>
        )}

        {p.open && hasResults && (
          <div className="mt-1.5 max-h-[60vh] overflow-y-auto rounded-xl border border-gray-700 bg-gray-900/95 py-1 shadow-xl backdrop-blur">
            {p.units.length > 0 && (
              <Group title="Správní území">
                {p.units.map((u, i) => (
                  <Row key={`u${i}`} onClick={() => p.onPickUnit(u)} icon={<Landmark size={14} className="text-cyan-400" />} label={u.name} note={u.level} />
                ))}
                {obec && (
                  <button
                    onClick={() => p.onExpandParts(obec.kod)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-cyan-300 hover:bg-gray-800"
                  >
                    <ChevronDown size={13} className="shrink-0" />
                    Rozbalit katastrální území obce {obec.name}
                  </button>
                )}
              </Group>
            )}

            {p.parts.length > 0 && (
              <Group title="Katastrální území">
                {p.parts.map((u, i) => (
                  <Row key={`p${i}`} onClick={() => p.onPickUnit(u)} icon={<Landmark size={14} className="text-gray-500" />} label={u.name} note="k.ú." />
                ))}
              </Group>
            )}

            {p.places.length > 0 && (
              <Group title="Místa">
                {p.places.map((h, i) => (
                  <Row key={`m${i}`} onClick={() => p.onPickPlace(h)} icon={<MapPin size={14} className="text-emerald-400" />} label={h.name} note="přelet" />
                ))}
              </Group>
            )}
          </div>
        )}

        {p.open && !hasResults && !p.busy && (
          <div className="mt-1.5 rounded-lg border border-gray-700 bg-gray-900/95 px-3 py-2 text-center text-xs text-gray-400 backdrop-blur">
            Nic nenalezeno
          </div>
        )}
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-800 py-0.5 last:border-b-0">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">{title}</div>
      {children}
    </div>
  )
}

function Row({ onClick, icon, label, note }: { onClick: () => void; icon: React.ReactNode; label: string; note: string }) {
  return (
    <button onClick={onClick} title={`${note}: ${label}`} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-800">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-gray-100">{label}</span>
      <span className="shrink-0 text-[10px] text-gray-500">{note}</span>
    </button>
  )
}
