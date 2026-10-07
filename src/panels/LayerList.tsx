/**
 * Seznam položek s hledáním, výběrem a očky — hladiny výkresu i objekty modelu (panel Scéna).
 *
 * Výběr: klik označí, tažením přes víc položek se označí (nebo odznačí) všechny, Shift+klik
 * vybere rozsah. Očka nahoře pracují nad výběrem, bez výběru nad tím, co je vidět (nalezené,
 * jinak všechno). Stav výběru a hledání drží `useScenePanelUi`, ať přežije sbalení sekce.
 */
import { Eye, EyeOff, Search } from 'lucide-react'
import { EMPTY_NAMESET } from '../config'
import type { ScenePanelUi } from './ScenePanel'

export type LayerItem = { name: string; visible: boolean; /** CSS barva políčka; bez ní žádné */ color?: string }

/** Slova pro hledání a počty — „hladina / hladin", „objekt / objektů". */
export type LayerWords = { search: string; count: (n: number) => string; empty: string; one: string }

export function LayerList({ oid, items, words, ui, onSetVisible, onToggle }: {
  /** id objektu ve scéně — klíč pro hledání a výběr v `ui` */
  oid: string
  items: LayerItem[]
  words: LayerWords
  ui: ScenePanelUi
  onSetVisible: (names: string[], visible: boolean) => void
  onToggle: (name: string) => void
}) {
  const { layerFilter, setLayerFilter, layerSel, startLayerDrag, dragOverLayer, selectAllLayers, clearLayerSel } = ui
  const q = (layerFilter[oid] || '').toLowerCase().trim()
  const shown = q ? items.filter(l => l.name.toLowerCase().includes(q)) : items
  const shownNames = shown.map(l => l.name)
  const sel = layerSel[oid] ?? EMPTY_NAMESET
  const selCount = sel.size
  const bulk = selCount > 0 ? [...sel] : shownNames // očka pracují nad výběrem, jinak nad zobrazenými
  return (
    <>
      <div className="flex items-center gap-1 px-1 pb-0.5">
        <Search size={11} className="shrink-0 text-gray-500" />
        <input
          value={layerFilter[oid] || ''}
          onChange={e => setLayerFilter(f => ({ ...f, [oid]: e.target.value }))}
          onClick={e => e.stopPropagation()}
          placeholder={words.search}
          className="flex-1 min-w-0 bg-gray-800 rounded px-1 py-0.5 text-xs text-gray-100 outline-none placeholder:text-gray-600"
        />
        <button onClick={e => { e.stopPropagation(); onSetVisible(bulk, true) }} title={selCount > 0 ? `Zobrazit vybrané (${selCount})` : q ? 'Zobrazit nalezené' : 'Zobrazit vše'} className="shrink-0 p-0.5 rounded text-gray-400 hover:text-emerald-300"><Eye size={12} /></button>
        <button onClick={e => { e.stopPropagation(); onSetVisible(bulk, false) }} title={selCount > 0 ? `Skrýt vybrané (${selCount})` : q ? 'Skrýt nalezené' : 'Skrýt vše'} className="shrink-0 p-0.5 rounded text-gray-400 hover:text-red-300"><EyeOff size={12} /></button>
      </div>
      <div className="flex items-center gap-2 px-1 pb-0.5 text-[10px] text-gray-500">
        <span className={selCount > 0 ? 'text-emerald-300' : ''}>{selCount > 0 ? `${selCount} vybráno` : words.count(shown.length)}</span>
        <button onClick={e => { e.stopPropagation(); selectAllLayers(oid, shownNames) }} className="hover:text-gray-200">vybrat vše</button>
        {selCount > 0 && <button onClick={e => { e.stopPropagation(); clearLayerSel(oid) }} className="hover:text-gray-200">zrušit výběr</button>}
      </div>
      {shown.length === 0 ? (
        <div className="px-1 py-0.5 text-xs text-gray-600">{words.empty}</div>
      ) : shown.map(ly => {
        const isSel = sel.has(ly.name)
        return (
          <div
            key={ly.name}
            data-layer-item={ly.name}
            onMouseDown={e => { e.stopPropagation(); e.preventDefault(); startLayerDrag(oid, ly.name, shownNames, e.shiftKey) }}
            onMouseEnter={() => dragOverLayer(oid, ly.name)}
            title={`${ly.name} — klik označí, tažením označíš víc, Shift+klik rozsah`}
            className={`flex items-center gap-1.5 px-1 py-0.5 rounded text-xs cursor-pointer select-none ${isSel ? 'bg-emerald-600/25 text-emerald-100' : `hover:bg-gray-800 ${ly.visible ? 'text-gray-300' : 'text-gray-500'}`}`}
          >
            {ly.color && <span className="shrink-0 w-2.5 h-2.5 rounded-sm border border-gray-600" style={{ background: ly.color }} />}
            <span className="flex-1 min-w-0 truncate">{ly.name}</span>
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); if (isSel) onSetVisible([...sel], !ly.visible); else onToggle(ly.name) }}
              title={isSel ? `Zobrazit/skrýt všechny vybrané (${selCount})` : `Zobrazit/skrýt ${words.one}`}
              className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-100"
            >
              {ly.visible ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
          </div>
        )
      })}
    </>
  )
}
