/**
 * Hlavička levého panelu: návrat na přehled, název scény a sdílení, čí je cizí scéna a jestli
 * se v ní ukládá, a co se zrovna obnovuje z úložiště.
 */
import { ChevronLeft, Eye, Layers, Loader2, Users } from 'lucide-react'
import type { ScenePersist } from '../lib/scenePersist'

export function PanelHeader({ scene, guest, restoring, onLeave, onHide }: {
  scene: ScenePersist
  guest: boolean
  restoring: string | null
  onLeave: () => void
  onHide: () => void
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-gray-700 p-2">
      {/* Navigace; vypínač prezentace se přestěhoval do lišty dole (panel Prezentace). */}
      <div className="flex items-center gap-1">
        {guest ? (
          <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-gray-300"><Eye size={14} className="text-sky-400" /> Prohlížeč scény</span>
        ) : (
          <button onClick={onLeave} title="Zpět na přehled scén" className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-200 transition-colors hover:bg-gray-700">
            <ChevronLeft size={14} /> Scény
          </button>
        )}
        <div className="flex-1" />
        <button onClick={onHide} title="Skrýt panel" className="rounded p-0.5 text-gray-500 hover:text-gray-200"><ChevronLeft size={16} /></button>
      </div>
      {/* Název scény + co se zrovna obnovuje z úložiště. Bez toho se při víc scénách
          nepozná, ve které z nich vlastně jsi. */}
      <div className="flex min-w-0 items-center gap-1.5 px-1">
        <Layers size={12} className="shrink-0 text-emerald-500" />
        <span className="truncate text-xs font-medium text-gray-200" title={scene.sceneName}>{scene.sceneName}</span>
        {scene.share && (
          <button onClick={scene.share} title="Sdílet scénu s kolegy" data-share-open className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200">
            <Users size={12} /> Sdílet
          </button>
        )}
      </div>
      {/* Cizí scéna: čí je a jestli se změny ukládají — u „jen prohlížet" by jinak člověk
          pracoval a po zavření by nic nenašel. */}
      {scene.access !== 'owner' && (
        <div data-access={scene.access} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${scene.access === 'viewer' ? 'bg-amber-950/60 text-amber-200' : 'bg-sky-950/60 text-sky-200'}`}>
          {scene.access === 'viewer' ? <Eye size={12} className="shrink-0" /> : <Users size={12} className="shrink-0" />}
          <span className="truncate" title={scene.ownerName ? `Scénu sdílí ${scene.ownerName}` : undefined}>
            {guest ? 'Můžeš se rozhlížet a měřit, nic se neuloží' : scene.access === 'viewer' ? 'Jen prohlížíš — nic se neuloží' : 'Sdílená scéna — změny se ukládají'}
            {scene.ownerName ? ` · ${scene.ownerName}` : ''}
          </span>
        </div>
      )}
      {restoring && (
        <div className="flex items-center gap-1.5 px-1 text-[11px] text-gray-400">
          <Loader2 size={12} className="shrink-0 animate-spin" />
          <span className="truncate">{restoring}</span>
        </div>
      )}
    </div>
  )
}
