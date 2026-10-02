/**
 * Sekce „Prezentace": popisky a pulz parcel. Obojí visí na uloženém pohledu a řídí to
 * vypínač „Prezentace" nahoře v panelu.
 */
import { Play, Trash2 } from 'lucide-react'
import { DOT_DEFAULT, FRAME_DEFAULT, SIZE_DEFAULT } from '../callouts'
import { Section } from '../ui'
import type { CamView } from '../types'
import type { PresentationTool } from '../usePresentation'

export function PresentationPanel({ pres, activeView, activeViewId, presentOn, calloutMode, toggleCallout, parcelCount, openSec, toggleSec }: {
  pres: PresentationTool
  activeView: CamView | null
  activeViewId: string | null
  presentOn: boolean
  calloutMode: boolean
  toggleCallout: () => void
  /** kolik je vybraných parcel — z nich vzniká nová sada pulzu */
  parcelCount: number
  openSec: Record<string, boolean>
  toggleSec: (id: string, next: boolean) => void
}) {
  const {
    callouts, calloutSel, setCalloutSel, updateCallout, delCallout, toggleCalloutHere,
    pulses, pulseColor, setPulseColor, pulseCount, setPulseCount, addPulseFromSelection,
    updatePulse, playPulse, delPulse, togglePulseHere,
  } = pres
  return (
    <>
      <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
        <span className="shrink-0">Pohled:</span>
        <span className="min-w-0 flex-1 truncate text-gray-300">{activeView ? activeView.name : 'žádný'}</span>
        {!presentOn && <span className="shrink-0 text-amber-500/80">vypnutá</span>}
      </div>
      {!activeViewId && !!(callouts.length || pulses.length) && (
        <div className="text-[10px] leading-snug text-amber-500/80">Není vybraný pohled, takže je vše zasunuté. Klikni na některý v sekci „Pohledy".</div>
      )}
      <Section id="popisky" title="Popisky" dflt={false} badge={callouts.length} open={openSec} onToggle={toggleSec}>
        <button
          onClick={toggleCallout}
          className={`px-2 py-1 rounded-lg text-xs ${calloutMode ? 'bg-sky-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
        >{calloutMode ? 'Klikni do mapy…' : 'Přidat popisek'}</button>
        {callouts.map(c => (
          <div key={c.id} className={`flex flex-col gap-1 rounded p-1.5 ${calloutSel === c.id ? 'bg-sky-900/40 ring-1 ring-sky-700' : 'bg-gray-800/50'}`}>
            <div className="flex items-center gap-1">
              <input
                value={c.text}
                onChange={e => updateCallout(c.id, { text: e.target.value })}
                onFocus={() => setCalloutSel(c.id)}
                className="flex-1 min-w-0 bg-gray-900 rounded px-1.5 py-0.5 text-xs text-gray-100 outline-none"
              />
              <button onClick={() => delCallout(c.id)} title="Smazat popisek" className="p-0.5 rounded text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
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
        {!callouts.length && <div className="text-[10px] text-gray-600 leading-snug">Zatím žádné — vyber pohled, dej „Přidat popisek" a klikni do mapy. Bublinu pak přetáhneš myší.</div>}
      </Section>
      <Section id="pulz" title="Pulz parcel" dflt={false} badge={pulses.length} open={openSec} onToggle={toggleSec}>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <input type="color" value={pulseColor} onChange={e => setPulseColor(e.target.value)} title="Barva pulzu" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
          <span className="shrink-0">pulzů</span>
          <input type="range" min={1} max={12} step={1} value={pulseCount} onChange={e => setPulseCount(Number(e.target.value))} title="Kolikrát to blikne, pak přestane" className="min-w-0 flex-1 accent-sky-500" />
          <span className="w-4 shrink-0 text-right tabular-nums text-gray-500">{pulseCount}</span>
        </div>
        <button
          onClick={addPulseFromSelection}
          disabled={!parcelCount}
          title="Zapamatuje si tvar právě vybraných parcel jako novou sadu"
          className="rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-gray-800"
        >Přidat z vybraných parcel ({parcelCount})</button>
        {pulses.map(p => (
          <div key={p.id} className="flex flex-col gap-1 rounded bg-gray-800/50 p-1.5">
            <div className="flex items-center gap-1.5">
              <input type="color" value={p.color} onChange={e => updatePulse(p.id, { color: e.target.value })} title="Barva této sady" className="h-4 w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
              <span className="min-w-0 flex-1 truncate text-xs text-gray-200">{p.name}</span>
              <button onClick={() => playPulse(p.id)} title="Přehrát teď" className="rounded p-0.5 text-gray-400 hover:text-sky-300"><Play size={13} /></button>
              <button onClick={() => delPulse(p.id)} title="Smazat sadu" className="rounded p-0.5 text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
              <span className="shrink-0">pulzů</span>
              <input type="range" min={1} max={12} step={1} value={p.count} onChange={e => updatePulse(p.id, { count: Number(e.target.value) })} className="min-w-0 flex-1 accent-sky-500" />
              <span className="w-4 shrink-0 text-right tabular-nums text-gray-500">{p.count}</span>
            </div>
            <label className={`flex items-center gap-1.5 text-[11px] ${activeViewId ? 'cursor-pointer text-gray-300' : 'text-gray-600'}`} title={activeViewId ? 'Ve kterých pohledech se pulz spustí' : 'Nejdřív vyber uložený pohled'}>
              <input type="checkbox" disabled={!activeViewId} checked={!!activeViewId && p.views.includes(activeViewId)} onChange={e => togglePulseHere(p.id, e.target.checked)} className="accent-sky-500" />
              <span>Spustit v tomto pohledu</span>
              <span className="ml-auto tabular-nums text-gray-500">{p.views.length}×</span>
            </label>
          </div>
        ))}
        {!pulses.length && <div className="text-[10px] text-gray-600 leading-snug">Zatím žádné — vyber parcely v mapě, nastav barvu a počet a dej „Přidat". Tvar se uloží, takže přežije refresh i zrušení výběru.</div>}
      </Section>
    </>
  )
}
