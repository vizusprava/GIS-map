/**
 * Sekce „Scéna": seznam modelů, parcel a výkresů — viditelnost, zaměření, přejmenování
 * a u výkresů jejich hladiny (výška, průhlednost, hledání a hromadné přepínání).
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Crosshair, Eye, EyeOff, Pencil, Search, Trash2 } from 'lucide-react'
import { EMPTY_NAMESET } from '../config'
import type { SceneObj } from '../types'
import type { DrawingsTool } from '../useDrawings'

export type ScenePanelUi = ReturnType<typeof useScenePanelUi>

/** ikonové tlačítko v řádku — na dotyku větší, ať se trefí prstem */
const rowBtn = 'shrink-0 rounded p-0.5 text-gray-400 pointer-coarse:p-1.5'

/**
 * Stav seznamu — co je rozbalené, výběr hladin, rozepsané jméno. Žije o patro výš než panel:
 * sbalená sekce svůj obsah odmontuje a rozbalené výkresy ani vybrané hladiny se tím ztratit nemají.
 */
export function useScenePanelUi() {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // rozbalené výkresy v panelu Scéna (ukazují seznam hladin)
  const [expandedDrawings, setExpandedDrawings] = useState<Set<string>>(new Set())
  // text pro filtrování hladin, klíč = id objektu výkresu
  const [layerFilter, setLayerFilter] = useState<Record<string, string>>({})
  // výběr hladin (multi-select klikáním i tažením), klíč = id objektu výkresu → množina názvů hladin
  const [layerSel, setLayerSel] = useState<Record<string, Set<string>>>({})
  const lastLayerClick = useRef<Record<string, string>>({}) // poslední klik pro Shift-rozsah
  // aktivní tažení výběru: přes které hladiny přejedeš se stejným režimem přidají/odeberou
  const dragRef = useRef<{ oid: string; mode: 'add' | 'remove' } | null>(null)
  useEffect(() => { const up = () => { dragRef.current = null }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up) }, [])

  // stisk na hladině: Shift = rozsah od posledního kliku; jinak zahájí tažení (přidávání/odebírání
  // podle toho, jestli hladina ve výběru už je) a rovnou přepne tu první
  function startLayerDrag(oid: string, name: string, shownNames: string[], shift: boolean) {
    const cur = new Set(layerSel[oid] ?? [])
    const last = lastLayerClick.current[oid]
    if (shift && last) {
      const a = shownNames.indexOf(last), b = shownNames.indexOf(name)
      if (a >= 0 && b >= 0) for (let k = Math.min(a, b); k <= Math.max(a, b); k++) cur.add(shownNames[k])
      setLayerSel(prev => ({ ...prev, [oid]: cur }))
      lastLayerClick.current[oid] = name
      return // Shift = jen rozsah, ne tažení
    }
    const mode: 'add' | 'remove' = cur.has(name) ? 'remove' : 'add'
    dragRef.current = { oid, mode }
    if (mode === 'add') cur.add(name); else cur.delete(name)
    setLayerSel(prev => ({ ...prev, [oid]: cur }))
    lastLayerClick.current[oid] = name
  }
  // přejezd přes hladinu během tažení = přidá/odebere ji stejným režimem jako začátek tažení
  function dragOverLayer(oid: string, name: string) {
    const d = dragRef.current
    if (!d || d.oid !== oid) return
    setLayerSel(prev => {
      const cur = new Set(prev[oid] ?? [])
      if (d.mode === 'add') cur.add(name); else cur.delete(name)
      return { ...prev, [oid]: cur }
    })
  }
  const selectAllLayers = (oid: string, names: string[]) => setLayerSel(prev => ({ ...prev, [oid]: new Set(names) }))
  const clearLayerSel = (oid: string) => setLayerSel(prev => ({ ...prev, [oid]: new Set() }))

  const toggleExpand = (id: string) => setExpandedDrawings(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return {
    clearLayerSel, dragOverLayer, expandedDrawings, layerFilter, layerSel, renameDraft, renamingId,
    selectAllLayers, setLayerFilter, setRenameDraft, setRenamingId, startLayerDrag, toggleExpand,
  }
}

export function ScenePanel({ ui, objects, selectedId, drawings, selectObject, locateObject, toggleVisible, deleteObject, onRename, readOnly }: {
  ui: ScenePanelUi
  objects: SceneObj[]
  selectedId: string | null
  drawings: DrawingsTool
  selectObject: (id: string | null) => void
  locateObject: (o: SceneObj) => void
  toggleVisible: (o: SceneObj) => void
  deleteObject: (o: SceneObj) => void
  /** nové jméno objektu (přejmenovat jde jen model) */
  onRename: (id: string, name: string) => void
  /** veřejný prohlížeč: bez mazání a přejmenování */
  readOnly?: boolean
}) {
  const {
    clearLayerSel, dragOverLayer, expandedDrawings, layerFilter, layerSel, renameDraft, renamingId,
    selectAllLayers, setLayerFilter, setRenameDraft, setRenamingId, startLayerDrag, toggleExpand,
  } = ui
  const { drawingsRef, drawH, drawA, setDrawingHeight, setDrawingAlpha, setLayersVisibility, toggleLayer } = drawings

  function commitRename() {
    const id = renamingId
    if (id) onRename(id, renameDraft.trim() || 'objekt')
    setRenamingId(null)
  }

  return (
    <>
      {objects.map(o => {
        const draw = o.kind === 'drawing' ? drawingsRef.current.get(o.id.replace('drawing-', '')) : null
        const hasLayers = !!draw && draw.layers.length > 0
        const isExpanded = hasLayers && expandedDrawings.has(o.id)
        return (
        <div key={o.id} className="flex flex-col">
        <div
          onClick={() => o.kind === 'model' ? selectObject(o.id) : o.kind === 'drawing' ? locateObject(o) : selectObject(null)}
          className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm cursor-pointer ${
            selectedId === o.id ? 'bg-emerald-600/25 text-emerald-100' : 'text-gray-300 hover:bg-gray-800'
          }`}
        >
          {hasLayers ? (
            <button onClick={e => { e.stopPropagation(); toggleExpand(o.id) }} title={`Hladiny (${draw!.layers.length})`} className="shrink-0 -ml-1 p-0.5 rounded text-gray-400 hover:text-gray-100">
              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : null}
          <span className="text-[10px] text-gray-500 w-9 shrink-0">{o.kind === 'model' ? 'model' : o.kind === 'parcel' ? 'parc' : o.kind === 'drawing' ? 'výkr' : 'ploch'}</span>
          {renamingId === o.id ? (
            <input
              autoFocus value={renameDraft}
              onChange={e => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null) }}
              onClick={e => e.stopPropagation()}
              className="flex-1 min-w-0 bg-gray-800 rounded px-1 text-gray-100 outline-none"
            />
          ) : (
            <span
              className="flex-1 min-w-0 truncate"
              onDoubleClick={e => { if (o.kind === 'model' && !readOnly) { e.stopPropagation(); setRenamingId(o.id); setRenameDraft(o.name) } }}
              title={o.name}
            >{o.name}</span>
          )}
          {/* přejmenování i tlačítkem — dvojklik na dotykové obrazovce nefunguje */}
          {o.kind === 'model' && !readOnly && renamingId !== o.id && (
            <button onClick={e => { e.stopPropagation(); setRenamingId(o.id); setRenameDraft(o.name) }} title="Přejmenovat (nebo dvojklik na název)" className={`${rowBtn} hover:text-gray-100 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100`}>
              <Pencil size={13} />
            </button>
          )}
          <button onClick={e => { e.stopPropagation(); locateObject(o) }} title="Zaměřit na mapě (odletět na místo)" className={`${rowBtn} hover:text-cyan-300`}>
            <Crosshair size={13} />
          </button>
          <button onClick={e => { e.stopPropagation(); toggleVisible(o) }} title="Zobrazit/skrýt" className={`${rowBtn} hover:text-gray-100`}>
            {o.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          {!readOnly && (
          <button onClick={e => { e.stopPropagation(); deleteObject(o) }} title="Smazat" className={`${rowBtn} hover:text-red-300 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100`}>
            <Trash2 size={13} />
          </button>
          )}
        </div>
        {isExpanded && draw && (() => {
          const did = o.id.replace('drawing-', '')
          const q = (layerFilter[o.id] || '').toLowerCase().trim()
          const shown = q ? draw.layers.filter(l => l.name.toLowerCase().includes(q)) : draw.layers
          const shownNames = shown.map(l => l.name)
          const sel = layerSel[o.id] ?? EMPTY_NAMESET
          const selCount = sel.size
          const bulk = selCount > 0 ? [...sel] : shownNames // očka pracují nad výběrem, jinak nad zobrazenými
          return (
          <div className="ml-5 mb-1 mt-0.5 flex flex-col gap-0.5 border-l border-gray-700 pl-2">
            <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-400" onClick={e => e.stopPropagation()}>
              <span className="w-10 shrink-0">Výška</span>
              <input type="range" min={-100} max={100} step={0.5} value={drawH[did] ?? 0} onChange={e => setDrawingHeight(did, Number(e.target.value))} className="flex-1 min-w-0" />
              <span className="w-10 text-right tabular-nums shrink-0">{(drawH[did] ?? 0).toFixed(1)} m</span>
            </div>
            <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-400" onClick={e => e.stopPropagation()}>
              <span className="w-10 shrink-0">Průhled.</span>
              <input type="range" min={0.05} max={1} step={0.05} value={drawA[did] ?? 1} onChange={e => setDrawingAlpha(did, Number(e.target.value))} className="flex-1 min-w-0" />
              <span className="w-10 text-right tabular-nums shrink-0">{Math.round((drawA[did] ?? 1) * 100)} %</span>
            </div>
            <div className="flex items-center gap-1 px-1 pb-0.5">
              <Search size={11} className="shrink-0 text-gray-500" />
              <input
                value={layerFilter[o.id] || ''}
                onChange={e => setLayerFilter(f => ({ ...f, [o.id]: e.target.value }))}
                onClick={e => e.stopPropagation()}
                placeholder="hledat hladinu…"
                className="flex-1 min-w-0 bg-gray-800 rounded px-1 py-0.5 text-xs text-gray-100 outline-none placeholder:text-gray-600"
              />
              <button onClick={e => { e.stopPropagation(); setLayersVisibility(did, bulk, true) }} title={selCount > 0 ? `Zobrazit vybrané (${selCount})` : q ? 'Zobrazit nalezené' : 'Zobrazit vše'} className="shrink-0 p-0.5 rounded text-gray-400 hover:text-emerald-300"><Eye size={12} /></button>
              <button onClick={e => { e.stopPropagation(); setLayersVisibility(did, bulk, false) }} title={selCount > 0 ? `Skrýt vybrané (${selCount})` : q ? 'Skrýt nalezené' : 'Skrýt vše'} className="shrink-0 p-0.5 rounded text-gray-400 hover:text-red-300"><EyeOff size={12} /></button>
            </div>
            <div className="flex items-center gap-2 px-1 pb-0.5 text-[10px] text-gray-500">
              <span className={selCount > 0 ? 'text-emerald-300' : ''}>{selCount > 0 ? `${selCount} vybráno` : `${shown.length} hladin`}</span>
              <button onClick={e => { e.stopPropagation(); selectAllLayers(o.id, shownNames) }} className="hover:text-gray-200">vybrat vše</button>
              {selCount > 0 && <button onClick={e => { e.stopPropagation(); clearLayerSel(o.id) }} className="hover:text-gray-200">zrušit výběr</button>}
            </div>
            {shown.length === 0 ? (
              <div className="px-1 py-0.5 text-xs text-gray-600">žádná hladina</div>
            ) : shown.map(ly => {
              const isSel = sel.has(ly.name)
              return (
              <div
                key={ly.name}
                onMouseDown={e => { e.stopPropagation(); e.preventDefault(); startLayerDrag(o.id, ly.name, shownNames, e.shiftKey) }}
                onMouseEnter={() => dragOverLayer(o.id, ly.name)}
                title={`${ly.name} — klik označí, tažením označíš víc, Shift+klik rozsah`}
                className={`flex items-center gap-1.5 px-1 py-0.5 rounded text-xs cursor-pointer select-none ${isSel ? 'bg-emerald-600/25 text-emerald-100' : `hover:bg-gray-800 ${ly.visible ? 'text-gray-300' : 'text-gray-500'}`}`}
              >
                <span className="shrink-0 w-2.5 h-2.5 rounded-sm border border-gray-600" style={{ background: '#' + (ly.color & 0xffffff).toString(16).padStart(6, '0') }} />
                <span className="flex-1 min-w-0 truncate">{ly.name}</span>
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); if (sel.has(ly.name)) setLayersVisibility(did, [...sel], !ly.visible); else toggleLayer(did, ly.name) }}
                  title={sel.has(ly.name) ? `Zobrazit/skrýt všechny vybrané (${selCount})` : 'Zobrazit/skrýt tuto hladinu'}
                  className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-100"
                >
                  {ly.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
              </div>
              )
            })}
          </div>
          )
        })()}
        </div>
        )
      })}
    </>
  )
}
