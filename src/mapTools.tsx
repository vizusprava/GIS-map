/**
 * Lišta nástrojů dole nad mapou.
 *
 * Nástroje, u kterých se pak kliká DO MAPY, nemají co dělat v panelu — při práci se na ně kouká
 * a panel kvůli nim musí být otevřený. Měření se navíc dělí na dva druhy, což v panelu zabíralo
 * dvě tlačítka pořád, i když se neměří. Tady je to jedno tlačítko a druh se vybere až po kliknutí.
 *
 * Nápověda k rozdělanému měření visí NAD lištou, ne v panelu — patří k tomu, co se zrovna dělá,
 * a panel se tím nerozjíždí.
 *
 * Posun modelu se ukáže jen když je model vybraný; jinak by to bylo tlačítko, které nic nedělá.
 */
import { useEffect, useState } from 'react'
import { Check, Hexagon, Move, Ruler, X } from 'lucide-react'

type Props = {
  rulerMode: boolean
  rulerKind: 'line' | 'area'
  /** rozdělané měření — dokud je, dá se ukončit */
  rulerDrafting: boolean
  onRuler: (kind: 'line' | 'area') => void
  onFinishRuler: () => void
  moveMode: boolean
  onMove: () => void
  /** je vybraný model, který jde posouvat? */
  canMove: boolean
  /** přepínač projekce — byl tu dřív a zůstává vpravo za dělítkem */
  children: React.ReactNode
}

export function MapTools(p: Props) {
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  const kindLabel = p.rulerKind === 'area' ? 'Plocha' : 'Vzdálenost'

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-1.5">
      {p.rulerMode && (
        <div className="max-w-[min(90vw,420px)] rounded-lg border border-gray-700 bg-gray-900/90 px-3 py-1.5 text-center text-[11px] leading-snug text-gray-300 shadow-lg backdrop-blur">
          {p.rulerKind === 'area'
            ? 'Naklikej obvod plochy (aspoň tři body) — uvnitř se ukáže výměra, u stran délky. Uzavře se sama.'
            : 'Každý klik přidá bod, u úseku se ukáže jeho délka.'}
          {' '}<span className="text-gray-500">Bod jde přetáhnout. Ukončíš pravým klikem.</span>
          {p.rulerDrafting && (
            <button onClick={p.onFinishRuler} className="ml-2 inline-flex items-center gap-1 rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-500">
              <Check size={12} /> Ukončit
            </button>
          )}
        </div>
      )}

      <div className="relative flex items-center gap-1 rounded-xl border border-gray-700 bg-gray-900/85 p-1 shadow-lg backdrop-blur">
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => setMenu(m => !m)}
          title="Měření — po kliknutí vyber vzdálenost nebo plochu"
          className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors ${
            p.rulerMode ? 'bg-amber-600 text-white' : 'text-gray-300 hover:bg-gray-800'
          }`}
        >
          <Ruler size={15} />
          {p.rulerMode ? kindLabel : 'Měření'}
        </button>

        {menu && (
          <div
            onPointerDown={e => e.stopPropagation()}
            className="absolute bottom-full left-0 z-10 mb-1 flex w-44 flex-col rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl"
          >
            <Item
              icon={<Ruler size={13} />} label="Vzdálenost"
              active={p.rulerMode && p.rulerKind === 'line'}
              onClick={() => { setMenu(false); p.onRuler('line') }}
            />
            <Item
              icon={<Hexagon size={13} />} label="Plocha"
              active={p.rulerMode && p.rulerKind === 'area'}
              onClick={() => { setMenu(false); p.onRuler('area') }}
            />
            {p.rulerMode && (
              <Item icon={<X size={13} />} label="Přestat měřit" onClick={() => { setMenu(false); p.onRuler(p.rulerKind) }} />
            )}
          </div>
        )}

        {p.canMove && (
          <button
            onClick={p.onMove}
            title="Posunout vybraný model tažením po mapě"
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors ${
              p.moveMode ? 'bg-sky-600 text-white' : 'text-gray-300 hover:bg-gray-800'
            }`}
          >
            <Move size={15} /> Posun
          </button>
        )}

        <div className="mx-0.5 h-5 w-px shrink-0 bg-gray-700" />
        {p.children}
      </div>
    </div>
  )
}

function Item({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-gray-800 ${active ? 'text-amber-300' : 'text-gray-200'}`}
    >
      <span className="shrink-0">{icon}</span>{label}
    </button>
  )
}
