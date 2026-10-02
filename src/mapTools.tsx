/**
 * Lišta dole nad mapou: podklad, výběr, nástroje a pohled — každé jako jedna rozbalovací skupina.
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
 * Každý nástroj má svou barvu (`toolColors.ts`): v ní svítí tlačítko skupiny, položka v nabídce
 * i rámeček nápovědy. Tlačítka v nápovědě mají barvu toho, KAM výsledek půjde — „Parcely uvnitř"
 * barvu parcel, „Dlaždice uvnitř" barvu dlaždic —, ať je vidět, ve které sekci panelu skončí.
 */
import { useEffect, useRef, useState } from 'react'
import { Building2, Check, ChevronUp, Crosshair, Grid3x3, Hexagon, Image, Landmark, Layers, Loader2, Map as MapIcon, MapPin, Mountain, MousePointerClick, Move, PencilRuler, Ruler, X } from 'lucide-react'
import { ENABLE_GOOGLE_3D } from './config'
import { TILE_SIZES, type TileSize } from './tiles'
import type { CamProj } from './ui'
import { toolTheme, type ToolId } from './toolColors'
import type { MapLayers } from './useMapLayers'
import type { ParcelsTool } from './useParcels'
import type { TilesTool } from './useTiles'
import type { RegionTool } from './useRegionTool'

type Props = {
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
  onRuler: (kind: 'line' | 'area') => void
  onFinishRuler: () => void
  coordsMode: boolean
  onCoords: () => void
  moveMode: boolean
  onMove: () => void
  /** je vybraný model, který jde posouvat? */
  canMove: boolean
  // pohled
  camProj: CamProj
  onPersp: () => void
  onOrtho: () => void
}

type GroupId = 'podklad' | 'vyber' | 'nastroje' | 'pohled'

export function MapTools(p: Props) {
  const [open, setOpen] = useState<GroupId | null>(null)
  // Klik kamkoliv mimo lištu skupinu zavře — na dotykové obrazovce jiná cesta zavření není.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  /** volba v nabídce: provést a nabídku zavřít */
  const pick = (fn: () => void) => () => { setOpen(null); fn() }

  const { base, setBase, katastrOn, setKatastrOn, googleLoading } = p.layers
  const baseLabel = base === 'google' ? '3D realita' : base === 'zm' ? 'Topo' : 'Ortofoto'
  const selTool: ToolId | null = p.parcelMode ? 'parcel' : p.areaMode ? 'area' : p.tileMode ? 'tiles' : p.region.regionMode ? 'region' : null
  const selLabel = p.parcelMode ? 'Parcela' : p.areaMode ? 'Oblast' : p.tileMode ? 'Dlaždice' : p.region.regionMode ? 'Území' : null
  const toolId: ToolId | null = p.rulerMode ? 'ruler' : p.coordsMode ? 'coords' : p.moveMode ? 'move' : null
  const toolLabel = p.rulerMode ? (p.rulerKind === 'area' ? 'Plocha' : 'Vzdálenost') : p.coordsMode ? 'Souřadnice' : p.moveMode ? 'Posun' : null
  const group = { open, setOpen }

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-1.5">
      <Hint {...p} />

      <div onPointerDown={e => e.stopPropagation()} className="flex items-center gap-1 rounded-xl border border-gray-700 bg-gray-900/90 p-1 shadow-lg">
        <Group
          {...group} id="podklad" title="Podklad mapy a katastr"
          icon={googleLoading ? <Loader2 size={15} className="animate-spin" /> : <Layers size={15} />}
          label={katastrOn ? `${baseLabel} · katastr` : baseLabel}
        >
          <Item icon={<Image size={13} />} label="Ortofoto ČR" active={base === 'ortofoto'} onClick={pick(() => setBase('ortofoto'))} />
          <Item icon={<MapIcon size={13} />} label="Topografická mapa" active={base === 'zm'} onClick={pick(() => setBase('zm'))} />
          {ENABLE_GOOGLE_3D && (
            <Item icon={<Building2 size={13} />} label="3D realita (Google)" active={base === 'google'} onClick={pick(() => setBase('google'))} />
          )}
          <Sep />
          {/* Katastr je překryv, ne podklad — přepíná se samostatně a nabídka u toho zůstane otevřená. */}
          <Item icon={<Layers size={13} />} label="Katastr" active={katastrOn} onClick={() => setKatastrOn(v => !v)} />
        </Group>

        <Group
          {...group} id="vyber" title="Výběr parcel, oblasti, dlaždic nebo území"
          icon={<MousePointerClick size={15} />} label={selLabel ?? 'Výběr'}
          tone={selTool ? toolTheme(selTool).solid : undefined}
        >
          <Item icon={p.parcels.parcelLoading ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />} label="Vybrat parcelu" active={p.parcelMode} tool="parcel" onClick={pick(p.onParcel)} />
          <Item icon={<Hexagon size={13} />} label="Vybrat oblast" active={p.areaMode} tool="area" onClick={pick(p.onArea)} />
          <Item icon={<Grid3x3 size={13} />} label="Vybrat dlaždice" active={p.tileMode} tool="tiles" onClick={pick(p.tiles.toggleTileMode)} />
          <Item icon={p.region.regionBusy ? <Loader2 size={13} className="animate-spin" /> : <Landmark size={13} />} label="Vybrat území" active={p.region.regionMode} tool="region" onClick={pick(p.onRegion)} />
        </Group>

        <Group
          {...group} id="nastroje" title="Měření, odečet souřadnic a posun modelu"
          icon={<PencilRuler size={15} />} label={toolLabel ?? 'Nástroje'}
          tone={toolId ? toolTheme(toolId).solid : undefined}
        >
          <Item icon={<Ruler size={13} />} label="Měření vzdálenosti" active={p.rulerMode && p.rulerKind === 'line'} tool="ruler" onClick={pick(() => p.onRuler('line'))} />
          <Item icon={<Hexagon size={13} />} label="Měření plochy" active={p.rulerMode && p.rulerKind === 'area'} tool="ruler" onClick={pick(() => p.onRuler('area'))} />
          {p.rulerMode && <Item icon={<X size={13} />} label="Přestat měřit" onClick={pick(() => p.onRuler(p.rulerKind))} />}
          <Sep />
          <Item icon={<Crosshair size={13} />} label="Souřadnice bodu" active={p.coordsMode} tool="coords" onClick={pick(p.onCoords)} />
          {p.canMove && <Item icon={<Move size={13} />} label="Posun modelu" active={p.moveMode} tool="move" onClick={pick(p.onMove)} />}
        </Group>

        <Group
          {...group} id="pohled" title="Perspektiva, nebo pohled shora bez perspektivy"
          icon={p.camProj === 'ortho' ? <MapIcon size={15} /> : <Mountain size={15} />}
          label={p.camProj === 'ortho' ? 'Shora' : 'Perspektiva'}
        >
          <Item icon={<Mountain size={13} />} label="Perspektiva" active={p.camProj === 'persp'} onClick={pick(p.onPersp)} />
          <Item icon={<MapIcon size={13} />} label="Shora (půdorys)" active={p.camProj === 'ortho'} onClick={pick(p.onOrtho)} />
        </Group>
      </div>
    </div>
  )
}

/**
 * Jedna skupina lišty. Najetí myší ji otevře, odjetí zavře s malým zpožděním — mezi tlačítkem
 * a nabídkou je mezera a myš by ji cestou nahoru jinak nestihla. Přejetí na sousední skupinu
 * přepne rovnou na ni. Ťuknutí (dotyk, pero) ji otevře a zavře se klikem mimo.
 */
function Group({ id, open, setOpen, icon, label, title, tone, children }: {
  id: GroupId
  open: GroupId | null
  setOpen: React.Dispatch<React.SetStateAction<GroupId | null>>
  icon: React.ReactNode
  label: string
  title: string
  /** barva tlačítka, když je ve skupině něco zapnuté */
  tone?: string
  children: React.ReactNode
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const isOpen = open === id
  return (
    <div
      className="relative"
      onPointerEnter={e => { if (e.pointerType !== 'mouse') return; clearTimeout(timer.current); setOpen(id) }}
      onPointerLeave={e => { if (e.pointerType !== 'mouse') return; timer.current = setTimeout(() => setOpen(o => (o === id ? null : o)), 200) }}
    >
      <button
        onClick={() => setOpen(id)}
        title={title}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors ${
          tone ?? (isOpen ? 'bg-gray-800 text-gray-100' : 'text-gray-300 hover:bg-gray-800')
        }`}
      >
        {icon}
        <span className="whitespace-nowrap">{label}</span>
        <ChevronUp size={12} className={`opacity-60 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        // `pb-1.5` je průhledný můstek mezi tlačítkem a nabídkou — myš na něm nabídku neopustí
        <div className="absolute bottom-full left-1/2 z-10 -translate-x-1/2 pb-1.5">
          <div role="menu" className="flex w-48 flex-col rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl">
            {children}
          </div>
        </div>
      )}
    </div>
  )
}

/** Položka nabídky; patří-li k nástroji (`tool`), zapnutá svítí jeho barvou. */
function Item({ icon, label, active, tool, onClick }: { icon: React.ReactNode; label: string; active?: boolean; tool?: ToolId; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-gray-800 ${active ? (tool ? toolTheme(tool).text : 'text-emerald-300') : 'text-gray-200'}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{label}</span>
      {active && <Check size={12} className="shrink-0" />}
    </button>
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
    return (
      <div className={box('ruler')}>
        {p.rulerKind === 'area'
          ? 'Naklikej obvod plochy (aspoň tři body) — uvnitř se ukáže výměra, u stran délky. Uzavře se sama.'
          : 'Každý klik přidá bod, u úseku se ukáže jeho délka.'}
        {' '}<span className="text-gray-500">Bod jde přetáhnout. Ukončíš pravým klikem.</span>
        {p.rulerDrafting && (
          <button onClick={p.onFinishRuler} className={`${btn} ${toolTheme('ruler').solid}`}>
            <Check size={12} /> Ukončit
          </button>
        )}
      </div>
    )
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
    const pickSize = (s: TileSize) => {
      if (s === tileSize) return
      if (tileCount && !confirm(`Změna velikosti na ${s} m zruší výběr ${tileCount} dlaždic. Pokračovat?`)) return
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
          Klikni nebo táhni přes dlaždice ({tileCount} vybráno). <span className="text-gray-500">Mapu tu posouváš pravým tlačítkem.</span>
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
