/**
 * Veřejný prohlížeč scény — odkaz `#/view/<kód>`, bez registrace.
 *
 * Kdo není přihlášený, přihlásí se na pozadí anonymně; databáze ho pustí ke scéně jako hosta
 * jen na čtení a jen dokud odkaz platí (sql/004_view_links.sql). Mapa jede v režimu prohlížeče
 * (`guest`): bez exportů, importu a úprav, s měřením bez ukládání. 3D realita používá klíč
 * Cesium ion vlastníka scény, když ho má.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Eye } from 'lucide-react'
import { MapView } from '../MapView'
import { listAssets } from '../lib/assets'
import { setSceneIonToken } from '../lib/ionKey'
import { getScene } from '../lib/scenes'
import { openSceneLink } from '../lib/sharing'
import { useAuthStore } from '../stores/authStore'
import type { ScenePersist } from '../lib/scenePersist'
import { Busy, MapErrorBoundary, viewOnlyPersist } from './ScenePage'

export function ViewPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const authLoading = useAuthStore(s => s.loading)
  const [persist, setPersist] = useState<ScenePersist | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // dokud se neobnoví uložené přihlášení, nevíme, jestli se má přihlašovat anonymně
    if (!token || authLoading) return
    let alive = true
    setPersist(null)
    setError(null)
    void (async () => {
      try {
        const link = await openSceneLink(token)
        const scene = await getScene(link.sceneId)
        if (!scene) throw new Error('Scéna už neexistuje, nebo odkaz přestal platit.')
        const assets = await listAssets(link.sceneId)
        if (!alive) return
        // klíč vlastníka scény se musí nastavit dřív, než se postaví mapa
        setSceneIonToken(link.ionToken)
        setPersist(viewOnlyPersist({
          sceneId: scene.id,
          sceneName: scene.name,
          ownerId: scene.owner,
          access: 'viewer',
          guest: true,
          ownerName: link.ownerName,
          initial: scene.state ?? {},
          assets,
          exit: () => navigate('/'),
        }))
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Odkaz se nepodařilo otevřít')
      }
    })()
    return () => { alive = false }
  }, [token, authLoading, navigate])

  // klíč vlastníka platí jen v prohlížeči — po odchodu zase podle přihlášeného
  useEffect(() => () => setSceneIonToken(null), [])

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div data-view-error className="max-w-sm text-center">
          <Eye size={24} className="mx-auto mb-3 text-gray-600" />
          <p className="text-sm text-red-300">{error}</p>
          <p className="mt-2 text-xs text-gray-500">Požádej toho, kdo ti odkaz poslal, o nový.</p>
        </div>
      </div>
    )
  }
  if (!persist) return <Busy text="Otevírám scénu…" />
  return (
    <MapErrorBoundary>
      <MapView scene={persist} />
    </MapErrorBoundary>
  )
}
