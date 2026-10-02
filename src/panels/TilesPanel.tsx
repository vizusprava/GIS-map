/**
 * Panel dlaždic — vybraný klad listů a co z něj jde vyexportovat.
 *
 * Exporty jsou dva druhy a každý má svoje volby: 3D (terén do Maxu) a 2D (mapa jako obrázek).
 * Volby se ukážou až po kliknutí na druh — dřív tu byly všechny naráz pod sebou a nebylo
 * poznat, co patří ke kterému tlačítku. Zvolené hodnoty i posun se ukládají se scénou, takže
 * opakovaný export po opravě výkresu vyjede stejně.
 */
import { useState } from 'react'
import { ArrowDownToLine, Box, Download, Grid3x3, Image, Layers, Trash2, X } from 'lucide-react'
import { LOCAL_TILES } from '../imagery'
import { estimateMapTiles, fmtBytes } from '../export/mapTiles'
import { MESH_STEPS, TEX_SIZES, estimateObjBytes, gridSize, tilesBounds } from '../tiles'
import type { Tile, TileSize } from '../tiles'
import { ShiftEditor } from '../coords'
import type { CoordPoint } from '../lib/types'
import type { ExportsApi } from '../useExports'
import { toolTheme } from '../toolColors'
import type { ExportRunner } from '../useExportRunner'
import { Card, Chip, ImagePlanNote, KindButton, MapImageOptions, Note, Row, Toggle, imagePlan } from './exportUi'

type Kind = '3d' | '2d'

export function TilesPanel({ outputs, runner, tilesRef, tileCount, tileSize, clearTiles, coordShift, coordPts, persistCoords }: {
  outputs: ExportsApi
  runner: ExportRunner
  tilesRef: React.RefObject<Map<string, Tile>>
  tileCount: number
  tileSize: TileSize
  clearTiles: () => void
  coordShift: [number, number, number]
  coordPts: CoordPoint[]
  persistCoords: (pts: CoordPoint[], shift: [number, number, number]) => void
}) {
  const [open, setOpen] = useState<Kind | null>(null)
  const toggle = (k: Kind) => setOpen(o => (o === k ? null : k))
  const tiles = [...tilesRef.current.values()]
  const bounds = tiles.length ? tilesBounds(tiles) : null

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Grid3x3 size={14} className={`shrink-0 ${toolTheme('tiles').text}`} />
        <span className="min-w-0 flex-1 text-sm text-gray-200">Vybráno: <span className="font-medium">{tileCount}</span> × {tileSize} m</span>
        <button onClick={clearTiles} title="Zrušit výběr dlaždic" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300">
          <Trash2 size={14} />
        </button>
      </div>

      {runner.tileBusy ? (
        <div className="flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-700">
            {runner.tilePct >= 0
              ? <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.max(3, Math.round(runner.tilePct * 100))}%` }} />
              : <div className="h-full w-1/3 animate-pulse bg-emerald-500/70" />}
          </div>
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-300">{runner.tileProgress || 'pracuji…'}</span>
          <button onClick={runner.cancelExport} title="Zrušit export" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={14} /></button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1">
            <KindButton active={open === '3d'} onClick={() => toggle('3d')} icon={<Box size={14} />} label="Export 3D" tone="bg-sky-600 hover:bg-sky-500" />
            <KindButton active={open === '2d'} onClick={() => toggle('2d')} icon={<Image size={14} />} label="Export 2D" tone="bg-teal-600 hover:bg-teal-500" />
          </div>
          {open === '3d' && <Export3D outputs={outputs} tileCount={tileCount} tileSize={tileSize} coordShift={coordShift} coordPts={coordPts} persistCoords={persistCoords} bounds={bounds} />}
          {open === '2d' && <Export2D outputs={outputs} tileCount={tileCount} tileSize={tileSize} bounds={bounds} />}
        </>
      )}
    </>
  )
}

function Export3D({ outputs, tileCount, tileSize, coordShift, coordPts, persistCoords, bounds }: {
  outputs: ExportsApi
  tileCount: number
  tileSize: TileSize
  coordShift: [number, number, number]
  coordPts: CoordPoint[]
  persistCoords: (pts: CoordPoint[], shift: [number, number, number]) => void
  bounds: ReturnType<typeof tilesBounds> | null
}) {
  const { meshStep, setMeshStep, exportOrtho, setExportOrtho, texSize, setTexSize, exportKatastr, setExportKatastr } = outputs
  const n = gridSize({ ix: 0, iy: 0, size: tileSize }, meshStep)
  const tris = tileCount * 2 * (n - 1) ** 2
  const objMb = estimateObjBytes(tileCount, tileSize, meshStep) / 1e6
  // ortofoto jako JPEG na dlaždici: ~0,25 B/px po kompresi (změřeno na typickém ortofotu)
  const jpgMb = exportOrtho ? tileCount * texSize * texSize * 0.25 / 1e6 : 0
  const mb = objMb + jpgMb
  return (
    <Card>
      <Row label="Terén" title="Rozteč mřížky terénu. Body DMR 5G mají ~2,8 m, takže 3 m sedne na zdroj.">
        {MESH_STEPS.map(s => (
          <Chip key={s} on={meshStep === s} onClick={() => setMeshStep(s)} tone="bg-cyan-600"
            title={s === 3 ? 'Sedne na zdrojová data (body DMR 5G mají rozteč ~2,8 m)' : s === 2 ? 'Hustší než zdroj — jen interpoluje, 2× víc trojúhelníků' : 'Řidší než zdroj — ubere detail, ušetří trojúhelníky'}
          >{s} m</Chip>
        ))}
      </Row>
      <Row label="Ortofoto" title="Ortofoto jako textura terénu. Bez něj vyjde čistý šedý terén — rychlejší a menší.">
        <Chip on={!exportOrtho} onClick={() => setExportOrtho(false)} tone="bg-cyan-600">bez</Chip>
        {TEX_SIZES.map(s => (
          <Chip key={s} on={exportOrtho && texSize === s} onClick={() => { setExportOrtho(true); setTexSize(s) }} tone="bg-cyan-600"
            title={`${(tileSize / s * 100).toFixed(0)} cm/px${tileSize / s < 0.2 ? ' — jemnější než nativních 20 cm ortofota, ostřejší už nebude' : ''}`}
          >{s}</Chip>
        ))}
      </Row>
      {exportOrtho && (
        <Note>Textura {(tileSize / texSize * 100).toFixed(0)} cm/px{tileSize / texSize < 0.2 ? ' (jemnější než nativních 20 cm)' : ''}.</Note>
      )}
      <Row label="Přibalit">
        <Toggle on={exportKatastr} onClick={() => setExportKatastr(v => !v)} icon={<Layers size={13} />} label="Katastr" title="Hranice parcel jako 3D křivky (katastr.dxf) ve stejném rámci jako terén" />
      </Row>
      {/* Tentýž posun jako v sekci Souřadnice — jedna hodnota uložená ve scéně, dvě místa. */}
      <ShiftEditor
        shift={coordShift}
        onShift={s => persistCoords(coordPts, s)}
        tileCenter={bounds ? [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2] : null}
      />
      {coordPts.length > 0 && (
        <Note>Přibalí se {coordPts.length} {coordPts.length === 1 ? 'odečtený bod' : 'odečtených bodů'} jako helpery (body.ms).</Note>
      )}
      <Note warn={mb > 150}>
        {tris >= 1e6 ? `~${(tris / 1e6).toFixed(1)} M trojúhelníků` : `~${Math.round(tris / 1e3)} k trojúhelníků`}
        {' · zip ~'}{mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`}
        {mb > 150 && ' — zvaž řidší terén nebo menší texturu'}
      </Note>
      <button onClick={outputs.exportTilesObj} title="Terén DMR 5G (s ortofotem, je-li zapnuté) → zip s OBJ + MTL pro 3ds Max" className="flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500">
        <Download size={13} /> Exportovat terén (OBJ)
      </button>
    </Card>
  )
}

function Export2D({ outputs, tileCount, tileSize, bounds }: {
  outputs: ExportsApi
  tileCount: number
  tileSize: TileSize
  bounds: ReturnType<typeof tilesBounds> | null
}) {
  // Výběr, který nevyplňuje celý obdélník, se ořízne do svého tvaru (viz `tilesOutline`).
  const shaped = !!bounds && tileCount < Math.round((bounds.maxX - bounds.minX) / tileSize) * Math.round((bounds.maxY - bounds.minY) / tileSize)
  const p = imagePlan(outputs, bounds, shaped)
  const tilesEst = estimateMapTiles(tileCount, tileSize, outputs.mapRes)
  const layers = outputs.mapLayer === 'both' ? 2 : 1
  return (
    <Card>
      <MapImageOptions outputs={outputs} />
      {p && <ImagePlanNote p={p} />}
      <button onClick={outputs.exportTilesGeoTiff} disabled={!!p?.blocked} title="Jeden spojený obrázek přes vybrané dlaždice, s georeferencí — ve tvaru výběru. Otevře ho Photoshop i After Effects." className="flex items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500 disabled:opacity-50">
        <Image size={13} /> Jeden obrázek ({p?.fmtName ?? 'PNG'})
      </button>
      <Note warn={tilesEst.bytes > 500e6}>
        Po dlaždicích: {tileCount}× {tilesEst.side}×{tilesEst.side} px · ~{fmtBytes(tilesEst.bytes * layers)}
        {tilesEst.bytes > 500e6 && ' — zapíše se rovnou na disk (Chrome/Edge)'}
      </Note>
      <button onClick={outputs.exportMapTiles2D} title="Každá dlaždice jako georeferencovaný JPEG + world file v zipu. Rozlišení se drží i u velkého území." className="flex items-center justify-center gap-1.5 rounded-lg bg-gray-800 px-2 py-1.5 text-xs text-gray-200 hover:bg-gray-700">
        <Grid3x3 size={13} /> Po dlaždicích (zip)
      </button>
      {!LOCAL_TILES && (
        <button onClick={outputs.loadLocal2DMap} title="Napéct ortofoto vybrané oblasti do prohlížeče jako dlaždicovou pyramidu — pak jede offline a jde zoomovat hloub. Jednorázové stahování z ČÚZK." className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-800">
          <ArrowDownToLine size={12} /> Uložit ortofoto do prohlížeče (offline)
        </button>
      )}
    </Card>
  )
}
