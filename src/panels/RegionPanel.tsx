/**
 * Panel správního území — výběr kraje, okresu, obce i katastrálního území a jeho výstupy.
 *
 * Čerpá ze dvou hooků, a je to tak správně: co se vybírá drží `useRegionTool`, co z toho jde
 * vyexportovat `useExports`. Ta druhá polovina je důvod, proč sekce vypadá tak velká.
 */
import { useState } from 'react'
import { ArrowDownToLine, Download, Grid3x3, Image, Landmark, Layers, Loader2, RotateCcw, X } from 'lucide-react'
import { LOCAL_TILES } from '../imagery'
import type { TileSize } from '../tiles'
import type { RegionTool } from '../useRegionTool'
import type { ExportsApi } from '../useExports'
import { toolTheme } from '../toolColors'
import type { ExportRunner } from '../useExportRunner'
import { Card, ImagePlanNote, KindButton, MapImageOptions, imagePlan } from './exportUi'

export function RegionPanel({ region, outputs, runner, addRegionTiles, tileSize }: {
  region: RegionTool
  outputs: ExportsApi
  runner: ExportRunner
  addRegionTiles: () => void
  tileSize: TileSize
}) {
  const [img, setImg] = useState(false)
  return (
    <>
        {region.regionName && (
          <>
            <div className="flex items-center gap-1.5">
              <Landmark size={14} className={`shrink-0 ${toolTheme('region').text}`} />
              <span className="min-w-0 flex-1 truncate text-sm text-gray-200">Zvýrazněno: <span className="font-medium">{region.regionName}</span></span>
              <button onClick={region.clearRegion} title="Zrušit zvýraznění území" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300"><RotateCcw size={14} /></button>
            </div>
            {/* Území → dlaždice. Výběr se SČÍTÁ, takže jde poskládat víc krajů za sebou:
                najdi území, přidej, najdi další, přidej. Dlaždice se přitom neruší. */}
            <button
              onClick={addRegionTiles}
              title={`Vyplní hranici území dlaždicemi ${tileSize} m a přidá je k už vybraným`}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors ${toolTheme('tiles').solid}`}
            >
              <Grid3x3 size={13} /> Přidat jako dlaždice ({tileSize} m)
            </button>
            <label className="flex items-center gap-1.5" title="Viditelnost okolí — 0 % = tmavé, 100 % = plně vidět">
              <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolí</span>
              <input type="range" min={0} max={1} step={0.05} value={region.regionDim} onChange={e => region.setRegionDim(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
              <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(region.regionDim * 100)} %</span>
            </label>
            {runner.cutoutBusy ? (
              <div className="flex items-center gap-2">
                <Loader2 size={13} className="shrink-0 animate-spin text-gray-300" />
                <span className="min-w-0 flex-1 truncate text-xs text-gray-300">{runner.cutoutProgress || 'exportuji…'}</span>
                <button onClick={runner.cancelExport} title="Zrušit export" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={13} /></button>
              </div>
            ) : (
              <>
                <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">Export území</div>
                <button onClick={outputs.exportRegionCutout} title="Výřez terénu DMR 5G + zapečené ortofoto ořezaný na hranici území → OBJ (velké území = hrubší mřížka / velký soubor)" className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500"><Download size={13} /> Terén + ortofoto (OBJ)</button>
                <button onClick={outputs.exportRegionKatastrDxf} disabled={outputs.exporting} title="Katastr území do DXF: hranice jednotlivých parcel (hladina PARCELY) + obrys území (HRANICE_UZEMI), reálné S-JTSK + výšky DMR → lícuje s Terén (OBJ) i dlaždicemi" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">{outputs.exporting ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />} Katastr (DXF)</button>
                <button onClick={outputs.exportRegionDxf} disabled={outputs.exporting} title="Jen obrys území jako uzavřená 3D křivka (DXF R12) drapovaná na DMR — S-JTSK a výška Bpv, lícuje s exportem terénu" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">{outputs.exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Obrys území (DXF)</button>

                {/* 2D mapa území, oříznutá na jeho obrys — volby stejné jako u parcel a dlaždic. */}
                <KindButton active={img} onClick={() => setImg(o => !o)} icon={<Image size={14} />} label="Export 2D" tone="bg-teal-600 hover:bg-teal-500" />
                {img && <RegionImage region={region} outputs={outputs} />}
              </>
            )}
          </>
        )}
    </>
  )
}

/** Volby a tlačítka 2D mapy území — oříznuté na jeho skutečný obrys. */
function RegionImage({ region, outputs }: { region: RegionTool; outputs: ExportsApi }) {
  const a = region.regionActiveRef.current
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null
  if (a) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const r of a.sjtskRings) for (const [x, y] of r) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    if (Number.isFinite(minX)) box = { minX, minY, maxX, maxY }
  }
  const p = imagePlan(outputs, box, true)
  return (
    <Card>
      <MapImageOptions outputs={outputs} />
      {p && <ImagePlanNote p={p} />}
      {/* Jeden spojený soubor pro Photoshop / AE. Zapisuje se po pruzích, takže ho
          neomezuje strop plátna prohlížeče (16 384 px). */}
      <button onClick={outputs.exportRegionGeoTiff} disabled={!!p?.blocked} title="Jeden spojený obrázek oříznutý na obrys území, s georeferencí. Otevře ho Photoshop i After Effects." className="flex items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500 disabled:opacity-50">
        <Image size={13} /> Jeden obrázek ({p?.fmtName ?? 'PNG'})
      </button>
      <button onClick={outputs.exportRegionMapTiles} title="2D mapa po dlaždicích, oříznutá na skutečný obrys území. Drží zvolený detail i u kraje." className="flex items-center justify-center gap-1.5 rounded-lg bg-gray-800 px-2 py-1.5 text-xs text-gray-200 hover:bg-gray-700">
        <Grid3x3 size={13} /> Po dlaždicích (zip)
      </button>
      {/* Dávka přes všechny kraje. Nesouvisí s právě vybraným územím — hranice si
          vytáhne z RÚIAN sama; stojí tu proto, že sem se člověk dívá, když řeší
          export území. Zapisuje do složky, takže se prohlížeč ptá jen jednou. */}
      <button
        onClick={outputs.exportAllRegions}
        title="Stáhne postupně všech 14 krajů (vrstva, detail a formát podle voleb výše), každý do vlastní podsložky. Vybereš složku jednou, pak to běží samo a jde to přerušit."
        className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-800"
      >
        <Download size={12} /> Všechny kraje ČR do složky
      </button>
      {!LOCAL_TILES && (
        <button onClick={outputs.loadRegionLocal2D} title="Napéct ortofoto území do prohlížeče jako dlaždicovou pyramidu (nativní rozlišení, jde zoomovat hloub). Jednorázové stahování z ČÚZK (u velkého území to chvíli trvá), pak jede offline a zůstane uložené." className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-800">
          <ArrowDownToLine size={12} /> Uložit ortofoto do prohlížeče (offline)
        </button>
      )}
    </Card>
  )
}
