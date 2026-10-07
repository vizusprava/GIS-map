/**
 * Nastavení účtu — jméno, e-mail, heslo, klíč Cesium ion, průvodce aplikací a smazání účtu i se všemi daty.
 *
 * Každý blok je samostatný formulář se svým stavem a hláškou, ať chyba v jednom nemaže
 * rozepsané v jiném. Práce se Supabase je v lib/account.ts.
 */
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, Compass, KeyRound, Loader2, Lock, Mail, Trash2, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { changeEmail, changePassword, deleteMyAccount, updateDisplayName } from '../lib/account'
import { useUserIonToken } from '../lib/ionKey'
import { openIonKeyDialog } from '../ionKeyDialog'
import { useAuthStore } from '../stores/authStore'
import { ION_TOKEN } from '../config'
import { TourSettings } from '../tour/TourSettings'

const input = 'w-full rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none ring-1 ring-gray-700 placeholder:text-gray-500 focus:ring-emerald-600'
const primary = 'inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-50'

export function AccountPage() {
  const navigate = useNavigate()
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <header className="mb-2 flex items-center gap-3">
          <button onClick={() => navigate('/')} title="Zpět na přehled scén" className="rounded-xl border border-gray-700 bg-gray-800 p-2 text-gray-300 hover:bg-gray-700">
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-lg font-bold text-gray-100">Nastavení účtu</h1>
        </header>
        <NameCard />
        <EmailCard />
        <PasswordCard />
        <IonCard />
        <Card icon={<Compass size={15} />} title="Průvodce aplikací"><TourSettings /></Card>
        <DeleteCard onDeleted={() => navigate('/')} />
      </div>
    </div>
  )
}

function Card({ icon, title, danger, children }: { icon: ReactNode; title: string; danger?: boolean; children: ReactNode }) {
  return (
    <section data-account-card={title} className={`flex flex-col gap-3 rounded-xl border p-4 ${danger ? 'border-red-900/70 bg-red-950/20' : 'border-gray-800 bg-gray-900/60'}`}>
      <h2 className={`flex items-center gap-2 text-sm font-medium ${danger ? 'text-red-300' : 'text-gray-100'}`}>{icon}{title}</h2>
      {children}
    </section>
  )
}

/** Hláška pod formulářem: chyba, nebo co se povedlo. */
function Msg({ err, ok }: { err: string | null; ok?: string | null }) {
  if (err) return <div className="text-xs text-amber-400">{err}</div>
  if (ok) return <div className="text-xs text-emerald-300">{ok}</div>
  return null
}

function NameCard() {
  const profile = useAuthStore(s => s.profile)
  const [name, setName] = useState(profile?.display_name ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const changed = name.trim() !== (profile?.display_name ?? '') && !!name.trim()
  return (
    <Card icon={<UserRound size={15} />} title="Jméno">
      <form className="flex gap-2" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setErr(null)
        try { await updateDisplayName(name); toast.success('Jméno uloženo') } catch (x) { setErr(x instanceof Error ? x.message : String(x)) } finally { setBusy(false) }
      }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Jak se jmenuješ" className={input} />
        <button disabled={busy || !changed} className={primary}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Uložit</button>
      </form>
      <Msg err={err} />
    </Card>
  )
}

function EmailCard() {
  const user = useAuthStore(s => s.user)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const pending = (user as { new_email?: string } | null)?.new_email
  return (
    <Card icon={<Mail size={15} />} title="E-mail">
      <div className="text-xs text-gray-400">Současný: <span className="text-gray-200">{user?.email}</span></div>
      {pending && (
        <div className="text-xs text-amber-300">Čeká na potvrzení změny na <b>{pending}</b> — klikni na odkaz v poště.</div>
      )}
      <form className="flex gap-2" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setErr(null); setOk(null)
        try {
          await changeEmail(email)
          setOk(`Na ${email.trim()} jsme poslali potvrzovací odkaz. Změna platí po kliknutí na něj — podle nastavení je potřeba potvrdit i na současné adrese.`)
          setEmail('')
        } catch (x) { setErr(x instanceof Error ? x.message : String(x)) } finally { setBusy(false) }
      }}>
        <input type="email" value={email} onChange={e => { setEmail(e.target.value); setErr(null) }} placeholder="nový@email.cz" className={input} autoComplete="email" />
        <button disabled={busy || !email.trim() || email.trim() === user?.email} className={`${primary} shrink-0`}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Změnit
        </button>
      </form>
      <Msg err={err} ok={ok} />
    </Card>
  )
}

function PasswordCard() {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Card icon={<Lock size={15} />} title="Heslo">
      <form className="flex flex-col gap-2" onSubmit={async e => {
        e.preventDefault(); setErr(null)
        if (next.length < 6) { setErr('Nové heslo musí mít alespoň 6 znaků.'); return }
        if (next !== again) { setErr('Nové heslo a jeho zopakování se neshodují.'); return }
        setBusy(true)
        try {
          await changePassword(cur, next)
          toast.success('Heslo změněno')
          setCur(''); setNext(''); setAgain('')
        } catch (x) { setErr(x instanceof Error ? x.message : String(x)) } finally { setBusy(false) }
      }}>
        <input type="password" value={cur} onChange={e => setCur(e.target.value)} placeholder="Současné heslo" className={input} autoComplete="current-password" />
        <input type="password" value={next} onChange={e => setNext(e.target.value)} placeholder="Nové heslo (aspoň 6 znaků)" className={input} autoComplete="new-password" />
        <input type="password" value={again} onChange={e => setAgain(e.target.value)} placeholder="Nové heslo znovu" className={input} autoComplete="new-password" />
        <div><button disabled={busy || !cur || !next || !again} className={primary}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Změnit heslo</button></div>
      </form>
      <Msg err={err} />
    </Card>
  )
}

function IonCard() {
  const own = useUserIonToken()
  return (
    <Card icon={<KeyRound size={15} />} title="Klíč Cesium ion">
      <div className="text-xs text-gray-400">
        {own ? 'Pro 3D realitu používáš vlastní klíč.'
          : ION_TOKEN ? 'Pro 3D realitu používáš sdílený zkušební klíč. Kdo ji používá hodně, nastaví si vlastní (zdarma).'
          : 'Appka nemá sdílený klíč — 3D realita půjde, až si nastavíš vlastní (zdarma).'}
      </div>
      <div><button onClick={openIonKeyDialog} className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700">{own ? 'Změnit klíč' : 'Nastavit vlastní klíč'}</button></div>
    </Card>
  )
}

const CONFIRM_WORD = 'SMAZAT'

function DeleteCard({ onDeleted }: { onDeleted: () => void }) {
  const [password, setPassword] = useState('')
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const ready = !!password && word.trim().toUpperCase() === CONFIRM_WORD
  return (
    <Card icon={<Trash2 size={15} />} title="Smazat účet" danger>
      <div className="text-xs leading-relaxed text-gray-300">
        Smaže se účet a s ním <b>všechny scény</b>, <b>nahrané soubory</b> (v úložišti i ty uložené jen v tomhle
        počítači), pohledy, měření a nastavení. <span className="text-red-300">Nejde to vzít zpátky.</span>
      </div>
      <div className="text-xs leading-relaxed text-gray-400">
        Scény, které sdílíš s kolegy, zmizí i jim. Ze scén, které s tebou sdílí někdo jiný, jen odejdeš —
        jejich vlastníkům zůstanou i se soubory, které jsi do nich nahrál(a).
      </div>
      <form className="flex flex-col gap-2" onSubmit={async e => {
        e.preventDefault(); if (!ready) return
        setBusy(true); setErr(null)
        try {
          await deleteMyAccount(password, setStep)
          toast.success('Účet je smazaný i se všemi daty')
          onDeleted()
        } catch (x) { setErr(x instanceof Error ? x.message : String(x)); setStep(null) } finally { setBusy(false) }
      }}>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Heslo pro potvrzení" className={input} autoComplete="current-password" />
        <input value={word} onChange={e => setWord(e.target.value)} placeholder={`Napiš ${CONFIRM_WORD}`} className={input} autoComplete="off" />
        <div className="flex items-center gap-3">
          <button disabled={busy || !ready} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-500 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Smazat účet natrvalo
          </button>
          {step && <span className="text-xs text-gray-400">{step}</span>}
        </div>
      </form>
      <Msg err={err} />
    </Card>
  )
}
