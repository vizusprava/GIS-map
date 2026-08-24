/**
 * Editor jednoho modelu ze scény — 3D viewer z jádra (`viewer-core`) nad nahraným .glb.
 *
 * Soubor se stahuje z úložiště do blobu, protože viewer chce URL, ne řádek v databázi.
 * `modelId` je id souboru ve scéně, takže anotace, vegetace, barvy i pohledy kamery se
 * ukládají k němu a při dalším otevření tam zase jsou.
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Viewer } from '@core'
import { fetchAssetFile } from '../lib/assets'
import { supabaseViewerAdapter } from '../lib/viewerAdapter'
import type { AssetRow } from '../lib/types'

async function confirmDialog({ message }: { message: string }) {
  return window.confirm(message)
}

export function ModelEditor({ asset, onClose }: { asset: AssetRow; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    void (async () => {
      try {
        const file = await fetchAssetFile(asset)
        if (!alive) return
        objectUrl = URL.createObjectURL(file)
        setUrl(objectUrl)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Model se nepodařilo načíst')
      }
    })()
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [asset])

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm text-red-300">{error}</p>
          <button onClick={onClose} className="mt-4 px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm">
            Zpět do mapy
          </button>
        </div>
      </div>
    )
  }

  if (!url) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={16} className="animate-spin" /> Stahuji model…
        </div>
      </div>
    )
  }

  return (
    <Viewer
      url={url}
      name={asset.name}
      modelId={asset.id}
      adapter={supabaseViewerAdapter}
      canEdit
      confirm={confirmDialog}
      onClose={onClose}
    />
  )
}
