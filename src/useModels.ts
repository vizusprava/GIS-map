/**
 * Importované 3D modely: načtení (GLB/glTF/OBJ, i s georeferencí z názvu nebo z geometrie),
 * usazení, výběr, posun tažením po mapě a ukládání do scény.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { MAX_GLB_YAW_DEG, MODEL_GLOW } from './config'
import { pickTerrain, viewCenterGround, buildMatrix } from './sceneUtils'
import { prepareModelFile } from './modelClient'
import type { PreparedModel } from './model3d'
import { parseAnchor } from './exportUtils'
import type { Anchor, MapClickOwner, ModelEntry, Placement, SceneObj } from './types'
import type { AssetConfig } from './lib/types'
import type { ScenePersist } from './lib/scenePersist'

export type ModelsTool = ReturnType<typeof useModels>

export function useModels(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  sceneRef: React.RefObject<ScenePersist>
  moveMode: boolean
  setObjects: React.Dispatch<React.SetStateAction<SceneObj[]>>
  releaseMapClick: (who: MapClickOwner) => void
  /** maska „skrýt mapu pod modelem" se počítá v `useMapLayers` */
  updateExcavation: () => void
  /** model zmizel — řez si k němu drží vlastní věci a uklidí si je */
  onModelRemoved: (id: string) => void
}) {
  const { viewerRef, sceneRef, moveMode, setObjects, releaseMapClick, updateExcavation, onModelRemoved } = deps

  const modelsRef = useRef<Map<string, ModelEntry>>(new Map())
  const selectedIdRef = useRef<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /** modely, které se ještě ani jednou celé nevykreslily (viz `dropUndrawn`) */
  const undrawnRef = useRef(new Set<string>())

  // Modely patřily vieweru, který zaniká spolu s komponentou: uvolnit jejich blob URL
  // a zapomenout odkazy, ať nový viewer (StrictMode, návrat do scény) nezačíná s mrtvými.
  useEffect(() => () => {
    for (const e of modelsRef.current.values()) URL.revokeObjectURL(e.url)
    modelsRef.current.clear()
  }, [])

  // promítnutí stavu umístění do matice VYBRANÉHO modelu
  useEffect(() => {
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (e && placement) {
      e.placement = placement
      e.model.modelMatrix = buildMatrix(placement, e.center, e.yawDeg)
      saveModel(e) // odloženě → tažení sliderem nevystřelí request na každý pixel
    }
  }, [placement])

  // režim přesunu: tažení vybraného modelu po mapě (kamera se při tahu vypne)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !moveMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    let dragging = false
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
      const picked = v.scene.pick(evt.position)
      if (picked && e && picked.primitive === e.model) {
        dragging = true
        v.scene.screenSpaceCameraController.enableInputs = false
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!dragging) return
      const g = pickTerrain(v, evt.endPosition)
      if (g) setPlacement(p => p ? { ...p, lon: g.lon, lat: g.lat, groundH: g.height } : p)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    const end = () => { if (dragging) { dragging = false; v.scene.screenSpaceCameraController.enableInputs = true } }
    handler.setInputAction(end, Cesium.ScreenSpaceEventType.LEFT_UP)
    // `v.scene` si držíme z registrace — při zániku komponenty je viewer už zničený a getter
    // by spadl (Viewer.isDestroyed() to nezachytí, v Cesiu vrací vždy false).
    const ssc = v.scene.screenSpaceCameraController
    return () => { handler.destroy(); ssc.enableInputs = true }
  }, [moveMode])

  /**
   * Nastavení modelu tak, jak se ukládá k jeho souboru. `center` ani `footprint` se neukládají
   * schválně — obojí se ze stejného souboru spočítá znovu a stejně, tak ať to nemůže zestárnout.
   */
  function modelConfig(e: ModelEntry): AssetConfig {
    return {
      placement: e.placement,
      yawDeg: e.yawDeg,
      visible: e.visible,
      excavate: !!e.excavate,
      outline: !!e.outline,
    }
  }

  /** Zapamatuj si usazení a přepínače modelu (odloženě — tažení sliderem je jinak vodopád). */
  function saveModel(e: ModelEntry | null | undefined) {
    if (e?.assetId) sceneRef.current.patchAssetConfig(e.assetId, modelConfig(e))
  }

  /** Nahraje model do scény na pozadí a doplní mu `assetId`. */
  async function uploadModel(entry: ModelEntry, file: File) {
    try {
      const asset = await sceneRef.current.uploadAsset({
        kind: 'model', name: entry.name, file, config: modelConfig(entry),
      })
      entry.assetId = asset.id
      // usazení se mohlo mezitím změnit (model jde posouvat, než upload dojede)
      sceneRef.current.patchAssetConfig(asset.id, modelConfig(entry))
      // ...a stejně tak jméno — přejmenovat jde i model, který se teprve nahrává
      if (asset.name !== entry.name) void sceneRef.current.renameAsset(asset.id, entry.name).catch(err => {
        console.error('Přejmenování modelu se neuložilo:', err)
      })
    } catch (e) {
      console.error('Uložení modelu selhalo:', e)
      toast.error(e instanceof Error ? e.message : 'Model se nepodařilo uložit do scény — po refreshi zmizí')
    }
  }

  async function importModel(file: File, restore?: { assetId: string; name: string; config: AssetConfig }) {
    if (!/\.(glb|gltf|obj)$/i.test(file.name)) return
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return

    const isGlb = /\.(glb|gltf)$/i.test(file.name)
    // glb URL pro Cesium (OBJ převedeme přes three) + nejnižší bod + případná geo-kotva
    let url: string
    let bottomZ: number | null = null
    let anchor = parseAnchor(file.name) // kotva z názvu (geo_lon_lat_h.*) → reimport našeho exportu
    let footprint: Cesium.Cartesian3[][] | null = null // obrys(y) půdorysu ve světě pro skrytí mapy (jen S-JTSK)
    // Ve workeru: materiály se zjednoduší na barevnou texturu (V-Ray z Maxu by byl černý),
    // OBJ se převede na GLB a u GLB bez kotvy se zkusí S-JTSK souřadnice v geometrii — u modelu
    // s miliony vrcholů práce na desítky vteřin, mapa se mezitím musí hýbat. Náš export
    // s kotvou v názvu se jen zjednoduší (nic se neparsuje, nejnižší bod se u kotvy nepoužívá).
    const known = !!anchor && isGlb
    let prep: PreparedModel
    try { prep = await prepareModelFile(file, { georef: !known, measure: !known }) } catch (e) {
      console.error(`Příprava modelu „${file.name}" selhala:`, e)
      if (/\.obj$/i.test(file.name)) { toast.error(restore ? `Model „${file.name}" se nepodařilo obnovit` : 'Import OBJ selhal'); return }
      prep = { glb: null, bottomZ: null, geo: null } // GLB zkusí načíst rovnou Cesium
    }
    if (v.isDestroyed()) return
    url = prep.glb ? URL.createObjectURL(new Blob([prep.glb], { type: 'model/gltf-binary' })) : URL.createObjectURL(file)
    bottomZ = prep.bottomZ
    if (prep.geo) {
      anchor = prep.geo.anchor
      footprint = prep.geo.footprint?.map(r => r.map(([x, y, z]) => new Cesium.Cartesian3(x, y, z))) ?? null
      if (!restore) toast.success('Model usazen podle S-JTSK souřadnic z geometrie')
    }

    let base: Anchor
    if (anchor) base = anchor
    else { const c = viewCenterGround(v); base = { lon: c.lon, lat: c.lat, h: c.height } }
    // glb (náš export i georeferencovaný) je otočený o 90° kolem svislé osy → kompenzace přes matici
    const autoYaw = (anchor && isGlb) ? MAX_GLB_YAW_DEG : 0
    // Uložené usazení má přednost před automatickým: model se od té doby mohl ručně posunout.
    const p: Placement = restore?.config.placement
      ?? { lon: base.lon, lat: base.lat, groundH: base.h, heightOffset: 0, heading: 0, pitch: 0, roll: 0, scale: 1 }
    const yawDeg = restore?.config.yawDeg ?? autoYaw
    if (!restore) {
      if (anchor && parseAnchor(file.name)) toast.success('Model usazen přesně podle geo-kotvy z názvu')
      else if (!anchor) toast.message('Soubor bez souřadnic — umístěno do středu, dolaď ručně')
    }

    try {
      const model = await Cesium.Model.fromGltfAsync({
        url,
        modelMatrix: buildMatrix(p, Cesium.Cartesian3.ZERO, yawDeg),
        /**
         * Bez dynamické mapy prostředí (odlesky a osvětlení z okolní oblohy). Každý model si ji
         * jinak počítá sám — při prvním modelu to byl i na silné grafice ~1 s zásek a s každým
         * dalším znovu. Modely z Maxu mají jednoduché materiály bez odlesků, takže jim stačí
         * výchozí osvětlení Cesia (slunce + okolní světlo) a vypadají stejně.
         */
        environmentMapOptions: { enabled: false },
      })
      if (v.isDestroyed()) { URL.revokeObjectURL(url); return }
      v.scene.primitives.add(model)
      // svítící obrys (glow) kolem modelu — výchozí VYPNUTÝ (jde zapnout v panelu modelu)
      model.silhouetteColor = MODEL_GLOW
      model.silhouetteSize = restore?.config.outline ? 2.0 : 0
      model.show = restore?.config.visible ?? true

      const id = crypto.randomUUID()
      const entry: ModelEntry = {
        id, name: restore?.name ?? file.name.replace(/\.(glb|gltf|obj)$/i, ''),
        model, url, center: Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO), yawDeg, placement: p,
        visible: restore?.config.visible ?? true,
        footprint: footprint ?? undefined,
        excavate: restore?.config.excavate ?? false,
        outline: restore?.config.outline ?? false,
        assetId: restore?.assetId,
      }
      modelsRef.current.set(id, entry)
      setObjects(list => [...list, { id, kind: 'model', name: entry.name, visible: entry.visible }])
      if (!restore) selectObject(id)

      // Dokud se model jednou celý nevykreslí (dva snímky po načtení), je „neověřený" —
      // kdyby na něm vykreslování spadlo, `dropUndrawn` ho odebere a mapa pojede dál.
      undrawnRef.current.add(id)
      let drawn = 0
      const offDrawn = v.scene.postRender.addEventListener(() => {
        if (!modelsRef.current.has(id) || !undrawnRef.current.has(id)) { offDrawn(); return }
        if (model.ready && ++drawn >= 2) { undrawnRef.current.delete(id); offDrawn() }
      })

      model.readyEvent.addEventListener(async () => {
        if (v.isDestroyed()) return
        if (!anchor) {
          const inv = Cesium.Matrix4.inverse(model.modelMatrix, new Cesium.Matrix4())
          const localCenter = Cesium.Matrix4.multiplyByPoint(inv, model.boundingSphere.center, new Cesium.Cartesian3())
          entry.center = new Cesium.Cartesian3(localCenter.x, localCenter.y, bottomZ ?? 0)
          model.modelMatrix = buildMatrix(entry.placement, entry.center, entry.yawDeg)
        }
        if (entry.excavate) updateExcavation() // matice i obrys jsou hotové → přepočítej masku
        // dosednutí i maska přišly asynchronně, mimo jakýkoli snímek — ukázat je
        v.scene.requestRender()
        // Při obnově scény se nikam nelétá: kamera se vrací na svoje uložené místo a přelet
        // na poslední načtený model by ji z něj sundal.
        if (!restore) v.camera.flyToBoundingSphere(model.boundingSphere, { duration: 1.0 })
      })

      if (!restore) void uploadModel(entry, file)
    } catch {
      URL.revokeObjectURL(url)
      toast.error(restore ? `Model „${file.name}" se nepodařilo obnovit` : 'Import modelu selhal')
    }
  }

  function selectObject(id: string | null) {
    selectedIdRef.current = id
    setSelectedId(id)
    const e = id ? modelsRef.current.get(id) : null
    setPlacement(e ? { ...e.placement } : null)
    releaseMapClick('move')
  }

  /** Odebere model z mapy a ze seznamu (soubor ve scéně nechá). */
  function unmountModel(id: string) {
    const v = viewerRef.current
    const e = modelsRef.current.get(id)
    if (!e) return null
    if (v && !v.isDestroyed()) v.scene.primitives.remove(e.model)
    onModelRemoved(id)
    URL.revokeObjectURL(e.url)
    modelsRef.current.delete(id)
    undrawnRef.current.delete(id)
    if (e.excavate) updateExcavation() // uklidit masku po smazaném modelu
    setObjects(list => list.filter(o => o.id !== id))
    if (selectedIdRef.current === id) selectObject(null)
    return e
  }

  /**
   * Pojistka po pádu vykreslování: modely, které se ještě ani jednou celé nevykreslily
   * (`undrawnRef`), jsou nejpravděpodobnější viník — třeba materiál, na kterém Cesium spadne
   * při stavbě shaderu. Odeberou se z mapy (soubor ve scéně zůstane, příští verze appky si
   * s ním může poradit) a vrátí se jejich jména; mapa pak může kreslit dál.
   */
  function dropUndrawn(): string[] {
    const names: string[] = []
    for (const id of [...undrawnRef.current]) {
      const e = unmountModel(id)
      if (e) names.push(e.name)
    }
    undrawnRef.current.clear()
    return names
  }

  function deleteModel(id: string) {
    const e = unmountModel(id)
    if (!e) return
    if (e.assetId) void sceneRef.current.deleteAsset(e.assetId).catch(err => {
      console.error('Smazání modelu z úložiště selhalo:', err)
      toast.error('Model zmizel z mapy, ale v úložišti zůstal — zkus to znovu po refreshi')
    })
  }

  // zapnout/vypnout skrytí mapy (ortofoto/topo + terén + Google) pod/nad vybraným modelem
  function toggleExcavation(id: string) {
    const e = modelsRef.current.get(id)
    if (!e || !e.footprint) return
    e.excavate = !e.excavate
    updateExcavation()
    saveModel(e)
    setObjects(list => [...list]) // překreslit panel (stav se čte z ref)
  }

  // zapnout/vypnout svítící obrys (silhouette) kolem vybraného modelu
  function toggleOutline(id: string) {
    const e = modelsRef.current.get(id)
    if (!e) return
    e.outline = !e.outline
    e.model.silhouetteSize = e.outline ? 2.0 : 0
    saveModel(e)
    setObjects(list => [...list]) // překreslit panel (stav se čte z ref)
  }

  /** Zap/vyp modelu z panelu Scéna. */
  function setModelVisible(id: string, vis: boolean) {
    const e = modelsRef.current.get(id)
    if (e) { e.model.show = vis; e.visible = vis; saveModel(e) }
  }

  /**
   * Nové jméno modelu. Bez zápisu by se po obnovení scény vrátilo původní. Model, který se
   * ještě nahrává, `assetId` nemá — jméno mu dopíše `uploadModel`, až upload dojede.
   */
  function renameModel(id: string, name: string) {
    const e = modelsRef.current.get(id)
    if (!e || e.name === name) return
    e.name = name
    if (e.assetId) void sceneRef.current.renameAsset(e.assetId, name).catch(err => {
      console.error('Přejmenování modelu se neuložilo:', err)
      toast.error('Nové jméno se nepodařilo uložit — po obnovení scény bude původní')
    })
  }

  function focusModel() {
    const v = viewerRef.current
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (v && !v.isDestroyed() && e) v.camera.flyToBoundingSphere(e.model.boundingSphere, { duration: 1.0 })
  }

  // přesné posazení vybraného modelu na povrch (terén i Google dlaždice)
  function dropToGround() {
    const v = viewerRef.current
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (!v || v.isDestroyed() || !placement || !e) return
    if (!v.scene.sampleHeightSupported) return
    const carto = Cesium.Cartographic.fromDegrees(placement.lon, placement.lat)
    const h = v.scene.sampleHeight(carto, [e.model])
    if (h != null) setPlacement(pp => pp ? { ...pp, groundH: h, heightOffset: 0 } : pp)
  }

  function patch(part: Partial<Placement>) {
    setPlacement(p => p ? { ...p, ...part } : p)
  }

  return {
    deleteModel,
    dropUndrawn,
    dropToGround,
    fileRef,
    focusModel,
    importModel,
    modelsRef,
    patch,
    placement,
    renameModel,
    selectObject,
    selectedId,
    selectedIdRef,
    setModelVisible,
    setSelectedId,
    toggleExcavation,
    toggleOutline,
  }
}
