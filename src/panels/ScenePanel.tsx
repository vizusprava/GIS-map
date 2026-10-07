/**
 * Sekce „Scéna": seznam modelů, parcel a výkresů — viditelnost, zaměření, přejmenování;
 * u výkresů jejich hladiny (výška, průhlednost, přilepení na terén), u modelů jejich objekty
 * a vzhled. Hladiny i objekty mají stejný seznam s hledáním a hromadným přepínáním (LayerList).
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Cloud, Crosshair, Eye, EyeOff, HardDrive, Pencil, Trash2 } from 'lucide-react'
import type { SceneObj } from '../types'
import type { FileStorage } from '../lib/types'
import type { DrawingsTool } from '../useDrawings'
import type { ModelsTool } from '../useModels'
import { MODEL_LOOKS, objectColor } from '../modelLook'
import { LayerList, type LayerWords } from './LayerList'

export type ScenePanelUi = ReturnType<typeof useScenePanelUi>

/** ikonové tlačítko v řádku — na dotyku větší, ať se trefí prstem */
const rowBtn = 'shrink-0 rounded p-0.5 text-gray-400 pointer-coarse:p-1.5'

const plural = (n: number, one: string, few: string, many: string) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many)
const LAYER_WORDS: LayerWords = { search: 'hledat hladinu…', count: n => `${n} ${plural(n, 'hladina', 'hladiny', 'hladin')}`, empty: 'žádná hladina', one: 'tuto hladinu' }
const OBJECT_WORDS: LayerWords = { search: 'hledat objekt…', count: n => `${n} ${plural(n, 'objekt', 'objekty', 'objektů')}`, empty: 'žádný objekt', one: 'tento objekt' }

/**
 * Kde leží soubor (sdílí to i panel Vlastní ortofoto). „Jen v tomto počítači" je vidět vždycky
 * — je to důležité vědět (jinde ani kolegům se soubor neotevře); „v cloudu" jen při najetí.
 * Klik soubor přesune na druhé místo (s potvrzením, viz MapView).
 */
export function FileAt({ at, onMove }: { at: FileStorage | null; onMove?: (to: FileStorage) => void }) {
  if (!at) return null
  const local = at === 'local'
  const title = local
    ? `Jen v tomto počítači${onMove ? ' — klikni a nahraje se do cloudu' : ''}`
    : `V cloudu${onMove ? ' — klikni a zůstane jen v tomto počítači' : ''}`
  const cls = `${rowBtn} ${local ? 'text-amber-400/90' : 'opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100'} ${onMove ? (local ? 'hover:text-amber-200' : 'hover:text-sky-300') : 'cursor-default'}`
  const icon = local ? <HardDrive size={13} /> : <Cloud size={13} />
  if (!onMove) return <span title={title} data-file-at={at} className={cls}>{icon}</span>
  return (
    <button data-file-at={at} title={title} onClick={e => { e.stopPropagation(); onMove(local ? 'cloud' : 'local') }} className={cls}>
      {icon}
    </button>
  )
}

/**
 * Stav seznamu — co je rozbalené, výběr hladin a objektů, rozepsané jméno. Žije o patro výš
 * než panel: sbalená sekce svůj obsah odmontuje a rozbalené položky ani výběr se tím ztratit nemají.
 */
export function useScenePanelUi() {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // rozbalené výkresy a modely v panelu Scéna (ukazují seznam hladin / objektů)
  const [expandedDrawings, setExpandedDrawings] = useState<Set<string>>(new Set())
  // text pro filtrování hladin / objektů, klíč = id objektu ve scéně
  const [layerFilter, setLayerFilter] = useState<Record<string, string>>({})
  // výběr (multi-select klikáním i tažením), klíč = id objektu ve scéně → množina názvů
  const [layerSel, setLayerSel] = useState<Record<string, Set<string>>>({})
  const lastLayerClick = useRef<Record<string, string>>({}) // poslední klik pro Shift-rozsah
  // aktivní tažení výběru: přes které položky přejedeš se stejným režimem přidají/odeberou
  const dragRef = useRef<{ oid: string; mode: 'add' | 'remove' } | null>(null)
  useEffect(() => { const up = () => { dragRef.current = null }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up) }, [])

  // stisk na položce: Shift = rozsah od posledního kliku; jinak zahájí tažení (přidávání/odebírání
  // podle toho, jestli položka ve výběru už je) a rovnou přepne tu první
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
  // přejezd přes položku během tažení = přidá/odebere ji stejným režimem jako začátek tažení
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

export function ScenePanel({ ui, objects, selectedId, drawings, models, selectObject, locateObject, toggleVisible, deleteObject, onRename, readOnly, fileAt, onMoveFile }: {
  ui: ScenePanelUi
  objects: SceneObj[]
  selectedId: string | null
  drawings: DrawingsTool
  models: ModelsTool
  selectObject: (id: string | null) => void
  locateObject: (o: SceneObj) => void
  toggleVisible: (o: SceneObj) => void
  deleteObject: (o: SceneObj) => void
  /** nové jméno objektu (přejmenovat jde jen model) */
  onRename: (id: string, name: string) => void
  /** veřejný prohlížeč: bez mazání a přejmenování */
  readOnly?: boolean
  /** kde leží soubor objektu (cloud / jen tento počítač), null = objekt bez souboru */
  fileAt?: (o: SceneObj) => FileStorage | null
  /** přesun souboru jinam; chybí = přesouvat nejde (jen prohlížení) */
  onMoveFile?: (o: SceneObj, to: FileStorage) => void
}) {
  const { expandedDrawings, renameDraft, renamingId, setRenameDraft, setRenamingId, toggleExpand } = ui
  const { drawingsRef, drawH, drawA, drawDrape, setDrawingHeight, setDrawingAlpha, setDrawingDrape, setLayersVisibility, toggleLayer } = drawings
  const { modelsRef, setModelLook, setModelObjectsVisible, toggleModelObject } = models

  function commitRename() {
    const id = renamingId
    if (id) onRename(id, renameDraft.trim() || 'objekt')
    setRenamingId(null)
  }

  return (
    <>
      {objects.map(o => {
        const draw = o.kind === 'drawing' ? drawingsRef.current.get(o.id.replace('drawing-', '')) : null
        const mdl = o.kind === 'model' ? modelsRef.current.get(o.id) : null
        const subCount = draw ? draw.layers.length : mdl ? mdl.objects.length : 0
        const isExpanded = subCount > 0 && expandedDrawings.has(o.id)
        return (
        <div key={o.id} className="flex flex-col">
        <div
          onClick={() => o.kind === 'model' ? selectObject(o.id) : o.kind === 'drawing' ? locateObject(o) : selectObject(null)}
          className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm cursor-pointer ${
            selectedId === o.id ? 'bg-emerald-600/25 text-emerald-100' : 'text-gray-300 hover:bg-gray-800'
          }`}
        >
          {subCount > 0 ? (
            <button
              onClick={e => { e.stopPropagation(); toggleExpand(o.id) }}
              title={draw ? `Hladiny (${subCount})` : `Objekty a vzhled (${subCount})`}
              data-expand={o.kind}
              className="shrink-0 -ml-1 p-0.5 rounded text-gray-400 hover:text-gray-100"
            >
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
          <FileAt at={fileAt?.(o) ?? null} onMove={onMoveFile && !readOnly ? to => onMoveFile(o, to) : undefined} />
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
          return (
          <div className="ml-5 mb-1 mt-0.5 flex flex-col gap-0.5 border-l border-gray-700 pl-2">
            {/* přilepit na terén: čáry po terénu, texty a body na jeho výšce — výškový posun pak nemá smysl */}
            <label data-drape={did} title="Čáry se promítnou na terén (i na 3D realitu), texty a body se posadí na jeho výšku" className="flex cursor-pointer items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-300" onClick={e => e.stopPropagation()}>
              <input type="checkbox" checked={!!drawDrape[did]} onChange={e => void setDrawingDrape(did, e.target.checked)} className="accent-emerald-500" />
              Přilepit na terén
            </label>
            <div className={`flex items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-400 ${drawDrape[did] ? 'opacity-40' : ''}`} onClick={e => e.stopPropagation()}>
              <span className="w-10 shrink-0">Výška</span>
              <input type="range" min={-100} max={100} step={0.5} value={drawH[did] ?? 0} disabled={!!drawDrape[did]} onChange={e => setDrawingHeight(did, Number(e.target.value))} className="flex-1 min-w-0" />
              <span className="w-10 text-right tabular-nums shrink-0">{drawDrape[did] ? 'terén' : `${(drawH[did] ?? 0).toFixed(1)} m`}</span>
            </div>
            <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-400" onClick={e => e.stopPropagation()}>
              <span className="w-10 shrink-0">Průhled.</span>
              <input type="range" min={0.05} max={1} step={0.05} value={drawA[did] ?? 1} onChange={e => setDrawingAlpha(did, Number(e.target.value))} className="flex-1 min-w-0" />
              <span className="w-10 text-right tabular-nums shrink-0">{Math.round((drawA[did] ?? 1) * 100)} %</span>
            </div>
            <LayerList
              oid={o.id}
              items={draw.layers.map(ly => ({ name: ly.name, visible: ly.visible, color: '#' + (ly.color & 0xffffff).toString(16).padStart(6, '0') }))}
              words={LAYER_WORDS}
              ui={ui}
              onSetVisible={(names, vis) => setLayersVisibility(did, names, vis)}
              onToggle={name => toggleLayer(did, name)}
            />
          </div>
          )
        })()}
        {isExpanded && mdl && (
          <div className="ml-5 mb-1 mt-0.5 flex flex-col gap-0.5 border-l border-gray-700 pl-2">
            {/* vzhled: s texturami, šedý, nebo každý objekt vlastní barvou (modelLook.ts) */}
            <div data-model-look={mdl.look} className="flex items-center gap-1.5 px-1 pb-1 text-[10px] text-gray-400" onClick={e => e.stopPropagation()}>
              <span className="w-10 shrink-0">Vzhled</span>
              <div className="flex flex-1 overflow-hidden rounded-md border border-gray-700">
                {MODEL_LOOKS.map(l => (
                  <button
                    key={l.id}
                    title={l.title}
                    onClick={() => setModelLook(o.id, l.id)}
                    className={`flex-1 px-1 py-0.5 pointer-coarse:py-1.5 ${mdl.look === l.id ? 'bg-emerald-600 text-white' : 'text-gray-300 hover:bg-gray-800'}`}
                  >{l.label}</button>
                ))}
              </div>
            </div>
            <LayerList
              oid={o.id}
              items={mdl.objects.map(x => ({ name: x.name, visible: x.visible, color: mdl.look === 'barvy' ? objectColor(x.id) : undefined }))}
              words={OBJECT_WORDS}
              ui={ui}
              onSetVisible={(names, vis) => setModelObjectsVisible(o.id, names, vis)}
              onToggle={name => toggleModelObject(o.id, name)}
            />
          </div>
        )}
        </div>
        )
      })}
    </>
  )
}
