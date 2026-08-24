/**
 * Seznam uložených pohledů — scénář scény.
 *
 * Dřív to byl řádek s názvem a dvěma ikonkami, zastrčený až pod všemi slidery zorného úhlu
 * a rozostření. Přitom je to ta část, která se používá nejčastěji (klik = přelet), zatímco
 * slidery se nastaví jednou. Teď je seznam nahoře a vzhled kamery zabalený pod ním.
 *
 * Čtyři věci, které tady dřív nebyly a chyběly:
 *  - přejmenování (šlo jen smazat a uložit znovu — a tím přijít o navázané popisky a pulzy),
 *  - pořadí tažením, protože pohledy jsou scénář a na jejich sledu záleží,
 *  - značka „upraveno", když se aktivní pohled rozešel s tím, co je zrovna vidět,
 *  - náhled, protože samotný název je slabá nápověda, co na tom záběru vlastně je.
 *
 * Komponenta je zobrazovací — kamera, ukládání i zachycení náhledu zůstávají v MapView.
 */
import { useEffect, useRef, useState } from 'react'
import { Camera, ChevronLeft, ChevronRight, Copy, GripVertical, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import type { CamView } from './types'

type Props = {
  views: CamView[]
  activeId: string | null
  /** aktivní pohled se rozešel s tím, co je právě vidět (kamera nebo vzhled) */
  dirty: boolean
  renamingId: string | null
  onRenameStart: (id: string | null) => void
  onRename: (id: string, name: string) => void
  onGoto: (cv: CamView) => void
  onOverwrite: (i: number) => void
  onDuplicate: (i: number) => void
  onDelete: (i: number) => void
  onMove: (from: number, to: number) => void
  onSave: () => void
  onStep: (dir: 1 | -1) => void
}

export function CamViews(p: Props) {
  const [menuId, setMenuId] = useState<string | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  // Nabídka ⋯ se musí zavřít i kliknutím jinam, ne jen opětovným kliknutím na tečky.
  useEffect(() => {
    if (!menuId) return
    const close = () => setMenuId(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuId])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <button
          onClick={p.onSave}
          title="Uloží aktuální kameru, vzhled i náhled. Pojmenovat můžeš hned potom."
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-2 py-1.5 text-xs text-white hover:bg-emerald-500"
        >
          <Plus size={14} /> Uložit aktuální pohled
        </button>
        {p.views.length > 1 && (
          <>
            <button onClick={() => p.onStep(-1)} title="Předchozí pohled (šipka vlevo)" className="shrink-0 rounded-lg bg-gray-800 p-1.5 text-gray-300 hover:bg-gray-700">
              <ChevronLeft size={14} />
            </button>
            <button onClick={() => p.onStep(1)} title="Další pohled (šipka vpravo)" className="shrink-0 rounded-lg bg-gray-800 p-1.5 text-gray-300 hover:bg-gray-700">
              <ChevronRight size={14} />
            </button>
          </>
        )}
      </div>

      {p.views.map((cv, i) => {
        const active = cv.id === p.activeId
        return (
          <div
            key={cv.id}
            draggable={p.renamingId !== cv.id}
            onDragStart={() => setDragFrom(i)}
            onDragOver={e => { e.preventDefault(); setDragOver(i) }}
            onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
            onDrop={e => {
              e.preventDefault()
              if (dragFrom !== null) p.onMove(dragFrom, i)
              setDragFrom(null); setDragOver(null)
            }}
            className={`relative flex items-center gap-1.5 rounded-lg p-1 transition-colors ${
              active ? 'bg-sky-900/40 ring-1 ring-sky-700' : 'bg-gray-800/50 hover:bg-gray-800'
            } ${dragOver === i && dragFrom !== null && dragFrom !== i ? 'ring-1 ring-emerald-500' : ''}`}
          >
            <GripVertical size={13} className="shrink-0 cursor-grab text-gray-600" />

            {/* Náhled je zároveň tlačítko přeletu — je to největší klikací plocha v řádku. */}
            <button
              onClick={() => p.onGoto(cv)}
              title={cv.look ? 'Přeletět a nastavit uložený vzhled' : 'Přeletět. Tenhle pohled je z dřívějška a vzhled uložený nemá — přepiš ho v nabídce ⋯.'}
              className="shrink-0 overflow-hidden rounded border border-gray-700 bg-gray-900"
              style={{ width: 56, height: 32 }}
            >
              {cv.thumb
                ? <img src={cv.thumb} alt="" className="h-full w-full object-cover" />
                : <span className="flex h-full w-full items-center justify-center text-[9px] text-gray-600">{i + 1}</span>}
            </button>

            <div className="flex min-w-0 flex-1 flex-col">
              {p.renamingId === cv.id ? (
                <NameInput initial={cv.name} onDone={n => p.onRename(cv.id, n)} onCancel={() => p.onRenameStart(null)} />
              ) : (
                <button
                  onClick={() => p.onGoto(cv)}
                  onDoubleClick={() => p.onRenameStart(cv.id)}
                  title="Klik přeletí, dvojklik přejmenuje"
                  className="min-w-0 truncate text-left text-xs text-gray-100"
                >
                  <span className="mr-1 text-gray-600">{i + 1}.</span>{cv.name}
                </button>
              )}
              {active && p.dirty && (
                <button
                  onClick={() => p.onOverwrite(i)}
                  title="Kamera nebo vzhled se liší od uloženého stavu — kliknutím pohled přepíšeš"
                  className="mt-0.5 self-start rounded bg-amber-900/60 px-1.5 text-[10px] text-amber-300 hover:bg-amber-800/60"
                >
                  upraveno — přepsat
                </button>
              )}
            </div>

            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => setMenuId(m => (m === cv.id ? null : cv.id))}
              title="Další akce"
              className="shrink-0 rounded p-0.5 text-gray-500 hover:text-gray-200"
            >
              <MoreVertical size={14} />
            </button>

            {menuId === cv.id && (
              <div
                onPointerDown={e => e.stopPropagation()}
                className="absolute right-1 top-full z-10 mt-0.5 flex w-44 flex-col rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl"
              >
                <MenuItem icon={<Camera size={13} />} label="Přepsat tímto záběrem" onClick={() => { setMenuId(null); p.onOverwrite(i) }} />
                <MenuItem icon={<Pencil size={13} />} label="Přejmenovat" onClick={() => { setMenuId(null); p.onRenameStart(cv.id) }} />
                <MenuItem icon={<Copy size={13} />} label="Duplikovat" onClick={() => { setMenuId(null); p.onDuplicate(i) }} />
                <MenuItem icon={<Trash2 size={13} />} label="Smazat" danger onClick={() => { setMenuId(null); p.onDelete(i) }} />
              </div>
            )}
          </div>
        )
      })}

      {!p.views.length && (
        <div className="text-[10px] leading-snug text-gray-600">
          Zatím žádné — natoč si kameru a dej „Uložit aktuální pohled". Uloží se i zorný úhel,
          rozostření, chvění a kroužení. Pojmenovat můžeš hned potom, přejmenovat kdykoliv.
        </div>
      )}
    </div>
  )
}

/** Přejmenování na místě: Enter potvrdí, Esc zahodí, kliknutí jinam taky potvrdí. */
function NameInput({ initial, onDone, onCancel }: { initial: string; onDone: (n: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.select() }, [])
  return (
    <input
      ref={ref}
      autoFocus
      value={v}
      onChange={e => setV(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') onDone(v)
        if (e.key === 'Escape') onCancel()
        e.stopPropagation() // šipky patří kurzoru v textu, ne procházení pohledů
      }}
      onBlur={() => onDone(v)}
      className="min-w-0 rounded bg-gray-900 px-1.5 py-0.5 text-xs text-gray-100 outline-none ring-1 ring-sky-700"
    />
  )
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-gray-800 ${danger ? 'text-red-300' : 'text-gray-200'}`}
    >
      <span className="shrink-0">{icon}</span>{label}
    </button>
  )
}
