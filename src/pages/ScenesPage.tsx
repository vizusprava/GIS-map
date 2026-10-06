/**
 * Přehled scén — první, co uživatel po přihlášení vidí.
 *
 * Scéna je jedna zakázka: drží svoje modely, výkresy, rastry, pohledy kamery, popisky
 * i měření. Tady se zakládá, hledá, řadí, přejmenovává, sdílí a maže; otevření vede do mapy.
 * Scény, které se mnou nasdílel někdo jiný, mají vlastní oddíl — ty smazat nejde, jen z nich
 * odejít.
 *
 * Všechno je popsané slovy, ne jen ikonami: tlačítka v hlavičce, údaje na kartě i akce scény
 * (nabídka ⋯ je vidět pořád — dřív se ikony ukázaly až po najetí myší a nikdo je nenašel).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Globe2, Plus, Trash2, Pencil, LogOut, Loader2, Layers, Clock, Image as ImageIcon, Check, X, KeyRound,
  UserRound, Users, UserMinus, Link2, MoreHorizontal, Search, ArrowUpDown, ChevronDown, ExternalLink,
} from 'lucide-react'
import { openIonKeyDialog } from '../ionKeyDialog'
import { openShareDialog } from '../shareDialog'
import { useUserIonToken } from '../lib/ionKey'
import { toast } from 'sonner'
import { ask } from '../dialog'
import { createScene, deleteScene, listScenes, renameScene } from '../lib/scenes'
import { ROLE_LABEL, leaveScene, sharingOverview } from '../lib/sharing'
import { signedUrlOrNull } from '../lib/storage'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import type { SceneItem } from '../lib/types'

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

/** 1 soubor, 2 soubory, 5 souborů */
const plural = (n: number, one: string, few: string, many: string) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many)

/** „dnes 8:12", „včera 14:35", jinak datum — u přehledu se čte rychleji než plné datum s časem. */
function fmtWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso), now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  const time = d.toLocaleTimeString('cs-CZ', { hour: 'numeric', minute: '2-digit' })
  if (diff === 0) return `dnes ${time}`
  if (diff === 1) return `včera ${time}`
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' })
}

/** hledání bez ohledu na velikost písmen a diakritiku („kladno" najde „Kladno", „most" i „Most") */
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

type Sort = 'opened' | 'name' | 'created'
const SORT_LABEL: Record<Sort, string> = { opened: 'Naposledy otevřené', name: 'Podle názvu', created: 'Nejnovější' }
const SORT_KEY = 'geo.scenesSort'
const readSort = (): Sort => {
  try { const s = localStorage.getItem(SORT_KEY); return s === 'name' || s === 'created' ? s : 'opened' } catch { return 'opened' }
}

/**
 * Rozbalovací nabídka: tlačítko + seznam položek. Zavře se výběrem, klikem jinam nebo Esc.
 * `align` = ke které straně tlačítka se nabídka zarovná.
 */
function Menu({ button, label, align = 'right', children, buttonClass }: {
  button: ReactNode
  label: string
  align?: 'left' | 'right'
  children: (close: () => void) => ReactNode
  buttonClass: string
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const out = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', out)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', out); window.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} className={buttonClass}>
        {button}
      </button>
      {open && (
        <div role="menu" className={`absolute top-full z-30 mt-1.5 min-w-48 overflow-hidden rounded-xl border border-gray-700 bg-gray-900 py-1 shadow-2xl ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function MenuItem({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-gray-800 pointer-coarse:py-3 ${danger ? 'text-red-300' : 'text-gray-200'}`}
    >
      <span className="shrink-0 text-gray-400">{icon}</span>{children}
    </button>
  )
}

/** malý štítek na kartě (veřejný odkaz, sdílení) */
function Badge({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-300 ring-1 ring-sky-500/25">
      {icon}{children}
    </span>
  )
}

const headBtn = 'flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-800/90 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 pointer-coarse:py-2.5'

export function ScenesPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { profile, user, signOut } = useAuthStore()
  const ownIon = useUserIonToken()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSortState] = useState<Sort>(readSort)
  const setSort = (s: Sort) => { setSortState(s); try { localStorage.setItem(SORT_KEY, s) } catch { /* jen pohodlí */ } }

  const { data: scenes, isLoading, error } = useQuery({ queryKey: ['scenes'], queryFn: listScenes })
  const ids = (scenes ?? []).map(s => s.id)
  const { data: counts } = useAssetCounts(ids)
  // s kým je která moje scéna sdílená a čí jsou ty cizí (bez migrace 003 prázdné)
  const { data: sharing } = useQuery({
    queryKey: ['sharing', ids.join(',')],
    enabled: ids.length > 0,
    queryFn: () => sharingOverview(scenes ?? []),
  })

  // hledání a řazení; „naposledy otevřené" je pořadí, ve kterém scény přišly (listScenes)
  const visible = useMemo(() => {
    const q = fold(query.trim())
    const list = (scenes ?? []).filter(s => !q || fold(s.name).includes(q))
    if (sort === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name, 'cs', { numeric: true }))
    if (sort === 'created') return [...list].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    return list
  }, [scenes, query, sort])
  const own = visible.filter(s => s.role === 'owner')
  const shared = visible.filter(s => s.role !== 'owner')
  const ownTotal = (scenes ?? []).filter(s => s.role === 'owner').length
  const sharedTotal = (scenes ?? []).length - ownTotal

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
    mutationFn: (scene: SceneItem) => deleteScene(scene),
    onSuccess: () => { toast.success('Scéna smazána'); void qc.invalidateQueries({ queryKey: ['scenes'] }) },
    onError: (e: Error) => toast.error(e.message),
  })

  const leave = useMutation({
    mutationFn: (scene: SceneItem) => leaveScene(scene.id),
    onSuccess: () => { toast.success('Scéna ti zmizela z přehledu'); void qc.invalidateQueries({ queryKey: ['scenes'] }) },
    onError: (e: Error) => toast.error(e.message),
  })

  function share(scene: SceneItem) {
    openShareDialog({ sceneId: scene.id, sceneName: scene.name, onChange: () => void qc.invalidateQueries({ queryKey: ['sharing'] }) })
  }

  async function confirmDelete(scene: SceneItem, sharedWith: number) {
    if (!(await ask({
      title: `Smazat scénu „${scene.name}"?`,
      message: 'Smaže se i se všemi nahranými soubory. Tohle nejde vzít zpět.'
        + (sharedWith > 0 ? '\n\nZmizí i lidem, se kterými ji sdílíš.' : ''),
      okLabel: 'Smazat', danger: true,
    }))) return
    remove.mutate(scene)
  }

  async function confirmLeave(scene: SceneItem) {
    if (!(await ask({
      title: `Odejít ze scény „${scene.name}"?`,
      message: 'Zmizí ti z přehledu; vlastníkovi i ostatním zůstane. Zpátky se dostaneš, jen když ji s tebou nasdílí znovu.',
      okLabel: 'Odejít', danger: true,
    }))) return
    leave.mutate(scene)
  }

  function card(scene: SceneItem) {
    const sharedWith = sharing?.counts[scene.id] ?? 0
    const ownerName = sharing?.owners[scene.owner]
    const files = counts?.[scene.id] ?? 0
    const opened = scene.opened_at
    return (
      <div
        key={scene.id}
        data-scene-card={scene.role}
        data-scene-id={scene.id}
        className="group rounded-2xl border border-gray-800 bg-gray-900/85 p-3 hover:border-emerald-500/40 transition-colors"
      >
        <button onClick={() => navigate(`/scene/${scene.id}`)} className="block w-full text-left" title={`Otevřít „${scene.name}"`}>
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
                  onKeyDown={e => { if (e.key === 'Escape') setRenaming(null) }}
                  aria-label="Nový název scény"
                  className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-100 outline-none focus:border-emerald-500/70"
                />
                <button type="submit" title="Uložit název" className="p-1 text-emerald-400 hover:text-emerald-300"><Check size={15} /></button>
                <button type="button" title="Zrušit" onClick={() => setRenaming(null)} className="p-1 text-gray-500 hover:text-gray-300"><X size={15} /></button>
              </form>
            ) : (
              <button
                onClick={() => navigate(`/scene/${scene.id}`)}
                className="block w-full text-left text-sm font-medium text-gray-100 truncate hover:text-emerald-300"
              >
                {scene.name}
              </button>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
              <span className="flex items-center gap-1"><Layers size={11} className="text-gray-500" /> {files} {plural(files, 'soubor', 'soubory', 'souborů')}</span>
              <span className="flex items-center gap-1"><Clock size={11} className="text-gray-500" /> {opened ? `otevřeno ${fmtWhen(opened)}` : `upraveno ${fmtWhen(scene.updated_at)}`}</span>
            </div>
            {(scene.role !== 'owner' || sharedWith > 0 || sharing?.links[scene.id]) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {scene.role !== 'owner' && (
                  <Badge icon={<Users size={11} />} title={`Scénu s tebou sdílí ${ownerName ?? 'kolega'}`}>
                    {ownerName ? `Sdílí ${ownerName}` : 'Sdílená'} · {ROLE_LABEL[scene.role]}
                  </Badge>
                )}
                {sharedWith > 0 && (
                  <Badge icon={<Users size={11} />} title="Lidé, se kterými scénu sdílíš (i ti, kteří ještě nemají účet)">
                    Sdíleno · {sharedWith} {plural(sharedWith, 'člověk', 'lidé', 'lidí')}
                  </Badge>
                )}
                {sharing?.links[scene.id] && (
                  <Badge icon={<Link2 size={11} />} title="Kdo má odkaz, scénu uvidí i bez registrace">Veřejný odkaz</Badge>
                )}
              </div>
            )}
          </div>

          {/* akce scény — tlačítko je vidět pořád (dřív ikony až po najetí myší) */}
          <Menu
            label={`Akce scény „${scene.name}"`}
            button={<MoreHorizontal size={16} />}
            buttonClass="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-gray-100 pointer-coarse:p-2.5"
          >
            {close => (
              <>
                <MenuItem icon={<ExternalLink size={15} />} onClick={() => { close(); navigate(`/scene/${scene.id}`) }}>Otevřít</MenuItem>
                {scene.role === 'owner' && (
                  <MenuItem icon={<Users size={15} />} onClick={() => { close(); share(scene) }}>Sdílet…</MenuItem>
                )}
                {scene.role !== 'viewer' && (
                  <MenuItem icon={<Pencil size={15} />} onClick={() => { close(); setRenaming(scene.id); setDraftName(scene.name) }}>Přejmenovat</MenuItem>
                )}
                <div className="my-1 h-px bg-gray-800" />
                {scene.role === 'owner'
                  ? <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { close(); void confirmDelete(scene, sharedWith) }}>Smazat scénu…</MenuItem>
                  : <MenuItem icon={<UserMinus size={15} />} danger onClick={() => { close(); void confirmLeave(scene) }}>Odejít ze scény…</MenuItem>}
              </>
            )}
          </Menu>
        </div>
      </div>
    )
  }

  const searching = query.trim().length > 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6">
        <header className="mb-8 flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center">
            <Globe2 size={20} className="text-emerald-400" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-100">GIS Map</h1>
            <p className="truncate text-xs text-gray-500">{profile?.display_name ?? profile?.email ?? 'přihlášen'}</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-medium pointer-coarse:py-2.5"
            >
              {create.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Nová scéna
            </button>
            {/* klíč pro 3D realitu: hned je vidět, na čí kvótu jede */}
            <button
              onClick={openIonKeyDialog}
              data-ion-button
              title={ownIon ? 'Klíč Cesium ion pro 3D dlaždice (Google 3D realita) — používáš vlastní' : 'Klíč Cesium ion pro 3D dlaždice (Google 3D realita) — používáš sdílený zkušební'}
              className={headBtn}
            >
              <KeyRound size={15} className={ownIon ? 'text-emerald-300' : 'text-gray-400'} />
              <span className="hidden sm:inline">3D dlaždice · klíč Cesium</span>
              <span className="sm:hidden">Klíč 3D</span>
              <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${ownIon ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-700 text-gray-300'}`}>
                {ownIon ? 'vlastní ✓' : 'sdílený'}
              </span>
            </button>
            <Menu
              label="Účet"
              button={<><UserRound size={15} className="text-gray-400" /> Účet <ChevronDown size={14} className="text-gray-500" /></>}
              buttonClass={headBtn}
            >
              {close => (
                <>
                  <div className="border-b border-gray-800 px-3 py-2">
                    <div className="truncate text-sm text-gray-100">{profile?.display_name ?? 'Účet'}</div>
                    <div className="truncate text-xs text-gray-500">{user?.email}</div>
                  </div>
                  <MenuItem icon={<UserRound size={15} />} onClick={() => { close(); navigate('/account') }}>Nastavení účtu</MenuItem>
                  <MenuItem icon={<KeyRound size={15} />} onClick={() => { close(); openIonKeyDialog() }}>Klíč pro 3D dlaždice (Cesium)</MenuItem>
                  <div className="my-1 h-px bg-gray-800" />
                  <MenuItem icon={<LogOut size={15} />} onClick={() => { close(); void signOut() }}>Odhlásit se</MenuItem>
                </>
              )}
            </Menu>
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
            {/* Tip na migraci jen když opravdu chybí tabulka. Ukazoval se na každou chybu
                včetně těch přihlašovacích a posílal hledat problém do databáze, i když
                schéma bylo celou dobu v pořádku. */}
            {/schema cache|does not exist|relation/i.test((error as Error).message) && (
              <p className="text-xs text-red-300/70 mt-1">
                Nezapomněl jsi spustit <code>sql/001_init.sql</code> ve svém Supabase projektu?
              </p>
            )}
          </div>
        )}

        {scenes && scenes.length === 0 && (
          <div className="rounded-2xl border-2 border-dashed border-gray-800 bg-gray-950/70 p-12 text-center">
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

        {scenes && scenes.length > 0 && (
          <>
            {/* nadpis + hledání + řazení */}
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-medium text-gray-200">
                Moje scény <span className="text-gray-500">({searching ? `${own.length} z ${ownTotal}` : ownTotal})</span>
              </h2>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <label className="relative">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input
                    id="scene-search"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') setQuery('') }}
                    placeholder="Hledat scénu…"
                    aria-label="Hledat scénu podle názvu"
                    className="w-48 rounded-lg border border-gray-700 bg-gray-900/90 py-1.5 pl-8 pr-2 text-sm text-gray-100 outline-none placeholder:text-gray-500 focus:border-emerald-500/70 sm:w-56"
                  />
                </label>
                <label className="relative flex items-center">
                  <ArrowUpDown size={14} className="pointer-events-none absolute left-2.5 text-gray-500" />
                  <select
                    id="scene-sort"
                    value={sort}
                    onChange={e => setSort(e.target.value as Sort)}
                    aria-label="Řazení scén"
                    className="appearance-none rounded-lg border border-gray-700 bg-gray-900/90 py-1.5 pl-8 pr-3 text-sm text-gray-200 outline-none focus:border-emerald-500/70"
                  >
                    {(Object.keys(SORT_LABEL) as Sort[]).map(s => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
                  </select>
                </label>
              </div>
            </div>

            {own.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {own.map(card)}
              </div>
            ) : ownTotal === 0 ? (
              <div className="rounded-2xl border-2 border-dashed border-gray-800 bg-gray-950/70 p-8 text-center text-sm text-gray-400">
                Zatím nemáš vlastní scénu.
                <button onClick={() => create.mutate()} className="ml-2 text-emerald-400 hover:text-emerald-300">Vytvořit první</button>
              </div>
            ) : (
              <div className="rounded-xl border border-gray-800 bg-gray-950/70 p-6 text-center text-sm text-gray-400">
                Žádná tvoje scéna neodpovídá „{query.trim()}“.
              </div>
            )}

            {sharedTotal > 0 && (
              <>
                <h2 className="mb-4 mt-10 flex items-center gap-1.5 text-sm font-medium text-gray-200">
                  <Users size={14} className="text-sky-400" /> Sdílené se mnou <span className="text-gray-500">({searching ? `${shared.length} z ${sharedTotal}` : sharedTotal})</span>
                </h2>
                {shared.length > 0 ? (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {shared.map(card)}
                  </div>
                ) : (
                  <div className="rounded-xl border border-gray-800 bg-gray-950/70 p-6 text-center text-sm text-gray-400">
                    Žádná sdílená scéna neodpovídá „{query.trim()}“.
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
