/**
 * Jedna otevřená scéna — dotáhne data z backendu a předá mapě `ScenePersist`.
 *
 * Mapa se smí složit teprve tehdy, až je znám stav i seznam souborů: Cesium viewer se staví
 * jednou a počáteční hodnoty (pohledy kamery, popisky, podklad) se z něj už nedají „dosadit
 * zpátky". Proto se do `MapView` jde až po načtení, ne s prázdnými daty.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Loader2, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { MapView } from '../MapView'
import { ModelEditor } from './ModelEditor'
import { createAsset, deleteAsset, flushAssetConfigs, getAsset, listAssets, saveAssetConfig } from '../lib/assets'
import { flushScene, getScene, saveSceneState, saveSceneThumb, touchScene } from '../lib/scenes'
import { useAuthStore } from '../stores/authStore'
import type { ScenePersist } from '../lib/scenePersist'
import type { AssetRow, SceneRow, SceneState } from '../lib/types'

type Loaded = { scene: SceneRow; assets: AssetRow[] }

export function ScenePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const ownerId = useAuthStore(s => s.user?.id)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Editace modelu ve 3D vieweru mapu odmountuje: dva WebGL kontexty (Cesium + R3F) vedle sebe
  // zbytečně žerou paměť a scéna se stejně uloží sama, takže návrat nic neztratí.
  const [editing, setEditing] = useState<AssetRow | null>(null)

  // Živý stav scény drží ref, ne useState: `patchState` se volá i desítky × za sekundu (tažení
  // popisku) a překreslovat kvůli tomu celou mapu by bylo zbytečné trápení.
  const stateRef = useRef<SceneState>({})

  useEffect(() => {
    if (!id) return
    let alive = true
    setLoaded(null)
    setError(null)
    void (async () => {
      try {
        const scene = await getScene(id)
        if (!alive) return
        if (!scene) { setError('Scéna neexistuje, nebo k ní nemáš přístup.'); return }
        const assets = await listAssets(id)
        if (!alive) return
        stateRef.current = scene.state ?? {}
        setLoaded({ scene, assets })
        void touchScene(id)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Scénu se nepodařilo načíst')
      }
    })()
    return () => { alive = false }
  }, [id])

  // Odchod ze scény (i zavření okna) musí dopsat, co čeká ve frontě odloženého ukládání.
  useEffect(() => {
    if (!id) return
    const flush = () => { void flushScene(id); void flushAssetConfigs() }
    window.addEventListener('beforeunload', flush)
    return () => { window.removeEventListener('beforeunload', flush); flush() }
  }, [id])

  const patchState = useCallback((patch: Partial<SceneState>) => {
    if (!id) return
    stateRef.current = { ...stateRef.current, ...patch }
    saveSceneState(id, stateRef.current)
  }, [id])

  const persist = useMemo<ScenePersist | null>(() => {
    if (!loaded || !id || !ownerId) return null
    return {
      sceneId: id,
      sceneName: loaded.scene.name,
      ownerId,
      initial: loaded.scene.state ?? {},
      assets: loaded.assets,
      patchState,
      uploadAsset: (opts) => createAsset({ sceneId: id, ownerId, ...opts }),
      patchAssetConfig: saveAssetConfig,
      deleteAsset,
      saveThumb: async (png) => { await saveSceneThumb(id, ownerId, png) },
      openModel: (assetId) => {
        // Řádek se dotahuje z databáze, ne z `loaded.assets` — model nahraný až za běhu
        // scény tam ještě není a čekat na refetch přehledu by editor jen zdržovalo.
        void (async () => {
          try {
            await flushScene(id)
            await flushAssetConfigs()
            const asset = await getAsset(assetId)
            if (asset) setEditing(asset)
            else toast.error('Model už ve scéně není.')
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Model se nepodařilo otevřít')
          }
        })()
      },
      exit: () => {
        void flushScene(id)
        void flushAssetConfigs()
        navigate('/')
      },
    }
  }, [loaded, id, ownerId, patchState, navigate])

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-sm text-red-300">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm"
          >
            <ArrowLeft size={16} /> Zpět na přehled
          </button>
        </div>
      </div>
    )
  }

  if (!persist) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={16} className="animate-spin" /> Otevírám scénu…
        </div>
      </div>
    )
  }

  if (editing) return <ModelEditor asset={editing} onClose={() => setEditing(null)} />

  return <MapView scene={persist} />
}
