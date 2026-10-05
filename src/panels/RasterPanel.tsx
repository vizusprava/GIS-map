/**
 * Sekce „Vlastní ortofoto": načtené snímky s world filem — krytí, soustava, zaměření.
 */
import { Crosshair, Eye, EyeOff, Trash2 } from 'lucide-react'
import { CRS_IDS, CRS_LABELS, type CrsId } from '../worldRaster'
import type { RastersTool } from '../useRasters'
import type { FileStorage } from '../lib/types'
import { FileAt } from './ScenePanel'

export function RasterPanel({ rasters, readOnly, fileAt, onMoveFile }: {
  rasters: RastersTool
  readOnly?: boolean
  /** kde leží soubor snímku podle id řádku (cloud / jen tento počítač) */
  fileAt?: (assetId?: string) => FileStorage | null
  /** přesun souboru jinam; chybí = přesouvat nejde */
  onMoveFile?: (assetId: string, to: FileStorage) => void
}) {
  const { rasterList, toggleRaster, locateRaster, removeRaster, setRasterAlpha, setRasterCrs, fmtGsd } = rasters
  return (
    <>
      {rasterList.map(r => (
        <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-gray-700/70 bg-gray-800/40 p-1.5">
          <div className="group flex items-center gap-1">
            <button onClick={() => toggleRaster(r.id)} title={r.visible ? 'Skrýt' : 'Zobrazit'} className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-gray-100">
              {r.visible ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <span className="min-w-0 flex-1 truncate text-xs text-gray-200" title={r.name}>{r.name}</span>
            <FileAt
              at={fileAt?.(r.assetId) ?? null}
              onMove={onMoveFile && r.assetId && !readOnly ? to => onMoveFile(r.assetId as string, to) : undefined}
            />
            <button onClick={() => locateRaster(r.id)} title="Zaměřit" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-cyan-300">
              <Crosshair size={13} />
            </button>
            {!readOnly && (
            <button onClick={() => removeRaster(r.id)} title="Odebrat" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-red-300">
              <Trash2 size={13} />
            </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-11 shrink-0 text-[10px] text-gray-400">Krytí</span>
            <input
              type="range" min={0} max={1} step={0.05} value={r.alpha}
              onChange={e => setRasterAlpha(r.id, parseFloat(e.target.value))}
              title="0 % = jen mapa pod tím, 100 % = snímek ten kus mapy nahradí"
              className="min-w-0 flex-1 accent-emerald-500"
            />
            <span className="w-8 text-[10px] tabular-nums text-gray-300">{Math.round(r.alpha * 100)}%</span>
          </div>
          {!readOnly && <div className="flex items-center gap-1.5">
            <span className="w-11 shrink-0 text-[10px] text-gray-400">Systém</span>
            <select
              value={r.crsId}
              onChange={e => setRasterCrs(r.id, e.target.value as CrsId)}
              title="Soustava world filu. Odhaduje se z .prj a z řádu souřadnic — přepni, když snímek skončil jinde, než má být."
              className="min-w-0 flex-1 rounded bg-gray-800 px-1 py-0.5 text-[11px] text-gray-200 outline-none"
            >
              {CRS_IDS.map(c => <option key={c} value={c}>{CRS_LABELS[c]}</option>)}
            </select>
          </div>}
          <div className="px-0.5 text-[10px] tabular-nums text-gray-600">{r.px} · {fmtGsd(r.gsd)}</div>
        </div>
      ))}
    </>
  )
}
