/**
 * Přehled scén — první, co uživatel po přihlášení vidí.
 *
 * Scéna je jedna zakázka: drží svoje modely, výkresy, rastry, pohledy kamery, popisky
 * i měření. Tady se zakládá, přejmenovává a maže; otevření vede do mapy.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe2, Plus, Trash2, Pencil, LogOut, Loader2, Layers, Clock, Image as ImageIcon, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { createScene, deleteScene, listScenes, renameScene } from '../lib/scenes'
import { signedUrlOrNull } from '../lib/storage'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import type { SceneRow } from '../lib/types'

/** Kolik souborů která scéna má — jeden dotaz pro celý přehled, ne N dotazů po řádcích. */
function useAssetCounts(sceneIds: string[]) {
  return useQuery({
    queryKey: ['asset-counts', sceneIds.join(',')],
    enabled: sceneIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from('geo_assets').select('scene_id').in('scene_id', sceneIds)
      if (error) throw new Error(error.message)
      const counts: Record<string, number> = {}
      for (const row of (data ?? []) as { scene_id: string }[]) {
        counts[row.scene_id] = (counts[row.scene_id] ?? 0) + 1
      }
      return counts
    },
  })
}

function SceneThumb({ path }: { path: string | null }) {
  const { data: url } = useQuery({
    queryKey: ['thumb', path],
    enabled: !!path,
    queryFn: () => signedUrlOrNull(path),
    staleTime: 30 * 60_000, // podepsané URL platí hodinu, nemá cenu ho pořád obnovovat
  })
  if (!url) {
    return (
      <div className="aspect-video rounded-lg bg-gray-900 border border-gray-800 flex items-center justify-center">
        <ImageIcon size={22} className="text-gray-700" />
      </div>
    )
  }
  return <img src={url} alt="" className="aspect-video w-full object-cover rounded-lg border border-gray-800" />
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function ScenesPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { profile, signOut } = useAuthStore()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const { data: scenes, isLoading, error } = useQuery({ queryKey: ['scenes'], queryFn: listScenes })
  const { data: counts } = useAssetCounts((scenes ?? []).map(s => s.id))

  const create = useMutation({
    mutationFn: () => createScene(`Nová scéna ${new Date().toLocaleDateString('cs-CZ')}`),
    onSuccess: (scene) => {
      void qc.invalidateQueries({ queryKey: ['scenes'] })
      navigate(`/scene/${scene.id}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameScene(id, name),
    onSuccess: () => { setRenaming(null); void qc.invalidateQueries({ queryKey: ['scenes'] }) },
    onError: (e: Error) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: (scene: SceneRow) => deleteScene(scene),
    onSuccess: () => { toast.success('Scéna smazána'); void qc.invalidateQueries({ queryKey: ['scenes'] }) },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6">
        <header className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center">
            <Globe2 size={20} className="text-emerald-400" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-100">GIS Map</h1>
            <p className="text-xs text-gray-500 truncate">
              {profile?.display_name ?? profile?.email ?? 'přihlášen'}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-medium"
            >
              {create.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Nová scéna
            </button>
            <button
              onClick={() => void signOut()}
              title="Odhlásit se"
              className="p-2 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin" /> Načítám scény…
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {(error as Error).message}
            <p className="text-xs text-red-300/70 mt-1">
              Nezapomněl jsi spustit <code>sql/001_init.sql</code> ve svém Supabase projektu?
            </p>
          </div>
        )}

        {scenes && scenes.length === 0 && (
          <div className="rounded-2xl border-2 border-dashed border-gray-800 p-12 text-center">
            <Layers size={28} className="mx-auto mb-3 text-gray-600" />
            <p className="text-sm text-gray-300 font-medium">Zatím tu nic není</p>
            <p className="text-xs text-gray-500 mt-1.5">
              Scéna je jedna zakázka — nahrané modely, výkresy, pohledy a měření na jednom místě.
            </p>
            <button
              onClick={() => create.mutate()}
              className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium"
            >
              <Plus size={16} /> Vytvořit první scénu
            </button>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(scenes ?? []).map(scene => (
            <div
              key={scene.id}
              className="group rounded-2xl border border-gray-800 bg-gray-900/50 p-3 hover:border-emerald-500/40 transition-colors"
            >
              <button onClick={() => navigate(`/scene/${scene.id}`)} className="block w-full text-left">
                <SceneThumb path={scene.thumb_path} />
              </button>

              <div className="mt-3 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {renaming === scene.id ? (
                    <form
                      onSubmit={e => { e.preventDefault(); if (draftName.trim()) rename.mutate({ id: scene.id, name: draftName.trim() }) }}
                      className="flex items-center gap-1"
                    >
                      <input
                        autoFocus value={draftName} onChange={e => setDraftName(e.target.value)}
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-100 outline-none focus:border-emerald-500/70"
                      />
                      <button type="submit" className="p-1 text-emerald-400 hover:text-emerald-300"><Check size={15} /></button>
                      <button type="button" onClick={() => setRenaming(null)} className="p-1 text-gray-500 hover:text-gray-300"><X size={15} /></button>
                    </form>
                  ) : (
                    <button
                      onClick={() => navigate(`/scene/${scene.id}`)}
                      className="block w-full text-left text-sm font-medium text-gray-100 truncate hover:text-emerald-300"
                    >
                      {scene.name}
                    </button>
                  )}
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-gray-500">
                    <span className="flex items-center gap-1"><Layers size={11} /> {counts?.[scene.id] ?? 0}</span>
                    <span className="flex items-center gap-1 truncate"><Clock size={11} /> {fmtDate(scene.opened_at ?? scene.updated_at)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => { setRenaming(scene.id); setDraftName(scene.name) }}
                    title="Přejmenovat"
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-gray-800"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (!window.confirm(`Smazat scénu „${scene.name}" i se všemi nahranými soubory? Tohle nejde vzít zpět.`)) return
                      remove.mutate(scene)
                    }}
                    title="Smazat scénu"
                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-300 hover:bg-gray-800"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
