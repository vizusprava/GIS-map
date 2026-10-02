/**
 * Nabídka „Prezentace" v liště dole: hlavní vypínač prezentace a popisky na uložených pohledech.
 *
 * Vypínač býval v hlavičce levého panelu a popisky v jeho sekci; teď je obojí tam, kde je
 * i kamera s pohledy — prezentace se ladí s mapou před očima, ne v bočním panelu.
 */
import { Eye, EyeOff, MessageSquarePlus, Trash2 } from 'lucide-react'
import { DOT_DEFAULT, FRAME_DEFAULT, SIZE_DEFAULT } from '../callouts'
import type { CamView } from '../types'
import type { PresentationTool } from '../usePresentation'

export function PresentationMenu({ pres, activeView, activeViewId, presentOn, togglePresent, calloutMode, toggleCallout }: {
  pres: PresentationTool
  activeView: CamView | null
  activeViewId: string | null
  presentOn: boolean
  togglePresent: () => void
  calloutMode: boolean
  toggleCallout: () => void
}) {
  const { callouts, calloutSel, setCalloutSel, updateCallout, delCallout, toggleCalloutHere } = pres
  return (
    <div className="flex flex-col gap-2 p-2">
      <button
        onClick={togglePresent}
        title={presentOn ? 'Skrýt popisky a efekty pohledů' : 'Ukázat popisky a efekty pohledů'}
        className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors ${presentOn ? 'bg-sky-600 text-white hover:bg-sky-500' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
      >
        {presentOn ? <Eye size={14} /> : <EyeOff size={14} />} Prezentace {presentOn ? 'zapnutá' : 'vypnutá'}
      </button>
      <div className="px-0.5 text-[10px] leading-snug text-gray-500">
        Zapnutá ukáže popisky a efekty uložených pohledů — rozostření, chvění a kroužení. Při běžné práci s mapou překážejí, tak ji vypni.
      </div>

      <div className="flex items-center gap-1.5 border-t border-gray-700 pt-2 text-[10px] text-gray-500">
        <span className="shrink-0 uppercase tracking-wide">Popisky</span>
        <span className="min-w-0 flex-1 truncate text-right">pohled: <span className="text-gray-300">{activeView ? activeView.name : 'žádný'}</span></span>
      </div>
      {!activeViewId && callouts.length > 0 && (
        <div className="text-[10px] leading-snug text-amber-500/80">Není vybraný pohled, takže jsou popisky zasunuté. Vyber ho v nabídce Kamera.</div>
      )}
      <button
        onClick={toggleCallout}
        className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs ${calloutMode ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
      >
        <MessageSquarePlus size={13} /> {calloutMode ? 'Klikni do mapy…' : 'Přidat popisek'}
      </button>
      {callouts.map(c => (
        <div key={c.id} className={`flex flex-col gap-1 rounded p-1.5 ${calloutSel === c.id ? 'bg-sky-900/40 ring-1 ring-sky-700' : 'bg-gray-800/50'}`}>
          <div className="flex items-center gap-1">
            <input
              value={c.text}
              onChange={e => updateCallout(c.id, { text: e.target.value })}
              onFocus={() => setCalloutSel(c.id)}
              className="min-w-0 flex-1 rounded bg-gray-900 px-1.5 py-0.5 text-xs text-gray-100 outline-none"
            />
            <button onClick={() => delCallout(c.id)} title="Smazat popisek" className="rounded p-0.5 text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <input type="color" value={c.dot ?? DOT_DEFAULT} onChange={e => updateCallout(c.id, { dot: e.target.value })} title="Barva tečky" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
            <input type="color" value={c.frame ?? FRAME_DEFAULT} onChange={e => updateCallout(c.id, { frame: e.target.value })} title="Barva rámečku a odpichové čáry" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
            <input type="range" min={9} max={26} step={1} value={c.size ?? SIZE_DEFAULT} onChange={e => updateCallout(c.id, { size: Number(e.target.value) })} title="Velikost textu" className="min-w-0 flex-1 accent-sky-500" />
            <span className="w-9 shrink-0 text-right tabular-nums text-gray-500">{c.size ?? SIZE_DEFAULT} px</span>
          </div>
          <label className={`flex items-center gap-1.5 text-[11px] ${activeViewId ? 'cursor-pointer text-gray-300' : 'text-gray-600'}`} title={activeViewId ? 'Ve kterých pohledech se popisek ukáže' : 'Nejdřív vyber uložený pohled'}>
            <input type="checkbox" disabled={!activeViewId} checked={!!activeViewId && c.views.includes(activeViewId)} onChange={e => toggleCalloutHere(c.id, e.target.checked)} className="accent-sky-500" />
            <span>Ukázat v tomto pohledu</span>
            <span className="ml-auto tabular-nums text-gray-500">{c.views.length}×</span>
          </label>
        </div>
      ))}
      {!callouts.length && (
        <div className="text-[10px] leading-snug text-gray-600">Zatím žádné — vyber pohled, dej „Přidat popisek" a klikni do mapy. Bublinu pak přetáhneš myší.</div>
      )}
    </div>
  )
}
