/**
 * Stavební prvky ovládacího panelu — číselný řádek, rozbalovací sekce a přepínací tlačítko.
 *
 * Čistě prezentační: žádný vlastní stav kromě rozbalení sekce, které si drží rodič, aby šlo
 * sekci otevřít i zvenčí (např. po zapnutí funkce skočit na její nastavení).
 */
import { createContext, useContext, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { toolTheme, type ToolId } from './toolColors'

/**
 * Sekce, kterou si bere právě zapnutý nástroj: je rozbalená a v barvě nástroje (`toolColors.ts`),
 * ostatní jsou sbalené. Je to jen pohled navrch — uložené rozbalení sekcí se tím nemění, takže po
 * vypnutí nástroje je panel přesně takový, jaký byl. Sekce, na kterou uživatel mezitím sám klikl
 * (`touched`), se řídí jeho volbou, ne nástrojem.
 */
export type SectionFocus = { id: string; tool: ToolId; touched: ReadonlySet<string> } | null
export const SectionFocusContext = createContext<SectionFocus>(null)

export function NumRow({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return (
    <div>
      <div className="flex justify-between items-center text-xs text-gray-400 mb-1">
        <span>{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={min} max={max} step={step}
            value={Number(value.toFixed(2))}
            onChange={e => { const n = Number(e.target.value); if (!Number.isNaN(n)) onChange(clamp(n)) }}
            className="w-16 bg-gray-800 rounded px-1.5 py-0.5 text-right text-gray-100 tabular-nums outline-none focus:ring-1 focus:ring-emerald-500"
          />
          <span className="text-gray-500 w-2 text-center">{unit}</span>
        </div>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-emerald-500"
      />
    </div>
  )
}

/**
 * Sbalitelná sekce levého panelu. Otevřenost drží rodič v jedné mapě, aby šla uložit celá naráz;
 * `dflt` platí, dokud do ní uživatel nesáhne.
 */
export function Section({ id, title, dflt, badge, open, onToggle, children }: {
  id: string; title: string; dflt: boolean; badge?: number
  open: Record<string, boolean>; onToggle: (id: string, next: boolean) => void; children: ReactNode
}) {
  const focus = useContext(SectionFocusContext)
  const own = open[id] ?? dflt
  const isOpen = !focus || focus.touched.has(id) ? own : id === focus.id
  const accent = focus?.id === id ? toolTheme(focus.tool) : null
  return (
    <div data-sec={id} className={`rounded-xl border transition-colors ${accent ? accent.section : 'border-gray-700/70 bg-gray-800/30'}`}>
      <button
        onClick={() => onToggle(id, !isOpen)}
        className="flex w-full items-center gap-1.5 rounded-xl px-2 py-1.5 text-left hover:bg-gray-700/40"
      >
        {isOpen ? <ChevronDown size={14} className="shrink-0 text-gray-500" /> : <ChevronRight size={14} className="shrink-0 text-gray-500" />}
        <span className={`min-w-0 flex-1 truncate text-xs font-medium ${accent ? accent.title : 'text-gray-200'}`}>{title}</span>
        {badge != null && badge > 0 && (
          <span className={`shrink-0 rounded-full px-1.5 text-[10px] tabular-nums ${accent ? accent.badge : 'bg-gray-700 text-gray-300'}`}>{badge}</span>
        )}
      </button>
      {isOpen && <div className="flex flex-col gap-1.5 border-t border-gray-700/70 p-2">{children}</div>}
    </div>
  )
}

export type CamProj = 'persp' | 'ortho'

/** Přepínací tlačítko; `tool` ho v zapnutém stavu obarví barvou nástroje (`toolColors.ts`). */
export function ToggleBtn({ active, onClick, icon, label, tool }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; tool?: ToolId }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
        active ? (tool ? toolTheme(tool).soft : 'bg-emerald-600/25 text-emerald-200 border border-emerald-500/40') : 'text-gray-400 hover:bg-gray-800 border border-transparent'
      }`}
    >
      {icon} {label}
    </button>
  )
}
