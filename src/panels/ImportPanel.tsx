/**
 * Sekce Import: kam se soubory scény ukládají (cloud / tento počítač — platí pro celou scénu
 * a jde přepnout kdykoliv, viz useFileStorage.ts) a tlačítka importu modelu, výkresu a vlastního
 * ortofota. Samotné výběry souborů jsou skryté inputy v MapView.
 */
import { Cloud, HardDrive, Loader2, Upload } from 'lucide-react'
import type { FileStorage } from '../lib/types'
import type { FileStorageTool } from '../useFileStorage'

export function ImportPanel({ storage, canEditFiles, onModel, onDrawing, drawingLoading, onRaster, rasterBusy }: {
  storage: FileStorageTool
  /** „jen prohlížet" nemá kam ukládat — přepínač se neukáže */
  canEditFiles: boolean
  onModel: () => void
  onDrawing: () => void
  drawingLoading: boolean
  onRaster: () => void
  rasterBusy: boolean
}) {
  const { fileStorage, files, movingFiles, changeStorage } = storage
  const all = Object.values(files)
  const local = all.filter(f => f.at === 'local').length
  const opt = (to: FileStorage, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => void changeStorage(to)}
      disabled={movingFiles}
      aria-pressed={fileStorage === to}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-60 pointer-coarse:py-2 ${fileStorage === to ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
    >{icon}{label}</button>
  )
  return (
    <>
      {canEditFiles && (
        <div data-file-storage={fileStorage} className="flex flex-col gap-1.5 rounded-lg border border-gray-800 p-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Ukládat soubory</div>
          <div className="flex gap-1 rounded-lg bg-gray-800/70 p-0.5">
            {opt('cloud', <Cloud size={13} />, 'Cloud')}
            {opt('local', <HardDrive size={13} />, 'Tento počítač')}
          </div>
          <div className="text-[10px] leading-snug text-gray-500">
            {fileStorage === 'cloud'
              ? 'Nahrají se na účet — otevřeš je odkudkoliv a uvidí je i kolegové.'
              : 'Zůstanou jen v tomhle počítači a prohlížeči. Jinde se scéna zeptá, kde soubory jsou; kolegové ani odkaz je neuvidí.'}
            {all.length > 0 && local > 0 && local < all.length && <> Teď: v cloudu {all.length - local}, jen tady {local}.</>}
          </div>
          {movingFiles && <div className="flex items-center gap-1.5 text-[10px] text-gray-400"><Loader2 size={11} className="animate-spin" /> Přesouvám soubory…</div>}
        </div>
      )}
      <button onClick={onModel} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-colors">
        <Upload size={15} /> Import modelu
      </button>
      <button onClick={onDrawing} disabled={drawingLoading} title="Nahrát výkres DXF/DWG a zobrazit ho na mapě (v S-JTSK se umístí na správné místo; DWG se převede přes WASM)" className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">
        {drawingLoading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Nahrát výkres (DXF/DWG)
      </button>
      {/* Vlastní ortofoto bývalo samostatnou sekcí — je to ale taky „přines soubor zvenčí",
          jen jiného druhu. Načtené snímky se vypisují níž ve vlastní sekci, jako parcely
          nebo dlaždice: objeví se, až nějaké jsou. */}
      <button
        onClick={onRaster}
        disabled={rasterBusy}
        title="Vyber najednou obrázek i world file (u GeoTIFFu stačí .tif sám). Snímek se natáhne na terén nad ČÚZK podklad."
        className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-800 disabled:opacity-50"
      >
        {rasterBusy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Vlastní ortofoto (snímek + .jgw)
      </button>
    </>
  )
}
