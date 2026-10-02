/**
 * Vlastní ortofoto: georeferencovaný snímek + world file nad podkladem ČÚZK.
 */
import { useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { pairRasterFiles, loadGeoRaster, makeRasterView, disposeRasterSrc, CRS_LABELS, type GeoRaster, type CrsId } from './worldRaster'
import type { ScenePersist } from './lib/scenePersist'

export type RastersTool = ReturnType<typeof useRasters>

export function useRasters(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  sceneRef: React.RefObject<ScenePersist>
  /** rastr jde do stacku hned pod katastr */
  katastrRef: React.RefObject<Cesium.ImageryLayer | null>
}) {
  const { viewerRef, sceneRef, katastrRef } = deps

  // vlastní georeferencované rastry (.jgw + snímek): dekódované pixely, vrstva a obálka pro přelet
  const rastersRef = useRef<Map<string, { raster: GeoRaster; layer: Cesium.ImageryLayer; rect: Cesium.Rectangle }>>(new Map())
  const rasterFileRef = useRef<HTMLInputElement>(null)
  // vlastní rastry v panelu (pixely a vrstva jsou v rastersRef, tady jen to, co kreslí UI)
  // `assetId` = řádek v `geo_assets`; chybí, dokud se snímek nahrává (nebo když nahrání selhalo)
  const [rasterList, setRasterList] = useState<{ id: string; name: string; crsId: CrsId; visible: boolean; alpha: number; gsd: number; px: string; assetId?: string }[]>([])
  const [rasterBusy, setRasterBusy] = useState(false)

  // ── Vlastní ortofoto (snímek + world file) ─────────────────────────────────────────
  // Rastr jde do stacku HNED POD katastr, tedy nad ČÚZK podklad: překryje ortofoto i topo,
  // ale čáry a čísla parcel zůstanou nahoře. Průhlednost rozhoduje, jestli se to s mapou
  // jen prolne, nebo ten kus mapy natvrdo nahradí.
  function rasterIndex(v: Cesium.Viewer): number | undefined {
    const idx = katastrRef.current ? v.scene.imageryLayers.indexOf(katastrRef.current) : -1
    return idx >= 0 ? idx : undefined
  }

  const fmtGsd = (m: number) => (m < 1 ? `${Math.round(m * 100)} cm/px` : `${m.toFixed(1)} m/px`)

  /**
   * Vloží už dekódovaný rastr do mapy a do panelu. Sdílí to import z disku i obnova scény
   * z úložiště — jinak by se vrstva, pořadí a pyramida řešily dvakrát a rozešly se.
   */
  function mountRaster(
    v: Cesium.Viewer,
    raster: GeoRaster,
    opts: { crsId?: CrsId; alpha?: number; visible?: boolean; assetId?: string; fly?: boolean },
  ): { id: string; gsd: number; cut: boolean } {
    const crsId = opts.crsId ?? raster.crsId
    const view = makeRasterView(raster, crsId)
    const layer = v.scene.imageryLayers.addImageryProvider(view.provider, rasterIndex(v))
    layer.alpha = opts.alpha ?? 1
    layer.show = opts.visible ?? true
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    rastersRef.current.set(id, { raster, layer, rect: view.rectangle })
    // Snímek se zmenšuje jen když by se do paměti prohlížeče nevešel — ale pak to není
    // vidět na první pohled, tak se to řekne nahlas, ať se kvalita neztratí potichu.
    const cut = raster.src.width !== raster.native.w
    setRasterList(prev => [...prev, {
      id, name: raster.name, crsId, visible: layer.show, alpha: layer.alpha, gsd: view.gsd,
      assetId: opts.assetId,
      px: cut
        ? `${raster.src.width}×${raster.src.height} px (z ${raster.native.w}×${raster.native.h})`
        : `${raster.src.width}×${raster.src.height} px · nativní`,
    }])
    if (opts.fly) v.camera.flyTo({ destination: view.rectangle, duration: 1.2 })
    return { id, gsd: view.gsd, cut }
  }

  async function importRasters(files: File[]) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const pairs = pairRasterFiles(files)
    if (!pairs.length) { toast.error('Vyber snímek (JPG/PNG/TIF) a k němu world file (.jgw/.pgw/.tfw)'); return }
    setRasterBusy(true)
    let flew = false
    try {
      for (const { image, world, prj } of pairs) {
        // dekódovaný snímek visí v paměti (bitmap + pyramida) → dokud si ho nepřevezme
        // rastersRef, drží se tady, ať ho případná chyba po cestě uklidí
        let pending: GeoRaster | null = null
        try {
          const raster = await loadGeoRaster(image, world, prj)
          pending = raster
          if (v.isDestroyed()) return
          const fly = !flew
          const { id, gsd, cut } = mountRaster(v, raster, { fly })
          pending = null
          if (fly) flew = true
          if (cut) toast.warning(`„${raster.name}" se musel zmenšit na ${raster.src.width}×${raster.src.height} px — na plné rozlišení nestačí paměť prohlížeče`)
          else toast.success(`Snímek „${raster.name}" usazen v plném rozlišení — ${CRS_LABELS[raster.crsId]}, ${fmtGsd(gsd)}`)
          // Nahrání běží na pozadí: rastr je v mapě hned, `assetId` do panelu dojde, jak se
          // upload dokončí. Čekat na síť před zobrazením by import jen zdržovalo.
          void uploadRaster(id, image, world ?? null, raster.crsId)
        } catch (e) {
          console.error('Import rastru selhal:', e)
          toast.error(e instanceof Error ? e.message : `Import „${image.name}" selhal`)
        } finally { if (pending) disposeRasterSrc(pending.src) }
      }
    } finally { setRasterBusy(false) }
  }

  /** Uloží snímek i jeho world file do scény a doplní `assetId` do panelu. */
  async function uploadRaster(id: string, image: File, sidecar: File | null, crsId: CrsId) {
    try {
      const asset = await sceneRef.current.uploadAsset({
        kind: 'raster',
        name: image.name.replace(/\.[^.]+$/, ''),
        file: image,
        sidecar,
        config: { crsId, rasterAlpha: 1, rasterVisible: true },
      })
      setRasterList(prev => prev.map(r => (r.id === id ? { ...r, assetId: asset.id } : r)))
      // Než upload dojel, mohl uživatel hýbat průhledností nebo rastr zhasnout — a `saveRasterCfg`
      // to zahodila, protože ještě nebylo kam zapsat. Živou pravdu drží vrstva, tak ji dopíšeme.
      const layer = rastersRef.current.get(id)?.layer
      if (layer) {
        sceneRef.current.patchAssetConfig(asset.id, {
          crsId, rasterAlpha: layer.alpha, rasterVisible: layer.show,
        })
      }
    } catch (e) {
      console.error('Uložení rastru selhalo:', e)
      toast.error(e instanceof Error ? e.message : 'Rastr se nepodařilo uložit do scény — po refreshi zmizí')
    }
  }

  /** Nastavení rastru tak, jak se ukládá k jeho souboru. */
  function saveRasterCfg(id: string, patchCfg: { crsId?: CrsId; alpha?: number; visible?: boolean }) {
    const r = rasterList.find(x => x.id === id)
    if (!r?.assetId) return
    sceneRef.current.patchAssetConfig(r.assetId, {
      crsId: patchCfg.crsId ?? r.crsId,
      rasterAlpha: patchCfg.alpha ?? r.alpha,
      rasterVisible: patchCfg.visible ?? r.visible,
    })
  }

  // Ruční oprava soustavy, když ji odhad trefil špatně (snímek je pak jinde nebo zrcadlově).
  // Přepočítá se jen georeference — dekódované pixely i pyramida zůstávají, je to okamžité.
  function setRasterCrs(id: string, crsId: CrsId) {
    const v = viewerRef.current
    const e = rastersRef.current.get(id)
    if (!v || v.isDestroyed() || !e) return
    let view: ReturnType<typeof makeRasterView>
    try { view = makeRasterView(e.raster, crsId) }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Přepnutí soustavy selhalo'); return }
    const layers = v.scene.imageryLayers
    const idx = layers.indexOf(e.layer)
    const show = e.layer.show, alpha = e.layer.alpha
    layers.remove(e.layer, true)
    const layer = layers.addImageryProvider(view.provider, idx >= 0 ? idx : rasterIndex(v))
    layer.show = show; layer.alpha = alpha
    rastersRef.current.set(id, { raster: e.raster, layer, rect: view.rectangle })
    setRasterList(prev => prev.map(r => (r.id === id ? { ...r, crsId, gsd: view.gsd } : r)))
    saveRasterCfg(id, { crsId })
    v.camera.flyTo({ destination: view.rectangle, duration: 1.0 })
  }

  function setRasterAlpha(id: string, alpha: number) {
    const e = rastersRef.current.get(id)
    if (e) e.layer.alpha = alpha
    setRasterList(prev => prev.map(r => (r.id === id ? { ...r, alpha } : r)))
    saveRasterCfg(id, { alpha })
  }

  function toggleRaster(id: string) {
    const e = rastersRef.current.get(id)
    if (!e) return
    e.layer.show = !e.layer.show
    setRasterList(prev => prev.map(r => (r.id === id ? { ...r, visible: e.layer.show } : r)))
    saveRasterCfg(id, { visible: e.layer.show })
  }

  function removeRaster(id: string) {
    const v = viewerRef.current
    const e = rastersRef.current.get(id)
    const assetId = rasterList.find(r => r.id === id)?.assetId
    if (e) {
      if (v && !v.isDestroyed()) v.scene.imageryLayers.remove(e.layer, true)
      disposeRasterSrc(e.raster.src)
      rastersRef.current.delete(id)
    }
    setRasterList(prev => prev.filter(r => r.id !== id))
    if (assetId) void sceneRef.current.deleteAsset(assetId).catch(err => {
      console.error('Smazání rastru z úložiště selhalo:', err)
      toast.error('Rastr zmizel z mapy, ale v úložišti zůstal — zkus to znovu po refreshi')
    })
  }

  function locateRaster(id: string) {
    const v = viewerRef.current
    const e = rastersRef.current.get(id)
    if (v && !v.isDestroyed() && e) v.camera.flyTo({ destination: e.rect, duration: 1.0 })
  }

  return {
    fmtGsd,
    importRasters,
    locateRaster,
    mountRaster,
    rasterBusy,
    rasterFileRef,
    rasterList,
    removeRaster,
    setRasterAlpha,
    setRasterCrs,
    toggleRaster,
  }
}
