/**
 * Sekce „Parcely": co s vybranými parcelami — jak je ukázat v mapě a co z nich vyexportovat.
 */
import { useState } from 'react'
import { Building2, Download, Eye, EyeOff, Hexagon, Image, Loader2, MapPin, RotateCcw, Ruler, Trash2, X } from 'lucide-react'
import { ENABLE_GOOGLE_3D } from '../config'
import { fmtArea } from '../measure'
import type { ParcelsTool } from '../useParcels'
import type { MapLayers } from '../useMapLayers'
import type { ExportsApi } from '../useExports'
import { toolTheme } from '../toolColors'
import type { ExportRunner } from '../useExportRunner'
import { Card, ImagePlanNote, KindButton, MapImageOptions, imagePlan } from './exportUi'

export function ParcelsPanel({ parcels, layers, outputs, runner }: {
  parcels: ParcelsTool
  layers: MapLayers
  outputs: ExportsApi
  runner: ExportRunner
}) {
  const { parcelCount, clearAllParcels, toggleParcelHighlight, parcelHl, parcelMeasure, setParcelMeasure, measureSum } = parcels
  const {
    base, parcelClip, setParcelClip, parcelBuffer, setParcelBuffer, googleAlpha, setGoogleAlpha,
    okoliVis, setOkoliVis, keep3DAround, setKeep3DAround, resetClipping,
  } = layers
  const { exporting, exportParcelCutout, exportGoogleMesh, exportParcelsDxf } = outputs
  const { cutoutBusy, cutoutPct, cutoutProgress, cancelExport } = runner
  // Volby obrázku se rozbalí až na kliknutí, stejně jako u dlaždic — jinak by sekce zbytečně rostla.
  const [img, setImg] = useState(false)
  return (
    <>
      <div className="flex items-center gap-1.5">
        <MapPin size={14} className={`shrink-0 ${toolTheme('parcel').text}`} />
        <span className="min-w-0 flex-1 text-sm text-gray-200">Vybráno: <span className="font-medium">{parcelCount}</span></span>
        <button onClick={clearAllParcels} title="Zrušit výběr všech parcel" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300">
          <Trash2 size={14} />
        </button>
      </div>
      {cutoutBusy ? (
        <div className="flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-700">
            {cutoutPct >= 0
              ? <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.max(3, Math.round(cutoutPct * 100))}%` }} />
              : <div className="h-full w-1/3 animate-pulse bg-emerald-500/70" />}
          </div>
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-300">{cutoutProgress || 'pracuji…'}</span>
          <button onClick={cancelExport} title="Zrušit stahování" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={14} /></button>
        </div>
      ) : (
        <>
          {/* Dřív to byla jedna dlouhá řada tlačítek — teď zvlášť „jak to vypadá" a „co z toho vyleze". */}
          <div className="px-0.5 text-[10px] uppercase tracking-wide text-gray-500">Zobrazení v mapě</div>
          <div className="grid grid-cols-2 gap-1">
            <button onClick={() => setParcelClip(m => m === 'hide' ? 'off' : 'hide')} title="Skrýt mapu (ortofoto/topo + terén + Google) uvnitř vybraných parcel" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'hide' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
              <EyeOff size={13} /> Skrýt parcelu
            </button>
            <button onClick={() => setParcelClip(m => m === 'only' ? 'off' : 'only')} title="Nechat jen vybrané parcely a ztlumit okolí — nastav okraj a viditelnost okolí" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'only' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
              <Hexagon size={13} /> Jen parcelu
            </button>
          </div>
          {ENABLE_GOOGLE_3D && (
            <button onClick={() => setParcelClip(m => m === 'g3d' ? 'off' : 'g3d')} title="Topografická mapa všude + Google 3D realita JEN uvnitř vybraných parcel (potřebuje ion token)" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'g3d' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
              <Building2 size={13} /> Google jen ve výběru
            </button>
          )}
          {parcelClip !== 'off' && (
            <label className="flex items-center gap-1.5" title="Rovnoměrně zvětšit (+) nebo zmenšit (−) hranici">
              <span className="w-14 shrink-0 text-[11px] text-gray-400">Okraj</span>
              <input type="range" min={-50} max={50} step={0.5} value={parcelBuffer} onChange={e => setParcelBuffer(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
              <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{parcelBuffer > 0 ? '+' : ''}{parcelBuffer.toFixed(1)} m</span>
            </label>
          )}
          {parcelClip === 'g3d' && (
            <label className="flex items-center gap-1.5" title="Průhlednost 3D reality ve výběru — 100 % = plné 3D (topo pod ním skryté), níž = prosvítá topo mapa">
              <span className="w-14 shrink-0 text-[11px] text-gray-400">3D realita</span>
              <input type="range" min={0.1} max={1} step={0.05} value={googleAlpha} onChange={e => setGoogleAlpha(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
              <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(googleAlpha * 100)} %</span>
            </label>
          )}
          {parcelClip === 'only' && (
            <>
              <label className="flex items-center gap-1.5" title="Viditelnost okolní ZEMĚ — 0 % = černá/skrytá, 100 % = plně vidět">
                <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolí</span>
                <input type="range" min={0} max={1} step={0.05} value={okoliVis} onChange={e => setOkoliVis(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(okoliVis * 100)} %</span>
              </label>
              <div className="flex items-center gap-1" title="Okolní 3D budovy: skrýt (čistá izolace) nebo nechat vidět (kontext)">
                <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolní 3D</span>
                <button onClick={() => setKeep3DAround(false)} className={`rounded px-1.5 py-0.5 text-[11px] ${!keep3DAround ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>skrýt</button>
                <button onClick={() => setKeep3DAround(true)} className={`rounded px-1.5 py-0.5 text-[11px] ${keep3DAround ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>zobrazit</button>
              </div>
            </>
          )}
          <div className="flex gap-1">
            <button onClick={toggleParcelHighlight} title="Zap/vyp barevné zvýraznění parcely (výběr i ořez zůstanou) — koukat na parcelu načisto" className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelHl ? 'bg-gray-800 text-gray-200 hover:bg-gray-700' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}>
              {parcelHl ? <Eye size={13} /> : <EyeOff size={13} />} Zvýraznění
            </button>
            <button onClick={() => setParcelMeasure(m => !m)} title="Kóty délek u každé strany + výměra uprostřed parcely. Počítá se v S-JTSK jako v katastru, takže čísla lícují s výměrou z KN." className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelMeasure ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
              <Ruler size={13} /> Měření
            </button>
          </div>
          {parcelMeasure && (
            <div className="rounded-lg bg-gray-800/60 px-2 py-1 text-[11px] text-gray-300">
              Výměra výběru: <span className="font-medium tabular-nums text-emerald-300">{fmtArea(measureSum.area)}</span>
              <span className="text-[10px] text-gray-500"> z KN</span>
              {Math.abs(measureSum.mapArea - measureSum.area) >= 1 && (
                <div className="mt-0.5 text-[10px] text-gray-400" title="Spočítáno z geometrie mapy — lícuje s kótami po obvodu a s DXF exportem. Výměra v KN není z mapy přepočítaná, je zapsaná.">
                  z mapy <span className="tabular-nums">{fmtArea(measureSum.mapArea)}</span>
                </div>
              )}
              {measureSum.note && <div className="mt-0.5 text-[10px] text-amber-400/90">{measureSum.note}</div>}
            </div>
          )}
          <button onClick={resetClipping} title="Reset ořezu — vypnout masky i parcelový ořez, zobrazit celou mapu" className="flex items-center justify-center gap-1 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700">
            <RotateCcw size={13} /> Reset ořezu
          </button>
          <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">Export výběru</div>
          <button onClick={exportParcelCutout} title="Výřez terénu DMR 5G ořezaný na hranici výběru + zapečené ortofoto → zip (OBJ + MTL + JPEG + V-Ray) pro 3ds Max" className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500">
            <Download size={13} /> Terén + ortofoto (OBJ)
          </button>
          {base === 'google' && (
            <button onClick={exportGoogleMesh} title="Vytáhnout mesh z Google 3D dlaždic pro vybranou oblast včetně fototextur (reference) → zip (OBJ + MTL + JPEG)" className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500">
              <Download size={13} /> Google mesh + textury (OBJ)
            </button>
          )}
          <button onClick={exportParcelsDxf} disabled={exporting} title="Hranice parcel jako 3D křivky (DXF pro 3ds Max) — S-JTSK a výška Bpv, lícuje s exportem terénu" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Hranice parcel (DXF)
          </button>
          <KindButton active={img} onClick={() => setImg(o => !o)} icon={<Image size={14} />} label="Export 2D" tone="bg-teal-600 hover:bg-teal-500" />
          {img && <ParcelsImage outputs={outputs} />}
        </>
      )}
    </>
  )
}

/** 2D obrázek výběru — ořízne se přesně do tvaru parcel, okolí průhledné. */
function ParcelsImage({ outputs }: { outputs: ExportsApi }) {
  const p = imagePlan(outputs, outputs.parcelsBox(), true)
  return (
    <Card>
      <MapImageOptions outputs={outputs} />
      {p && <ImagePlanNote p={p} />}
      <button onClick={outputs.exportParcelsImage} disabled={!!p?.blocked} title="Mapa vybraných parcel jako jeden obrázek s georeferencí, oříznutý přesně po hranici parcel. Otevře ho Photoshop i After Effects." className="flex items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500 disabled:opacity-50">
        <Image size={13} /> Obrázek výběru ({p?.fmtName ?? 'PNG'})
      </button>
    </Card>
  )
}
