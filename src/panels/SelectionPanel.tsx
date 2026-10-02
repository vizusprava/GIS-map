/**
 * Sekce „Výběr v mapě": nástroje, kterými se vybírá — parcela, oblast, dlaždice, území.
 *
 * Co z výběru vznikne (parcely, dlaždice, území a jejich exporty), má vlastní sekce níž.
 */
import { Check, Eye, EyeOff, Grid3x3, Hexagon, Landmark, Loader2, MapPin } from 'lucide-react'
import { TILE_SIZES } from '../tiles'
import { ToggleBtn } from '../ui'
import { toolTheme } from '../toolColors'
import type { ParcelsTool } from '../useParcels'
import type { TilesTool } from '../useTiles'
import type { RegionTool } from '../useRegionTool'

export function SelectionPanel({ parcels, tiles, region, parcelMode, areaMode, tileMode, toggleParcel, toggleAreaMode, toggleRegionMode }: {
  parcels: ParcelsTool
  tiles: TilesTool
  region: RegionTool
  parcelMode: boolean
  areaMode: boolean
  tileMode: boolean
  toggleParcel: () => void
  toggleAreaMode: () => void
  toggleRegionMode: () => void
}) {
  const { parcelLoading, areaLoading, areaPtCount, finalizeArea } = parcels
  const { tileSize, tileCount, toggleTileMode, finalizeAreaTiles, gridOn, setGridOn, gridNote, changeTileSize } = tiles
  return (
    <>
      <div className="px-1 text-[10px] leading-snug text-gray-600">
        <kbd className="rounded bg-gray-800 px-1 text-gray-400">Esc</kbd> vypne nástroj, podruhé zruší výběr.
      </div>
      <ToggleBtn active={parcelMode} tool="parcel" onClick={toggleParcel} icon={parcelLoading ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />} label={parcelMode ? 'Klikni na parcelu' : 'Vybrat parcelu'} />
      <ToggleBtn active={areaMode} tool="area" onClick={toggleAreaMode} icon={areaLoading ? <Loader2 size={15} className="animate-spin" /> : <Hexagon size={15} />} label={areaMode ? `Klikej body (${areaPtCount})` : 'Vybrat oblast'} />
      {areaMode && areaPtCount >= 3 && (
        // Tentýž nakreslený obrys umí dvě věci; co z něj vznikne, se rozhoduje až tady.
        // Tlačítka mají barvu toho, kam výsledek půjde (parcely / dlaždice).
        <div className="flex flex-col gap-1">
          <button onClick={finalizeArea} disabled={areaLoading} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${toolTheme('parcel').solid}`}>
            {areaLoading ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Parcely uvnitř
          </button>
          <button onClick={finalizeAreaTiles} disabled={areaLoading} title={`Vybere dlaždice ${tileSize} m, jejichž střed padne dovnitř oblasti`} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${toolTheme('tiles').solid}`}>
            <Grid3x3 size={15} /> Dlaždice uvnitř ({tileSize} m)
          </button>
        </div>
      )}
      <ToggleBtn active={tileMode} tool="tiles" onClick={toggleTileMode} icon={<Grid3x3 size={15} />} label={tileMode ? `Klikej / táhni (${tileCount})` : 'Vybrat dlaždice'} />
      <ToggleBtn active={region.regionMode} tool="region" onClick={toggleRegionMode} icon={region.regionBusy ? <Loader2 size={15} className="animate-spin" /> : <Landmark size={15} />} label={region.regionMode ? 'Klikni na mapu (kraj/obec)' : 'Vybrat území'} />
      {region.regionMode && (
        <div className="px-1 pb-0.5 max-w-[200px] text-[10px] leading-snug text-gray-500">
          Klikni na mapu. Podle názvu se hledá v liště nahoře uprostřed.
        </div>
      )}
      {tileMode && (
        <div className="flex flex-col gap-1 px-1 pb-0.5">
          <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
            Tažením maluješ přes víc dlaždic; tah, co začne na vybrané, naopak odebírá.
            <span className="text-gray-400"> Mapu tady posouváš pravým tlačítkem, zoom kolečkem.</span>
          </div>
          {/* Zkratka na kreslení oblasti — kdo maluje dlaždice, hledá to tady, ne o dva
              přepínače výš u parcel. Je to tentýž režim, jen se pak zvolí „Dlaždice uvnitř". */}
          <button
            onClick={toggleAreaMode}
            title="Místo malování obtáhni oblast a vyber dlaždice uvnitř"
            className="flex items-center gap-2 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-700"
          >
            <Hexagon size={13} /> Vybrat oblastí
          </button>
          <button
            onClick={() => setGridOn(g => !g)}
            className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs transition-colors ${gridOn ? toolTheme('tiles').solid : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            {gridOn ? <Eye size={13} /> : <EyeOff size={13} />} Mřížka s názvy
          </button>
          {gridOn && (
            <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
              {gridNote || `Názvy odpovídají „dlazdice_<X>_<Y>" v exportu.`}
            </div>
          )}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-500 w-11 shrink-0">Dlaždice</span>
            {TILE_SIZES.map(s => (
              <button
                key={s}
                onClick={() => changeTileSize(s)}
                className={`px-1.5 py-0.5 rounded text-[11px] ${tileSize === s ? toolTheme('tiles').solid : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >{s} m</button>
            ))}
          </div>
          {tileCount > 0 && (
            <div className="max-w-[190px] text-[10px] leading-snug text-gray-500">
              Kvalitu a export najdeš níž v sekci <span className="text-gray-300">Dlaždice</span>.
            </div>
          )}
        </div>
      )}
    </>
  )
}
