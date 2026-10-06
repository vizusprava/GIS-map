/**
 * Lišta dole nad mapou: podklad, výběr, nástroje, pohled, kamera a prezentace — každé jako jedna skupina.
 *
 * Skupina se rozbalí najetím myší (na dotykové obrazovce ťuknutím) a její tlačítko ukazuje, co je
 * v ní zrovna zapnuté, takže lišta zůstává úzká a stav je vidět i zavřený. Je to schválně jen rychlá
 * volba: podrobnosti (průhlednost 3D, pozadí, velikost dlaždic, exporty…) zůstávají v panelu vlevo.
 *
 * Nad lištou visí nápověda k právě zapnutému nástroji i s tím, co k němu patří — dokončení oblasti,
 * mřížka dlaždic, ukončení měření. Bez ní by nástroj zapnutý odsud se zavřeným panelem skončil
 * ve slepé uličce (oblast by nešlo potvrdit).
 *
 * Posun modelu je v nástrojích jen když je model vybraný; jinak by to byla položka, která nic nedělá.
 *
 * Na úzké mapě (tablet na výšku, otevřený panel) jsou skupiny jen ikony (`compact`) — celá
 * lišta by se jinak nevešla a prohlížeč by stránku zmenšil. Na dotyku jsou terče větší.
 *
 * Ve veřejném prohlížeči (`guest`) chybí výběr parcel/dlaždic/území, odečet souřadnic i posun
 * modelu — vedou k exportům a úpravám. Zůstává podklad, měření, pohled, kamera a prezentace.
 *
 * Kamera a Prezentace nejsou krátké nabídky, ale panely (pohledy, slidery, popisky) — dřív to
 * byly sekce levého panelu. Otevřou se najetím jako ostatní, ale jakmile do nich klikneš, zůstanou
 * otevřené („přišpendlí se"), ať jde posouvat slider nebo psát název, aniž by panel ujel pod myší.
 * Zavře je Esc, klik mimo nebo znovu tlačítko skupiny.
 *
 * Každý nástroj má svou barvu (`toolColors.ts`): v ní svítí tlačítko skupiny, položka v nabídce
 * i rámeček nápovědy. Tlačítka v nápovědě mají barvu toho, KAM výsledek půjde — „Parcely uvnitř"
 * barvu parcel, „Dlaždice uvnitř" barvu dlaždic —, ať je vidět, ve které sekci panelu skončí.
 *
 * Nástroje jdou zapnout i klávesou (`SHORTCUTS` níž); písmeno je vidět v nabídce a celý přehled
 * pod tlačítkem „?" nebo klávesou ?. Vedle lišty se točí kolečko, dokud se mapa dotahuje.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type * as Cesium from 'cesium'
import { Building2, Check, ChevronUp, Crosshair, Eye, EyeOff, Grid3x3, Hexagon, Image, Keyboard, Landmark, Layers, Loader2, LocateFixed, Map as MapIcon, MapPin, Mountain, MousePointerClick, Move, PencilRuler, Ruler, Video, X } from 'lucide-react'
import { ENABLE_GOOGLE_3D } from './config'
import { TILE_SIZES, type TileSize } from './tiles'
import type { CamProj } from './ui'
import { toolTheme, type ToolId } from './toolColors'
import { ask, isDialogOpen } from './dialog'
import type { MapLayers } from './useMapLayers'
import type { ParcelsTool } from './useParcels'
import type { TilesTool } from './useTiles'
import type { RegionTool } from './useRegionTool'
import type { RulerSnap } from './useRulers'

type Props = {
  /** veřejný prohlížeč: bez výběrů, souřadnic a posunu modelu (i bez jejich zkratek) */
  guest?: boolean
  /** málo místa: skupiny jen jako ikony (popisek zůstává v title) */
  compact?: boolean
  /** pro kolečko „načítám mapu" — null, dokud mapa není */
  viewer: Cesium.Viewer | null
  layers: MapLayers
  // výběr
  parcels: ParcelsTool
  tiles: TilesTool
  region: RegionTool
  parcelMode: boolean
  areaMode: boolean
  tileMode: boolean
  onParcel: () => void
  onArea: () => void
  onRegion: () => void
  // nástroje
  rulerMode: boolean
  rulerKind: 'line' | 'area'
  /** rozdělané měření — dokud je, dá se ukončit */
  rulerDrafting: boolean
  /** co udělá klik, ke kterému se myš zrovna přichytila (uzavřít, dokončit, přichytit na bod) */
  rulerSnap?: RulerSnap
  onRuler: (kind: 'line' | 'area') => void
  onFinishRuler: () => void
  coordsMode: boolean
  onCoords: () => void
  moveMode: boolean
  onMove: () => void
  /** je vybraný model, který jde posouvat? */
  canMove: boolean
  // pohled, kamera a prezentace
  camProj: CamProj
  onPersp: () => void
  onOrtho: () => void
  /** minimapa v rohu (poloha kamery shora) */
  minimapOn: boolean
  onMinimap: () => void
  /** otočit kameru na místě o tolik stupňů (kladné doprava) */
  onTurn: (deg: number) => void
  /** obsah panelu Kamera (CameraMenu) a kolik je uložených pohledů */
  cameraMenu: ReactNode
  viewCount: number
  /** obsah panelu Prezentace (PresentationMenu) */
  presentationMenu: ReactNode
  presentOn: boolean
  /** pokládá se popisek — klik do mapy panel Prezentace nezavře, ať jde hned psát text */
  calloutMode: boolean
}

type GroupId = 'podklad' | 'vyber' | 'nastroje' | 'pohled' | 'kamera' | 'prezentace'

/** Klávesová zkratka: písmeno (malé), případně se Shiftem, a co udělá. `repeat` = podržením se opakuje. */
type Shortcut = { key: string; shift?: boolean; label: string; run: () => void; when?: boolean; note?: string; repeat?: boolean }
const kbdLabel = (sc: Pick<Shortcut, 'key' | 'shift'>) => (sc.shift ? '⇧' : '') + sc.key.toUpperCase()

/**
 * Tabulka zkratek. Tatáž plní posluchač kláves, písmena v nabídkách i přehled pod „?",
 * takže se nemůžou rozejít. Písmena podle českých názvů, kde to šlo (Parcela, Oblast,
 * Dlaždice, Území, Měření, Souřadnice, Katastr) — a jen ta, která se na české i anglické
 * klávesnici píšou stejně (žádné Y/Z).
 */
function shortcuts(p: Props): Shortcut[] {
  const all: (Shortcut & { edit?: boolean })[] = [
    { key: 'p', label: 'Vybrat parcelu', run: p.onParcel, edit: true },
    { key: 'o', label: 'Vybrat oblast', run: p.onArea, edit: true },
    { key: 'd', label: 'Vybrat dlaždice', run: p.tiles.toggleTileMode, edit: true },
    { key: 'u', label: 'Vybrat území', run: p.onRegion, edit: true },
    { key: 'm', label: 'Měření vzdálenosti', run: () => p.onRuler('line') },
    { key: 'm', shift: true, label: 'Měření plochy', run: () => p.onRuler('area') },
    { key: 's', label: 'Souřadnice bodu', run: p.onCoords, edit: true },
    { key: 'v', label: 'Posun modelu', run: p.onMove, when: p.canMove, note: 'jen s vybraným modelem', edit: true },
    { key: 'k', label: 'Katastr zap / vyp', run: () => p.layers.setKatastrOn(v => !v) },
    { key: 't', label: 'Shora / perspektiva', run: p.camProj === 'ortho' ? p.onPersp : p.onOrtho },
    { key: 'n', label: 'Minimapa zap / vyp', run: p.onMinimap },
    { key: 'q', label: 'Otočit kameru doleva', run: () => p.onTurn(-5), repeat: true, note: 'na místě, podržet' },
    { key: 'e', label: 'Otočit kameru doprava', run: () => p.onTurn(5), repeat: true, note: 'na místě, podržet' },
  ]
  // `edit` = nástroj, který ve veřejném prohlížeči není (vede k exportům nebo úpravám)
  return p.guest ? all.filter(s => !s.edit) : all
}
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function MapTools(p: Props) {
  const [open, setOpen] = useState<GroupId | null>(null)
  // Přišpendlená skupina (panel, do kterého se kliklo) nejde najetím na jinou skupinu zavřít.
  const [pinned, setPinned] = useState(false)
  useEffect(() => { if (!open) setPinned(false) }, [open])
  const calloutRef = useRef(p.calloutMode)
  useEffect(() => { calloutRef.current = p.calloutMode })
  // Klik kamkoliv mimo lištu skupinu zavře — na dotykové obrazovce jiná cesta zavření není.
  // Výjimka: pokládání popisku z panelu Prezentace — klik do mapy ho položí a panel zůstane.
  // Esc zavře otevřenou skupinu dřív, než by vypnul nástroj (zachytávací fáze, jako u přehledu
  // zkratek); v textovém poli patří Esc poli.
  useEffect(() => {
    if (!open) return
    const close = () => { if (!(open === 'prezentace' && calloutRef.current)) setOpen(null) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isTyping(e.target) || isDialogOpen()) return
      e.stopImmediatePropagation()
      setOpen(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  /** volba v nabídce: provést a nabídku zavřít */
  const pick = (fn: () => void) => () => { setOpen(null); fn() }

  // ── klávesové zkratky ──
  const keys = shortcuts(p)
  const kbd = (label: string) => { const sc = keys.find(k => k.label === label); return sc ? kbdLabel(sc) : undefined }
  const [help, setHelp] = useState(false)
  // posluchač se registruje jednou a sahá na aktuální tabulku přes ref (jako Esc v MapView)
  const keysRef = useRef(keys)
  useEffect(() => { keysRef.current = keys })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
      if (e.key === '?') { if (!e.repeat) { e.preventDefault(); setHelp(h => !h) } return }
      const k = e.key.toLowerCase()
      const sc = keysRef.current.find(s => s.key === k && !!s.shift === e.shiftKey && s.when !== false)
      // podržená klávesa opakuje jen to, co opakovat má (otáčení), ne přepínače
      if (!sc || (e.repeat && !sc.repeat)) return
      e.preventDefault()
      if (!e.repeat) setOpen(null)
      sc.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Otevřený přehled zavře Esc (a jen on — nástroj ani výběr se tím nevypne: posluchač běží
  // v zachytávací fázi, takže se k Esc v MapView nedostane) nebo klik mimo.
  useEffect(() => {
    if (!help) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isDialogOpen()) return
      e.stopImmediatePropagation()
      setHelp(false)
    }
    const close = () => setHelp(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', close)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', close) }
  }, [help])

  const { base, setBase, katastrOn, setKatastrOn, googleLoading } = p.layers
  const baseLabel = base === 'google' ? '3D realita' : base === 'zm' ? 'Topo' : 'Ortofoto'
  const selTool: ToolId | null = p.parcelMode ? 'parcel' : p.areaMode ? 'area' : p.tileMode ? 'tiles' : p.region.regionMode ? 'region' : null
  const selLabel = p.parcelMode ? 'Parcela' : p.areaMode ? 'Oblast' : p.tileMode ? 'Dlaždice' : p.region.regionMode ? 'Území' : null
  const toolId: ToolId | null = p.rulerMode ? 'ruler' : p.coordsMode ? 'coords' : p.moveMode ? 'move' : null
  const toolLabel = p.rulerMode ? (p.rulerKind === 'area' ? 'Plocha' : 'Vzdálenost') : p.coordsMode ? 'Souřadnice' : p.moveMode ? 'Posun' : null
  const group = { open, setOpen, pinned, setPinned, compact: !!p.compact }

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-1.5">
      {help ? <KeyHelp keys={keys} onClose={() => setHelp(false)} /> : <Hint {...p} />}

      <div onPointerDown={e => e.stopPropagation()} className="relative flex items-center gap-1 rounded-xl border border-gray-700 bg-gray-900/90 p-1 shadow-lg">
        <Group
          {...group} id="podklad" title="Podklad mapy a katastr"
          icon={googleLoading ? <Loader2 size={15} className="animate-spin" /> : <Layers size={15} />}
          label={baseLabel} badge={katastrOn ? 'K' : undefined}
        >
          <Item icon={<Image size={13} />} label="Ortofoto ČR" active={base === 'ortofoto'} onClick={pick(() => setBase('ortofoto'))} />
          <Item icon={<MapIcon size={13} />} label="Topografická mapa" active={base === 'zm'} onClick={pick(() => setBase('zm'))} />
          {ENABLE_GOOGLE_3D && (
            <Item icon={<Building2 size={13} />} label="3D realita (Google)" active={base === 'google'} onClick={pick(() => setBase('google'))} />
          )}
          <Sep />
          {/* Katastr je překryv, ne podklad — přepíná se samostatně a nabídka u toho zůstane otevřená. */}
          <Item icon={<Layers size={13} />} label="Katastr" active={katastrOn} kbd={kbd('Katastr zap / vyp')} onClick={() => setKatastrOn(v => !v)} />
        </Group>

        {!p.guest && <Group
          {...group} id="vyber" title="Výběr parcel, oblasti, dlaždic nebo území"
          icon={<MousePointerClick size={15} />} label={selLabel ?? 'Výběr'}
          tone={selTool ? toolTheme(selTool).solid : undefined}
        >
          <Item icon={p.parcels.parcelLoading ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />} label="Vybrat parcelu" active={p.parcelMode} tool="parcel" kbd={kbd('Vybrat parcelu')} onClick={pick(p.onParcel)} />
          <Item icon={<Hexagon size={13} />} label="Vybrat oblast" active={p.areaMode} tool="area" kbd={kbd('Vybrat oblast')} onClick={pick(p.onArea)} />
          <Item icon={<Grid3x3 size={13} />} label="Vybrat dlaždice" active={p.tileMode} tool="tiles" kbd={kbd('Vybrat dlaždice')} onClick={pick(p.tiles.toggleTileMode)} />
          <Item icon={p.region.regionBusy ? <Loader2 size={13} className="animate-spin" /> : <Landmark size={13} />} label="Vybrat území" active={p.region.regionMode} tool="region" kbd={kbd('Vybrat území')} onClick={pick(p.onRegion)} />
        </Group>}

        <Group
          {...group} id="nastroje" title={p.guest ? 'Měření vzdálenosti a plochy' : 'Měření, odečet souřadnic a posun modelu'}
          icon={<PencilRuler size={15} />} label={toolLabel ?? 'Nástroje'}
          tone={toolId ? toolTheme(toolId).solid : undefined}
        >
          <Item icon={<Ruler size={13} />} label="Měření vzdálenosti" active={p.rulerMode && p.rulerKind === 'line'} tool="ruler" kbd={kbd('Měření vzdálenosti')} onClick={pick(() => p.onRuler('line'))} />
          <Item icon={<Hexagon size={13} />} label="Měření plochy" active={p.rulerMode && p.rulerKind === 'area'} tool="ruler" kbd={kbd('Měření plochy')} onClick={pick(() => p.onRuler('area'))} />
          {p.rulerMode && <Item icon={<X size={13} />} label="Přestat měřit" onClick={pick(() => p.onRuler(p.rulerKind))} />}
          {!p.guest && <>
            <Sep />
            <Item icon={<Crosshair size={13} />} label="Souřadnice bodu" active={p.coordsMode} tool="coords" kbd={kbd('Souřadnice bodu')} onClick={pick(p.onCoords)} />
            {p.canMove && <Item icon={<Move size={13} />} label="Posun modelu" active={p.moveMode} tool="move" kbd={kbd('Posun modelu')} onClick={pick(p.onMove)} />}
          </>}
        </Group>

        <Group
          {...group} id="pohled" title="Perspektiva, pohled shora bez perspektivy a minimapa"
          icon={p.camProj === 'ortho' ? <MapIcon size={15} /> : <Mountain size={15} />}
          label={p.camProj === 'ortho' ? 'Shora' : 'Perspektiva'}
        >
          <Item icon={<Mountain size={13} />} label="Perspektiva" active={p.camProj === 'persp'} onClick={pick(p.onPersp)} />
          <Item icon={<MapIcon size={13} />} label="Shora (půdorys)" active={p.camProj === 'ortho'} onClick={pick(p.onOrtho)} />
          <div className="px-2.5 pb-0.5 text-[10px] text-gray-500">Přepnout klávesou <Kbd>T</Kbd></div>
          <Sep />
          <Item icon={<LocateFixed size={13} />} label="Minimapa" active={p.minimapOn} kbd={kbd('Minimapa zap / vyp')} onClick={pick(p.onMinimap)} />
        </Group>

        <Group
          {...group} id="kamera" panel title="Kamera: uložené pohledy a vzhled"
          icon={<Video size={15} />}
          label="Kamera" badge={p.viewCount ? String(p.viewCount) : undefined}
        >
          {p.cameraMenu}
        </Group>

        <Group
          {...group} id="prezentace" panel title={p.presentOn ? 'Prezentace zapnutá — popisky a efekty pohledů' : 'Prezentace vypnutá'}
          icon={p.presentOn ? <Eye size={15} /> : <EyeOff size={15} />}
          label="Prezentace"
        >
          {p.presentationMenu}
        </Group>

        {/* na dotykovém zařízení bez klávesnice zkratky nemají smysl */}
        <button
          onClick={() => setHelp(h => !h)}
          title="Klávesové zkratky (?)"
          aria-pressed={help}
          className={`rounded-lg p-1.5 transition-colors pointer-coarse:hidden ${help ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`}
        >
          <Keyboard size={15} />
        </button>
        <MapLoading viewer={p.viewer} compact={p.compact} />
      </div>
    </div>
  )
}

/**
 * Jedna skupina lišty. Najetí myší ji otevře, odjetí zavře s malým zpožděním — mezi tlačítkem
 * a nabídkou je mezera a myš by ji cestou nahoru jinak nestihla. Přejetí na sousední skupinu
 * přepne rovnou na ni. Ťuknutí (dotyk, pero) ji otevře a zavře se klikem mimo.
 *
 * `panel` = místo krátké nabídky širší panel s ovládáním. Klik do něj (nebo na tlačítko) ho
 * přišpendlí: pak ho nezavře odjetí myší ani najetí na jinou skupinu, jen Esc, klik mimo nebo
 * znovu tlačítko.
 */
function Group({ id, open, setOpen, pinned, setPinned, compact, icon, label, badge, title, tone, panel, children }: {
  id: GroupId
  open: GroupId | null
  setOpen: React.Dispatch<React.SetStateAction<GroupId | null>>
  pinned: boolean
  setPinned: (v: boolean) => void
  /** jen ikona (popisek v title) */
  compact: boolean
  icon: React.ReactNode
  label: string
  /** krátký údaj vedle popisku (počet pohledů, „K" = zapnutý katastr) */
  badge?: string
  title: string
  /** barva tlačítka, když je ve skupině něco zapnuté */
  tone?: string
  panel?: boolean
  children: React.ReactNode
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const isOpen = open === id
  const click = () => {
    if (!panel) { setOpen(id); setPinned(false); return }
    if (isOpen && pinned) { setOpen(null); return }
    setOpen(id); setPinned(true)
  }
  return (
    <div
      className="relative"
      onPointerEnter={e => {
        if (e.pointerType !== 'mouse' || (pinned && open !== id)) return
        clearTimeout(timer.current); setOpen(id)
      }}
      onPointerLeave={e => {
        if (e.pointerType !== 'mouse' || (pinned && isOpen)) return
        timer.current = setTimeout(() => setOpen(o => (o === id ? null : o)), 200)
      }}
    >
      <button
        onClick={click}
        title={compact ? `${label} — ${title}` : title}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={label}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors pointer-coarse:py-2 ${
          tone ?? (isOpen ? 'bg-gray-800 text-gray-100' : 'text-gray-300 hover:bg-gray-800')
        }`}
      >
        {icon}
        {!compact && <span className="whitespace-nowrap">{label}</span>}
        {badge && <span className="rounded bg-gray-700/80 px-1 text-[10px] leading-4 tabular-nums text-gray-300">{badge}</span>}
        <ChevronUp size={12} className={`opacity-60 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        // `pb-1.5` je průhledný můstek mezi tlačítkem a nabídkou — myš na něm nabídku neopustí
        <div className="absolute bottom-full left-1/2 z-10 -translate-x-1/2 pb-1.5">
          {panel ? (
            <div
              role="dialog"
              aria-label={title}
              data-panel={id}
              onPointerDown={() => setPinned(true)}
              className={`w-80 max-w-[92vw] overflow-y-auto rounded-lg border bg-gray-900 shadow-xl ${pinned ? 'border-gray-600' : 'border-gray-700'}`}
              style={{ maxHeight: 'min(70vh, 620px)' }}
            >
              {children}
            </div>
          ) : (
            <div role="menu" className="flex w-48 flex-col rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl">
              {children}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Položka nabídky; patří-li k nástroji (`tool`), zapnutá svítí jeho barvou. `kbd` = klávesová zkratka. */
function Item({ icon, label, active, tool, kbd, onClick }: { icon: React.ReactNode; label: string; active?: boolean; tool?: ToolId; kbd?: string; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-gray-800 pointer-coarse:py-2.5 ${active ? (tool ? toolTheme(tool).text : 'text-emerald-300') : 'text-gray-200'}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{label}</span>
      {kbd && <Kbd>{kbd}</Kbd>}
      <Check size={12} className={`shrink-0 ${active ? '' : 'invisible'}`} />
    </button>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="shrink-0 rounded border border-gray-700 bg-gray-800 px-1 font-sans text-[10px] leading-4 text-gray-400">{children}</kbd>
}

/** Přehled klávesových zkratek — místo nápovědy nad lištou, dokud je otevřený. */
function KeyHelp({ keys, onClose }: { keys: Shortcut[]; onClose: () => void }) {
  const rows: { k: string; label: string; note?: string }[] = [
    ...keys.map(sc => ({ k: kbdLabel(sc), label: sc.label, note: sc.note })),
    { k: 'Esc', label: 'Vypnout nástroj, podruhé zrušit výběr' },
    { k: '← →', label: 'Předchozí / další uložený pohled' },
    { k: '⇧ + tah', label: 'Rozhlédnout se na místě', note: 'myší v mapě' },
    { k: '?', label: 'Tenhle přehled' },
  ]
  return (
    <div onPointerDown={e => e.stopPropagation()} className="max-w-[min(92vw,520px)] rounded-lg border border-gray-700 bg-gray-900/95 px-3 py-2 text-[11px] text-gray-300 shadow-lg">
      <div className="mb-1.5 flex items-center gap-2">
        <Keyboard size={13} className="text-gray-400" />
        <span className="flex-1 font-medium text-gray-200">Klávesové zkratky</span>
        <button onClick={onClose} title="Zavřít (Esc)" className="rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"><X size={13} /></button>
      </div>
      <div className="grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2">
        {rows.map(r => (
          <div key={r.k + r.label} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-right"><Kbd>{r.k}</Kbd></span>
            <span>{r.label}{r.note && <span className="text-gray-500"> ({r.note})</span>}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Kolečko „načítám mapu" vedle lišty, dokud glóbus dotahuje dlaždice (terén, ortofoto, topo).
 *
 * Stav drží tahle malá komponenta, ne MapView: událost chodí s každou změnou fronty a překreslovat
 * kvůli ní celý panel by stálo víc než samo načítání. Ukáže se až po chvilce, ať při drobném
 * posunu mapy jen neproblikne; zmizí hned, jak je fronta prázdná.
 */
function MapLoading({ viewer, compact }: { viewer: Cesium.Viewer | null; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onProgress = (queued: number) => {
      if (queued > 0) { if (!timer) timer = setTimeout(() => setBusy(true), 400) }
      else { clearTimeout(timer); timer = undefined; setBusy(false) }
    }
    const off = viewer.scene.globe.tileLoadProgressEvent.addEventListener(onProgress)
    return () => { off(); clearTimeout(timer) }
  }, [viewer])
  if (!busy) return null
  return (
    <div data-map-loading className="pointer-events-none absolute left-full top-1/2 ml-2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-gray-700 bg-gray-900/85 px-2 py-1 text-[10px] text-gray-300 shadow">
      <Loader2 size={11} className="animate-spin" />{!compact && ' načítám mapu'}
    </div>
  )
}

function Sep() {
  return <div className="my-1 h-px bg-gray-700" />
}

/** Nápověda k právě zapnutému nástroji — co dělat a co k tomu patří. */
function Hint(p: Props) {
  // rámeček v barvě nástroje (toolColors.ts)
  const frame = 'max-w-[min(90vw,460px)] rounded-lg border bg-gray-900/90 px-3 py-1.5 text-center text-[11px] leading-snug text-gray-300 shadow-lg'
  const box = (t: ToolId) => `${frame} ${toolTheme(t).border}`
  const esc = <span className="text-gray-500"> Esc nástroj vypne.</span>
  const btn = 'ml-1 inline-flex items-center gap-1 rounded px-2 py-0.5 text-white disabled:opacity-50'

  if (p.rulerMode) {
    // myš je u bodu, ke kterému se klik přichytí — řekni rovnou, co klik udělá
    if (p.rulerSnap) {
      return (
        <div className={box('ruler')}>
          {p.rulerSnap === 'close'
            ? (p.rulerKind === 'area' ? 'Klikni — plocha se tím dokončí.' : 'Klikni — měření se uzavře do prvního bodu a dokončí.')
            : p.rulerSnap === 'finish' ? 'Klikni — měření se tím dokončí.'
            : 'Klikni — bod se přichytí přesně na tenhle.'}
        </div>
      )
    }
    return (
      <div className={box('ruler')}>
        {p.rulerKind === 'area'
          ? 'Naklikej obvod plochy (aspoň tři body) — uvnitř se ukáže výměra, u stran délky. Uzavře se sama.'
          : 'Každý klik přidá bod, u úseku se ukáže jeho délka.'}
        {' '}<span className="text-gray-500">
          {p.rulerDrafting
            ? 'Klik na první bod měření uzavře, na poslední ho dokončí (nebo pravým klikem). Ke stávajícím bodům se klik přichytí.'
            : 'Bod jde přetáhnout. Ukončíš klepnutím na poslední bod nebo pravým klikem.'}
        </span>
        {p.rulerDrafting && (
          <button onClick={p.onFinishRuler} className={`${btn} ${toolTheme('ruler').solid}`}>
            <Check size={12} /> Ukončit
          </button>
        )}
      </div>
    )
  }
  if (p.calloutMode) {
    return <div className={`${frame} border-sky-600/70`}>Klikni do mapy, kam má popisek ukazovat. Bublinu pak přetáhneš a text napíšeš v panelu Prezentace.{esc}</div>
  }
  if (p.coordsMode) {
    return <div className={box('coords')}>Klikni do mapy — bod se odečte v S-JTSK s výškou Bpv přímo z ČÚZK. Bod jde přetáhnout.{esc}</div>
  }
  if (p.moveMode) {
    return <div className={box('move')}>Chyť vybraný model a táhni ho po mapě.{esc}</div>
  }
  if (p.parcelMode) {
    return (
      <div className={box('parcel')}>
        {p.parcels.parcelLoading && <Loader2 size={12} className="mr-1 inline animate-spin" />}
        Klikni na parcelu — přidá se do výběru, klik na vybranou ji zase odebere.{esc}
      </div>
    )
  }
  if (p.areaMode) {
    const n = p.parcels.areaPtCount
    const busy = p.parcels.areaLoading
    return (
      <div className={box('area')}>
        Klikej body obrysu ({n}).
        {n >= 3 ? (
          <>
            <button onClick={p.parcels.finalizeArea} disabled={busy} className={`${btn} ${toolTheme('parcel').solid}`}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Parcely uvnitř
            </button>
            <button onClick={p.tiles.finalizeAreaTiles} disabled={busy} title={`Dlaždice ${p.tiles.tileSize} m, jejichž střed padne dovnitř`} className={`${btn} ${toolTheme('tiles').solid}`}>
              <Grid3x3 size={12} /> Dlaždice uvnitř
            </button>
          </>
        ) : <span className="text-gray-500"> Od tří bodů jde vybrat, co je uvnitř.</span>}
      </div>
    )
  }
  if (p.tileMode) {
    const { tileCount, tileSize, gridOn, setGridOn, changeTileSize } = p.tiles
    // jiná velikost = jiná mřížka, takže výběr zmizí — u rozdělané práce se zeptat
    const pickSize = async (s: TileSize) => {
      if (s === tileSize) return
      if (tileCount && !(await ask({
        title: `Změnit velikost dlaždic na ${s} m?`,
        message: `Jiná velikost znamená jinou mřížku — výběr ${tileCount} dlaždic se zruší.`,
        okLabel: 'Změnit', danger: true,
      }))) return
      changeTileSize(s)
    }
    return (
      <div className={`${box('tiles')} flex flex-col items-center gap-1`}>
        <div className="flex flex-wrap items-center justify-center gap-1">
          <span className="text-gray-400">Velikost dlaždice</span>
          {TILE_SIZES.map(s => (
            <button key={s} onClick={() => pickSize(s)} className={`rounded px-2 py-0.5 ${tileSize === s ? toolTheme('tiles').solid : 'bg-gray-700 text-gray-200 hover:bg-gray-600'}`}>{s} m</button>
          ))}
          <button onClick={() => setGridOn(g => !g)} className={`${btn} ${gridOn ? toolTheme('tiles').solid : 'bg-gray-700 hover:bg-gray-600'}`}>
            <Grid3x3 size={12} /> Mřížka
          </button>
        </div>
        <div>
          Klikni nebo táhni přes dlaždice ({tileCount} vybráno).{' '}
          <span className="text-gray-500">
            {/* tah prstem vybírá dlaždice — posunout mapu jde jen myší, na dotyku po vypnutí výběru */}
            {matchMedia('(pointer: coarse)').matches ? 'Mapou posuneš, až výběr vypneš.' : 'Mapu tu posouváš pravým tlačítkem.'}
          </span>
        </div>
      </div>
    )
  }
  if (p.region.regionMode) {
    return (
      <div className={box('region')}>
        {p.region.regionBusy && <Loader2 size={12} className="mr-1 inline animate-spin" />}
        Klikni do mapy — nabídnu kraj, okres, obec a k.ú. v tom místě. Podle názvu se hledá v liště nahoře.{esc}
      </div>
    )
  }
  return null
}
