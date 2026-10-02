/**
 * Jedna otevřená scéna — dotáhne data z backendu a předá mapě `ScenePersist`.
 *
 * Mapa se smí složit teprve tehdy, až je znám stav i seznam souborů: Cesium viewer se staví
 * jednou a počáteční hodnoty (pohledy kamery, popisky, podklad) se z něj už nedají „dosadit
 * zpátky". Proto se do `MapView` jde až po načtení, ne s prázdnými daty.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Loader2, ArrowLeft, RotateCcw } from 'lucide-react'
import { MapView } from '../MapView'
import { createAsset, deleteAsset, flushAssetConfigs, hasPendingAssetConfigs, listAssets, renameAsset, saveAssetConfig } from '../lib/assets'
import { flushScene, getScene, hasPendingSave, saveSceneState, saveSceneThumb, touchScene } from '../lib/scenes'
import { useAuthStore } from '../stores/authStore'
import type { ScenePersist } from '../lib/scenePersist'
import type { AssetRow, SceneRow, SceneState } from '../lib/types'

type Loaded = { scene: SceneRow; assets: AssetRow[] }

function Busy({ text }: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={16} className="animate-spin" /> {text}
      </div>
    </div>
  )
}

/**
 * Pád mapy nesmí skončit černou obrazovkou. Bez hranice chyb React při výjimce odmountuje celý
 * strom a nezbude nic — ani hláška, ani cesta zpět. Tady se ukáže, co spadlo (text chyby pomůže
 * při hlášení), a jde to načíst znovu. Uložené je všechno, co se stihlo zapsat: fronta ukládání
 * se dopisuje při odchodu ze stránky (viz efekt s `flushScene` níž).
 */
class MapErrorBoundary extends Component<{ children: ReactNode; onExit: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidCatch(error: Error) { console.error('Mapa spadla:', error) }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-lg w-full">
          <p className="text-sm text-red-300">Mapa narazila na chybu a nedá se zobrazit.</p>
          <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-gray-800 bg-gray-950 p-3 text-[11px] leading-snug text-gray-400 whitespace-pre-wrap">
            {error.message}{error.stack ? `\n\n${error.stack.split('\n').slice(1, 8).join('\n')}` : ''}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
            >
              <RotateCcw size={16} /> Načíst znovu
            </button>
            <button
              onClick={this.props.onExit}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm"
            >
              <ArrowLeft size={16} /> Zpět na přehled
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export function ScenePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const ownerId = useAuthStore(s => s.user?.id)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    // Skrytí záložky je spolehlivější chvíle než zavření: na asynchronní request `beforeunload`
    // nepočká a na mobilu ani nemusí přijít. Při přepnutí jinam se proto dopisuje hned.
    const onHide = () => { if (document.visibilityState === 'hidden') flush() }
    // Když pořád něco čeká (typicky výpadek sítě), prohlížeč se před zavřením zeptá.
    const onUnload = (e: BeforeUnloadEvent) => {
      flush()
      if (hasPendingSave(id) || hasPendingAssetConfigs()) { e.preventDefault(); e.returnValue = '' }
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onUnload)
      flush()
    }
  }, [id])

  const patchState = useCallback((patch: Partial<SceneState>) => {
    if (!id) return
    // Patch, který nic nemění, se neposílá. Mapa si při otevření scény ohlásí podklad
    // a pozadí, které jí scéna sama dala — bez téhle kontroly by každé otevření zapsalo celý
    // stav zpátky na server. Porovnává se jen totožnost (u čísel a textů hodnota); objekty
    // chodí vždycky nové, a hloubkové srovnání velkých polí by stálo víc než samotný zápis.
    const cur = stateRef.current as Record<string, unknown>
    if (Object.entries(patch).every(([k, v]) => cur[k] === v)) return
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
      renameAsset,
      deleteAsset,
      saveThumb: async (png) => { await saveSceneThumb(id, ownerId, png) },
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

  if (!persist) return <Busy text="Otevírám scénu…" />

  return (
    <MapErrorBoundary onExit={persist.exit}>
      <MapView scene={persist} />
    </MapErrorBoundary>
  )
}
