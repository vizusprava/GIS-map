/**
 * Obnova scény po otevření: uložené parcely a soubory (modely, výkresy, rastry) zpátky do mapy.
 *
 * Nahrané soubory se stáhnou z úložiště a projdou STEJNÝM importem jako z disku (jen bez
 * přeletů a s uloženým usazením), parcely se vykreslí z uložených prstenců. Jede to
 * POSTUPNĚ a až nad hotovou mapou: modely i výkresy jsou velké a paralelní dekódování
 * by appku na chvíli zabilo.
 *
 * Soubory uložené jen v jiném počítači (lib/localFiles.ts) se nehlásí jako chyba — sbírají
 * se do `missingFiles` a panel je nabídne dohledat na disku.
 */
import { useEffect, useRef, useState } from 'react'
import type * as Cesium from 'cesium'
import { toast } from 'sonner'
import { ask } from './dialog'
import { parseDrawingFile } from './drawingClient'
import { fetchAssetFile, fetchAssetSidecar, relinkLocalAsset } from './lib/assets'
import { MissingLocalFile } from './lib/localFiles'
import { nextFrame, waitForMap } from './sceneUtils'
import { disposeRasterSrc, loadGeoRaster, type CrsId } from './worldRaster'
import type { AssetRow, SavedParcel } from './lib/types'
import type { ScenePersist } from './lib/scenePersist'
import type { ModelsTool } from './useModels'
import type { DrawingsTool } from './useDrawings'
import type { RastersTool } from './useRasters'

export function useSceneRestore(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  viewerReady: boolean
  sceneRef: React.RefObject<ScenePersist>
  importModel: ModelsTool['importModel']
  renderDrawing: DrawingsTool['renderDrawing']
  mountRaster: RastersTool['mountRaster']
  restoreParcels: (saved: SavedParcel[]) => void
  /** některé soubory jsou jen v jiném počítači — panel se má otevřít, ať je vidět, co chybí */
  onMissing: () => void
}) {
  const { viewerRef, viewerReady, sceneRef, importModel, renderDrawing, mountRaster, restoreParcels, onMissing } = deps

  const restoredRef = useRef(false)
  /** co se právě obnovuje (hláška v liště a v panelu), null = nic */
  const [restoring, setRestoring] = useState<string | null>(null)
  const [missingFiles, setMissingFiles] = useState<AssetRow[]>([])

  /** Načte soubor scény do mapy podle druhu — při obnově scény i po dohledání chybějícího. */
  async function mountAsset(a: AssetRow, file: File, alive: () => boolean = () => true) {
    if (a.kind === 'model') {
      await importModel(file, { assetId: a.id, name: a.name, config: a.config })
    } else if (a.kind === 'drawing') {
      const parse = await parseDrawingFile(file)
      if (!alive()) return
      await renderDrawing(parse, a.file_name, { assetId: a.id, config: a.config })
    } else {
      const world = await fetchAssetSidecar(a)
      const raster = await loadGeoRaster(file, world ?? undefined)
      const v2 = viewerRef.current
      if (!alive() || !v2 || v2.isDestroyed()) { disposeRasterSrc(raster.src); return }
      mountRaster(v2, raster, {
        crsId: (a.config.crsId as CrsId | undefined) ?? raster.crsId,
        alpha: a.config.rasterAlpha ?? 1,
        visible: a.config.rasterVisible ?? true,
        assetId: a.id,
      })
    }
  }

  /**
   * Dohledaný chybějící soubor: sedí-li název a velikost, rovnou se použije, jinak se zeptá.
   * Uloží se do tohohle počítače (příště se načte sám) a načte se do mapy.
   */
  async function relinkMissing(a: AssetRow, picked: File[]) {
    const ext = (n: string) => n.slice(n.lastIndexOf('.')).toLowerCase()
    const main = picked.find(p => p.name === a.file_name) ?? picked.find(p => ext(p.name) === ext(a.file_name)) ?? picked[0]
    const side = a.sidecar_name
      ? picked.find(p => p !== main && p.name === a.sidecar_name) ?? picked.find(p => p !== main && ext(p.name) === ext(a.sidecar_name as string)) ?? null
      : null
    const size = main.size + (side?.size ?? 0)
    const fits = main.name === a.file_name && (a.size_bytes == null || a.size_bytes === size)
    if (!fits && !(await ask({
      title: 'Je to ten správný soubor?',
      message: `Ve scéně byl „${a.file_name}“${a.size_bytes ? ` (${(a.size_bytes / 1048576).toFixed(1)} MB)` : ''}, vybraný je „${main.name}“ (${(size / 1048576).toFixed(1)} MB).`,
      okLabel: 'Použít',
    }))) return
    if (a.sidecar_name && !side && !(await ask({
      title: `Chybí „${a.sidecar_name}“`,
      message: 'K rastru patří i soubor s georeferencí. Vyber příště oba najednou — bez něj se snímek nemusí umístit.',
      okLabel: 'Přesto načíst',
    }))) return
    try {
      await relinkLocalAsset(a, main, side)
      setMissingFiles(list => list.filter(x => x.id !== a.id))
      await mountAsset(a, main)
      toast.success(`„${a.name}“ je zpátky — příště se načte sám`)
    } catch (e) {
      console.error(`Dohledaný soubor „${a.name}“ se nepodařilo načíst:`, e)
      toast.error(`„${a.name}“ se nepodařilo načíst`)
    }
  }

  /** Soubor je nenávratně pryč — odebere se ze scény, ať se na něj neptá pořád dokola. */
  async function removeMissing(a: AssetRow) {
    if (!(await ask({
      title: `Odebrat „${a.name}“ ze scény?`,
      message: 'Soubor se pak už nebude hledat. Usazení a nastavení, které k němu patřily, se smažou.',
      okLabel: 'Odebrat', danger: true,
    }))) return
    try {
      await sceneRef.current.deleteAsset(a.id)
      setMissingFiles(list => list.filter(x => x.id !== a.id))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Odebrání se nepovedlo') }
  }

  useEffect(() => {
    if (!viewerReady || restoredRef.current) return
    restoredRef.current = true

    restoreParcels(sceneRef.current.initial.parcels ?? [])

    const assets = sceneRef.current.assets
    if (!assets.length) return
    let alive = true
    void (async () => {
      // Nejdřív mapa: dokud se dotahují dlaždice pod pohledem, soubory čekají — jinak by
      // se o procesor a grafiku praly a nebylo by vidět nic. Pomalé dlaždice ale čekají
      // nejdéle pár vteřin.
      const v0 = viewerRef.current
      if (!v0 || v0.isDestroyed()) return
      const n = assets.length
      setRestoring(`Nejdřív mapa, pak ${n === 1 ? 'soubor' : `${n} ${n <= 4 ? 'soubory' : 'souborů'}`} scény…`)
      await waitForMap(v0)
      // Stahování jde po síti a mapu nebrzdí: další soubor se stahuje, zatímco se předchozí staví.
      const files = new Map<number, Promise<File>>()
      const fileAt = (i: number) => {
        let p = files.get(i)
        if (!p) { p = fetchAssetFile(assets[i]); p.catch(() => { /* ozve se, až na něj dojde */ }); files.set(i, p) }
        return p
      }
      const missing: AssetRow[] = []
      for (let i = 0; i < assets.length; i++) {
        const a = assets[i]
        const v = viewerRef.current
        if (!alive || !v || v.isDestroyed()) return
        setRestoring(`Načítám „${a.name}" (${i + 1}/${assets.length})`)
        try {
          const file = await fileAt(i)
          files.delete(i)
          if (i + 1 < assets.length) fileAt(i + 1)
          if (!alive) return
          await mountAsset(a, file, () => alive)
          // mezi soubory dát mapě snímek — překreslí, co přibylo, a chytí myš
          await nextFrame()
        } catch (e) {
          // uložený jen v jiném počítači → nabídnout k dohledání, ne hlásit jako chybu
          if (e instanceof MissingLocalFile) { missing.push(a); continue }
          console.error(`Obnova souboru „${a.name}" selhala:`, e)
          toast.error(`Soubor „${a.name}" se nepodařilo načíst`)
        }
      }
      if (!alive) return
      setRestoring(null)
      if (missing.length) {
        setMissingFiles(missing)
        onMissing()
        toast.warning(missing.length === 1 ? `„${missing[0].name}“ je uložený jen v jiném počítači` : `${missing.length} soubory jsou uložené jen v jiném počítači`, {
          description: 'Najdi je na disku v panelu vlevo, sekce Chybějící soubory.',
          duration: 8000,
        })
      }
    })()
    return () => { alive = false }
  }, [viewerReady]) // eslint-disable-line react-hooks/exhaustive-deps

  return { restoring, missingFiles, relinkMissing, removeMissing }
}
