/**
 * Ovládání exportů sdílené panely (dlaždice, parcely, území): řádky voleb, čipy, přepínače a hlavně
 * volby 2D obrázku. Jedno místo, ať dva panely nenabízejí totéž pokaždé trochu jinak.
 */
import { useEffect, useRef } from 'react'
import { Check, ChevronDown, ChevronRight, Layers, PenLine } from 'lucide-react'
import { MAP_RES, fmtBytes } from '../export/mapTiles'
import { planGeoTiff } from '../export/geotiff'
import { KATASTR_MAX_RES } from '../tiles'
import type { ExportsApi } from '../useExports'

/** Tlačítko druhu exportu — rozbalí pod sebou jeho volby. */
export function KindButton({ active, onClick, icon, label, tone }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; tone: string }) {
  return (
    <button
      onClick={onClick}
      aria-expanded={active}
      className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors ${active ? `${tone} text-white` : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}
    >
      {icon} {label} {active ? <ChevronDown size={12} className="opacity-70" /> : <ChevronRight size={12} className="opacity-70" />}
    </button>
  )
}

/** Řádek voleb: popisek vlevo, tlačítka vpravo. */
export function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1" title={title}>
      <span className="w-14 shrink-0 text-[10px] text-gray-500">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

export function Chip({ on, onClick, title, tone, children }: { on: boolean; onClick: () => void; title?: string; tone: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className={`rounded px-1.5 py-0.5 text-[11px] ${on ? `${tone} text-white` : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
      {children}
    </button>
  )
}

/** Přepínač „přidat / nepřidat". */
export function Toggle({ on, onClick, icon, label, title }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition-colors ${on ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
    >
      {on ? <Check size={13} /> : icon} {label}
    </button>
  )
}

/**
 * Rozbalené volby jednoho druhu exportu. Objeví se pod tlačítkem, které bývá dole v sekci —
 * při otevření se proto samy posunou do zorného pole, jinak by skončily pod okrajem panelu.
 */
export function Card({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [])
  return <div ref={ref} className="flex flex-col gap-1.5 rounded-lg border border-gray-700/70 bg-gray-900/40 p-1.5">{children}</div>
}

export const Note = ({ warn, children }: { warn?: boolean; children: React.ReactNode }) => (
  <div className={`px-0.5 text-[10px] leading-snug ${warn ? 'text-amber-400' : 'text-gray-500'}`}>{children}</div>
)

/** Volby 2D obrázku: vrstva, detail, formát a co se má přes mapu dokreslit. */
export function MapImageOptions({ outputs }: { outputs: ExportsApi }) {
  const { mapLayer, setMapLayer, mapRes, setMapRes, mapFormat, setMapFormat, mapDrawings, setMapDrawings, mapKatastr, setMapKatastr } = outputs
  return (
    <>
      <Row label="Vrstva">
        {([['ortofoto', 'ortofoto'], ['topo', 'topo'], ['both', 'obojí']] as const).map(([v, lbl]) => (
          <Chip key={v} on={mapLayer === v} onClick={() => setMapLayer(v)} tone="bg-teal-600"
            title={v === 'both' ? 'Obě vrstvy přes tutéž obálku a rozlišení → vyjdou pixel na pixel a jdou položit přes sebe' : undefined}
          >{lbl}</Chip>
        ))}
      </Row>
      <Row label="Detail" title="Metry na pixel. Ortofoto ČÚZK má nativně 20 cm.">
        {MAP_RES.map(r => (
          <Chip key={r} on={mapRes === r} onClick={() => setMapRes(r)} tone="bg-teal-600"
            title={r === 0.2 ? 'Nativní rozlišení ČÚZK — nejostřejší, co existuje' : `${(r / 0.2).toFixed(0)}× hrubší než zdroj, ${(r / 0.2) ** 2}× menší soubor`}
          >{r < 1 ? `${r * 100} cm` : `${r} m`}</Chip>
        ))}
      </Row>
      <Row label="Formát">
        {([['png', 'PNG'], ['jpeg', 'JPEG'], ['tiff', 'GeoTIFF']] as const).map(([v, lbl]) => (
          <Chip key={v} on={mapFormat === v} onClick={() => setMapFormat(v)} tone="bg-teal-600"
            title={v === 'png' ? 'Bezeztrátově, georeference vedle jako .pgw' : v === 'jpeg' ? 'Nejmenší soubor; jeden obrázek jen do 16 384 px' : 'Georeference přímo v souboru (QGIS, ArcGIS); nekomprimovaný, strop 4 GB'}
          >{lbl}</Chip>
        ))}
      </Row>
      <Row label="Přidat">
        <Toggle on={mapKatastr} onClick={() => setMapKatastr(v => !v)} icon={<Layers size={13} />} label="Katastr"
          title="Katastrální mapa ČÚZK přes podklad — hranice a čísla parcel, budovy (jako překryv Katastr v mapě)" />
        {outputs.hasDrawings() && (
          <Toggle on={mapDrawings} onClick={() => setMapDrawings(v => !v)} icon={<PenLine size={13} />} label="Výkresy"
            title="Výkresy, které jsou v mapě vidět (i s vypnutými hladinami a průhledností), se dokreslí do exportu" />
        )}
      </Row>
      {mapKatastr && mapRes > KATASTR_MAX_RES && (
        <Note warn>Katastr ČÚZK kreslí jen do detailu {KATASTR_MAX_RES} m — při hrubším se do obrázku nepřidá.</Note>
      )}
    </>
  )
}

/**
 * Plán jednoho obrázku přes obálku: rozměr, odhad velikosti a jestli se do zvoleného formátu
 * vejde. `shaped` = ořez do tvaru výběru (průhledné okolí stojí kanál navíc, JPEG ho nemá).
 */
export function imagePlan(outputs: ExportsApi, box: { minX: number; minY: number; maxX: number; maxY: number } | null, shaped: boolean) {
  const { mapRes, mapFormat, mapLayer } = outputs
  if (!box) return null
  const plan = planGeoTiff(box.maxX - box.minX, box.maxY - box.minY, mapRes, shaped && mapFormat !== 'jpeg')
  const layers = mapLayer === 'both' ? 2 : 1
  const jpegTooBig = mapFormat === 'jpeg' && (plan.W > 16384 || plan.H > 16384)
  const tiffTooBig = mapFormat === 'tiff' && !plan.tiffOk
  // JPEG se komprimuje zhruba na desetinu, PNG ortofota na ~60 %, TIFF je nekomprimovaný
  const bytes = plan.bytes * (mapFormat === 'jpeg' ? 0.1 : mapFormat === 'png' ? 0.6 : 1) * layers
  const fmtName = mapFormat === 'png' ? 'PNG' : mapFormat === 'jpeg' ? 'JPEG' : 'GeoTIFF'
  return { ...plan, layers, jpegTooBig, tiffTooBig, blocked: jpegTooBig || tiffTooBig, est: bytes, fmtName, shaped, jpeg: mapFormat === 'jpeg' }
}

/** Odhad jednoho obrázku pod volbami — rozměr, velikost a varování. */
export function ImagePlanNote({ p }: { p: NonNullable<ReturnType<typeof imagePlan>> }) {
  return (
    <Note warn={p.blocked || !p.afterEffectsOk}>
      Jeden obrázek: {p.W}×{p.H} px · ~{fmtBytes(p.est)}{p.layers > 1 ? ' (obě vrstvy)' : ''}
      {p.jpegTooBig && ' — do JPEGu se nevejde (strop 16 384 px), zvol PNG nebo hrubší detail'}
      {p.tiffTooBig && ' — přes strop TIFFu (4 GB), zvol PNG nebo hrubší detail'}
      {!p.blocked && !p.afterEffectsOk && ' — nad 30 000 px, After Effects to neotevře'}
      {p.shaped && (p.jpeg
        ? <><br />Ve tvaru výběru, okolí bílé (JPEG průhlednost neumí — pro průhledné okolí zvol PNG).</>
        : <><br />Ve tvaru výběru, okolí průhledné.</>)}
    </Note>
  )
}
