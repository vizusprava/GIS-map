/**
 * Okno „Klíč Cesium ion" — vlastní klíč pro 3D realitu místo sdíleného zkušebního.
 *
 * Otevře se odkudkoliv přes `openIonKeyDialog()` (přehled scén, panel Podklad, chyba Google 3D);
 * kreslí ho `<IonKeyHost />` v main.tsx. Klíč se před uložením ověří u Cesium ion, takže se
 * neuloží nic, co by v mapě stejně nefungovalo. Logika klíče je v lib/ionKey.ts.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, KeyRound, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { ION_TOKEN } from './config'
import { checkIonToken, saveUserIonToken, useUserIonToken } from './lib/ionKey'
import { useAuthStore } from './stores/authStore'

let open: (() => void) | null = null
/** Otevře okno s klíčem (když hostitel není připojený, nic se nestane). */
export function openIonKeyDialog() { open?.() }

export function IonKeyHost() {
  const [shown, setShown] = useState(false)
  useEffect(() => { open = () => setShown(true); return () => { open = null } }, [])
  return shown ? <IonKeyDialog onClose={() => setShown(false)} /> : null
}

function IonKeyDialog({ onClose }: { onClose: () => void }) {
  const own = useUserIonToken()
  const signedIn = useAuthStore(s => !!s.user)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Fokus do okna (bez přihlášení v něm pole není) a Esc odkudkoliv — v zachytávací fázi, ať se
  // k Esc nedostane mapa pod oknem (vypnutí nástroje, zavření panelu lišty).
  useEffect(() => {
    (inputRef.current ?? boxRef.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return // v okně to vyřídí onKeyDown
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !busyRef.current) closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  async function save() {
    const t = value.trim()
    if (!t) { setErr('Vlož klíč.'); return }
    setBusy(true); setErr(null)
    const check = await checkIonToken(t)
    if (!check.ok) { setBusy(false); setErr(check.reason); return }
    try {
      await saveUserIonToken(t)
      toast.success('Vlastní klíč Cesium ion je uložený — 3D realita teď jede na tvou kvótu')
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function removeOwn() {
    setBusy(true); setErr(null)
    try {
      await saveUserIonToken(null)
      toast.success(ION_TOKEN ? 'Vlastní klíč odebrán — 3D realita jede zase na sdílený zkušební' : 'Vlastní klíč odebrán')
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

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
        aria-label="Klíč Cesium ion"
        data-ion-dialog
        onKeyDown={e => {
          e.stopPropagation() // zkratky mapy pod oknem nesmí reagovat
          if (e.key === 'Escape' && !busy) onClose()
          if (e.key === 'Enter' && !busy) void save()
        }}
        className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-gray-700 bg-gray-900 p-4 text-gray-100 shadow-2xl outline-none"
      >
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-sky-400" />
          <span className="flex-1 text-sm font-medium">Klíč Cesium ion pro 3D realitu</span>
          <button onClick={onClose} disabled={busy} title="Zavřít (Esc)" className="rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"><X size={14} /></button>
        </div>

        <div className={`rounded-lg px-2.5 py-1.5 text-xs ${own ? 'bg-emerald-950/60 text-emerald-200' : 'bg-gray-800 text-gray-300'}`}>
          {own
            ? <><Check size={12} className="mr-1 inline" />Používáš <b>vlastní klíč</b> (…{own.slice(-6)}) — 3D realita čerpá tvou kvótu.</>
            : ION_TOKEN
              ? <>Používáš <b>sdílený zkušební klíč</b>. Stačí na vyzkoušení; jeho kvótu ale čerpají všichni uživatelé dohromady, a když dojde, 3D realita přestane jít všem.</>
              : <>Appka nemá žádný sdílený klíč — 3D realita půjde, až si nastavíš vlastní.</>}
        </div>

        <div className="text-xs leading-relaxed text-gray-300">
          Vlastní klíč je zdarma:
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-gray-400">
            <li>Zaregistruj se na <a href="https://ion.cesium.com/signup" target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">ion.cesium.com <ExternalLink size={10} className="inline" /></a>.</li>
            <li>V <b className="text-gray-300">Asset Depot</b> přidej „Google Photorealistic 3D Tiles" do svých assetů.</li>
            <li>V <b className="text-gray-300">Access Tokens</b> vytvoř klíč (stačí výchozí oprávnění) a zkopíruj ho sem.</li>
          </ol>
        </div>

        {signedIn ? (
          <>
            <input
              ref={inputRef}
              value={value}
              onChange={e => { setValue(e.target.value); setErr(null) }}
              placeholder={own ? 'Nový klíč (eyJhbGciOi…)' : 'Vlož klíč (eyJhbGciOi…)'}
              spellCheck={false}
              autoComplete="off"
              className="rounded-lg bg-gray-800 px-2.5 py-1.5 font-mono text-xs text-gray-100 outline-none ring-1 ring-gray-700 focus:ring-sky-600"
            />
            {err && <div className="text-xs text-amber-400">{err}</div>}
            <div className="flex flex-wrap justify-end gap-2">
              {own && (
                <button onClick={() => void removeOwn()} disabled={busy} className="mr-auto rounded-lg px-2 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-red-300 disabled:opacity-50">
                  {ION_TOKEN ? 'Vrátit sdílený klíč' : 'Odebrat klíč'}
                </button>
              )}
              <button onClick={onClose} disabled={busy} className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50">Zavřít</button>
              <button onClick={() => void save()} disabled={busy || !value.trim()} className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Ověřit a uložit
              </button>
            </div>
          </>
        ) : (
          <div className="text-xs text-gray-400">Vlastní klíč se ukládá k účtu — nejdřív se přihlas.</div>
        )}
      </div>
    </div>
  )
}
