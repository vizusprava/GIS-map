/**
 * Sekce „Měření": výsledky měření. Spouští se tlačítkem v liště dole nad mapou (mapTools.tsx) —
 * je to nástroj, u kterého se pak kliká do mapy, takže patří k mapě.
 */
import { Trash2 } from 'lucide-react'
import { fmtLen, rulerTotals, rulerArea } from '../ruler'
import { fmtArea } from '../measure'
import type { RulersTool } from '../useRulers'
import { toolTheme } from '../toolColors'

export function RulersPanel({ rulers: tool, rulerMode }: { rulers: RulersTool; rulerMode: boolean }) {
  const { rulers, rulerSel, setRulerSel, rulerDraftId, delRuler, clearRulers } = tool
  return (
    <>
      {rulers.map(r => {
        // u plochy je hlavní číslo výměra, u čáry celková délka
        const a = r.kind === 'area' ? rulerArea(r.pts) : null
        const val = r.kind === 'area'
          ? (a ? fmtArea(a.area) : '—')
          : (r.pts.length > 1 ? fmtLen(rulerTotals(r.pts).len) : '—')
        return (
          <div
            key={r.id}
            onMouseEnter={() => setRulerSel(r.id)}
            onMouseLeave={() => setRulerSel(s => (s === r.id ? null : s))}
            className={`flex items-center gap-1 rounded px-1 py-0.5 ${rulerSel === r.id ? 'bg-gray-700/50' : ''}`}
          >
            <span className="min-w-0 flex-1 truncate text-xs text-gray-200">
              {r.name}
              {r.id === rulerDraftId && <span className={`ml-1 text-[9px] opacity-80 ${toolTheme('ruler').text}`}>kreslí se</span>}
            </span>
            <span className={`shrink-0 text-[11px] tabular-nums ${toolTheme('ruler').text}`}>{val}</span>
            <button onClick={() => delRuler(r.id)} title={r.kind === 'area' ? 'Smazat tuto plochu' : 'Smazat toto měření'} className="shrink-0 rounded p-0.5 text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
          </div>
        )
      })}
      {rulers.length > 1 && (
        <button onClick={clearRulers} className="self-start px-1 text-[10px] text-gray-500 hover:text-red-300">smazat všechna měření</button>
      )}
      {!rulers.length && rulerMode && (
        <div className="max-w-[200px] px-1 text-[10px] leading-snug text-gray-500">
          Klikej body do mapy — měření se tu objeví i s délkou nebo výměrou. Ukončíš pravým klikem.
        </div>
      )}
      {!rulers.length && !rulerMode && (
        <div className="max-w-[200px] px-1 text-[10px] leading-snug text-gray-600">
          Zatím žádné — začni tlačítkem <span className="text-gray-400">Měření</span> v liště dole.
          Měří se v prostoru: bod se bere z povrchu i s výškou, takže sedí na svahu i na budově.
        </div>
      )}
    </>
  )
}
