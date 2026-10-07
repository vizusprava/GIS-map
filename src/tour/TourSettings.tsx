/**
 * Průvodce v nastavení účtu: zapnout / vypnout a projít znovu od začátku. Pro ty, kdo nabídku
 * po prvním přihlášení odmítli, i pro staré účty, kterým se sám nenabídne.
 */
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useTourStore } from './tourStore'
import { CHAPTERS } from './steps'

export function TourSettings() {
  const { prefs, start, stop } = useTourStore()
  const done = CHAPTERS.filter(c => prefs.done.includes(c.id)).length
  return (
    <>
      <div className="text-xs leading-relaxed text-gray-400">
        Provede tě mapou a nástroji přímo ve scéně — ukáže, kde co najdeš, a nechá tě to rovnou zkusit.
        Zapnutý se ukáže po otevření scény. Prošlé kapitoly: {done} z {CHAPTERS.length}.
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          role="switch"
          aria-checked={prefs.on}
          data-tour-switch
          onClick={() => (prefs.on ? stop() : start('resume'))}
          className="flex items-center gap-2 text-sm text-gray-200"
        >
          <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${prefs.on ? 'bg-sky-600' : 'bg-gray-700'}`}>
            <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${prefs.on ? 'left-[18px]' : 'left-0.5'}`} />
          </span>
          {prefs.on ? 'Zapnutý' : 'Vypnutý'}
        </button>
        <button
          onClick={() => { start('beginning'); toast.success('Průvodce začne od začátku po otevření scény.') }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700"
        >
          <RotateCcw size={14} /> Projít znovu od začátku
        </button>
      </div>
    </>
  )
}
