/**
 * Patička panelu: co leží na disku prohlížeče (napečená lokální mapa a cache dlaždic).
 */
import { cacheClear } from '../cache'
import type { LocalCache } from '../useLocalCache'

export function StorageFooter({ cache }: { cache: LocalCache }) {
  const { bakedInfo, clearBaked, cacheInfo, refreshCache } = cache
  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t border-gray-700 px-2 py-1.5">
      {/* Obojí je „co leží na disku prohlížeče" — dřív byly napečené dlaždice sekcí nahoře
          a cache dole, takže spolu zdánlivě nesouvisely. */}
      {bakedInfo > 0 && (
        <div className="flex items-center justify-between gap-2 px-1 text-[10px] text-gray-500">
          <span title="Ortofoto napečené do localu — mapa jede offline a jde zoomovat hloub.">
            {/* ~27 kB na dlaždici cache ORTOFOTO_WM (změřeno na Liberci) */}
            Lokální mapa: <span className="text-gray-300">{bakedInfo}</span> dl. · ~{Math.round(bakedInfo * 0.027)} MB
          </span>
          <button
            onClick={clearBaked}
            title="Smazat celou lokální mapu (napečené dlaždice) — zpět na živé ČÚZK"
            className="shrink-0 text-gray-500 hover:text-red-300"
          >smazat</button>
        </div>
      )}
      {cacheInfo.count > 0 && (
        <div className="flex items-center justify-between gap-2 px-1 text-[10px] text-gray-500">
          <span title="Data terénu a mapy uložená na disku prohlížeče (přežijí refresh, zrychlují návraty). LRU maže nejstarší přes strop.">
            Cache: {(cacheInfo.bytes / 1e6).toFixed(0)} MB · {cacheInfo.count} pol.
          </span>
          <button
            onClick={() => cacheClear().then(refreshCache)}
            title="Smazat data z disku prohlížeče (cache terénu a mapy)"
            className="shrink-0 text-gray-500 hover:text-red-300"
          >vymazat</button>
        </div>
      )}
    </div>
  )
}
