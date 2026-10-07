/**
 * Nabídka průvodce po prvním přihlášení nového uživatele (přehled scén). Zeptá se jednou;
 * průvodce pak začne po otevření scény. Odmítnutý jde zapnout v nastavení účtu nebo
 * v přehledu zkratek v mapě.
 */
import { Compass, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTourStore } from './tourStore'

export function TourWelcome() {
  const offer = useTourStore(s => s.offer)
  const { start, set } = useTourStore()
  if (!offer) return null
  const later = () => {
    set({ asked: true, on: false })
    toast.info('Průvodce najdeš kdykoliv v nastavení účtu nebo v mapě v přehledu zkratek (klávesa pod Esc).', { duration: 5000 })
  }
  return (
    <div className="fixed bottom-6 right-6 z-40 w-[min(360px,calc(100vw-48px))] rounded-xl border border-sky-500/50 bg-gray-900/97 p-4 text-gray-200 shadow-2xl" data-tour-welcome>
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-sky-500/40 bg-sky-600/20">
          <Compass size={18} className="text-sky-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-100">Vítej! Mám tě provést?</div>
          <div className="mt-1 text-xs leading-relaxed text-gray-300">
            Průvodce ti v mapě ukáže, jak se ovládá, kde co najdeš, a nechá tě to rovnou zkusit. Zabere pár minut
            a kdykoliv ho přerušíš.
          </div>
        </div>
        <button onClick={later} title="Teď ne" className="rounded p-0.5 text-gray-500 hover:bg-gray-800 hover:text-gray-200"><X size={14} /></button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={later} className="rounded-lg px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200">Teď ne</button>
        <button
          onClick={() => { start('beginning'); toast.success('Průvodce je zapnutý — otevři nebo založ scénu a začneme.') }}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs text-white hover:bg-sky-500"
        >Ano, provést</button>
      </div>
    </div>
  )
}
