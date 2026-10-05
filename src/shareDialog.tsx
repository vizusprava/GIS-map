/**
 * Okno „Sdílet scénu" — pozvání kolegů e-mailem, jejich role, čekající pozvánky a odkaz.
 *
 * Otevře se odkudkoliv přes `openShareDialog()` (přehled scén, hlavička panelu ve scéně);
 * kreslí ho `<ShareHost />` v main.tsx. Pravidla hlídá databáze (sql/003_sharing.sql), práce
 * se Supabase je v lib/sharing.ts. Appka sama e-maily neposílá — proto odkaz ke zkopírování.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Link2, Loader2, UserPlus, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { ask, isAskOpen, useModal } from './dialog'
import {
  ROLE_LABEL, listMembers, removeMember, revokeInvite, sceneLink, setInviteRole, setMemberRole, shareScene,
  type Invite, type Member,
} from './lib/sharing'
import { useAuthStore } from './stores/authStore'
import type { MemberRole } from './lib/types'

type ShareOpts = {
  sceneId: string
  sceneName: string
  /** po každé změně (přehled scén si přenačte, s kolika lidmi je scéna sdílená) */
  onChange?: () => void
}

let open: ((o: ShareOpts) => void) | null = null
/** Otevře okno sdílení scény (když hostitel není připojený, nic se nestane). */
export function openShareDialog(o: ShareOpts) { open?.(o) }

export function ShareHost() {
  const [opts, setOpts] = useState<ShareOpts | null>(null)
  useEffect(() => { open = setOpts; return () => { open = null } }, [])
  return opts ? <ShareDialog key={opts.sceneId} {...opts} onClose={() => setOpts(null)} /> : null
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ROLES: MemberRole[] = ['editor', 'viewer']

function RoleSelect({ value, onChange, disabled, label }: { value: MemberRole; onChange: (r: MemberRole) => void; disabled?: boolean; label: string }) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={e => onChange(e.target.value as MemberRole)}
      className="shrink-0 rounded-md bg-gray-800 px-1.5 py-1 text-xs text-gray-200 outline-none ring-1 ring-gray-700 focus:ring-sky-600 disabled:opacity-50"
    >
      {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
    </select>
  )
}

function ShareDialog({ sceneId, sceneName, onChange, onClose }: ShareOpts & { onClose: () => void }) {
  useModal()
  const profile = useAuthStore(s => s.profile)
  const myEmail = useAuthStore(s => s.user?.email)
  const [data, setData] = useState<{ members: Member[]; invites: Invite[] } | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('editor')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const reload = useCallback(async () => {
    try { setData(await listMembers(sceneId)); setLoadErr(null) } catch (e) { setLoadErr(msg(e)) }
  }, [sceneId])
  useEffect(() => { void reload() }, [reload])

  // Fokus do pole a Esc odkudkoliv — v zachytávací fázi, ať se k Esc nedostane mapa pod oknem.
  // Potvrzovací okno (odebrání člověka) nad tímhle si klávesy vyřídí samo.
  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (isAskOpen() || boxRef.current?.contains(e.target as Node)) return
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !busyRef.current) closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  /** Změna v seznamu: po úspěchu přenačíst a dát vědět přehledu. */
  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null); setOk(null)
    try { await fn(); await reload(); onChange?.() } catch (e) { setErr(msg(e)) } finally { setBusy(false) }
  }

  async function invite() {
    const e = email.trim()
    if (!e) return
    await run(async () => {
      const r = await shareScene(sceneId, e, role)
      setOk(r === 'added'
        ? `${e} má teď přístup (${ROLE_LABEL[role]}). Dej vědět a pošli odkaz (tlačítko dole).`
        : `${e} zatím nemá účet. Pozvánka počká — jakmile se na tenhle e-mail zaregistruje a potvrdí ho, scénu uvidí.`)
      setEmail('')
    })
  }

  async function copyLink() {
    const url = sceneLink(sceneId)
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Odkaz na scénu je ve schránce')
    } catch {
      setOk(`Odkaz: ${url}`) // schránka zakázaná — aspoň ho ukázat ke zkopírování
    }
  }

  const empty = data && !data.members.length && !data.invites.length

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4"
      onPointerDown={e => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Sdílet scénu ${sceneName}`}
        data-share-dialog
        onKeyDown={e => {
          e.stopPropagation() // zkratky mapy pod oknem nesmí reagovat
          if (e.key === 'Escape' && !busy) onClose()
        }}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 p-4 text-gray-100 shadow-2xl outline-none"
      >
        <div className="flex items-center gap-2">
          <Users size={16} className="shrink-0 text-sky-400" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Sdílet „{sceneName}“</span>
          <button onClick={onClose} disabled={busy} title="Zavřít (Esc)" className="rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"><X size={14} /></button>
        </div>

        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void invite() }}>
          <input
            ref={inputRef}
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); setErr(null) }}
            placeholder="kolega@firma.cz"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg bg-gray-800 px-2.5 py-1.5 text-sm text-gray-100 outline-none ring-1 ring-gray-700 placeholder:text-gray-500 focus:ring-sky-600"
          />
          <RoleSelect value={role} onChange={setRole} disabled={busy} label="Role nového člověka" />
          <button disabled={busy || !email.trim()} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />} Pozvat
          </button>
        </form>
        {err && <div className="text-xs text-amber-400">{err}</div>}
        {ok && <div className="break-words text-xs text-emerald-300">{ok}</div>}

        <div className="flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500">Kdo má přístup</div>
          <div className="flex items-center gap-2 rounded-lg bg-gray-800/50 px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-gray-200">{profile?.display_name || myEmail} <span className="text-gray-500">(ty)</span></div>
            </div>
            <span className="text-xs text-gray-400">{ROLE_LABEL.owner}</span>
          </div>
          {!data && !loadErr && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-gray-400"><Loader2 size={12} className="animate-spin" /> Načítám…</div>
          )}
          {loadErr && <div className="px-1 text-xs text-amber-400">{loadErr}</div>}
          {data?.members.map(m => (
            <div key={m.userId} data-share-member={m.email ?? m.userId} className="flex items-center gap-2 rounded-lg bg-gray-800/50 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-gray-200">{m.name}</div>
                {m.email && m.email !== m.name && <div className="truncate text-[11px] text-gray-500">{m.email}</div>}
              </div>
              <RoleSelect value={m.role} disabled={busy} label={`Role: ${m.name}`} onChange={r => void run(() => setMemberRole(sceneId, m.userId, r))} />
              <button
                disabled={busy}
                title="Odebrat přístup"
                onClick={async () => {
                  if (!(await ask({ title: `Odebrat ${m.name} ze scény?`, message: 'Scénu už v přehledu neuvidí. Všechno, co v ní je, zůstane.', okLabel: 'Odebrat', danger: true }))) return
                  void run(() => removeMember(sceneId, m.userId))
                }}
                className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-300 disabled:opacity-50"
              ><X size={13} /></button>
            </div>
          ))}
          {data?.invites.map(i => (
            <div key={i.email} data-share-invite={i.email} className="flex items-center gap-2 rounded-lg border border-dashed border-gray-700 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-gray-300">{i.email}</div>
                <div className="text-[11px] text-gray-500">čeká na registraci</div>
              </div>
              <RoleSelect value={i.role} disabled={busy} label={`Role: ${i.email}`} onChange={r => void run(() => setInviteRole(sceneId, i.email, r))} />
              <button
                disabled={busy}
                title="Zrušit pozvánku"
                onClick={() => void run(() => revokeInvite(sceneId, i.email))}
                className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-300 disabled:opacity-50"
              ><X size={13} /></button>
            </div>
          ))}
          {empty && <div className="px-1 text-xs text-gray-500">Zatím ji nesdílíš s nikým.</div>}
        </div>

        <div className="rounded-lg bg-gray-800/60 px-2.5 py-2 text-[11px] leading-relaxed text-gray-400">
          <div><Check size={11} className="mr-1 inline text-sky-400" /><b className="text-gray-300">Může upravovat</b> — mění scénu a nahrává soubory; smazat ani sdílet ji nemůže.</div>
          <div><Check size={11} className="mr-1 inline text-sky-400" /><b className="text-gray-300">Jen prohlížet</b> — vidí všechno, ale nic neuloží.</div>
          <div className="mt-1">Appka e-maily neposílá — dej vědět a pošli odkaz. Kdo ještě nemá účet, ať se zaregistruje na pozvaný e-mail.</div>
          <div className="mt-1">Upravuje-li scénu víc lidí naráz, platí poslední uložená změna — a cizí změny uvidíš po znovuotevření scény.</div>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={() => void copyLink()} className="mr-auto flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-800">
            <Link2 size={13} /> Kopírovat odkaz
          </button>
          <button onClick={onClose} disabled={busy} className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50">Hotovo</button>
        </div>
      </div>
    </div>
  )
}
