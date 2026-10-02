/**
 * Sekce „Výběr v mapě": nastavení právě zapnutého nástroje výběru — oblasti nebo dlaždic.
 *
 * Nástroje samy se zapínají v liště dole nebo klávesou (mapTools.tsx). Dřív tu byly ještě
 * jednou jako čtyři přepínače nad sebou a panel byl o kus delší, aniž by uměl něco navíc.
 * Parcela a území žádné nastavení nemají, takže sekce je vidět jen u oblasti a dlaždic
 * (podmínku drží MapView). Co z výběru vznikne, má vlastní sekce níž.
 */
import { Check, Eye, EyeOff, Grid3x3, Hexagon, Loader2 } from 'lucide-react'
import { TILE_SIZES, type TileSize } from '../tiles'
import { toolTheme } from '../toolColors'
import type { ParcelsTool } from '../useParcels'
import type { TilesTool } from '../useTiles'

const note = 'max-w-[200px] px-1 text-[10px] leading-snug text-gray-500'

export function SelectionPanel({ parcels, tiles, areaMode, toggleAreaMode }: {
  parcels: ParcelsTool
  tiles: TilesTool
  areaMode: boolean
  toggleAreaMode: () => void
}) {
  const { areaLoading, areaPtCount, finalizeArea } = parcels
  const { tileSize, tileCount, finalizeAreaTiles, gridOn, setGridOn, gridNote, changeTileSize } = tiles

  if (areaMode) {
    return areaPtCount >= 3 ? (
      // Tentýž nakreslený obrys umí dvě věci; co z něj vznikne, se rozhoduje až tady.
      // Tlačítka mají barvu toho, kam výsledek půjde (parcely / dlaždice).
      <>
        <div className={note}>Obrys má {areaPtCount} bodů. Co z něj vybrat?</div>
        <button onClick={finalizeArea} disabled={areaLoading} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${toolTheme('parcel').solid}`}>
          {areaLoading ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Parcely uvnitř
        </button>
        <button onClick={finalizeAreaTiles} disabled={areaLoading} title={`Vybere dlaždice ${tileSize} m, jejichž střed padne dovnitř oblasti`} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${toolTheme('tiles').solid}`}>
          <Grid3x3 size={15} /> Dlaždice uvnitř ({tileSize} m)
        </button>
      </>
    ) : (
      <div className={note}>
        Klikej body obrysu ({areaPtCount}). Od tří bodů jde vybrat parcely nebo dlaždice uvnitř.
      </div>
    )
  }

  // jiná velikost = jiná mřížka, takže výběr zmizí — u rozdělané práce se zeptat (jako v nápovědě nad lištou)
  const pickSize = (s: TileSize) => {
    if (s === tileSize) return
    if (tileCount && !confirm(`Změna velikosti na ${s} m zruší výběr ${tileCount} dlaždic. Pokračovat?`)) return
    changeTileSize(s)
  }
  return (
    <>
      <div className={note}>
        Tažením maluješ přes víc dlaždic; tah, co začne na vybrané, naopak odebírá.
        <span className="text-gray-400"> Mapu tady posouváš pravým tlačítkem, zoom kolečkem.</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-11 shrink-0 text-[10px] text-gray-500">Dlaždice</span>
        {TILE_SIZES.map(s => (
          <button
            key={s}
            onClick={() => pickSize(s)}
            className={`rounded px-1.5 py-0.5 text-[11px] ${tileSize === s ? toolTheme('tiles').solid : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >{s} m</button>
        ))}
      </div>
      <button
        onClick={() => setGridOn(g => !g)}
        className={`flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition-colors ${gridOn ? toolTheme('tiles').solid : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
      >
        {gridOn ? <Eye size={13} /> : <EyeOff size={13} />} Mřížka s názvy
      </button>
      {gridOn && <div className={note}>{gridNote || `Názvy odpovídají „dlazdice_<X>_<Y>" v exportu.`}</div>}
      {/* Místo malování obtáhnout oblast — tentýž režim jako „Vybrat oblast", jen se pak zvolí
          „Dlaždice uvnitř". Kdo maluje dlaždice, hledá to tady. */}
      <button
        onClick={toggleAreaMode}
        title="Místo malování obtáhni oblast a vyber dlaždice uvnitř"
        className="flex items-center gap-2 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-700"
      >
        <Hexagon size={13} /> Vybrat oblastí
      </button>
    </>
  )
}
