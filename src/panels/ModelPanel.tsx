/**
 * Sekce „Vybraný model": usazení (výška, natočení, měřítko), posazení na terén, maska a obrys.
 */
import { ArrowDownToLine, Crosshair, Mountain, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { NumRow } from '../ui'
import type { Placement, SceneObj } from '../types'
import type { ModelsTool } from '../useModels'

export function ModelPanel({ models, objects, placement }: { models: ModelsTool; objects: SceneObj[]; placement: Placement }) {
  const { selectedId, modelsRef, deleteModel, focusModel, dropToGround, toggleExcavation, toggleOutline, patch } = models
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-gray-100 truncate">{objects.find(o => o.id === selectedId)?.name ?? 'Model'}</div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button onClick={() => selectedId && deleteModel(selectedId)} title="Odebrat model" className="p-1 rounded-lg text-gray-400 hover:bg-gray-800 hover:text-red-300">
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* Posun je nástroj — kliká se s ním do mapy, takže sedí v liště dole (mapTools.tsx).
          Objeví se tam právě tehdy, když je model vybraný, tedy když má co posouvat. */}
      <div className="flex gap-1.5">
        <button onClick={focusModel} title="Zaměřit kameru na model" className="px-2 py-1.5 rounded-lg bg-gray-800 text-gray-200 hover:bg-gray-700">
          <Crosshair size={15} />
        </button>
      </div>

      <button onClick={dropToGround} className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-200 hover:bg-gray-700">
        <ArrowDownToLine size={14} /> Posadit na terén
      </button>

      {selectedId && modelsRef.current.get(selectedId)?.footprint && (
        <button
          onClick={() => selectedId && toggleExcavation(selectedId)}
          title="Skrýt mapu (ortofoto/topo + terén + Google 3D) přesně pod/nad modelem podle jeho obrysu"
          className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
            modelsRef.current.get(selectedId)?.excavate ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
          }`}
        >
          <Mountain size={14} /> {modelsRef.current.get(selectedId)?.excavate ? 'Mapa pod modelem skrytá' : 'Skrýt mapu pod modelem'}
        </button>
      )}

      {selectedId && (
        <button
          onClick={() => selectedId && toggleOutline(selectedId)}
          title="Zapnout/vypnout svítící obrys kolem modelu"
          className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
            modelsRef.current.get(selectedId)?.outline ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
          }`}
        >
          <Sparkles size={14} /> {modelsRef.current.get(selectedId)?.outline ? 'Obrys zapnutý' : 'Obrys vypnutý'}
        </button>
      )}

      <NumRow label="Výška nad terénem" value={placement.heightOffset} min={-20} max={200} step={0.1} unit="m" onChange={v => patch({ heightOffset: v })} />
      <NumRow label="Otočení" value={placement.heading} min={0} max={359} step={1} unit="°" onChange={v => patch({ heading: v })} />
      <NumRow label="Náklon (pitch)" value={placement.pitch} min={-45} max={45} step={0.5} unit="°" onChange={v => patch({ pitch: v })} />
      <NumRow label="Náklon (roll)" value={placement.roll} min={-45} max={45} step={0.5} unit="°" onChange={v => patch({ roll: v })} />
      <NumRow label="Měřítko" value={placement.scale} min={0.1} max={20} step={0.1} unit="×" onChange={v => patch({ scale: v })} />

      <button onClick={() => patch({ heading: 0, pitch: 0, roll: 0 })} className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-300 hover:bg-gray-700">
        <RotateCcw size={13} /> Reset natočení
      </button>

      <div className="text-[10px] text-gray-500 leading-snug">
        {placement.lat.toFixed(5)}, {placement.lon.toFixed(5)}
      </div>
    </>
  )
}
