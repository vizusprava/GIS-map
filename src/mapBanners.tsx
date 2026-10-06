/**
 * Hlášky nad mapou pod vyhledávací lištou: co se obnovuje ze scény a že 3D realita potřebuje
 * klíč Cesium ion. Míří doprostřed VIDITELNÉ mapy (vedle panelu), jinak by na užší obrazovce
 * zajely pod panel.
 */
import { Loader2 } from 'lucide-react'
import { openIonKeyDialog } from './ionKeyDialog'

export function MapBanners({ restoring, needIon, guest, left }: {
  restoring: string | null
  /** podklad 3D realita bez klíče */
  needIon: boolean
  guest: boolean
  /** levý okraj viditelné mapy (šířka otevřeného panelu) */
  left: number
}) {
  if (!restoring && !needIon) return null
  return (
    <div className="pointer-events-none absolute right-0 top-16 z-30 flex flex-col items-center gap-2 px-3 transition-[left]" style={{ left }}>
      {restoring && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/90 px-3 py-1.5 text-xs text-gray-200">
          <Loader2 size={13} className="animate-spin" /> {restoring}
        </div>
      )}
      {needIon && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-amber-600/50 bg-amber-900/80 px-3 py-1.5 text-xs text-amber-200">
          3D realita potřebuje klíč Cesium ion
          {!guest && <button onClick={openIonKeyDialog} className="rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-500">Nastavit</button>}
        </div>
      )}
    </div>
  )
}
